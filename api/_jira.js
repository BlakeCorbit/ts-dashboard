// Shared Jira client for API routes
// Uses Atlassian Cloud REST API v2

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

async function jiraRequest(endpoint, options = {}) {
  const creds = getJiraAuth();
  if (!creds) throw new Error('Jira credentials not configured');

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${creds.baseUrl}/rest/api/2${endpoint}`;

  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Basic ${creds.auth}`,
      'Content-Type': 'application/json',
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (resp.status === 429) {
    const retry = parseInt(resp.headers.get('retry-after') || '5', 10);
    await new Promise(r => setTimeout(r, retry * 1000));
    return jiraRequest(endpoint, options);
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
