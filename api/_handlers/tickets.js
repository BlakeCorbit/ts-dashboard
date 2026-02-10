const { zdRequest } = require('../_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const hours = parseInt(req.query.hours || '24', 10);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const data = await zdRequest('/search.json', {
      params: {
        query: `type:ticket created>${sinceStr} status<solved`,
        sort_by: 'created_at',
        sort_order: 'desc',
        per_page: '100',
      },
    });

    const tickets = (data.results || []).map(t => ({
      id: t.id,
      subject: t.subject || '',
      description: (t.description || '').substring(0, 300),
      status: t.status,
      priority: t.priority,
      tags: t.tags || [],
      createdAt: t.created_at,
      assigneeId: t.assignee_id,
      groupId: t.group_id,
      problemId: t.problem_id,
      type: t.type,
    }));

    res.json({ tickets, count: tickets.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
