// feedback.js — POST /api/feedback
// Persists triage approve/dismiss as Zendesk tags + KV shared learning.

const { zdRequest } = require('../_zendesk');
const { isKVConfigured, kvGetJSON, kvSetJSON } = require('../_kv');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { ticketId, action, errorPattern, problemId } = req.body;

    if (!ticketId || !action) {
      return res.status(400).json({ error: 'ticketId and action required' });
    }
    if (!['dismiss', 'approve'].includes(action)) {
      return res.status(400).json({ error: 'action must be dismiss or approve' });
    }

    // 1. Tag in Zendesk
    const ticketData = await zdRequest(`/tickets/${ticketId}.json`);
    const existingTags = (ticketData && ticketData.ticket && ticketData.ticket.tags) || [];
    const newTag = action === 'dismiss' ? 'triage_dismissed' : 'triage_approved';

    if (!existingTags.includes(newTag)) {
      await zdRequest(`/tickets/${ticketId}.json`, {
        method: 'PUT',
        body: { ticket: { tags: [...existingTags, newTag] } },
      });
    }

    // 2. Store in KV for shared team learning
    if (isKVConfigured() && errorPattern && errorPattern !== 'other' && problemId) {
      const kvKey = `feedback:${errorPattern}::${problemId}`;
      const entry = await kvGetJSON(kvKey) || { approved: 0, dismissed: 0, last: '' };

      if (action === 'approve') entry.approved++;
      else entry.dismissed++;
      entry.last = new Date().toISOString();

      await kvSetJSON(kvKey, entry, 30 * 24 * 3600); // 30 day TTL
    }

    res.json({ ok: true, ticketId, action, tag: newTag });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
