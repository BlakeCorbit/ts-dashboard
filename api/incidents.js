const { zdRequest, getJiraLinks } = require('./_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const data = await zdRequest('/search.json', {
      params: {
        query: 'type:ticket ticket_type:problem status<solved',
        sort_by: 'created_at',
        sort_order: 'desc',
        per_page: '25',
      },
    });

    const problems = data.results || [];
    const incidents = await Promise.all(problems.map(async (p) => {
      // Fetch Jira links and linked incidents in parallel
      const [jiraLinks, linkedData] = await Promise.all([
        getJiraLinks(p.id),
        zdRequest('/tickets/' + p.id + '/incidents.json', {
          params: { per_page: '100' },
        }).catch(() => ({ tickets: [] })),
      ]);
      const linkedTickets = (linkedData.tickets || []).map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
      }));
      return {
        problemId: p.id,
        subject: p.subject,
        status: p.status,
        priority: p.priority,
        tags: p.tags || [],
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        jiraLinks,
        linkedCount: linkedTickets.length,
        linkedTickets,
      };
    }));

    res.json({ incidents, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
