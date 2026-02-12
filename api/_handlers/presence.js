const { isKVConfigured, kvSet, kvKeys, kvGetJSON } = require('../_kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isKVConfigured()) {
    return res.json({ agents: [], message: 'KV not configured — presence disabled' });
  }

  try {
    if (req.method === 'POST') {
      // Heartbeat
      const agent = req.headers['x-agent'] || req.body.agent;
      if (!agent) return res.status(400).json({ error: 'agent name required' });

      const data = {
        agent,
        page: req.body.page || 'unknown',
        claimedTickets: req.body.claimedTickets || [],
        lastSeen: new Date().toISOString(),
      };

      await kvSet(`presence:${agent}`, JSON.stringify(data), 120); // 2 min TTL
      return res.json({ success: true });
    }

    // GET — return all active agents
    const keys = await kvKeys('presence:*');
    const agents = [];

    for (const key of keys) {
      const data = await kvGetJSON(key);
      if (data) agents.push(data);
    }

    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
