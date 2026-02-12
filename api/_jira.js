// Shared Jira client for API routes
// Uses Atlassian Cloud REST API v3 (v2 search deprecated as of 2025)

function getJiraAuth() {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
    return null; // Jira integration is optional
  }
  return {
    baseUrl: 'https://autovitals.atlassian.net',
    auth: Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64'),
  };
}

async function jiraRequest(endpoint, options = {}, _retryCount = 0) {
  const MAX_RETRIES = 3;
  const creds = getJiraAuth();
  if (!creds) throw new Error('Jira credentials not configured');

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${creds.baseUrl}/rest/api/3${endpoint}`;

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
      throw new Error(`Jira rate limited after ${MAX_RETRIES} retries on ${endpoint}`);
    }
    const retry = Math.min(parseInt(resp.headers.get('retry-after') || '5', 10), 20);
    const backoff = retry * Math.pow(1.5, _retryCount);
    await new Promise(r => setTimeout(r, backoff * 1000));
    return jiraRequest(endpoint, options, _retryCount + 1);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jira ${resp.status}: ${body.substring(0, 200)}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

function isJiraConfigured() {
  return !!(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

module.exports = { jiraRequest, isJiraConfigured };
