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
};

module.exports = (req, res) => {
  const { action } = req.query;

  const loader = HANDLERS[action];
  if (!loader) {
    return res.status(404).json({ error: `Unknown action: ${action}` });
  }

  const handler = loader();

  // Support both default export and module.exports patterns
  const fn = typeof handler === 'function' ? handler : handler.default;
  if (typeof fn !== 'function') {
    return res.status(500).json({ error: `Handler for "${action}" is not a function` });
  }

  return fn(req, res);
};
