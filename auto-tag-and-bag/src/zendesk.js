/**
 * Zendesk API client for tag-and-bag operations.
 * Supports both read-only (dry-run) and live modes.
 */

class ZendeskClient {
  constructor({ subdomain, email, apiToken, liveMode = false }) {
    this.rootUrl = `https://${subdomain}.zendesk.com`;
    this.baseUrl = `${this.rootUrl}/api/v2`;
    this.auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64');
    this.liveMode = liveMode;
  }

  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const urlObj = new URL(url);

    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        urlObj.searchParams.set(key, value);
      }
    }

    const fetchOpts = {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json',
      },
    };

    if (options.body) {
      fetchOpts.body = JSON.stringify(options.body);
    }

    const response = await fetch(urlObj.toString(), fetchOpts);

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '30', 10);
      console.log(`  Rate limited, waiting ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this.request(endpoint, options);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Zendesk API ${response.status}: ${body.substring(0, 200)}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  /**
   * Get a single ticket by ID.
   */
  async getTicket(ticketId) {
    const data = await this.request(`/tickets/${ticketId}.json`);
    return data.ticket;
  }

  /**
   * Search for recent tickets (unsolved, created in window).
   */
  async getRecentTickets(windowMinutes) {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);
    const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const query = `type:ticket created>${sinceStr} status<solved`;

    const data = await this.request('/search.json', {
      params: { query, sort_by: 'created_at', sort_order: 'desc', per_page: '100' },
    });

    return (data.results || []).map(t => ({
      id: t.id,
      subject: t.subject || '',
      description: t.description || '',
      createdAt: t.created_at,
      status: t.status,
      priority: t.priority,
      tags: t.tags || [],
      groupId: t.group_id,
      organizationId: t.organization_id,
      problemId: t.problem_id,
    }));
  }

  /**
   * Link a ticket as incident of a Problem ticket.
   * ONLY runs in live mode.
   */
  async linkToProblem(ticketId, problemTicketId) {
    if (!this.liveMode) {
      console.log(`  [DRY-RUN] Would link ZD#${ticketId} → Problem ZD#${problemTicketId}`);
      return;
    }

    await this.request(`/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: {
          type: 'incident',
          problem_id: problemTicketId,
        },
      },
    });
    console.log(`  [LIVE] Linked ZD#${ticketId} → Problem ZD#${problemTicketId}`);
  }

  /**
   * Send a public reply on a ticket.
   * ONLY runs in live mode.
   */
  async sendPublicReply(ticketId, message) {
    if (!this.liveMode) {
      console.log(`  [DRY-RUN] Would send message on ZD#${ticketId}: "${message.substring(0, 60)}..."`);
      return;
    }

    await this.request(`/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: {
          comment: {
            body: message,
            public: true,
          },
        },
      },
    });
    console.log(`  [LIVE] Sent message on ZD#${ticketId}`);
  }

  /**
   * Add an internal note to a ticket.
   * ONLY runs in live mode.
   */
  async addInternalNote(ticketId, note) {
    if (!this.liveMode) {
      console.log(`  [DRY-RUN] Would add internal note on ZD#${ticketId}`);
      return;
    }

    await this.request(`/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: {
          comment: {
            body: note,
            public: false,
          },
        },
      },
    });
  }

  /**
   * Get linked Jira issues for a Zendesk ticket.
   * Uses the Zendesk-Jira integration API.
   */
  async getJiraLinks(ticketId) {
    try {
      // Jira integration API is at /api/services/ not /api/v2/
      const data = await this.request(`${this.rootUrl}/api/services/jira/links`, {
        params: { ticket_id: String(ticketId) },
      });
      return (data.links || []).map(link => ({
        issueKey: link.issue_key,
        issueId: link.issue_id,
        url: `https://autovitals.atlassian.net/browse/${link.issue_key}`,
        createdAt: link.created_at,
      }));
    } catch (err) {
      // Jira integration may not be available or ticket may have no links
      return [];
    }
  }
}

module.exports = { ZendeskClient };
