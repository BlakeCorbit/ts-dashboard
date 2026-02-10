// Shared Zendesk client for all API routes
function getAuth() {
  const { ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN } = process.env;
  if (!ZENDESK_SUBDOMAIN || !ZENDESK_EMAIL || !ZENDESK_API_TOKEN) {
    throw new Error('Missing Zendesk credentials in environment');
  }
  return {
    baseUrl: `https://${ZENDESK_SUBDOMAIN}.zendesk.com`,
    auth: Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64'),
  };
}

async function zdRequest(endpoint, options = {}) {
  const { baseUrl, auth } = getAuth();
  const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}/api/v2${endpoint}`;
  const urlObj = new URL(url);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      urlObj.searchParams.set(key, value);
    }
  }

  const fetchOpts = {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  };

  if (options.body) fetchOpts.body = JSON.stringify(options.body);

  const response = await fetch(urlObj.toString(), fetchOpts);

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '10', 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return zdRequest(endpoint, options);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zendesk ${response.status}: ${body.substring(0, 200)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getJiraLinks(ticketId) {
  const { baseUrl, auth } = getAuth();
  try {
    const url = new URL(`${baseUrl}/api/services/jira/links`);
    url.searchParams.set('ticket_id', String(ticketId));
    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.links || []).map(l => ({
      issueKey: l.issue_key,
      url: `https://autovitals.atlassian.net/browse/${l.issue_key}`,
    }));
  } catch { return []; }
}

module.exports = { zdRequest, getJiraLinks, getAuth };
