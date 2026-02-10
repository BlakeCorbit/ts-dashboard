const { zdRequest } = require('./_zendesk');

const TAG_TO_POS = {
  napaenterprise: 'NAPA TRACS', napa_binary: 'NAPA Binary',
  protractor_partner_api: 'Protractor', tekmetric_partner_api: 'Tekmetric',
  tekmetric_pos: 'Tekmetric', shopware_partner_api: 'Shop-Ware',
  mitchell_binary: 'Mitchell', rowriter_binary: 'RO Writer',
  winworks_binary: 'Winworks', vast_binary: 'VAST',
  maxxtraxx_binary: 'MaxxTraxx', alldata_binary: 'AllData',
  autofluent_binary: 'AutoFluent', yes_binary: 'YES/Pace',
};

const TAG_TO_CAT = {
  system_issue: 'System Issue', app_workorder: 'AV.X / App',
  integrations: 'Integration', billing: 'Billing',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sinceStr = weekAgo.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const [created, resolved, backlog] = await Promise.all([
      zdRequest('/search.json', {
        params: { query: `type:ticket created>${sinceStr}`, sort_by: 'created_at', per_page: '1' },
      }),
      zdRequest('/search.json', {
        params: { query: `type:ticket solved>${sinceStr}`, sort_by: 'created_at', per_page: '1' },
      }),
      zdRequest('/search.json', {
        params: { query: 'type:ticket status<solved', sort_by: 'created_at', per_page: '1' },
      }),
    ]);

    const totalTickets = created.count || 0;
    const resolvedTickets = resolved.count || 0;
    const openBacklog = backlog.count || 0;

    // Fetch actual tickets for breakdown
    const allPages = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 4) {
      const d = await zdRequest('/search.json', {
        params: { query: `type:ticket created>${sinceStr}`, sort_by: 'created_at', per_page: '100', page: String(page) },
      });
      allPages.push(...(d.results || []));
      hasMore = (d.results || []).length === 100;
      page++;
    }

    // Breakdowns
    const catCounts = {};
    const posCounts = {};
    const dayCounts = {};

    for (const t of allPages) {
      // Category
      let cat = 'Other';
      for (const tag of (t.tags || [])) {
        if (TAG_TO_CAT[tag]) { cat = TAG_TO_CAT[tag]; break; }
      }
      catCounts[cat] = (catCounts[cat] || 0) + 1;

      // POS
      for (const tag of (t.tags || [])) {
        if (TAG_TO_POS[tag]) {
          const pos = TAG_TO_POS[tag];
          posCounts[pos] = (posCounts[pos] || 0) + 1;
          break;
        }
      }

      // Day
      const day = t.created_at ? t.created_at.split('T')[0] : 'unknown';
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    }

    const toSorted = (obj) => Object.entries(obj)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const byDay = Object.entries(dayCounts)
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));

    res.json({
      totalTickets,
      resolvedTickets,
      openBacklog,
      avgPerDay: totalTickets / 7,
      byCategory: toSorted(catCounts).slice(0, 10),
      byPOS: toSorted(posCounts).slice(0, 10),
      byDay,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
