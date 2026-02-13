// Shared Confluence client for API routes
// Uses Atlassian Cloud REST API v1 (same credentials as Jira — same instance)
const { withCircuitBreaker } = require('./_circuit-breaker');

function getConfluenceAuth() {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
    return null;
  }
  return {
    baseUrl: 'https://autovitals.atlassian.net',
    auth: Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64'),
  };
}

async function _confluenceRequestRaw(endpoint, options = {}, _retryCount = 0) {
  const MAX_RETRIES = 3;
  const creds = getConfluenceAuth();
  if (!creds) throw new Error('Confluence credentials not configured');

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${creds.baseUrl}/wiki/rest/api${endpoint}`;

  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Basic ${creds.auth}`,
      'Content-Type': 'application/json',
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (resp.status === 429) {
    if (_retryCount >= MAX_RETRIES) {
      throw new Error(`Confluence rate limited after ${MAX_RETRIES} retries on ${endpoint}`);
    }
    const retry = Math.min(parseInt(resp.headers.get('retry-after') || '5', 10), 20);
    const backoff = retry * Math.pow(1.5, _retryCount);
    await new Promise(r => setTimeout(r, backoff * 1000));
    return _confluenceRequestRaw(endpoint, options, _retryCount + 1);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Confluence ${resp.status}: ${body.substring(0, 200)}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

const confluenceRequest = withCircuitBreaker('confluence', _confluenceRequestRaw);

function isConfluenceConfigured() {
  return !!(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

module.exports = { confluenceRequest, isConfluenceConfigured };
