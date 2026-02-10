// _clusterer.js — Shared clustering helper for ticket pattern detection
// Ported from incident-detector/src/clusterer.js with embedded config
// Underscore prefix = not a Vercel route

const POS_SYSTEMS = [
  'tekmetric', 'protractor', 'mitchell', 'shopkey', 'shop-ware', 'shopware',
  'napa tracs', 'napa', 'tracs', 'ro writer', 'rowriter', 'vast',
  'winworks', 'maxxtraxx', 'maxxtraxx', 'yes management', 'yes prime',
  'alldata', 'stocktrac', 'autofluent', 'tabs', 'costar', 'lankar',
];

const TAG_TO_POS = {
  'protractor_partner_api': 'protractor',
  'tekmetric_partner_api': 'tekmetric',
  'shopware_partner_api': 'shop-ware',
  'mitchell_binary': 'mitchell',
  'napa_binary': 'napa tracs',
  'rowriter_binary': 'ro writer',
  'winworks_binary': 'winworks',
  'vast_binary': 'vast',
  'maxxtraxx_binary': 'maxxtraxx',
  'alldata_binary': 'alldata',
  'autofluent_binary': 'autofluent',
  'yes_binary': 'yes management',
  'stocktrac_binary': 'stocktrac',
};

const TAG_TO_CATEGORY = {
  'system_issue': 'pos',
  'data_issue': 'pos',
  'integration_issue': 'pos',
  'email_issue': 'comms',
  'sms_issue': 'comms',
  'twilio_issue': 'comms',
  'mailgun_issue': 'comms',
  'login_issue': 'access',
  'access_issue': 'access',
};

const IGNORE_TAGS = ['twilio_rejected', 'twilio_category', 'web', 'web_category', 'website', 'voicemail'];

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
  { pattern: /(media|upload).*(not|fail|error|issue)/i, label: 'Media upload' },
  { pattern: /(camera|autofocus|photo.*tak)/i, label: 'Camera/photo issues' },
  { pattern: /(notification|alert|push).*(not|fail|miss)/i, label: 'Notification issues' },
  { pattern: /(sound|audio|video).*(no|not|miss|fail)/i, label: 'Audio/video issues' },
  { pattern: /(freeze|crash|stuck|unresponsive)/i, label: 'App freezing/crashing' },
];

// Embedded keywords (from incident-detector config)
const KEYWORDS = {
  pos: ['ro ', 'repair order', 'sync', 'transfer', 'binary', 'integration', 'partner api', 'ftp', 'addon'],
  comms: ['email', 'sms', 'text message', 'mailgun', 'twilio', 'reminder', 'campaign', 'notification'],
  access: ['login', 'password', 'locked', 'access', 'permission', 'code'],
};

class TicketClusterer {
  categorize(ticket) {
    for (const tag of (ticket.tags || [])) {
      if (TAG_TO_CATEGORY[tag]) return TAG_TO_CATEGORY[tag];
    }
    const text = ((ticket.subject || '') + ' ' + (ticket.description || '')).toLowerCase();
    for (const kw of KEYWORDS.pos) { if (text.includes(kw)) return 'pos'; }
    for (const kw of KEYWORDS.comms) { if (text.includes(kw)) return 'comms'; }
    for (const kw of KEYWORDS.access) { if (text.includes(kw)) return 'access'; }
    return 'general';
  }

  extractPOS(ticket) {
    for (const tag of (ticket.tags || [])) {
      if (TAG_TO_POS[tag]) return TAG_TO_POS[tag];
    }
    for (const tag of (ticket.tags || [])) {
      const tagLower = tag.toLowerCase();
      for (const pos of POS_SYSTEMS) {
        if (tagLower.includes(pos.replace(/\s+/g, ''))) return pos;
      }
    }
    const text = ((ticket.subject || '') + ' ' + (ticket.description || '')).toLowerCase();
    for (const pos of POS_SYSTEMS) {
      if (text.includes(pos)) return pos;
    }
    return null;
  }

  extractErrorPattern(ticket) {
    const text = (ticket.subject || '') + ' ' + (ticket.description || '');
    for (const { pattern, label } of ERROR_PATTERNS) {
      if (pattern.test(text)) return label;
    }
    return 'other';
  }

  shouldIgnore(ticket) {
    return (ticket.tags || []).some(tag => IGNORE_TAGS.includes(tag.toLowerCase()));
  }

  findClusters(tickets) {
    const groups = new Map();
    for (const ticket of tickets) {
      if (this.shouldIgnore(ticket)) continue;
      const category = this.categorize(ticket);
      const pos = this.extractPOS(ticket);
      const errorPattern = this.extractErrorPattern(ticket);
      const key = [category, pos, errorPattern].filter(Boolean).join(':');

      if (!groups.has(key)) {
        groups.set(key, { key, category, pos, errorPattern, tickets: [], organizations: new Set() });
      }
      const cluster = groups.get(key);
      cluster.tickets.push(ticket);
      if (ticket.organizationId) cluster.organizations.add(ticket.organizationId);
    }

    return Array.from(groups.values())
      .map(c => {
        const orgs = Array.from(c.organizations);
        const times = c.tickets.map(t => new Date(t.createdAt).getTime());
        const span = c.tickets.length >= 2 ? Math.round((Math.max(...times) - Math.min(...times)) / 60000) : 0;

        // Human-readable pattern
        const parts = [];
        if (c.category === 'pos') parts.push('POS Integration');
        else if (c.category === 'comms') parts.push('Email/SMS');
        else if (c.category === 'access') parts.push('Login/Access');
        else parts.push('General');
        if (c.pos) parts.push('- ' + c.pos);
        parts.push('- ' + c.errorPattern);

        return {
          key: c.key,
          category: c.category,
          pos: c.pos,
          errorPattern: c.errorPattern,
          pattern: parts.join(' '),
          tickets: c.tickets,
          ticketCount: c.tickets.length,
          organizations: orgs,
          orgCount: orgs.length,
          timeSpanMinutes: span,
          suggestedSubject: 'PT - ' + (c.pos ? c.pos + ' - ' : '') + c.errorPattern,
          suggestedDescription: 'Multiple reports (' + c.tickets.length + ' tickets' + (span > 0 ? ' in ' + span + ' min' : '') + ') of ' + c.errorPattern.toLowerCase() + (c.pos ? ' affecting ' + c.pos : '') + '. ' + orgs.length + ' shop(s) affected.',
        };
      })
      .filter(c => c.ticketCount >= 2)
      .sort((a, b) => b.ticketCount - a.ticketCount);
  }
}

module.exports = { TicketClusterer };
