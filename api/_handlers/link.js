const { zdRequest, getJiraLinks } = require('../_zendesk');

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

    // Link ticket as incident of Problem
    await zdRequest(`/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: {
          type: 'incident',
          problem_id: problemId,
        },
      },
    });

    // Fetch Jira links from the Problem ticket
    const jiraLinks = await getJiraLinks(problemId);

    // Create actual Jira links on the incident via the integration API
    if (jiraLinks.length > 0) {
      const { getAuth } = require('../_zendesk');
      const { baseUrl, auth } = getAuth();
      await Promise.all(
        jiraLinks.map(j =>
          fetch(`${baseUrl}/api/services/jira/links`, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket_id: String(ticketId), issue_id: String(j.issueId), issue_key: j.issueKey }),
          }).catch(() => {})
        )
      );
    }

    res.json({ success: true, ticketId, problemId, jiraLinks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
