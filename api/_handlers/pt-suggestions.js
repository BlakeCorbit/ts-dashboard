// pt-suggestions.js — GET /api/pt-suggestions
// Finds tickets that share a Jira issue but have no Problem Ticket linking them.
// These are candidates for a new Problem Ticket.

const { zdRequest, getJiraLinks } = require('../_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const days = parseInt(req.query.days || '14', 10);
    const since = new Date(Date.now() - days * 24 * 3600000);
    const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');

    // 1. Fetch recent open/pending/new tickets (non-problem, non-closed)
    const searchQuery = `type:ticket ticket_type:incident ticket_type:question ticket_type:task created>${sinceStr} status<solved`;
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

    // 2. Get Jira links for all tickets (batched to avoid rate limits)
    const ticketJiraMap = {}; // ticketId -> [{ issueId, issueKey, url }]
    const batchSize = 10;
    for (let i = 0; i < tickets.length; i += batchSize) {
      const batch = tickets.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(t => getJiraLinks(t.id).then(links => ({ id: t.id, links })))
      );
      results.forEach(r => { ticketJiraMap[r.id] = r.links; });
    }

    // 3. Group tickets by Jira issue key
    const jiraGroups = {}; // issueKey -> { issueKey, issueId, url, tickets: [] }
    tickets.forEach(t => {
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
      });
    }

    // Sort by total ticket count descending
    suggestions.sort((a, b) => b.totalTickets - a.totalTickets);

    res.json({
      suggestions,
      scannedTickets: tickets.length,
      days,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
