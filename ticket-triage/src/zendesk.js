/**
 * Zendesk API client — READ ONLY.
 * This module only reads tickets. No updates, no writes.
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

    return response.json();
  }

  async getRecentTickets(windowMinutes) {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);
    const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
      assigneeId: ticket.assignee_id,
    }));
  }
}

module.exports = { ZendeskClient };
