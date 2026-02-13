/**
 * Zendesk API Client
 *
 * Adapted from dashboard/collect.js. Provides paginated search,
 * rate limit handling, and org/ticket fetching for the churn analyzer.
 */

class ZendeskClient {
  constructor({ subdomain, email, apiToken }) {
    this.rootUrl = `https://${subdomain}.zendesk.com`;
    this.baseUrl = `${this.rootUrl}/api/v2`;
    this.auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64');
  }

  async request(endpoint, params = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const urlObj = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      urlObj.searchParams.set(key, value);
    }

    const response = await fetch(urlObj.toString(), {
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '30', 10);
      console.log(`  Rate limited, waiting ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this.request(endpoint, params);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Zendesk API ${response.status}: ${body.substring(0, 200)}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  /**
   * Paginated search. Returns up to maxResults items.
   */
  async searchAll(query, maxResults = 1000) {
    const results = [];
    let page = 1;

    while (results.length < maxResults) {
      const data = await this.request('/search.json', {
        query,
        sort_by: 'created_at',
        sort_order: 'desc',
        per_page: '100',
        page: String(page),
      });

      results.push(...(data.results || []));

      if (!data.next_page || (data.results || []).length === 0) break;
      page++;

      await new Promise(r => setTimeout(r, 500));
    }

    return results.slice(0, maxResults);
  }

  /**
   * Fetch all organizations (paginated).
   */
  async getAllOrganizations() {
    const orgs = [];
    let page = 1;

    while (true) {
      const data = await this.request('/organizations.json', {
        per_page: '100',
        page: String(page),
      });

      orgs.push(...(data.organizations || []));

      if (!data.next_page || (data.organizations || []).length === 0) break;
      page++;

      await new Promise(r => setTimeout(r, 500));
    }

    return orgs;
  }

  /**
   * Get tickets created since a given date.
   */
  async getTicketsSince(sinceDate, maxResults = 5000) {
    const since = sinceDate.toISOString().split('T')[0];
    return this.searchAll(`type:ticket created>=${since}`, maxResults);
  }

  /**
   * Get tickets for a specific organization.
   */
  async getOrgTickets(orgId, sinceDate) {
    const since = sinceDate ? sinceDate.toISOString().split('T')[0] : '';
    const query = since
      ? `type:ticket organization_id:${orgId} created>=${since}`
      : `type:ticket organization_id:${orgId}`;
    return this.searchAll(query, 2000);
  }
}

/**
 * Create a ZendeskClient from environment variables.
 */
function createClient() {
  const config = {
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    email: process.env.ZENDESK_EMAIL,
    apiToken: process.env.ZENDESK_API_TOKEN,
  };

  const missing = [];
  if (!config.subdomain) missing.push('ZENDESK_SUBDOMAIN');
  if (!config.email) missing.push('ZENDESK_EMAIL');
  if (!config.apiToken) missing.push('ZENDESK_API_TOKEN');

  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in your Zendesk credentials.');
    process.exit(1);
  }

  return new ZendeskClient(config);
}

module.exports = { ZendeskClient, createClient };
