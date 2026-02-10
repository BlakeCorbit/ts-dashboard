const { zdRequest } = require('../_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { ticketId, body } = req.body;

    if (!ticketId || !body) {
      return res.status(400).json({ error: 'ticketId and body required' });
    }

    await zdRequest('/tickets/' + ticketId + '.json', {
      method: 'PUT',
      body: {
        ticket: {
          comment: { body: body, public: false },
        },
      },
    });

    res.json({ success: true, ticketId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
