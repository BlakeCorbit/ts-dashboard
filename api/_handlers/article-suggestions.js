// article-suggestions.js — GET /api/article-suggestions?days=30
// Returns article suggestions from three sources:
//   1. Agent-flagged tickets (needs_article tag in Zendesk)
//   2. Jira "Works As Designed" issues
//   3. Auto-detected repeat patterns (filtered: no POS integration)
//
// Each suggestion includes two body versions:
//   suggestedBodyInternal — for Confluence (includes ticket links, Jira refs, runbook links)
//   suggestedBodyExternal — for ZD Help Center (customer-facing, no internal refs)

const { zdRequest } = require('../_zendesk');
const { jiraRequest, isJiraConfigured } = require('../_jira');
const { TicketClusterer } = require('../_clusterer');

// Categories to EXCLUDE from auto-detected suggestions (shop-specific, not KB material)
const EXCLUDED_CATEGORIES = ['pos'];
const EXCLUDED_PATTERNS = [
  'ROs not showing', 'Data not syncing', 'Binary integration', 'Partner API',
];

// ZD section mapping — maps ticket patterns to the best-fit Help Center sections
// IDs from sections.json; used for smart placement and section-aware matching
const PATTERN_SECTIONS = {
  'TVP issues':          [{ id: 360013552372, name: 'TVP.X' }, { id: 4409181653012, name: 'TVP Display Settings' }, { id: 4417800652564, name: 'TVP.X Settings' }],
  'Email delivery':      [{ id: 4409181801108, name: 'Customer Communication' }, { id: 4414776161044, name: 'Thank You Messages and Reviews' }],
  'SMS delivery':        [{ id: 4409181801108, name: 'Customer Communication' }],
  'Login/access':        [{ id: 4403287293972, name: 'AutoVitals Settings' }, { id: 4417812763540, name: 'Business Control Panel' }],
  'Inspection issues':   [{ id: 11734471307412, name: 'Inspection Results' }, { id: 4409295139476, name: 'Editing Inspection Sheets' }],
  'Reminders/campaigns': [{ id: 4417885812244, name: 'Service Reminders' }, { id: 4411219332756, name: 'Campaigns' }],
  'Chat issues':         [{ id: 18374589671316, name: 'Conversation Center' }, { id: 4409182176020, name: 'Internal Shop Communication' }],
  'Performance/errors':  [{ id: 360013552372, name: 'TVP.X' }],
  'Appointments':        [{ id: 4410295511956, name: 'Appointments' }],
  'Media upload':        [{ id: 360013773092, name: 'Settings' }],  // AV.X App
  'Camera/photo issues': [{ id: 360013773092, name: 'Settings' }],  // AV.X App
  'Notification issues': [{ id: 360013773092, name: 'Settings' }],  // AV.X App
  'Audio/video issues':  [{ id: 360013773092, name: 'Settings' }],  // AV.X App
  'App freezing/crashing': [{ id: 360013773092, name: 'Settings' }], // AV.X App
};

// Stale threshold: articles not updated in this many days are candidates for refresh
const STALE_DAYS = 365;

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

// Customer-facing action rewrites (friendlier language, no internal tools)
const CUSTOMER_ACTIONS = {
  'TVP issues':            'Refresh the page and clear your browser cache. Try a different browser (Chrome recommended). If the page still doesn\'t load, please contact support.',
  'Email delivery':        'Check your spam/junk folder for any AutoVitals emails. Verify your email address is correct in your account settings. If you\'re still not receiving emails, contact our support team so we can verify your email configuration.',
  'SMS delivery':          'Verify your phone number is correct in your account settings. Check that you haven\'t blocked the sending number. If texts are still not coming through, contact our support team.',
  'Login/access':          'Try resetting your password using the "Forgot Password" link. Make sure you\'re using the correct login page for your account type. Clear your browser cache and cookies, then try again.',
  'Inspection issues':     'Refresh the inspection page and check that all required fields are filled in. If an inspection is missing or showing the wrong status, try closing and reopening the work order.',
  'Reminders/campaigns':   'Check your communication preferences in your account settings. Verify your contact information is up to date. If reminders are not being sent as expected, please contact support.',
  'Chat issues':           'Refresh the page and check your internet connection. Try clearing your browser cache. If the chat feature is still not working, try using a different browser.',
  'Performance/errors':    'Refresh the page and clear your browser cache. Try using a different browser (Chrome is recommended). If you\'re seeing error messages, please note the error code and contact support.',
  'Appointments':          'Check that your appointment details are correct. If an appointment isn\'t showing up, try refreshing the page. For scheduling issues, contact your service advisor or our support team.',
  'Media upload':          'Check that your device has enough storage space. Make sure the app has permission to access your camera and photos. Try restarting the app. Ensure you have a stable Wi-Fi or cellular connection.',
  'Camera/photo issues':   'Make sure the app has camera permissions enabled in your device settings. Check that your device has enough storage space. Try restarting the app. If photo quality looks different than expected, this is a known issue we\'re working on.',
  'Notification issues':   'Check that notifications are enabled for the app in your device settings. Make sure "Do Not Disturb" is turned off. Try restarting the app.',
  'Audio/video issues':    'This is a known issue we\'re currently working to resolve. In the meantime, you can try restarting the app before recording. If videos are recording without sound, please contact support.',
  'App freezing/crashing': 'Try force-closing the app and reopening it. Make sure your app and device operating system are updated to the latest version. If the issue persists, try uninstalling and reinstalling the app.',
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

// Section-aware scoring: combines title match + section relevance + staleness
function scoreArticle(article, errorPattern) {
  const titleScore = fuzzyMatch(article.title, errorPattern);
  const sections = PATTERN_SECTIONS[errorPattern] || [];
  const inRelevantSection = sections.some(s => s.id === article.sectionId);
  const sectionBoost = inRelevantSection ? 0.25 : 0;

  // Stale articles are still matches but flagged for update
  const updatedAt = article.updatedAt ? new Date(article.updatedAt) : null;
  const ageMs = updatedAt ? Date.now() - updatedAt.getTime() : Infinity;
  const isStale = ageMs > STALE_DAYS * 86400000;

  const totalScore = Math.min(titleScore + sectionBoost, 1.0);
  return { score: totalScore, inRelevantSection, isStale };
}

// Determine recommended action for a suggestion based on existing articles
function recommendAction(existingArticles, errorPattern) {
  const sections = PATTERN_SECTIONS[errorPattern] || [];
  const scored = existingArticles.map(a => ({
    ...a,
    ...scoreArticle(a, errorPattern),
  }));

  // Strong match (>= 0.5): article exists covering this topic
  const strongMatches = scored.filter(a => a.score >= 0.5);

  if (strongMatches.length > 0) {
    // Sort by score desc, prefer stale articles (update candidates)
    strongMatches.sort((a, b) => {
      if (a.isStale !== b.isStale) return a.isStale ? -1 : 1;
      return b.score - a.score;
    });
    const best = strongMatches[0];
    if (best.isStale) {
      return {
        action: 'update_existing',
        targetArticle: { id: best.id, title: best.title, url: best.url, sectionId: best.sectionId, score: best.score },
        recommendedSection: sections[0] || null,
        relatedArticles: strongMatches.slice(0, 5),
      };
    }
    // Good match, not stale — already covered
    return {
      action: 'already_covered',
      targetArticle: { id: best.id, title: best.title, url: best.url, sectionId: best.sectionId, score: best.score },
      recommendedSection: sections[0] || null,
      relatedArticles: strongMatches.slice(0, 5),
    };
  }

  // Weak matches (0.3-0.5): might be adjacent — suggest create new but show related
  const weakMatches = scored.filter(a => a.score >= 0.3 && a.score < 0.5);

  return {
    action: 'create_new',
    targetArticle: null,
    recommendedSection: sections[0] || null,
    relatedArticles: weakMatches.slice(0, 5),
  };
}

// ---- Internal body builders (agent-focused) ----

function buildArticleBodyInternal(meta, cluster) {
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

// ---- Customer-facing body builders ----

function buildArticleBodyExternal(meta, cluster) {
  const pattern = cluster.errorPattern || cluster.pattern;
  const customerAction = CUSTOMER_ACTIONS[cluster.errorPattern] || null;
  const lines = [];

  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>If you're experiencing issues with <strong>${escHtml(pattern)}</strong>, this guide will help you resolve the problem.</p>`);

  lines.push(`<h2>Symptoms</h2>`);
  lines.push(`<p>You may be experiencing one or more of the following:</p>`);
  lines.push(`<ul>`);
  lines.push(`<li>${escHtml(pattern)} not working as expected</li>`);
  if (meta.category) lines.push(`<li>Issues related to: <strong>${escHtml(meta.category)}</strong></li>`);
  lines.push(`</ul>`);

  lines.push(`<h2>Resolution Steps</h2>`);
  if (customerAction) {
    const steps = customerAction.split('. ').filter(Boolean);
    lines.push(`<ol>`);
    steps.forEach(s => lines.push(`<li>${s.trim().replace(/\.$/, '')}.</li>`));
    lines.push(`</ol>`);
  } else if (meta.action) {
    // Fallback: use internal steps but clean up internal tool references
    const steps = meta.action.split('. ').filter(Boolean);
    lines.push(`<ol>`);
    steps.forEach(s => {
      let clean = s.trim().replace(/\.$/, '');
      // Remove internal URLs and tool references
      clean = clean.replace(/\(.*?autovitals\.com.*?\)/g, '');
      clean = clean.replace(/shop\.autovitals\.com\S*/g, 'your account settings');
      lines.push(`<li>${clean}.</li>`);
    });
    lines.push(`</ol>`);
  } else {
    lines.push(`<p>Please contact our support team for assistance with this issue.</p>`);
  }

  lines.push(`<h2>Still Need Help?</h2>`);
  lines.push(`<p>If the steps above didn't resolve your issue, please <a href="https://bayiq.zendesk.com/hc/en-us/requests/new">submit a support request</a> and our team will be happy to assist you.</p>`);

  return lines.join('\n');
}

// Extract plain text from Jira v3 ADF (Atlassian Document Format) description
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (!node.content || !Array.isArray(node.content)) return '';
  return node.content.map(adfToText).join(node.type === 'paragraph' ? '\n' : ' ').trim();
}

function buildJiraArticleBodyInternal(issue) {
  const lines = [];
  const summary = issue.fields.summary || '';
  const desc = adfToText(issue.fields.description);

  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>This issue was resolved as <strong>Works As Designed</strong> in Jira. Creating an internal article so agents can quickly identify and respond to this type of request.</p>`);

  lines.push(`<h2>Issue Summary</h2>`);
  lines.push(`<p>${escHtml(summary)}</p>`);

  if (desc) {
    lines.push(`<h2>Details</h2>`);
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

function buildJiraArticleBodyExternal(issue) {
  const lines = [];
  const summary = issue.fields.summary || '';

  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>This article explains the expected behavior for: <strong>${escHtml(summary)}</strong></p>`);

  lines.push(`<h2>Details</h2>`);
  lines.push(`<p>The behavior you're seeing is working as designed. This is the expected functionality of the system.</p>`);

  // Try to extract a useful explanation from the description
  const desc = adfToText(issue.fields.description);
  if (desc) {
    // Only include description if it doesn't contain internal jargon
    const cleanDesc = desc.substring(0, 800)
      .replace(/SID:\s*\d+/gi, '')
      .replace(/RO#?\s*\d+/gi, '')
      .replace(/Shop Name:.*$/gm, '')
      .trim();
    if (cleanDesc.length > 50) {
      lines.push(`<h2>Additional Information</h2>`);
      lines.push(`<p>${escHtml(cleanDesc).replace(/\n/g, '<br>')}</p>`);
    }
  }

  lines.push(`<h2>Still Need Help?</h2>`);
  lines.push(`<p>If you believe this behavior is incorrect or need further assistance, please <a href="https://bayiq.zendesk.com/hc/en-us/requests/new">submit a support request</a> and our team will review your specific situation.</p>`);

  return lines.join('\n');
}

function buildFlaggedArticleBodyInternal(ticket, similarTickets) {
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

function buildFlaggedArticleBodyExternal(ticket) {
  const lines = [];
  // Clean up the subject line for a title
  const topic = (ticket.subject || 'this issue').replace(/^(re:|fwd:|fw:)\s*/i, '');

  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>This article provides guidance for resolving issues related to: <strong>${escHtml(topic)}</strong></p>`);

  lines.push(`<h2>Resolution Steps</h2>`);
  lines.push(`<p>Please try the following steps to resolve this issue:</p>`);
  lines.push(`<ol>`);
  lines.push(`<li>Refresh the page or restart the application.</li>`);
  lines.push(`<li>Clear your browser cache and cookies.</li>`);
  lines.push(`<li>Try using a different browser (Chrome is recommended).</li>`);
  lines.push(`<li>If the issue persists, please contact our support team with details about what you're experiencing.</li>`);
  lines.push(`</ol>`);

  lines.push(`<h2>Still Need Help?</h2>`);
  lines.push(`<p>If the steps above didn't resolve your issue, please <a href="https://bayiq.zendesk.com/hc/en-us/requests/new">submit a support request</a> with a description of the problem and our team will be happy to assist you.</p>`);

  return lines.join('\n');
}

// ---- Source 1: Agent-flagged tickets (needs_article tag) ----
async function fetchFlaggedTickets() {
  const query = 'type:ticket tags:needs_article';
  const url = `/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&per_page=50`;

  const data = await zdRequest(url);
  if (!data || !data.results) return [];

  return data.results.map(t => ({
    id: t.id,
    subject: t.subject || '',
    description: (t.description || '').substring(0, 1500),
    status: t.status,
    tags: t.tags || [],
    createdAt: t.created_at,
    organizationId: t.organization_id,
  }));
}

// Find tickets with similar subjects to a flagged ticket
async function findSimilarTickets(ticket) {
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
      updatedAt: a.updated_at,
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

      // Use clusterer to detect the pattern from the ticket subject
      const clusterer = new TicketClusterer();
      const detectedPattern = clusterer.extractErrorPattern(ticket);
      const flaggedRec = recommendAction(existingArticles, detectedPattern !== 'other' ? detectedPattern : ticket.subject);

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
        suggestedBodyInternal: buildFlaggedArticleBodyInternal(ticket, similar),
        suggestedBodyExternal: buildFlaggedArticleBodyExternal(ticket),
        existingArticles: existingArticles.filter(a => fuzzyMatch(a.title, ticket.subject) >= 0.4),
        hasGap: flaggedRec.action !== 'already_covered',
        flaggedTicketId: ticket.id,
        recommendedAction: flaggedRec.action === 'already_covered' ? 'create_new' : flaggedRec.action, // flagged = always allow create
        recommendedSection: flaggedRec.recommendedSection,
        updateTarget: flaggedRec.targetArticle,
        relatedArticles: (flaggedRec.relatedArticles || []).map(a => ({
          id: a.id, title: a.title, url: a.url, score: a.score, isStale: a.isStale,
        })),
      });
    }

    // ---- Build Source 2: Jira WAD suggestions ----
    const jiraSuggestions = jiraIssues.map(issue => {
      const summary = issue.fields.summary || '';
      const jiraRec = recommendAction(existingArticles, summary);
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
        suggestedBodyInternal: buildJiraArticleBodyInternal(issue),
        suggestedBodyExternal: buildJiraArticleBodyExternal(issue),
        existingArticles: existingArticles.filter(a => fuzzyMatch(a.title, summary) >= 0.4),
        hasGap: jiraRec.action !== 'already_covered',
        updatedAt: issue.fields.updated,
        recommendedAction: jiraRec.action,
        recommendedSection: jiraRec.recommendedSection,
        updateTarget: jiraRec.targetArticle,
        relatedArticles: (jiraRec.relatedArticles || []).map(a => ({
          id: a.id, title: a.title, url: a.url, score: a.score, isStale: a.isStale,
        })),
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

      const recommendation = recommendAction(existingArticles, cluster.errorPattern);

      // Legacy field: existingArticles for backward compat
      const matchingArticles = recommendation.relatedArticles
        .filter(a => a.score >= 0.5)
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
        suggestedBodyInternal: buildArticleBodyInternal(meta, {
          ...cluster,
          sampleTickets: cluster.tickets.slice(0, 5),
        }),
        suggestedBodyExternal: buildArticleBodyExternal(meta, cluster),
        existingArticles: matchingArticles,
        hasGap: recommendation.action === 'create_new',
        recommendedAction: recommendation.action,
        recommendedSection: recommendation.recommendedSection,
        updateTarget: recommendation.targetArticle,
        relatedArticles: recommendation.relatedArticles.map(a => ({
          id: a.id, title: a.title, url: a.url, score: a.score, isStale: a.isStale,
        })),
      };
    });

    // Sort patterns: create_new first, then update_existing, then covered; by ticket count within
    const ACTION_PRIORITY = { create_new: 0, update_existing: 1, already_covered: 2 };
    patternSuggestions.sort((a, b) => {
      const pa = ACTION_PRIORITY[a.recommendedAction] ?? 2;
      const pb = ACTION_PRIORITY[b.recommendedAction] ?? 2;
      if (pa !== pb) return pa - pb;
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
