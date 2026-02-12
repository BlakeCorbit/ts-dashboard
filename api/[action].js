/**
 * Catch-all dynamic route for Vercel serverless functions.
 *
 * Vercel populates req.query.action from the [action] path segment,
 * so /api/incidents -> action="incidents", /api/agents -> action="agents", etc.
 *
 * All actual handlers live in _handlers/ (underscore-prefixed = not counted
 * as separate serverless functions by Vercel).
 */

const { isKVConfigured, kvGet, kvSet } = require('./_kv');

const HANDLERS = {
  agents:           () => require('./_handlers/agents'),
  approve:          () => require('./_handlers/approve'),
  comment:          () => require('./_handlers/comment'),
  'create-problem': () => require('./_handlers/create-problem'),
  detect:           () => require('./_handlers/detect'),
  feedback:         () => require('./_handlers/feedback'),
  incidents:        () => require('./_handlers/incidents'),
  link:             () => require('./_handlers/link'),
  metrics:          () => require('./_handlers/metrics'),
  'propagate-jira': () => require('./_handlers/propagate-jira'),
  'ticket-detail':  () => require('./_handlers/ticket-detail'),
  tickets:          () => require('./_handlers/tickets'),
  'triage-queue':         () => require('./_handlers/triage-queue'),
  'article-suggestions':  () => require('./_handlers/article-suggestions'),
  'create-article':       () => require('./_handlers/create-article'),
  'sf-task':              () => require('./_handlers/sf-task'),
  'pt-suggestions':       () => require('./_handlers/pt-suggestions'),
  'bulk-update':          () => require('./_handlers/bulk-update'),
  'batch-link':           () => require('./_handlers/batch-link'),
  presence:               () => require('./_handlers/presence'),
  activity:               () => require('./_handlers/activity'),
};

// Write actions that benefit from idempotency protection
const IDEMPOTENT_ACTIONS = new Set([
  'link', 'batch-link', 'create-problem', 'bulk-update',
  'comment', 'create-article', 'sf-task', 'propagate-jira',
]);

module.exports = async (req, res) => {
  // Centralized CORS — handlers no longer need to set these
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent, X-Idempotency-Key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  const loader = HANDLERS[action];
  if (!loader) {
    return res.status(404).json({ error: `Unknown action: ${action}` });
  }

  // Idempotency check: if POST with X-Idempotency-Key, check KV for cached response
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey && req.method === 'POST' && IDEMPOTENT_ACTIONS.has(action) && isKVConfigured()) {
    try {
      const cached = await kvGet(`idem:${idempotencyKey}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        return res.json(parsed);
      }
    } catch {}
  }

  const handler = loader();

  // Support both default export and module.exports patterns
  const fn = typeof handler === 'function' ? handler : handler.default;
  if (typeof fn !== 'function') {
    return res.status(500).json({ error: `Handler for "${action}" is not a function` });
  }

  // Wrap response to cache for idempotency
  if (idempotencyKey && req.method === 'POST' && IDEMPOTENT_ACTIONS.has(action) && isKVConfigured()) {
    const originalJson = res.json.bind(res);
    res.json = function (data) {
      // Cache successful responses for 5 minutes
      if (!res.statusCode || res.statusCode < 400) {
        kvSet(`idem:${idempotencyKey}`, JSON.stringify(data), 300).catch(() => {});
      }
      return originalJson(data);
    };
  }

  return fn(req, res);
};
