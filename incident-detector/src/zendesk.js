/**
 * Zendesk API client for fetching recent tickets.
 * Uses the Zendesk Search API to find tickets created within a time window.
 * Auth: email/token (https://developer.zendesk.com/api-reference/introduction/security-and-auth/)
 */

class ZendeskClient {
  constructor({ subdomain, email, apiToken }) {
    this.baseUrl = `https://${subdomain}.zendesk.com/api/v2`;
    this.auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64');
  }

  async request(endpoint, params = {}) {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Zendesk API ${response.status}: ${body}`);
    }

    return response.json();
  }

  /**
   * Get tickets created within the last N minutes.
   * Uses Zendesk Search API with created>= filter.
   */
  async getRecentTickets(windowMinutes) {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);
    const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');

    // Search for tickets created in the window, sorted by creation time
    const query = `type:ticket created>${sinceStr} status<solved`;
    const data = await this.request('/search.json', {
      query,
      sort_by: 'created_at',
      sort_order: 'desc',
    });

    return (data.results || []).map(ticket => ({
      id: ticket.id,
      subject: ticket.subject || '',
      description: ticket.description || '',
      createdAt: ticket.created_at,
      status: ticket.status,
      priority: ticket.priority,
      tags: ticket.tags || [],
      groupId: ticket.group_id,
      organizationId: ticket.organization_id,
      customFields: ticket.custom_fields || [],
    }));
  }

  /**
   * Get organization name by ID (for shop identification).
   */
  async getOrganization(orgId) {
    if (!orgId) return null;
    try {
      const data = await this.request(`/organizations/${orgId}.json`);
      return data.organization;
    } catch {
      return null;
    }
  }
}

module.exports = { ZendeskClient };
