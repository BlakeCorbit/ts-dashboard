// sf-task.js — POST /api/sf-task
// Creates a Salesforce Task for the Customer Success Advisor linked to a ZD ticket's org.
// Also triggered by ZD webhook when `sf_task` tag is added.
//
// Flow:
//   1. Get ticket data from ZD (SID, org, requester, last comment)
//   2. Look up SF Account by SID (unique match), fallback to org name
//   3. Get Customer Success Advisor from Account
//   4. Create SF Task (Call In, Check In, High priority, due today)
//   5. Write SF task link back to ZD ticket as internal note

const { zdRequest } = require('../_zendesk');
const { sfRequest, isSalesforceConfigured, getInstanceUrl } = require('../_salesforce');

// ZD custom field IDs
const ZD_SID_FIELD = 360042445632; // SID (Shop ID)

// ---- Fetch ZD ticket details ----
async function getTicketData(ticketId) {
  const data = await zdRequest(`/tickets/${ticketId}.json?include=comment_count`);
  if (!data || !data.ticket) throw new Error('Ticket not found: ' + ticketId);
  const ticket = data.ticket;

  // Get requester name
  let requesterName = 'Unknown';
  if (ticket.requester_id) {
    try {
      const user = await zdRequest(`/users/${ticket.requester_id}.json`);
      if (user && user.user) requesterName = user.user.name;
    } catch { /* use fallback */ }
  }

  // Get assignee (ZD agent) name + email for SF user lookup
  let assigneeName = null;
  let assigneeEmail = null;
  if (ticket.assignee_id) {
    try {
      const user = await zdRequest(`/users/${ticket.assignee_id}.json`);
      if (user && user.user) {
        assigneeName = user.user.name;
        assigneeEmail = user.user.email;
      }
    } catch { /* assignee lookup failed */ }
  }

  // Get organization name
  let orgName = null;
  if (ticket.organization_id) {
    try {
      const org = await zdRequest(`/organizations/${ticket.organization_id}.json`);
      if (org && org.organization) orgName = org.organization.name;
    } catch { /* org lookup failed */ }
  }

  // Extract SID from custom fields
  let sid = null;
  if (ticket.custom_fields) {
    const sidField = ticket.custom_fields.find(f => f.id === ZD_SID_FIELD);
    if (sidField && sidField.value) sid = String(sidField.value);
  }

  // Get last public comment
  let lastComment = '';
  try {
    const comments = await zdRequest(`/tickets/${ticketId}/comments.json?sort_order=desc&per_page=5`);
    if (comments && comments.comments) {
      const publicComment = comments.comments.find(c => c.public) || comments.comments[0];
      if (publicComment) lastComment = publicComment.body || publicComment.plain_body || '';
    }
  } catch { /* no comments */ }

  return {
    id: ticket.id,
    subject: ticket.subject,
    requesterName,
    assigneeName,
    assigneeEmail,
    orgName,
    sid,
    lastComment: lastComment.substring(0, 5000), // Trim for SF field limits
    url: `https://bayiq.zendesk.com/agent/tickets/${ticket.id}`,
  };
}

// ---- Look up SF Account by SID, falling back to org name ----
async function findSfAccount(sid, orgName) {
  // Primary: look up by SID (unique, avoids duplicate name issues)
  if (sid) {
    const query = `SELECT Id, Name, Customer_Success_Advisor__c FROM Account WHERE SID__c = '${sid}' LIMIT 1`;
    const result = await sfRequest(`/query?q=${encodeURIComponent(query)}`);
    if (result && result.records && result.records.length > 0) {
      return result.records[0];
    }
  }

  // Fallback: look up by org name
  if (!orgName) {
    throw new Error(sid
      ? `No Salesforce Account found with SID ${sid}`
      : 'No SID or organization on this ticket — cannot look up SF Account');
  }

  const escaped = orgName.replace(/'/g, "\\'");
  const query = `SELECT Id, Name, Customer_Success_Advisor__c FROM Account WHERE Name = '${escaped}' LIMIT 1`;
  const result = await sfRequest(`/query?q=${encodeURIComponent(query)}`);

  if (result && result.records && result.records.length > 0) {
    return result.records[0];
  }

  throw new Error(`No Salesforce Account found matching SID "${sid || 'n/a'}" or name "${orgName}"`);
}

// ---- Get advisor user info ----
async function getAdvisorUser(advisorId) {
  if (!advisorId) return null;
  try {
    const user = await sfRequest(`/sobjects/User/${advisorId}`);
    return user;
  } catch {
    return null;
  }
}

// ---- Find SF User by email (to map ZD agent → SF user) ----
async function findSfUserByEmail(email) {
  if (!email) return null;
  try {
    const escaped = email.replace(/'/g, "\\'");
    const query = `SELECT Id, Name, Email FROM User WHERE Email = '${escaped}' AND IsActive = true LIMIT 1`;
    const result = await sfRequest(`/query?q=${encodeURIComponent(query)}`);
    if (result && result.records && result.records.length > 0) {
      return result.records[0];
    }
  } catch { /* SF user lookup failed */ }
  return null;
}

// ---- Create SF Task ----
async function createSfTask({ account, advisorId, requesterName, ticketUrl, lastComment, createdById, assigneeName }) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const taskData = {
    Subject: `Call In: ${requesterName}`,
    WhatId: account.Id,                  // Related To: the Account
    OwnerId: advisorId,                  // Assigned To: Customer Success Advisor
    Type: 'Check In',                    // Activity Type
    Priority: 'High',
    ActivityDate: today,                 // Due Date
    Status: 'Not Started',
    Description: `Zendesk Ticket: ${ticketUrl}\n${assigneeName ? `Created by: ${assigneeName}\n` : ''}\n--- Last Message ---\n${lastComment}`,
  };

  // If we found the ZD agent as an SF User, set CreatedById
  // (requires "Set Audit Fields upon Record Creation" permission in SF)
  if (createdById) {
    taskData.CreatedById = createdById;
  }

  let result;
  try {
    result = await sfRequest('/sobjects/Task', {
      method: 'POST',
      body: taskData,
    });
  } catch (err) {
    // If CreatedById failed (permission not enabled), retry without it
    if (createdById && err.message && err.message.includes('CreatedById')) {
      delete taskData.CreatedById;
      result = await sfRequest('/sobjects/Task', {
        method: 'POST',
        body: taskData,
      });
    } else {
      throw err;
    }
  }

  if (!result || !result.id) {
    throw new Error('Salesforce returned unexpected response when creating Task');
  }

  return result;
}

// ---- Write SF link back to ZD ticket ----
async function writeBackToZd(ticketId, sfTaskId, sfInstanceUrl) {
  const sfTaskUrl = `${sfInstanceUrl}/lightning/r/Task/${sfTaskId}/view`;

  // Add internal note with SF task link
  await zdRequest(`/tickets/${ticketId}.json`, {
    method: 'PUT',
    body: {
      ticket: {
        comment: {
          body: `Salesforce Task created: ${sfTaskUrl}`,
          public: false, // Internal note
        },
      },
    },
  });

  return sfTaskUrl;
}

// ---- Handler ----
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    if (!isSalesforceConfigured()) {
      return res.status(503).json({
        error: 'Salesforce credentials not configured. Set SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD in environment.',
      });
    }

    // Support both direct POST (from dashboard) and ZD webhook format
    let ticketId;
    if (req.body && req.body.ticketId) {
      // Direct call from dashboard or API
      ticketId = req.body.ticketId;
    } else if (req.body && req.body.ticket && req.body.ticket.id) {
      // Zendesk webhook/trigger format (HTTP target with ticket JSON)
      ticketId = req.body.ticket.id;
    } else {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    // 1. Get ticket data from ZD
    const ticket = await getTicketData(ticketId);

    // 2. Look up SF Account by SID (preferred) or org name (fallback)
    const account = await findSfAccount(ticket.sid, ticket.orgName);

    // 3. Get Customer Success Advisor
    const advisorId = account.Customer_Success_Advisor__c;
    if (!advisorId) {
      return res.status(400).json({
        error: `Account "${account.Name}" has no Customer Success Advisor assigned in Salesforce`,
        accountId: account.Id,
        accountName: account.Name,
      });
    }

    const advisor = await getAdvisorUser(advisorId);

    // 4. Map ZD agent → SF User (for CreatedById)
    const sfAgent = await findSfUserByEmail(ticket.assigneeEmail);

    // 5. Create SF Task
    const sfTask = await createSfTask({
      account,
      advisorId,
      requesterName: ticket.requesterName,
      ticketUrl: ticket.url,
      lastComment: ticket.lastComment,
      createdById: sfAgent ? sfAgent.Id : null,
      assigneeName: ticket.assigneeName,
    });

    // 6. Get instance URL for link building
    const instanceUrl = await getInstanceUrl();

    // 7. Write back to ZD
    let sfTaskUrl;
    try {
      sfTaskUrl = await writeBackToZd(ticketId, sfTask.id, instanceUrl);
    } catch (e) {
      // Non-critical: task was created, just couldn't write back
      sfTaskUrl = `${instanceUrl}/lightning/r/Task/${sfTask.id}/view`;
    }

    return res.json({
      success: true,
      sfTaskId: sfTask.id,
      sfTaskUrl,
      accountName: account.Name,
      advisorName: advisor ? advisor.Name : 'Unknown',
      ticketId: ticket.id,
      requesterName: ticket.requesterName,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
