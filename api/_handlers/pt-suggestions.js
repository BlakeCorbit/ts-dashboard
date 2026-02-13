// pt-suggestions.js — GET /api/pt-suggestions
// Finds tickets that share a Jira issue but have no Problem Ticket linking them.
// These are candidates for a new Problem Ticket.

const { zdRequest, getJiraLinks } = require('../_zendesk');
const { jiraRequest, isJiraConfigured } = require('../_jira');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const days = parseInt(req.query.days || '14', 10);
    const since = new Date(Date.now() - days * 24 * 3600000);
    const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');

    // 1. Fetch recent open/pending/new tickets (exclude problem tickets and solved/closed)
    const searchQuery = `type:ticket -ticket_type:problem status<solved created>${sinceStr}`;
    const data = await zdRequest('/search.json', {
      params: {
        query: searchQuery,
        sort_by: 'created_at',
        sort_order: 'desc',
        per_page: '100',
      },
    });

    const tickets = data.results || [];
    if (!tickets.length) {
      return res.json({ suggestions: [], generatedAt: new Date().toISOString() });
    }

    // 2. Pre-filter: tickets with any Jira-related tag (jira_auto_linked, jira-linked, jira_*, etc.)
    const jiraTagged = tickets.filter(t =>
      (t.tags || []).some(tag => tag.startsWith('jira'))
    );

    // Scan all Jira-tagged tickets; fall back to all tickets if none tagged
    const toScan = jiraTagged.length > 0 ? jiraTagged : tickets;

    // Get Jira links for relevant tickets (batched)
    const ticketJiraMap = {}; // ticketId -> [{ issueId, issueKey, url }]
    const batchSize = 10;
    for (let i = 0; i < toScan.length; i += batchSize) {
      const batch = toScan.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(t => getJiraLinks(t.id).then(links => ({ id: t.id, links })))
      );
      results.forEach(r => { ticketJiraMap[r.id] = r.links; });
    }

    // 3. Group tickets by Jira issue key
    const jiraGroups = {}; // issueKey -> { issueKey, issueId, url, tickets: [] }
    toScan.forEach(t => {
      const links = ticketJiraMap[t.id] || [];
      links.forEach(link => {
        if (!jiraGroups[link.issueKey]) {
          jiraGroups[link.issueKey] = {
            issueKey: link.issueKey,
            issueId: link.issueId,
            jiraUrl: link.url,
            tickets: [],
          };
        }
        jiraGroups[link.issueKey].tickets.push({
          id: t.id,
          subject: t.subject,
          status: t.status,
          priority: t.priority,
          createdAt: t.created_at,
          problemId: t.problem_id || null,
        });
      });
    });

    // 4. Filter: only groups with 2+ tickets that DON'T already share a Problem Ticket
    const suggestions = [];
    for (const key of Object.keys(jiraGroups)) {
      const group = jiraGroups[key];
      if (group.tickets.length < 2) continue;

      // Check if tickets already share a common problem_id
      const problemIds = new Set(
        group.tickets.map(t => t.problemId).filter(Boolean)
      );

      // If ALL tickets already link to the same problem, skip
      if (problemIds.size === 1 && group.tickets.every(t => t.problemId)) {
        continue;
      }

      // Count how many are unlinked (no problem_id)
      const unlinked = group.tickets.filter(t => !t.problemId);

      suggestions.push({
        issueKey: group.issueKey,
        issueId: group.issueId,
        jiraUrl: group.jiraUrl,
        totalTickets: group.tickets.length,
        unlinkedCount: unlinked.length,
        tickets: group.tickets,
        issueSummary: null, // populated below
      });
    }

    // 4b. Fetch Jira issue summaries for each suggestion
    if (isJiraConfigured() && suggestions.length > 0) {
      const summaryBatch = 5;
      for (let i = 0; i < suggestions.length; i += summaryBatch) {
        const batch = suggestions.slice(i, i + summaryBatch);
        const results = await Promise.allSettled(
          batch.map(s =>
            jiraRequest(`/issue/${s.issueKey}?fields=summary`)
              .then(data => ({ key: s.issueKey, summary: data && data.fields && data.fields.summary }))
          )
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.summary) {
            const match = suggestions.find(s => s.issueKey === r.value.key);
            if (match) match.issueSummary = r.value.summary;
          }
        }
      }
    }

    // Sort by total ticket count descending
    suggestions.sort((a, b) => b.totalTickets - a.totalTickets);

    const withJira = Object.keys(ticketJiraMap).filter(id => ticketJiraMap[id].length > 0).length;

    res.json({
      suggestions,
      scannedTickets: tickets.length,
      jiraLinkedTickets: withJira,
      days,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
