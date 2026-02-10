// feedback.js — POST /api/feedback
// Persists triage approve/dismiss as Zendesk tags on the ticket.

const { zdRequest } = require('../_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { ticketId, action } = req.body;

    if (!ticketId || !action) {
      return res.status(400).json({ error: 'ticketId and action required' });
    }
    if (!['dismiss', 'approve'].includes(action)) {
      return res.status(400).json({ error: 'action must be dismiss or approve' });
    }

    // Fetch existing tags to preserve them
    const ticketData = await zdRequest(`/tickets/${ticketId}.json`);
    const existingTags = (ticketData && ticketData.ticket && ticketData.ticket.tags) || [];

    const newTag = action === 'dismiss' ? 'triage_dismissed' : 'triage_approved';

    if (!existingTags.includes(newTag)) {
      await zdRequest(`/tickets/${ticketId}.json`, {
        method: 'PUT',
        body: {
          ticket: {
            tags: [...existingTags, newTag],
          },
        },
      });
    }

    res.json({ ok: true, ticketId, action, tag: newTag });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
