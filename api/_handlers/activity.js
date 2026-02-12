const { isKVConfigured, kvListPush, kvLrange } = require('../_kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isKVConfigured()) {
    return res.json({ feed: [], message: 'KV not configured — activity feed disabled' });
  }

  try {
    if (req.method === 'POST') {
      const agent = req.headers['x-agent'] || req.body.agent || 'unknown';
      const { action, ticketId, problemId, detail } = req.body;

      if (!action) return res.status(400).json({ error: 'action required' });

      const entry = {
        action,
        agent,
        ticketId: ticketId || null,
        problemId: problemId || null,
        detail: detail || null,
        at: new Date().toISOString(),
      };

      await kvListPush('activity:feed', entry, 500); // cap at 500 entries
      return res.json({ success: true });
    }

    // GET
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const raw = await kvLrange('activity:feed', 0, limit - 1);
    const feed = (raw || []).map((item) => {
      try { return typeof item === 'string' ? JSON.parse(item) : item; }
      catch { return item; }
    });

    res.json({ feed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
