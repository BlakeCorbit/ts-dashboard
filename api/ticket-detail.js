const { zdRequest } = require('./_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const ticketId = req.query.id;
    if (!ticketId) return res.status(400).json({ error: 'id query param required' });

    // Fetch ticket + comments in parallel
    const [ticketData, commentsData] = await Promise.all([
      zdRequest('/tickets/' + ticketId + '.json'),
      zdRequest('/tickets/' + ticketId + '/comments.json', {
        params: { sort_order: 'desc', per_page: '15' },
      }),
    ]);

    const t = ticketData.ticket;
    const comments = (commentsData.comments || []).map(c => ({
      id: c.id,
      body: c.body,
      public: c.public,
      author: c.author_id,
      createdAt: c.created_at,
    }));

    res.json({
      ticket: {
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        type: t.type,
        problemId: t.problem_id,
        tags: t.tags || [],
        requester: t.requester_id,
        assignee: t.assignee_id,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      },
      comments,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
