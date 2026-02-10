// auth.js — POST /api/auth
// Verifies the team passcode. Returns 200 if valid, 401 if not.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const expected = process.env.DASHBOARD_PASSCODE;
  if (!expected) {
    return res.status(500).json({ error: 'DASHBOARD_PASSCODE not configured' });
  }

  let body = '';
  if (typeof req.body === 'object' && req.body !== null) {
    // Vercel already parsed the body
    body = req.body;
  } else {
    // Parse manually
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  }

  const { passcode } = body;

  if (passcode && passcode === expected) {
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ error: 'Invalid passcode' });
};
