// propagate-jira.js — POST /api/propagate-jira
// Links Jira issues from a Problem ticket onto an incident ticket
// via the Zendesk-Jira integration (creates actual sidebar links,
// not just comments).

const { zdRequest, getJiraLinks, getAuth } = require('./_zendesk');

async function createJiraLink(ticketId, issueId, issueKey) {
  const { baseUrl, auth } = getAuth();
  const url = `${baseUrl}/api/services/jira/links`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticket_id: String(ticketId), issue_id: String(issueId), issue_key: issueKey }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jira link ${resp.status}: ${body.substring(0, 200)}`);
  }
  return resp.status === 204 ? null : resp.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { ticketId, problemId } = req.body;
    if (!ticketId || !problemId) {
      return res.status(400).json({ error: 'ticketId and problemId required' });
    }

    // Fetch Jira links from the Problem ticket
    const jiraLinks = await getJiraLinks(problemId);

    if (jiraLinks.length === 0) {
      return res.json({ success: true, ticketId, problemId, jiraLinks: [], message: 'No Jira links on Problem ticket' });
    }

    // Create actual Jira links on the incident ticket via the integration API
    const results = await Promise.all(
      jiraLinks.map(j => createJiraLink(ticketId, j.issueId, j.issueKey).catch(err => ({ error: err.message, issueKey: j.issueKey })))
    );

    const linked = results.filter(r => !r || !r.error);
    const failed = results.filter(r => r && r.error);

    res.json({
      success: true,
      ticketId,
      problemId,
      jiraLinks,
      linkedCount: linked.length,
      failedCount: failed.length,
      failures: failed.length > 0 ? failed : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
