/**
 * Dashboard Data Collector
 *
 * Fetches data from Zendesk and outputs JSON files for the static dashboard.
 * Designed to run via GitHub Actions on a schedule, or locally with `node dashboard/collect.js`.
 *
 * Outputs:
 *   dashboard/data/metrics.json   — Weekly metrics summary
 *   dashboard/data/incidents.json — Active incidents (Problem tickets + Jira links)
 *   dashboard/data/triage.json    — Recent triage results
 */

const path = require('path');
const fs = require('fs');

// Load .env from auto-metrics (local dev) or rely on GitHub Actions env vars
const envPath = path.join(__dirname, '..', 'auto-metrics', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  // Fallback: try repo root .env
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

// Import the triage engine from ticket-triage
const { TriageEngine } = require('../ticket-triage/src/rules');

// ─── CONFIGURATION ─────────────────────────────────────────────

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
  console.error('Set them in auto-metrics/.env or as environment variables.');
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, 'data');

// ─── TAG MAPPINGS ──────────────────────────────────────────────
// Reused from auto-metrics/src/analyzer.js

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

const TAG_TO_CATEGORY = {
  'system_issue': 'System Issue',
  'integrations': 'Integration',
  'app_workorder': 'App/Work Order',
  'bayiq': 'BayIQ',
  'high_slack': 'High Priority',
};

const TAG_TO_SOURCE = {
  'source_tvp': 'TVP',
  'source_email': 'Email',
  'source_phone': 'Phone',
  'source_chat': 'Chat',
  'web': 'Web',
};

const IGNORE_TAGS = ['twilio_rejected', 'twilio_category', 'voicemail'];

// POS tags recognized for incident detection (from auto-tag-and-bag)
const POS_TAGS = [
  'napaenterprise', 'napa_binary', 'protractor_partner_api', 'tekmetric_partner_api',
  'tekmetric_pos', 'shopware_partner_api', 'mitchell_binary', 'rowriter_binary',
  'winworks_binary', 'vast_binary', 'maxxtraxx_binary', 'alldata_binary',
  'autofluent_binary', 'yes_binary',
];

// ─── ZENDESK API CLIENT ────────────────────────────────────────

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
   * Paginated search. Returns up to maxResults tickets.
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

      // Delay between pages to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    return results.slice(0, maxResults);
  }

  /**
   * Get tickets created in a date range.
   */
  async getTicketsInRange(startDate, endDate) {
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    return this.searchAll(`type:ticket created>=${start} created<=${end}`);
  }

  /**
   * Get tickets solved in a date range.
   */
  async getResolvedInRange(startDate, endDate) {
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    return this.searchAll(`type:ticket solved>=${start} solved<=${end}`);
  }

  /**
   * Get all open/pending tickets (backlog).
   */
  async getOpenTickets() {
    return this.searchAll('type:ticket status<solved');
  }

  /**
   * Get active Problem tickets (unsolved).
   */
  async getProblemTickets() {
    const data = await this.request('/search.json', {
      query: 'type:ticket ticket_type:problem status<solved',
      sort_by: 'created_at',
      sort_order: 'desc',
      per_page: '25',
    });
    return data.results || [];
  }

  /**
   * Get Jira links for a ticket via the Zendesk-Jira integration API.
   * NOTE: This endpoint is at /api/services/, NOT /api/v2/.
   */
  async getJiraLinks(ticketId) {
    try {
      const data = await this.request(`${this.rootUrl}/api/services/jira/links`, {
        ticket_id: String(ticketId),
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

  /**
   * Get recent unsolved tickets (for triage).
   */
  async getRecentTickets(maxResults = 200) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sinceStr = since.toISOString().split('T')[0];
    return this.searchAll(`type:ticket created>=${sinceStr} status<solved`, maxResults);
  }
}

// ─── HELPER FUNCTIONS ──────────────────────────────────────────

function filterTickets(tickets) {
  return tickets.filter(t => {
    const tags = t.tags || [];
    return !tags.some(tag => IGNORE_TAGS.includes(tag));
  });
}

function extractPOS(ticket) {
  for (const tag of (ticket.tags || [])) {
    if (TAG_TO_POS[tag]) return TAG_TO_POS[tag];
  }
  return null;
}

function extractCategory(ticket) {
  for (const tag of (ticket.tags || [])) {
    if (TAG_TO_CATEGORY[tag]) return TAG_TO_CATEGORY[tag];
  }
  return 'Other';
}

function extractSource(ticket) {
  for (const tag of (ticket.tags || [])) {
    if (TAG_TO_SOURCE[tag]) return TAG_TO_SOURCE[tag];
  }
  return 'Unknown';
}

function countBy(tickets, keyFn) {
  const counts = {};
  for (const t of tickets) {
    const key = keyFn(t);
    if (key) {
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function ticketsByDay(tickets) {
  const days = {};
  for (const t of tickets) {
    const day = (t.created_at || '').split('T')[0];
    if (day) {
      days[day] = (days[day] || 0) + 1;
    }
  }
  return Object.entries(days)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, count }));
}

function detectPOSTag(problemTicket) {
  const tags = (problemTicket.tags || []).map(t => t.toLowerCase());
  for (const tag of tags) {
    if (POS_TAGS.includes(tag)) return tag;
  }
  // Try text detection as fallback
  const text = `${problemTicket.subject} ${problemTicket.description || ''}`.toLowerCase();
  const posNames = {
    'napa tracs': 'napaenterprise',
    'napa': 'napaenterprise',
    'protractor': 'protractor_partner_api',
    'tekmetric': 'tekmetric_partner_api',
    'shop-ware': 'shopware_partner_api',
    'mitchell': 'mitchell_binary',
    'ro writer': 'rowriter_binary',
    'winworks': 'winworks_binary',
  };
  for (const [name, tag] of Object.entries(posNames)) {
    if (text.includes(name)) return tag;
  }
  return null;
}

function detectPattern(problemTicket) {
  const text = `${problemTicket.subject} ${problemTicket.description || ''}`.toLowerCase();
  const patterns = {
    'ROs Not Showing': ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'not showing up', 'not transferring', 'not populating'],
    'Platform Down': ['tvp down', 'page not loading', 'blank page', 'error 500', 'error 503', 'site down', 'not loading', 'completely down'],
    'App Issues': ['app crash', 'app freeze', 'app not working', 'crashing', 'freezing', 'white screen'],
    'Email/SMS Down': ['email not sending', 'text not sending', 'reminders not', 'mailgun', 'twilio down', 'sms not'],
    'Integration Issue': ['integration', 'binary', 'partner api', 'overnight compare'],
    'Media Upload Issue': ['media not uploading', 'photo not uploading', 'image not uploading', 'upload fail'],
  };

  for (const [label, keywords] of Object.entries(patterns)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return label;
    }
  }

  return 'Custom Pattern';
}

function writeJSON(filename, data) {
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`  Wrote ${filepath}`);
}

// ─── COLLECTORS ────────────────────────────────────────────────

/**
 * Collect weekly metrics and write metrics.json
 */
async function collectMetrics(zd) {
  console.log('Collecting metrics...');

  const days = 7;
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  // Fetch data in parallel
  const [created, resolved, open] = await Promise.all([
    zd.getTicketsInRange(startDate, endDate),
    zd.getResolvedInRange(startDate, endDate),
    zd.getOpenTickets(),
  ]);

  console.log(`  Created: ${created.length}, Resolved: ${resolved.length}, Open: ${open.length}`);

  const filtered = filterTickets(created);

  const metrics = {
    totalTickets: filtered.length,
    resolvedTickets: filterTickets(resolved).length,
    openBacklog: filterTickets(open).length,
    avgPerDay: Math.round((filtered.length / days) * 10) / 10,
    byCategory: countBy(filtered, t => extractCategory(t)),
    byPOS: countBy(filtered, t => extractPOS(t) || 'Non-POS'),
    bySource: countBy(filtered, t => extractSource(t)),
    byDay: ticketsByDay(filtered),
    generatedAt: new Date().toISOString(),
  };

  writeJSON('metrics.json', metrics);
  return metrics;
}

/**
 * Collect active incidents and write incidents.json
 */
async function collectIncidents(zd) {
  console.log('Collecting incidents...');

  const problems = await zd.getProblemTickets();
  console.log(`  Active Problem tickets: ${problems.length}`);

  const incidents = [];

  for (const problem of problems) {
    const posTag = detectPOSTag(problem);
    const pattern = detectPattern(problem);

    // Fetch Jira links for each Problem ticket
    const jiraLinks = await zd.getJiraLinks(problem.id);

    // Count linked incident tickets
    let linkedCount = 0;
    try {
      const linkedData = await zd.request('/search.json', {
        query: `type:ticket problem_id:${problem.id}`,
        per_page: '1',
      });
      linkedCount = linkedData.count || 0;
    } catch (err) {
      // If count query fails, skip
    }

    incidents.push({
      problemId: problem.id,
      subject: problem.subject,
      pattern,
      posTag: posTag ? (TAG_TO_POS[posTag] || posTag) : null,
      jiraLinks: jiraLinks.map(j => ({
        issueKey: j.issueKey,
        url: j.url,
      })),
      linkedCount,
      createdAt: problem.created_at,
    });

    // Small delay between Jira link requests
    await new Promise(r => setTimeout(r, 300));
  }

  const data = {
    incidents,
    generatedAt: new Date().toISOString(),
  };

  writeJSON('incidents.json', data);
  return data;
}

/**
 * Collect triage results and write triage.json
 */
async function collectTriage(zd) {
  console.log('Collecting triage data...');

  const engine = new TriageEngine();

  // Get recent unsolved tickets
  const tickets = await zd.getRecentTickets(200);
  console.log(`  Recent tickets to triage: ${tickets.length}`);

  const triageResults = [];
  let matched = 0;
  let unmatched = 0;
  const categoryCounts = {};

  for (const ticket of tickets) {
    const result = engine.triage({
      subject: ticket.subject || '',
      description: ticket.description || '',
      tags: ticket.tags || [],
    });

    if (result.ignored) continue;

    if (result.rule !== 'unmatched') {
      matched++;
      const cat = result.category || 'Unknown';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    } else {
      unmatched++;
    }

    triageResults.push({
      id: ticket.id,
      subject: ticket.subject || '',
      category: result.category,
      subcategory: result.subcategory,
      runbook: result.runbook ? result.runbook.title : null,
      priority: result.suggestedPriority || ticket.priority || null,
      matchedAt: new Date().toISOString(),
    });
  }

  // Only keep the most recent 50 for the dashboard
  const recentTickets = triageResults.slice(0, 50);
  const total = matched + unmatched;
  const matchRate = total > 0 ? Math.round((matched / total) * 100) : 0;

  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const data = {
    recentTickets,
    stats: {
      total,
      matched,
      unmatched,
      matchRate,
    },
    topCategories,
    generatedAt: new Date().toISOString(),
  };

  writeJSON('triage.json', data);
  return data;
}

// ─── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('=== TS Automation Dashboard Data Collector ===');
  console.log(`  Zendesk: ${config.subdomain}.zendesk.com`);
  console.log(`  Output:  ${OUTPUT_DIR}`);
  console.log('');

  const zd = new ZendeskClient(config);

  const startTime = Date.now();

  try {
    // Run all three collectors
    const [metrics, incidents, triage] = await Promise.all([
      collectMetrics(zd),
      collectIncidents(zd),
      collectTriage(zd),
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    console.log('=== Collection Complete ===');
    console.log(`  Time: ${elapsed}s`);
    console.log(`  Metrics: ${metrics.totalTickets} tickets, ${metrics.resolvedTickets} resolved, ${metrics.openBacklog} backlog`);
    console.log(`  Incidents: ${incidents.incidents.length} active`);
    console.log(`  Triage: ${triage.stats.total} triaged (${triage.stats.matchRate}% match rate)`);
    console.log('');
    console.log('JSON files written to dashboard/data/');
  } catch (err) {
    console.error('');
    console.error('Collection failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
