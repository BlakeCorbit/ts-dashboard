// bulk-update.js — POST /api/bulk-update
// Sends an internal note to multiple tickets at once (bulk update for Problem Tickets).
// Also posts the update to the Problem Ticket itself as a record.

const { zdRequest } = require('../_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { problemId, ticketIds, message } = req.body || {};

    if (!problemId || !ticketIds || !ticketIds.length || !message) {
      return res.status(400).json({ error: 'problemId, ticketIds[], and message are required' });
    }

    const noteBody = [
      '--- Problem Update (ZD#' + problemId + ') ---',
      '',
      message,
      '',
      '-- TS Dashboard (Bulk Update)',
    ].join('\n');

    let updatedCount = 0;
    let failedCount = 0;

    // Post to all linked tickets in batches of 5
    for (let i = 0; i < ticketIds.length; i += 5) {
      const batch = ticketIds.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(ticketId =>
          zdRequest('/tickets/' + ticketId + '.json', {
            method: 'PUT',
            body: {
              ticket: {
                comment: { body: noteBody, public: false },
              },
            },
          })
        )
      );
      results.forEach(r => {
        if (r.status === 'fulfilled') updatedCount++;
        else failedCount++;
      });
    }

    // Also post to the Problem Ticket itself as a record
    try {
      await zdRequest('/tickets/' + problemId + '.json', {
        method: 'PUT',
        body: {
          ticket: {
            comment: {
              body: '--- Bulk Update Sent ---\n\nSent to ' + updatedCount + ' linked tickets:\n' +
                ticketIds.map(id => '#' + id).join(', ') + '\n\nMessage:\n' + message + '\n\n-- TS Dashboard',
              public: false,
            },
          },
        },
      });
    } catch { /* non-critical */ }

    const updatedAt = new Date().toISOString();

    res.json({
      success: true,
      problemId,
      updatedCount,
      failedCount,
      updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
