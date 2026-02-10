const { zdRequest } = require('../_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { ticketId, category, subcategory, runbook, suggestedAction, priority } = req.body;

    if (!ticketId) return res.status(400).json({ error: 'ticketId required' });

    const lines = [
      `--- Auto-Triage Result ---`,
      `Category: ${category || 'Unknown'}`,
      subcategory ? `Subcategory: ${subcategory}` : null,
      priority ? `Suggested Priority: ${priority}` : null,
      suggestedAction ? `Suggested Action: ${suggestedAction}` : null,
      runbook ? `Runbook: ${runbook}` : null,
      ``,
      `-- TS Dashboard (Auto-Triage)`,
    ].filter(Boolean).join('\n');

    await zdRequest(`/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: {
          comment: { body: lines, public: false },
        },
      },
    });

    res.json({ success: true, ticketId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
