const { zdRequest, getJiraLinks } = require('./_zendesk');

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

    // Fetch Problem ticket info + Jira links for the internal note
    const [problem, jiraLinks] = await Promise.all([
      zdRequest(`/tickets/${problemId}.json`).then(d => d.ticket),
      getJiraLinks(problemId),
    ]);

    const jiraInfo = jiraLinks.length > 0
      ? jiraLinks.map(j => `${j.issueKey}: ${j.url}`).join('\n')
      : '(no Jira linked)';

    const note = [
      `Linked to Problem ZD#${problemId}: ${problem.subject}`,
      ``,
      `Jira: ${jiraInfo}`,
      ``,
      `-- TS Dashboard (Auto Tag-and-Bag)`,
    ].join('\n');

    await zdRequest(`/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: {
          comment: { body: note, public: false },
        },
      },
    });

    res.json({ success: true, ticketId, problemId, jiraLinks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
