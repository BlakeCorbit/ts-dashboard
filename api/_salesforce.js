// Shared Salesforce REST client for API routes
// Uses OAuth 2.0 username-password flow
// Env vars: SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD, SF_SECURITY_TOKEN

let cachedToken = null;
let tokenExpiry = 0;

function isSalesforceConfigured() {
  const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD } = process.env;
  return !!(SF_CLIENT_ID && SF_CLIENT_SECRET && SF_USERNAME && SF_PASSWORD);
}

async function getAccessToken() {
  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && Date.now() < tokenExpiry - 300000) {
    return cachedToken;
  }

  const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD, SF_SECURITY_TOKEN, SF_LOGIN_URL } = process.env;
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce credentials not configured (SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD)');
  }

  const loginUrl = SF_LOGIN_URL || 'https://login.salesforce.com';
  const password = SF_SECURITY_TOKEN ? SF_PASSWORD + SF_SECURITY_TOKEN : SF_PASSWORD;

  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
    username: SF_USERNAME,
    password: password,
  });

  const resp = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Salesforce auth failed (${resp.status}): ${body.substring(0, 300)}`);
  }

  const data = await resp.json();
  cachedToken = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
  };
  // SF tokens last ~2 hours; cache for 1 hour
  tokenExpiry = Date.now() + 3600000;

  return cachedToken;
}

async function sfRequest(endpoint, options = {}) {
  const token = await getAccessToken();

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${token.instanceUrl}/services/data/v59.0${endpoint}`;

  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (resp.status === 401) {
    // Token expired, clear cache and retry once
    cachedToken = null;
    tokenExpiry = 0;
    const newToken = await getAccessToken();
    const retryResp = await fetch(url.replace(token.instanceUrl, newToken.instanceUrl), {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${newToken.accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!retryResp.ok) {
      const body = await retryResp.text();
      throw new Error(`Salesforce ${retryResp.status}: ${body.substring(0, 300)}`);
    }
    if (retryResp.status === 204) return null;
    return retryResp.json();
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Salesforce ${resp.status}: ${body.substring(0, 300)}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

async function getInstanceUrl() {
  const token = await getAccessToken();
  return token.instanceUrl;
}

module.exports = { sfRequest, isSalesforceConfigured, getInstanceUrl };
