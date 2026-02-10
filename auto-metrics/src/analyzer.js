/**
 * Analyzes Zendesk ticket data and generates metrics.
 */

// Tags to ignore in analysis
const IGNORE_TAGS = ['twilio_rejected', 'twilio_category', 'web', 'website', 'voicemail'];

// Tag → POS name mapping
const TAG_TO_POS = {
  'protractor_partner_api': 'Protractor',
  'tekmetric_partner_api': 'Tekmetric',
  'tekmetric_pos': 'Tekmetric',
  'shopware_partner_api': 'Shop-Ware',
  'mitchell_binary': 'Mitchell',
  'napa_binary': 'NAPA TRACS',
  'napaenterprise': 'NAPA TRACS',
  'rowriter_binary': 'RO Writer',
  'winworks_binary': 'Winworks',
  'vast_binary': 'VAST',
  'maxxtraxx_binary': 'MaxxTraxx',
  'alldata_binary': 'ALLDATA',
  'autofluent_binary': 'AutoFluent',
  'yes_binary': 'YES',
  'stocktrac_binary': 'StockTrac',
};

// Tag → category mapping
const TAG_TO_CATEGORY = {
  'system_issue': 'System Issue',
  'integrations': 'Integration',
  'bayiq': 'BayIQ',
  'high_slack': 'High Priority',
};

// Source tag mapping
const TAG_TO_SOURCE = {
  'source_tvp': 'TVP',
  'source_email': 'Email',
  'source_phone': 'Phone',
  'source_chat': 'Chat',
};

class TicketAnalyzer {
  constructor() {}

  /**
   * Filter out tickets we don't care about.
   */
  filterTickets(tickets) {
    return tickets.filter(t => {
      const tags = t.tags || [];
      return !tags.some(tag => IGNORE_TAGS.includes(tag));
    });
  }

  /**
   * Extract POS system from ticket tags.
   */
  extractPOS(ticket) {
    for (const tag of (ticket.tags || [])) {
      if (TAG_TO_POS[tag]) return TAG_TO_POS[tag];
    }
    return null;
  }

  /**
   * Extract category from ticket tags.
   */
  extractCategory(ticket) {
    for (const tag of (ticket.tags || [])) {
      if (TAG_TO_CATEGORY[tag]) return TAG_TO_CATEGORY[tag];
    }
    return 'Other';
  }

  /**
   * Extract source from ticket tags.
   */
  extractSource(ticket) {
    for (const tag of (ticket.tags || [])) {
      if (TAG_TO_SOURCE[tag]) return TAG_TO_SOURCE[tag];
    }
    return 'Unknown';
  }

  /**
   * Generate full metrics report from ticket data.
   */
  generateReport(created, resolved, open, agents, groups, days) {
    const filtered = this.filterTickets(created);
    const filteredResolved = this.filterTickets(resolved);
    const filteredOpen = this.filterTickets(open);

    // Build agent name map
    const agentMap = {};
    for (const a of agents) {
      agentMap[a.id] = a.name;
    }

    // Build group name map
    const groupMap = {};
    for (const g of groups) {
      groupMap[g.id] = g.name;
    }

    return {
      period: `${days} days`,
      summary: this.getSummary(filtered, filteredResolved, filteredOpen, days),
      byCategory: this.countBy(filtered, t => this.extractCategory(t)),
      byPOS: this.countBy(filtered, t => this.extractPOS(t) || 'Non-POS'),
      bySource: this.countBy(filtered, t => this.extractSource(t)),
      byPriority: this.countBy(filtered, t => t.priority || 'none'),
      byStatus: this.countBy(filtered, t => t.status),
      byAssignee: this.countBy(filtered, t => agentMap[t.assignee_id] || 'Unassigned'),
      byGroup: this.countBy(filtered, t => groupMap[t.group_id] || 'No Group'),
      byDay: this.ticketsByDay(filtered),
      topSubjects: this.topSubjects(filtered, 10),
      topOrgs: this.countBy(filtered, t => t.organization_id || 'No Org'),
      highPriority: filtered.filter(t => t.priority === 'high' || t.priority === 'urgent'),
    };
  }

  getSummary(created, resolved, open, days) {
    return {
      created: created.length,
      resolved: resolved.length,
      open: open.length,
      avgPerDay: Math.round((created.length / days) * 10) / 10,
      newVsResolved: created.length - resolved.length,
    };
  }

  countBy(tickets, keyFn) {
    const counts = {};
    for (const t of tickets) {
      const key = keyFn(t);
      counts[key] = (counts[key] || 0) + 1;
    }
    // Sort by count descending
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, pct: Math.round((count / tickets.length) * 100) }));
  }

  ticketsByDay(tickets) {
    const days = {};
    for (const t of tickets) {
      const day = t.created_at.split('T')[0];
      days[day] = (days[day] || 0) + 1;
    }
    return Object.entries(days)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }));
  }

  topSubjects(tickets, n) {
    // Normalize subjects and find most common patterns
    const normalized = {};
    for (const t of tickets) {
      // Strip shop names, IDs, and specific details to find patterns
      let subj = (t.subject || '').toLowerCase()
        .replace(/\[?\d{4,}\]?/g, '') // Remove IDs
        .replace(/\s+/g, ' ')
        .trim();

      // Truncate to first 50 chars for grouping
      subj = subj.substring(0, 50);
      normalized[subj] = (normalized[subj] || 0) + 1;
    }

    return Object.entries(normalized)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([subject, count]) => ({ subject, count }));
  }
}

module.exports = { TicketAnalyzer };
