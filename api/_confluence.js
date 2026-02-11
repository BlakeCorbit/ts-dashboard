// Shared Confluence client for API routes
// Uses Atlassian Cloud REST API v1 (same credentials as Jira — same instance)

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

async function confluenceRequest(endpoint, options = {}) {
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
    const retry = parseInt(resp.headers.get('retry-after') || '5', 10);
    await new Promise(r => setTimeout(r, retry * 1000));
    return confluenceRequest(endpoint, options);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Confluence ${resp.status}: ${body.substring(0, 200)}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

function isConfluenceConfigured() {
  return !!(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

module.exports = { confluenceRequest, isConfluenceConfigured };
