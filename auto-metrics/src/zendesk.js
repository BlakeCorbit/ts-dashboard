/**
 * Zendesk API client for metrics/reporting.
 * Handles pagination for large result sets.
 */

class ZendeskClient {
  constructor({ subdomain, email, apiToken }) {
    this.baseUrl = `https://${subdomain}.zendesk.com/api/v2`;
    this.auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64');
  }

  async request(url, params = {}) {
    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
    const urlObj = new URL(fullUrl);
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
      return this.request(url, params);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Zendesk API ${response.status}: ${body.substring(0, 200)}`);
    }

    return response.json();
  }

  /**
   * Search with pagination. Returns all results up to maxResults.
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

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    return results.slice(0, maxResults);
  }

  /**
   * Get all tickets created in a date range.
   */
  async getTicketsInRange(startDate, endDate) {
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    const query = `type:ticket created>=${start} created<=${end}`;
    return this.searchAll(query);
  }

  /**
   * Get tickets solved/closed in a date range.
   */
  async getResolvedTicketsInRange(startDate, endDate) {
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    const query = `type:ticket solved>=${start} solved<=${end}`;
    return this.searchAll(query);
  }

  /**
   * Get current open ticket count by status.
   */
  async getOpenTickets() {
    const query = 'type:ticket status<solved';
    return this.searchAll(query);
  }

  /**
   * Get users (agents) for mapping assignee IDs to names.
   */
  async getAgents() {
    const data = await this.request('/users.json', { role: 'agent' });
    return data.users || [];
  }

  /**
   * Get groups for mapping group IDs to names.
   */
  async getGroups() {
    const data = await this.request('/groups.json');
    return data.groups || [];
  }
}

module.exports = { ZendeskClient };
