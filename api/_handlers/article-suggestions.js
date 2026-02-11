// article-suggestions.js — GET /api/article-suggestions?days=30
// Returns article suggestions from three sources:
//   1. Agent-flagged tickets (needs_article tag in Zendesk)
//   2. Jira "Works As Designed" issues
//   3. Auto-detected repeat patterns (filtered: no POS integration)

const { zdRequest } = require('../_zendesk');
const { jiraRequest, isJiraConfigured } = require('../_jira');
const { TicketClusterer } = require('../_clusterer');

// Categories to EXCLUDE from auto-detected suggestions (shop-specific, not KB material)
const EXCLUDED_CATEGORIES = ['pos'];
const EXCLUDED_PATTERNS = [
  'ROs not showing', 'Data not syncing', 'Binary integration', 'Partner API',
];

// Triage rule metadata for building article bodies
const RULE_META = {
  'TVP issues':          { title: 'Troubleshooting: TVP Page Issues', category: 'Platform', runbook: null, action: 'Check if TVP loads at all or shows errors. Try clear cache (shop.autovitals.com/services/clearCache.asmx/Shop?shopid=X). Check browser compatibility. Verify shop is active.' },
  'Email delivery':      { title: 'Troubleshooting: Email Delivery Issues', category: 'Email/SMS', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/838270999', action: 'Identify email config type (AV-managed Google, promoted domain, or 3rd party). Check Mailgun domain status. Verify DNS records in Cloudflare/GoDaddy.' },
  'SMS delivery':        { title: 'Troubleshooting: SMS/Text Delivery Issues', category: 'Email/SMS', runbook: null, action: 'Check Twilio number status in AMD (shop.autovitals.com). Verify messaging service configured. Check Twilio console for delivery errors. Test outbound message.' },
  'Login/access':        { title: 'Troubleshooting: Login and Access Issues', category: 'Login/Access', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/847740929', action: 'Determine platform (TVP.x vs Legacy). Verify user exists in POS and AV. Try: update from POS button, verify welcome code, check if account active.' },
  'Inspection issues':   { title: 'Troubleshooting: Inspection Issues', category: 'Platform', runbook: null, action: 'Determine specific issue: missing inspection, wrong status, template problem, or delivery issue. Check if inspection sheet configured correctly in shop settings.' },
  'Reminders/campaigns': { title: 'Troubleshooting: Reminders and Campaigns', category: 'Email/SMS', runbook: null, action: 'Check reminder settings in shop.autovitals.com > Settings > Communication. Verify Twilio number in AMD. Check campaign settings in campaignmanager2.autovitals.com.' },
  'Chat issues':         { title: 'Troubleshooting: Chat and Conversation Center', category: 'Platform', runbook: null, action: 'Check Conversation Center status. Verify chat enabled for shop. Try clearing browser cache. Check if issue is with sending or receiving messages.' },
  'Performance/errors':  { title: 'Troubleshooting: Performance and Error Codes', category: 'Platform', runbook: null, action: 'Check for system-wide issues first (StatusPage). If shop-specific: clear cache, try different browser. If 500/503/504: likely backend issue — escalate to engineering.' },
  'Appointments':        { title: 'Troubleshooting: Appointment Issues', category: 'Platform', runbook: null, action: 'Check appointment settings in shop config. Verify POS integration sending appointment data. Check if issue is with scheduling, confirmations, or reminders.' },
  'Media upload':        { title: 'Troubleshooting: Media Upload Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known AV.X bugs list. Get device model, OS version, app version. Try: check storage space, permissions, restart app. Verify Wi-Fi connectivity.' },
  'Camera/photo issues': { title: 'Troubleshooting: AV.X Camera and Photo Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known AV.X bugs. AV.X 6.9.6: image quality differs from preview. Get device info. Try: check storage space, camera permissions, restart app.' },
  'Notification issues': { title: 'Troubleshooting: Notification and Alert Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known AV.X bugs. Verify notification permissions on device. Check if issue is with push notifications, in-app alerts, or email notifications.' },
  'Audio/video issues':  { title: 'Troubleshooting: AV.X Audio and Video Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Known bug in AV.X 6.9.6 — videos recording without sound. No fix yet. Document device info and link to existing JIRA if available.' },
  'App freezing/crashing': { title: 'Troubleshooting: AV.X Crash and Freeze Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known bugs list. Get device model, OS version, app version. Try: force close, clear cache, reinstall. If reproducible, create JIRA with steps.' },
};

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fuzzyMatch(articleTitle, pattern) {
  const a = articleTitle.toLowerCase();
  const keywords = pattern.toLowerCase().split(/[\s/]+/).filter(w => w.length > 2);
  let matched = 0;
  for (const kw of keywords) {
    if (a.includes(kw)) matched++;
  }
  return keywords.length > 0 ? matched / keywords.length : 0;
}

function buildArticleBody(meta, cluster) {
  const lines = [];
  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>This article covers troubleshooting steps for <strong>${escHtml(cluster.errorPattern || cluster.pattern)}</strong> issues. This pattern has been identified as a frequent support topic.</p>`);

  lines.push(`<h2>Symptoms</h2>`);
  lines.push(`<ul>`);
  lines.push(`<li>Tickets matching pattern: <strong>${escHtml(cluster.errorPattern || cluster.pattern)}</strong></li>`);
  if (cluster.category) lines.push(`<li>Category: <strong>${escHtml(meta.category || cluster.category)}</strong></li>`);
  lines.push(`<li>Recent volume: <strong>${cluster.ticketCount}</strong> tickets</li>`);
  lines.push(`</ul>`);

  lines.push(`<h2>Troubleshooting Steps</h2>`);
  if (meta.action) {
    const steps = meta.action.split('. ').filter(Boolean);
    lines.push(`<ol>`);
    steps.forEach(s => lines.push(`<li>${s.trim().replace(/\.$/, '')}.</li>`));
    lines.push(`</ol>`);
  } else {
    lines.push(`<p>Manual review required. No automated troubleshooting steps available for this pattern.</p>`);
  }

  if (meta.runbook) {
    lines.push(`<h2>Related Resources</h2>`);
    lines.push(`<ul>`);
    lines.push(`<li><a href="${meta.runbook}" target="_blank">Internal Runbook (Confluence)</a></li>`);
    lines.push(`</ul>`);
  }

  if (cluster.sampleTickets && cluster.sampleTickets.length) {
    lines.push(`<h2>Sample Tickets</h2>`);
    lines.push(`<ul>`);
    cluster.sampleTickets.slice(0, 5).forEach(t => {
      lines.push(`<li><a href="https://bayiq.zendesk.com/agent/tickets/${t.id}" target="_blank">#${t.id}</a> — ${escHtml(t.subject)}</li>`);
    });
    lines.push(`</ul>`);
  }

  lines.push(`<hr>`);
  lines.push(`<p><em>Auto-generated by Tech Support Command Center on ${new Date().toLocaleDateString('en-US')}. Review and edit before publishing.</em></p>`);
  return lines.join('\n');
}

function buildJiraArticleBody(issue) {
  const lines = [];
  const summary = issue.fields.summary || '';
  const desc = issue.fields.description || '';

  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>This issue was resolved as <strong>Works As Designed</strong> in Jira. Creating an internal article so agents can quickly identify and respond to this type of request.</p>`);

  lines.push(`<h2>Issue Summary</h2>`);
  lines.push(`<p>${escHtml(summary)}</p>`);

  if (desc) {
    lines.push(`<h2>Details</h2>`);
    // Jira descriptions can be long; truncate and clean up for HTML
    const cleanDesc = desc.substring(0, 2000).replace(/\n/g, '<br>');
    lines.push(`<p>${escHtml(cleanDesc).replace(/&lt;br&gt;/g, '<br>')}</p>`);
  }

  lines.push(`<h2>Resolution</h2>`);
  lines.push(`<p>This is <strong>working as designed</strong>. The behavior described is expected and intentional.</p>`);

  const components = (issue.fields.components || []).map(c => c.name);
  if (components.length) {
    lines.push(`<h2>Affected Components</h2>`);
    lines.push(`<ul>`);
    components.forEach(c => lines.push(`<li>${escHtml(c)}</li>`));
    lines.push(`</ul>`);
  }

  lines.push(`<h2>Related Resources</h2>`);
  lines.push(`<ul>`);
  lines.push(`<li><a href="https://autovitals.atlassian.net/browse/${issue.key}" target="_blank">Jira Issue: ${issue.key}</a></li>`);
  lines.push(`</ul>`);

  lines.push(`<hr>`);
  lines.push(`<p><em>Auto-generated from Jira "Works As Designed" issue by Tech Support Command Center on ${new Date().toLocaleDateString('en-US')}. Review and edit before publishing.</em></p>`);
  return lines.join('\n');
}

function buildFlaggedArticleBody(ticket, similarTickets) {
  const lines = [];

  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>This article was flagged by an agent for documentation. The original ticket and similar tickets suggest this is a recurring topic that needs a Help Center article.</p>`);

  lines.push(`<h2>Reported Issue</h2>`);
  lines.push(`<p>${escHtml(ticket.subject)}</p>`);

  if (ticket.description) {
    lines.push(`<h2>Details from Original Ticket</h2>`);
    const cleanDesc = ticket.description.substring(0, 1500).replace(/\n/g, '<br>');
    lines.push(`<p>${escHtml(cleanDesc).replace(/&lt;br&gt;/g, '<br>')}</p>`);
  }

  lines.push(`<h2>Troubleshooting Steps</h2>`);
  lines.push(`<p><strong>TODO:</strong> Add troubleshooting steps based on agent experience with this issue type.</p>`);
  lines.push(`<ol>`);
  lines.push(`<li>Step 1 — [Add step]</li>`);
  lines.push(`<li>Step 2 — [Add step]</li>`);
  lines.push(`<li>Step 3 — [Add step]</li>`);
  lines.push(`</ol>`);

  if (similarTickets && similarTickets.length > 1) {
    lines.push(`<h2>Similar Tickets (${similarTickets.length} found)</h2>`);
    lines.push(`<ul>`);
    similarTickets.slice(0, 8).forEach(t => {
      lines.push(`<li><a href="https://bayiq.zendesk.com/agent/tickets/${t.id}" target="_blank">#${t.id}</a> — ${escHtml(t.subject)}</li>`);
    });
    lines.push(`</ul>`);
  }

  lines.push(`<hr>`);
  lines.push(`<p><em>Flagged by agent via needs_article tag. Auto-generated by Tech Support Command Center on ${new Date().toLocaleDateString('en-US')}. Review and edit before publishing.</em></p>`);
  return lines.join('\n');
}

// ---- Source 1: Agent-flagged tickets (needs_article tag) ----
async function fetchFlaggedTickets() {
  const query = 'type:ticket tags:needs_article';
  let flagged = [];
  let url = `/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&per_page=50`;

  const data = await zdRequest(url);
  if (!data || !data.results) return [];

  flagged = data.results.map(t => ({
    id: t.id,
    subject: t.subject || '',
    description: (t.description || '').substring(0, 1500),
    status: t.status,
    tags: t.tags || [],
    createdAt: t.created_at,
    organizationId: t.organization_id,
  }));

  return flagged;
}

// Find tickets with similar subjects to a flagged ticket
async function findSimilarTickets(ticket) {
  // Extract key words from subject for searching
  const words = (ticket.subject || '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 4);

  if (words.length === 0) return [];

  const query = `type:ticket subject:"${words.join(' ')}"`;
  const url = `/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&per_page=20`;

  try {
    const data = await zdRequest(url);
    if (!data || !data.results) return [];
    return data.results
      .filter(t => t.id !== ticket.id)
      .map(t => ({
        id: t.id,
        subject: t.subject || '',
        status: t.status,
        createdAt: t.created_at,
      }));
  } catch {
    return [];
  }
}

// ---- Source 2: Jira "Works As Designed" issues ----
async function fetchJiraWAD() {
  if (!isJiraConfigured()) return [];

  try {
    const jql = 'status = "Works As Designed" ORDER BY updated DESC';
    const url = `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=25&fields=key,summary,description,status,updated,components,labels,project`;
    const data = await jiraRequest(url);

    if (!data || !data.issues) return [];
    return data.issues;
  } catch {
    return [];
  }
}

// ---- Source 3: Auto-detected repeat patterns ----
async function fetchPatternSuggestions(days, threshold) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const query = `type:ticket created>${since}`;

  let allTickets = [];
  let url = `/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&per_page=100`;

  for (let page = 0; page < 4 && url; page++) {
    const data = await zdRequest(url);
    if (!data || !data.results) break;
    const tickets = data.results.map(t => ({
      id: t.id,
      subject: t.subject || '',
      description: (t.description || '').substring(0, 500),
      status: t.status,
      priority: t.priority,
      tags: t.tags || [],
      createdAt: t.created_at,
      organizationId: t.organization_id,
    }));
    allTickets = allTickets.concat(tickets);
    url = data.next_page ? data.next_page.replace(/^https:\/\/[^/]+\/api\/v2/, '') : null;
  }

  const clusterer = new TicketClusterer();
  let clusters = clusterer.findClusters(allTickets);

  // Filter: minimum threshold, not "other", exclude POS integration patterns
  clusters = clusters.filter(c =>
    c.ticketCount >= threshold &&
    c.errorPattern !== 'other' &&
    !EXCLUDED_CATEGORIES.includes(c.category) &&
    !EXCLUDED_PATTERNS.includes(c.errorPattern)
  );

  return { clusters, totalTicketsScanned: allTickets.length };
}

// ---- Fetch existing HC articles ----
async function fetchExistingArticles() {
  let existingArticles = [];
  let hcUrl = '/help_center/articles.json?per_page=100';
  for (let page = 0; page < 5 && hcUrl; page++) {
    const data = await zdRequest(hcUrl);
    if (!data || !data.articles) break;
    existingArticles = existingArticles.concat(data.articles.map(a => ({
      id: a.id,
      title: a.title,
      sectionId: a.section_id,
      draft: a.draft,
      url: a.html_url,
    })));
    hcUrl = data.next_page ? data.next_page.replace(/^https:\/\/[^/]+\/api\/v2/, '') : null;
  }
  return existingArticles;
}

// ---- Main handler ----
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const days = parseInt(req.query.days || '30', 10);
    const threshold = parseInt(req.query.threshold || '5', 10);

    // Run all sources in parallel
    const [flaggedTickets, jiraIssues, patternData, existingArticles] = await Promise.all([
      fetchFlaggedTickets(),
      fetchJiraWAD(),
      fetchPatternSuggestions(days, threshold),
      fetchExistingArticles(),
    ]);

    // ---- Build Source 1: Agent-flagged suggestions ----
    const flaggedSuggestions = [];
    for (const ticket of flaggedTickets) {
      const similar = await findSimilarTickets(ticket);

      flaggedSuggestions.push({
        source: 'flagged',
        pattern: ticket.subject,
        errorPattern: ticket.subject,
        category: 'Agent Flagged',
        ticketCount: 1 + similar.length,
        sampleTickets: [
          { id: ticket.id, subject: ticket.subject, createdAt: ticket.createdAt },
          ...similar.slice(0, 4).map(t => ({ id: t.id, subject: t.subject, createdAt: t.createdAt })),
        ],
        suggestedTitle: 'Troubleshooting: ' + ticket.subject.replace(/^(re:|fwd:|fw:)\s*/i, '').substring(0, 80),
        suggestedBody: buildFlaggedArticleBody(ticket, similar),
        existingArticles: existingArticles.filter(a => fuzzyMatch(a.title, ticket.subject) >= 0.4),
        hasGap: true,
        flaggedTicketId: ticket.id,
      });
    }

    // ---- Build Source 2: Jira WAD suggestions ----
    const jiraSuggestions = jiraIssues.map(issue => {
      const summary = issue.fields.summary || '';
      return {
        source: 'jira-wad',
        pattern: `${issue.key}: ${summary}`,
        errorPattern: summary,
        category: 'Works As Designed',
        jiraKey: issue.key,
        jiraUrl: `https://autovitals.atlassian.net/browse/${issue.key}`,
        ticketCount: 0,
        sampleTickets: [],
        suggestedTitle: 'Works As Designed: ' + summary.substring(0, 80),
        suggestedBody: buildJiraArticleBody(issue),
        existingArticles: existingArticles.filter(a => fuzzyMatch(a.title, summary) >= 0.4),
        hasGap: true,
        updatedAt: issue.fields.updated,
      };
    });

    // ---- Build Source 3: Auto-detected pattern suggestions ----
    const { clusters, totalTicketsScanned } = patternData;
    const patternSuggestions = clusters.map(cluster => {
      const meta = RULE_META[cluster.errorPattern] || {
        title: 'Troubleshooting: ' + cluster.errorPattern,
        category: cluster.category,
        runbook: null,
        action: null,
      };

      const matchingArticles = existingArticles
        .filter(a => fuzzyMatch(a.title, cluster.errorPattern) >= 0.5)
        .map(a => ({ id: a.id, title: a.title, url: a.url, draft: a.draft }));

      return {
        source: 'pattern',
        pattern: cluster.pattern,
        errorPattern: cluster.errorPattern,
        category: meta.category || cluster.category,
        ticketCount: cluster.ticketCount,
        orgCount: cluster.orgCount,
        sampleTickets: cluster.tickets.slice(0, 5).map(t => ({
          id: t.id,
          subject: t.subject,
          createdAt: t.createdAt,
        })),
        runbookUrl: meta.runbook || null,
        suggestedTitle: meta.title,
        suggestedBody: buildArticleBody(meta, {
          ...cluster,
          sampleTickets: cluster.tickets.slice(0, 5),
        }),
        existingArticles: matchingArticles,
        hasGap: matchingArticles.length === 0,
      };
    });

    // Sort patterns: gaps first, then by ticket count
    patternSuggestions.sort((a, b) => {
      if (a.hasGap !== b.hasGap) return a.hasGap ? -1 : 1;
      return b.ticketCount - a.ticketCount;
    });

    const totalGaps = flaggedSuggestions.length +
      jiraSuggestions.filter(s => s.existingArticles.length === 0).length +
      patternSuggestions.filter(s => s.hasGap).length;

    res.setHeader('Cache-Control', 's-maxage=300');
    res.json({
      flagged: flaggedSuggestions,
      jiraWAD: jiraSuggestions,
      patterns: patternSuggestions,
      totalGaps,
      totalTicketsScanned,
      jiraConfigured: isJiraConfigured(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
