// create-problem.js — POST /api/create-problem
// Creates a Problem ticket in Zendesk, links all provided tickets as incidents,
// propagates Jira context, returns reply template.

const { zdRequest, getJiraLinks, getAuth } = require('../_zendesk');
const { isKVConfigured, kvListPush } = require('../_kv');

const { buildReply } = require('../_templates');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { subject, description, tags, ticketIds, errorPattern, pos, jiraIssueId, jiraIssueKey } = req.body;

    if (!subject) return res.status(400).json({ error: 'subject is required' });

    // 1. Create Problem ticket
    const createData = await zdRequest('/tickets.json', {
      method: 'POST',
      body: {
        ticket: {
          subject: subject,
          comment: { body: description || subject, public: false },
          type: 'problem',
          priority: 'high',
          tags: tags || [],
        },
      },
    });

    const problemId = createData.ticket.id;

    // 2. Propagate Jira link to the new Problem Ticket (if provided)
    if (jiraIssueId && jiraIssueKey) {
      try {
        const { baseUrl, auth } = getAuth();
        await fetch(`${baseUrl}/api/services/jira/links`, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket_id: String(problemId), issue_id: String(jiraIssueId), issue_key: jiraIssueKey }),
        });
      } catch { /* Jira link is non-critical */ }
    }

    // 3. Link all provided tickets as incidents
    let linkedCount = 0;
    const ids = ticketIds || [];

    // Fetch Jira links for the new Problem
    const jiraLinks = await getJiraLinks(problemId);
    const jiraInfo = jiraLinks.length > 0
      ? jiraLinks.map(j => j.issueKey + ': ' + j.url).join('\n')
      : '(pending Jira link)';

    // Link tickets in batches of 5
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      await Promise.all(batch.map(async (ticketId) => {
        try {
          // Set as incident of the new Problem
          await zdRequest('/tickets/' + ticketId + '.json', {
            method: 'PUT',
            body: {
              ticket: {
                type: 'incident',
                problem_id: problemId,
                comment: {
                  body: [
                    'Linked to Problem ZD#' + problemId + ': ' + subject,
                    '',
                    'Jira: ' + jiraInfo,
                    '',
                    '-- TS Dashboard (Auto-Created Problem)',
                  ].join('\n'),
                  public: false,
                },
              },
            },
          });
          linkedCount++;
        } catch (e) {
          console.error('Failed to link ticket ' + ticketId + ':', e.message);
        }
      }));
    }

    // 4. Generate reply template
    const template = buildReply(errorPattern, problemId, pos);

    // 4b. Auto-send reply to all linked tickets if requested
    const { sendReply } = req.body;
    if (sendReply && ids.length > 0) {
      const replyBatches = [];
      for (let i = 0; i < ids.length; i += 5) {
        replyBatches.push(ids.slice(i, i + 5));
      }
      for (const batch of replyBatches) {
        await Promise.allSettled(batch.map(ticketId =>
          zdRequest('/tickets/' + ticketId + '.json', {
            method: 'PUT',
            body: { ticket: { comment: { body: template, public: false } } },
          }).catch(() => {})
        ));
      }
    }

    // Audit trail
    if (isKVConfigured()) {
      kvListPush('audit:log', {
        action: 'problem-created',
        agent: req.headers['x-agent'] || 'unknown',
        problemId,
        linkedCount,
        subject,
        at: new Date().toISOString(),
      }, 500).catch(() => {});
    }

    res.json({
      success: true,
      problemId,
      linkedCount,
      jiraLinks,
      replyTemplate: template,
      zdUrl: 'https://bayiq.zendesk.com/agent/tickets/' + problemId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
