/**
 * Clusters similar Zendesk tickets to detect potential incidents.
 *
 * Strategy:
 * 1. Categorize each ticket by type (POS, Comms, Access, General)
 * 2. Extract POS system name if present
 * 3. Extract key error patterns from subject/description
 * 4. Group tickets by (category + POS + error pattern)
 * 5. Return clusters that meet the threshold
 */

// Known POS systems — used to tag tickets
const POS_SYSTEMS = [
  'tekmetric', 'protractor', 'mitchell', 'shopkey', 'shop-ware', 'shopware',
  'napa tracs', 'napa', 'tracs', 'ro writer', 'rowriter', 'vast',
  'winworks', 'maxxtruxx', 'maxxtraxx', 'yes management', 'yes prime',
  'alldata', 'stocktrac', 'autofluent', 'tabs', 'costar', 'lankar',
  'idenifix', 'navex',
];

// Common error patterns to normalize ticket descriptions
const ERROR_PATTERNS = [
  { pattern: /ro.*(not|missing|gone|disappeared|showing)/i, label: 'ROs not showing' },
  { pattern: /data.*(not|stop|miss|delay|late)/i, label: 'Data not syncing' },
  { pattern: /(tvp|page).*(blank|empty|down|error|load|slow)/i, label: 'TVP issues' },
  { pattern: /(email|mailgun).*(not|fail|bounce|unverif|disabled)/i, label: 'Email delivery' },
  { pattern: /(text|sms|twilio).*(not|fail|send|receiv)/i, label: 'SMS delivery' },
  { pattern: /(login|access|password|code|locked)/i, label: 'Login/access' },
  { pattern: /(inspect|dvi|photo|image|video).*(not|miss|fail|error)/i, label: 'Inspection issues' },
  { pattern: /(reminder|campaign).*(not|fail|miss|wrong)/i, label: 'Reminders/campaigns' },
  { pattern: /(chat|conversation).*(not|fail|miss|error)/i, label: 'Chat issues' },
  { pattern: /(slow|performance|timeout|504|503|500)/i, label: 'Performance/errors' },
  { pattern: /(appointment|schedule).*(not|miss|wrong|fail)/i, label: 'Appointments' },
  { pattern: /(binary|ftp|addon|smartflow.*addon)/i, label: 'Binary integration' },
  { pattern: /(partner.*api|api.*error|webhook)/i, label: 'Partner API' },
];

class TicketClusterer {
  constructor(config) {
    this.config = config;
    this.keywords = config.keywords;
  }

  /**
   * Categorize a ticket into a type based on keywords.
   */
  categorize(ticket) {
    const text = `${ticket.subject} ${ticket.description}`.toLowerCase();

    // Check POS keywords
    for (const kw of this.keywords.pos) {
      if (text.includes(kw)) return 'pos';
    }
    // Check comms keywords
    for (const kw of this.keywords.comms) {
      if (text.includes(kw)) return 'comms';
    }
    // Check access keywords
    for (const kw of this.keywords.access) {
      if (text.includes(kw)) return 'access';
    }
    return 'general';
  }

  /**
   * Extract POS system name from ticket text.
   */
  extractPOS(ticket) {
    const text = `${ticket.subject} ${ticket.description}`.toLowerCase();
    for (const pos of POS_SYSTEMS) {
      if (text.includes(pos)) return pos;
    }
    // Also check tags
    for (const tag of ticket.tags) {
      const tagLower = tag.toLowerCase();
      for (const pos of POS_SYSTEMS) {
        if (tagLower.includes(pos.replace(/\s+/g, ''))) return pos;
      }
    }
    return null;
  }

  /**
   * Extract the most specific error pattern from ticket text.
   */
  extractErrorPattern(ticket) {
    const text = `${ticket.subject} ${ticket.description}`;
    for (const { pattern, label } of ERROR_PATTERNS) {
      if (pattern.test(text)) return label;
    }
    return 'other';
  }

  /**
   * Generate a cluster key for a ticket.
   * Tickets with the same key are considered "similar".
   */
  getClusterKey(ticket) {
    const category = this.categorize(ticket);
    const pos = this.extractPOS(ticket);
    const error = this.extractErrorPattern(ticket);

    // Build a key: category:pos:error
    const parts = [category];
    if (pos) parts.push(pos);
    parts.push(error);
    return parts.join(':');
  }

  /**
   * Find all clusters in the given tickets.
   * Returns array of cluster objects, sorted by size descending.
   */
  findClusters(tickets) {
    const groups = new Map();

    for (const ticket of tickets) {
      const key = this.getClusterKey(ticket);

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          category: this.categorize(ticket),
          pos: this.extractPOS(ticket),
          errorPattern: this.extractErrorPattern(ticket),
          tickets: [],
          organizations: new Set(),
        });
      }

      const cluster = groups.get(key);
      cluster.tickets.push(ticket);
      if (ticket.organizationId) {
        cluster.organizations.add(ticket.organizationId);
      }
    }

    // Convert to array, add metadata, sort
    return Array.from(groups.values())
      .map(cluster => ({
        ...cluster,
        organizations: Array.from(cluster.organizations),
        fingerprint: cluster.key,
        pattern: this.describeCluster(cluster),
        timeSpanMinutes: this.getTimeSpan(cluster.tickets),
      }))
      .filter(c => c.tickets.length >= 2) // Only return clusters with 2+ tickets
      .sort((a, b) => b.tickets.length - a.tickets.length);
  }

  /**
   * Generate a human-readable description of a cluster.
   */
  describeCluster(cluster) {
    const parts = [];
    if (cluster.category === 'pos') parts.push('POS Integration');
    else if (cluster.category === 'comms') parts.push('Email/SMS');
    else if (cluster.category === 'access') parts.push('Login/Access');
    else parts.push('General');

    if (cluster.pos) parts.push(`- ${cluster.pos}`);
    parts.push(`- ${cluster.errorPattern}`);

    return parts.join(' ');
  }

  /**
   * Get the time span of tickets in a cluster (in minutes).
   */
  getTimeSpan(tickets) {
    if (tickets.length < 2) return 0;
    const times = tickets.map(t => new Date(t.createdAt).getTime());
    const min = Math.min(...times);
    const max = Math.max(...times);
    return Math.round((max - min) / (60 * 1000));
  }
}

module.exports = { TicketClusterer };
