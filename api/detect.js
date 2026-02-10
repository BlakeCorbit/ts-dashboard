// detect.js — GET /api/detect?hours=4&threshold=3
// Cluster detection endpoint: fetches recent tickets, runs clustering,
// filters out clusters matching existing Problem tickets.

const { zdRequest } = require('./_zendesk');
const { TicketClusterer } = require('./_clusterer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const hours = parseInt(req.query.hours || '4', 10);
    const threshold = parseInt(req.query.threshold || '3', 10);

    // Fetch recent tickets
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const query = `type:ticket created>${since} status<solved`;

    let allTickets = [];
    let url = `/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&per_page=100`;

    // Paginate up to 4 pages (400 tickets)
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
        problemId: t.problem_id,
      }));
      allTickets = allTickets.concat(tickets);
      url = data.next_page ? data.next_page.replace(/^https:\/\/[^/]+\/api\/v2/, '') : null;
    }

    // Filter out tickets that are already linked to a Problem
    const unlinked = allTickets.filter(t => !t.problemId && t.type !== 'problem');

    // Run clustering
    const clusterer = new TicketClusterer();
    let clusters = clusterer.findClusters(unlinked);

    // Apply threshold
    clusters = clusters.filter(c => c.ticketCount >= threshold);

    // Fetch active Problem tickets to filter out clusters that match existing problems
    const problemData = await zdRequest('/search.json?query=' + encodeURIComponent('type:ticket ticket_type:problem status<solved') + '&per_page=25');
    const activeProblems = (problemData && problemData.results) ? problemData.results : [];

    // Filter: remove clusters where an existing Problem ticket matches the error pattern
    if (activeProblems.length > 0) {
      clusters = clusters.filter(cluster => {
        const pattern = cluster.errorPattern.toLowerCase();
        const pos = (cluster.pos || '').toLowerCase();
        return !activeProblems.some(p => {
          const subj = (p.subject || '').toLowerCase();
          return subj.includes(pattern) || (pos && subj.includes(pos) && pattern !== 'other');
        });
      });
    }

    // Simplify ticket data in response
    clusters.forEach(c => {
      c.tickets = c.tickets.map(t => ({
        id: t.id,
        subject: t.subject,
        createdAt: t.createdAt,
        priority: t.priority,
        organizationId: t.organizationId,
      }));
    });

    res.json({ clusters, totalScanned: allTickets.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
