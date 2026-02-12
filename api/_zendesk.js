// Shared Zendesk client for all API routes
const { isKVConfigured, kvGet, kvSet } = require('./_kv');
const { withCircuitBreaker } = require('./_circuit-breaker');

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

async function _zdRequestRaw(endpoint, options = {}, _retryCount = 0) {
  const MAX_RETRIES = 3;
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
    if (_retryCount >= MAX_RETRIES) {
      throw new Error(`Zendesk rate limited after ${MAX_RETRIES} retries on ${endpoint}`);
    }
    const retryAfter = Math.min(parseInt(response.headers.get('retry-after') || '5', 10), 20);
    const backoff = retryAfter * Math.pow(1.5, _retryCount);
    await new Promise(r => setTimeout(r, backoff * 1000));
    return _zdRequestRaw(endpoint, options, _retryCount + 1);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zendesk ${response.status}: ${body.substring(0, 200)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

// Circuit breaker wrapped version
const zdRequest = withCircuitBreaker('zendesk', _zdRequestRaw);

// Cached wrapper for GET requests
async function cachedZdRequest(endpoint, options = {}, cacheTtl = 300) {
  // Only cache GET requests
  if (options.method && options.method !== 'GET') {
    return zdRequest(endpoint, options);
  }

  if (isKVConfigured()) {
    const cacheKey = `zd_cache:${endpoint}`;
    try {
      const cached = await kvGet(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {}

    const result = await zdRequest(endpoint, options);
    if (result) {
      kvSet(cacheKey, JSON.stringify(result), cacheTtl).catch(() => {});
    }
    return result;
  }

  return zdRequest(endpoint, options);
}

async function getJiraLinks(ticketId) {
  // Check KV cache first (5 min TTL)
  if (isKVConfigured()) {
    const cacheKey = `jira_links:${ticketId}`;
    try {
      const cached = await kvGet(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {}
  }

  const { baseUrl, auth } = getAuth();
  try {
    const url = new URL(`${baseUrl}/api/services/jira/links`);
    url.searchParams.set('ticket_id', String(ticketId));
    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const links = (data.links || []).map(l => ({
      issueId: l.issue_id,
      issueKey: l.issue_key,
      url: `https://autovitals.atlassian.net/browse/${l.issue_key}`,
    }));

    // Cache result
    if (isKVConfigured() && links.length > 0) {
      kvSet(`jira_links:${ticketId}`, JSON.stringify(links), 300).catch(() => {});
    }

    return links;
  } catch { return []; }
}

module.exports = { zdRequest, cachedZdRequest, getJiraLinks, getAuth };
