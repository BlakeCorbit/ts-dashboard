const { zdRequest, getJiraLinks, getAuth } = require('../_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required (each: { ticketId, problemId, replyBody? })' });
    }

    if (items.length > 50) {
      return res.status(400).json({ error: 'Max 50 items per batch' });
    }

    const results = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (item) => {
          const { ticketId, problemId, replyBody } = item;
          if (!ticketId || !problemId) {
            return { ticketId, success: false, error: 'ticketId and problemId required' };
          }

          // Link ticket as incident of problem
          await zdRequest(`/tickets/${ticketId}.json`, {
            method: 'PUT',
            body: { ticket: { type: 'incident', problem_id: problemId } },
          });

          // Propagate Jira links from problem to incident
          const jiraLinks = await getJiraLinks(problemId);
          if (jiraLinks.length > 0) {
            const { baseUrl, auth } = getAuth();
            await Promise.allSettled(
              jiraLinks.map((j) =>
                fetch(`${baseUrl}/api/services/jira/links`, {
                  method: 'POST',
                  headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ticket_id: String(ticketId), issue_id: String(j.issueId), issue_key: j.issueKey }),
                }).catch(() => {})
              )
            );
          }

          // Post internal note if provided
          if (replyBody && replyBody.trim()) {
            await zdRequest(`/tickets/${ticketId}.json`, {
              method: 'PUT',
              body: { ticket: { comment: { body: replyBody.trim(), public: false } } },
            });
          }

          return { ticketId, problemId, success: true, jiraLinks };
        })
      );

      batchResults.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          results.push({
            ticketId: batch[idx].ticketId,
            success: false,
            error: r.reason ? r.reason.message : 'Unknown error',
          });
        }
      });
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    res.json({ success: true, results, succeeded, failed, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
