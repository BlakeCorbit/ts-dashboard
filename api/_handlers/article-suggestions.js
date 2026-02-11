// article-suggestions.js — GET /api/article-suggestions?days=30
// Analyzes recent tickets, finds repeat patterns, cross-references against
// existing Help Center articles, and returns gaps with suggested article content.

const { zdRequest } = require('../_zendesk');
const { TicketClusterer } = require('../_clusterer');

// Triage rules mapped inline (avoids cross-module require from ticket-triage)
const RULE_META = {
  'ROs not showing':     { title: 'Troubleshooting: ROs Not Showing', category: 'POS Integration', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2558230545', action: 'Identify POS type (shop.autovitals.com > EIS Shops). Use Retool Broken Shop App. Follow Binary Troubleshooting or Partner API troubleshooting based on integration type.' },
  'Data not syncing':    { title: 'Troubleshooting: Data Not Syncing', category: 'POS Integration', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2505408515', action: 'Check Binary health in Retool. Verify binary client running on shop server. Check #alerts-bin-service. For Partner API shops, verify API key and endpoint health.' },
  'TVP issues':          { title: 'Troubleshooting: TVP Page Issues', category: 'Platform', runbook: null, action: 'Check if TVP loads at all or shows errors. Try clear cache (shop.autovitals.com/services/clearCache.asmx/Shop?shopid=X). Check browser compatibility. Verify shop is active.' },
  'Email delivery':      { title: 'Troubleshooting: Email Delivery Issues', category: 'Email/SMS', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/838270999', action: 'Identify email config type (AV-managed Google, promoted domain, or 3rd party). Check Mailgun domain status. Verify DNS records in Cloudflare/GoDaddy.' },
  'SMS delivery':        { title: 'Troubleshooting: SMS/Text Delivery Issues', category: 'Email/SMS', runbook: null, action: 'Check Twilio number status in AMD (shop.autovitals.com). Verify messaging service configured. Check Twilio console for delivery errors. Test outbound message.' },
  'Login/access':        { title: 'Troubleshooting: Login and Access Issues', category: 'Login/Access', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/847740929', action: 'Determine platform (TVP.x vs Legacy). Verify user exists in POS and AV. Try: update from POS button, verify welcome code, check if account active.' },
  'Inspection issues':   { title: 'Troubleshooting: Inspection Issues', category: 'Platform', runbook: null, action: 'Determine specific issue: missing inspection, wrong status, template problem, or delivery issue. Check if inspection sheet configured correctly in shop settings.' },
  'Reminders/campaigns': { title: 'Troubleshooting: Reminders and Campaigns', category: 'Email/SMS', runbook: null, action: 'Check reminder settings in shop.autovitals.com > Settings > Communication. Verify Twilio number in AMD. Check campaign settings in campaignmanager2.autovitals.com.' },
  'Chat issues':         { title: 'Troubleshooting: Chat and Conversation Center', category: 'Platform', runbook: null, action: 'Check Conversation Center status. Verify chat enabled for shop. Try clearing browser cache. Check if issue is with sending or receiving messages.' },
  'Performance/errors':  { title: 'Troubleshooting: Performance and Error Codes', category: 'Platform', runbook: null, action: 'Check for system-wide issues first (StatusPage). If shop-specific: clear cache, try different browser. If 500/503/504: likely backend issue — escalate to engineering.' },
  'Appointments':        { title: 'Troubleshooting: Appointment Issues', category: 'Platform', runbook: null, action: 'Check appointment settings in shop config. Verify POS integration sending appointment data. Check if issue is with scheduling, confirmations, or reminders.' },
  'Binary integration':  { title: 'Troubleshooting: Binary Integration Issues', category: 'POS Integration', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2505408515', action: 'Check binary client status on shop server. Verify FTP data flow. Check #alerts-bin-service. Use Retool Broken Shop App for diagnostics.' },
  'Partner API':         { title: 'Troubleshooting: Partner API Issues', category: 'POS Integration', runbook: null, action: 'Check Partner API health dashboard. Verify API key is valid. Check if POS vendor has known outages. Test API connectivity from Retool.' },
  'Media upload':        { title: 'Troubleshooting: Media Upload Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known AV.X bugs list. Get device model, OS version, app version. Try: check storage space, permissions, restart app. Verify Wi-Fi connectivity.' },
  'Camera/photo issues': { title: 'Troubleshooting: AV.X Camera and Photo Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known AV.X bugs. AV.X 6.9.6: image quality differs from preview. Get device info. Try: check storage space, camera permissions, restart app.' },
  'Notification issues': { title: 'Troubleshooting: Notification and Alert Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known AV.X bugs. Verify notification permissions on device. Check if issue is with push notifications, in-app alerts, or email notifications.' },
  'Audio/video issues':  { title: 'Troubleshooting: AV.X Audio and Video Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Known bug in AV.X 6.9.6 — videos recording without sound. No fix yet. Document device info and link to existing JIRA if available.' },
  'App freezing/crashing': { title: 'Troubleshooting: AV.X Crash and Freeze Issues', category: 'App Issue', runbook: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169', action: 'Check known bugs list. Get device model, OS version, app version. Try: force close, clear cache, reinstall. If reproducible, create JIRA with steps.' },
};

function buildArticleBody(meta, cluster) {
  const lines = [];
  lines.push(`<h2>Overview</h2>`);
  lines.push(`<p>This article covers troubleshooting steps for <strong>${cluster.errorPattern}</strong> issues${cluster.pos ? ' related to <strong>' + cluster.pos + '</strong>' : ''}. This pattern has been identified as a frequent support topic.</p>`);

  lines.push(`<h2>Symptoms</h2>`);
  lines.push(`<ul>`);
  lines.push(`<li>Tickets matching pattern: <strong>${cluster.errorPattern}</strong></li>`);
  if (cluster.pos) lines.push(`<li>Affected POS system: <strong>${cluster.pos}</strong></li>`);
  if (cluster.category) lines.push(`<li>Category: <strong>${meta.category || cluster.category}</strong></li>`);
  lines.push(`<li>Recent volume: <strong>${cluster.ticketCount}</strong> tickets from <strong>${cluster.orgCount}</strong> shop(s)</li>`);
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

  lines.push(`<h2>Sample Tickets</h2>`);
  lines.push(`<ul>`);
  cluster.tickets.slice(0, 5).forEach(t => {
    lines.push(`<li><a href="https://bayiq.zendesk.com/agent/tickets/${t.id}" target="_blank">#${t.id}</a> — ${escHtml(t.subject)}</li>`);
  });
  lines.push(`</ul>`);

  lines.push(`<hr>`);
  lines.push(`<p><em>Auto-generated by Tech Support Command Center on ${new Date().toLocaleDateString('en-US')}. Review and edit before publishing.</em></p>`);

  return lines.join('\n');
}

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const days = parseInt(req.query.days || '30', 10);
    const threshold = parseInt(req.query.threshold || '5', 10);

    // 1. Fetch recent tickets (solved + unsolved)
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
        type: t.type,
      }));
      allTickets = allTickets.concat(tickets);
      url = data.next_page ? data.next_page.replace(/^https:\/\/[^/]+\/api\/v2/, '') : null;
    }

    // 2. Cluster tickets by pattern
    const clusterer = new TicketClusterer();
    let clusters = clusterer.findClusters(allTickets);
    clusters = clusters.filter(c => c.ticketCount >= threshold && c.errorPattern !== 'other');

    // 3. Fetch existing Help Center articles
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

    // 4. For each cluster, check for matching articles + build suggestion
    const suggestions = [];
    for (const cluster of clusters) {
      const meta = RULE_META[cluster.errorPattern] || {
        title: 'Troubleshooting: ' + cluster.errorPattern,
        category: cluster.category,
        runbook: null,
        action: null,
      };

      // Fuzzy match against existing articles
      const matchingArticles = existingArticles
        .filter(a => fuzzyMatch(a.title, cluster.errorPattern) >= 0.5)
        .map(a => ({ id: a.id, title: a.title, url: a.url, draft: a.draft }));

      const suggestedTitle = cluster.pos
        ? meta.title + ' (' + cluster.pos + ')'
        : meta.title;

      suggestions.push({
        pattern: cluster.pattern,
        errorPattern: cluster.errorPattern,
        category: meta.category || cluster.category,
        pos: cluster.pos,
        ticketCount: cluster.ticketCount,
        orgCount: cluster.orgCount,
        sampleTickets: cluster.tickets.slice(0, 5).map(t => ({
          id: t.id,
          subject: t.subject,
          createdAt: t.createdAt,
        })),
        runbookUrl: meta.runbook || null,
        suggestedTitle,
        suggestedBody: buildArticleBody(meta, cluster),
        existingArticles: matchingArticles,
        hasGap: matchingArticles.length === 0,
      });
    }

    // Sort: gaps first, then by ticket count
    suggestions.sort((a, b) => {
      if (a.hasGap !== b.hasGap) return a.hasGap ? -1 : 1;
      return b.ticketCount - a.ticketCount;
    });

    const gapCount = suggestions.filter(s => s.hasGap).length;

    res.setHeader('Cache-Control', 's-maxage=300');
    res.json({
      suggestions,
      totalPatterns: suggestions.length,
      coveredPatterns: suggestions.length - gapCount,
      gapCount,
      totalTicketsScanned: allTickets.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
