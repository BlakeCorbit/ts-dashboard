/**
 * Catch-all dynamic route for Vercel serverless functions.
 *
 * Vercel populates req.query.action from the [action] path segment,
 * so /api/incidents -> action="incidents", /api/agents -> action="agents", etc.
 *
 * All actual handlers live in _handlers/ (underscore-prefixed = not counted
 * as separate serverless functions by Vercel).
 */

const HANDLERS = {
  agents:           () => require('./_handlers/agents'),
  approve:          () => require('./_handlers/approve'),
  auth:             () => require('./_handlers/auth'),
  comment:          () => require('./_handlers/comment'),
  'create-problem': () => require('./_handlers/create-problem'),
  detect:           () => require('./_handlers/detect'),
  incidents:        () => require('./_handlers/incidents'),
  link:             () => require('./_handlers/link'),
  metrics:          () => require('./_handlers/metrics'),
  'propagate-jira': () => require('./_handlers/propagate-jira'),
  'ticket-detail':  () => require('./_handlers/ticket-detail'),
  tickets:          () => require('./_handlers/tickets'),
};

// Routes that skip passcode auth (the auth endpoint itself)
const NO_AUTH = ['auth'];

// Routes that accept API key as alternative auth (webhooks)
const API_KEY_ROUTES = ['propagate-jira'];

function authenticate(req, action) {
  // Skip auth for the auth endpoint
  if (NO_AUTH.includes(action)) return true;

  // Check Bearer passcode
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    const passcode = process.env.DASHBOARD_PASSCODE;
    if (passcode && match[1] === passcode) return true;
  }

  // Check API key for webhook routes
  if (API_KEY_ROUTES.includes(action)) {
    const apiKey = req.headers['x-api-key'];
    const expected = process.env.DASHBOARD_API_KEY;
    if (expected && apiKey === expected) return true;
  }

  return false;
}

module.exports = (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  const loader = HANDLERS[action];
  if (!loader) {
    return res.status(404).json({ error: `Unknown action: ${action}` });
  }

  // Auth check
  if (!authenticate(req, action)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const handler = loader();

  // Support both default export and module.exports patterns
  const fn = typeof handler === 'function' ? handler : handler.default;
  if (typeof fn !== 'function') {
    return res.status(500).json({ error: `Handler for "${action}" is not a function` });
  }

  return fn(req, res);
};
