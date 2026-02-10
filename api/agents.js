// agents.js — GET /api/agents
// Agent performance data for Blake Corbit, Brien Nunn, Jacob Ryder.
// Returns weekly and daily stats with category breakdowns.

const { zdRequest, getAuth } = require('./_zendesk');

const AGENTS = [
  { name: 'Blake Corbit' },
  { name: 'Brien Nunn' },
  { name: 'Jacob Ryder' },
];

// Tag to category mapping (reuse from metrics)
const TAG_TO_CAT = {
  system_issue: 'System Issue',
  app_workorder: 'AV.X / App',
  integrations: 'Integration',
  billing: 'Billing',
  high_slack: 'High Priority',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Step 1: Resolve agent user IDs
    const agentResults = await Promise.all(
      AGENTS.map(async (agent) => {
        const data = await zdRequest('/users/search.json', {
          params: { query: '"' + agent.name + '"' },
        });
        const user = (data.users || []).find(u =>
          u.name.toLowerCase() === agent.name.toLowerCase() &&
          (u.role === 'agent' || u.role === 'admin')
        );
        return { ...agent, userId: user ? user.id : null };
      })
    );

    // Step 2: Compute date ranges
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() + mondayOffset);
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const todayStr = now.toISOString().split('T')[0];

    // Step 3: Fetch data for each agent
    const agents = await Promise.all(
      agentResults.map(async (agent) => {
        if (!agent.userId) {
          return { name: agent.name, userId: null, error: 'User not found', currentWeek: null, today: null };
        }

        // Fetch assigned this week, solved this week, and currently open — in parallel
        const [assignedData, solvedData, openData, todayData] = await Promise.all([
          zdRequest('/search.json', {
            params: { query: 'type:ticket assignee:' + agent.userId + ' created>=' + weekStartStr, per_page: '100' },
          }),
          zdRequest('/search.json', {
            params: { query: 'type:ticket assignee:' + agent.userId + ' solved>=' + weekStartStr, per_page: '100' },
          }),
          zdRequest('/search.json', {
            params: { query: 'type:ticket assignee:' + agent.userId + ' status<solved', per_page: '100' },
          }),
          zdRequest('/search.json', {
            params: { query: 'type:ticket assignee:' + agent.userId + ' created>=' + todayStr, per_page: '100' },
          }),
        ]);

        const assigned = assignedData.count || 0;
        const solved = solvedData.count || 0;
        const openCount = openData.count || 0;
        const todayAssigned = todayData.count || 0;

        // Compute categories from assigned tickets this week
        const categories = {};
        const weekTickets = (assignedData.results || []);
        weekTickets.forEach(t => {
          let cat = 'Other';
          for (const tag of (t.tags || [])) {
            if (TAG_TO_CAT[tag]) { cat = TAG_TO_CAT[tag]; break; }
          }
          categories[cat] = (categories[cat] || 0) + 1;
        });

        const categoryBreakdown = Object.entries(categories)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);

        // Avg resolution time from solved tickets (approximate from created_at to updated_at)
        // Zendesk search results include created_at and updated_at but not solved_at
        // Use updated_at as proxy for solved tickets
        let avgResolutionHours = null;
        const solvedTickets = (solvedData.results || []).slice(0, 20);
        if (solvedTickets.length > 0) {
          const totalHours = solvedTickets.reduce((sum, t) => {
            const created = new Date(t.created_at).getTime();
            const updated = new Date(t.updated_at).getTime();
            return sum + (updated - created) / 3600000;
          }, 0);
          avgResolutionHours = Math.round((totalHours / solvedTickets.length) * 10) / 10;
        }

        // Today solved count
        const todaySolvedData = await zdRequest('/search.json', {
          params: { query: 'type:ticket assignee:' + agent.userId + ' solved>=' + todayStr, per_page: '1' },
        });
        const todaySolved = todaySolvedData.count || 0;

        // Velocity: solved per business day this week
        const daysElapsed = Math.max(1, Math.min(dayOfWeek === 0 ? 5 : dayOfWeek, 5));
        const velocityPerDay = solved > 0 ? Math.round((solved / daysElapsed) * 10) / 10 : 0;

        return {
          name: agent.name,
          userId: agent.userId,
          currentWeek: {
            assigned,
            solved,
            open: openCount,
            avgResolutionHours,
            velocityPerDay,
            categories: categoryBreakdown,
          },
          today: {
            assigned: todayAssigned,
            solved: todaySolved,
          },
        };
      })
    );

    // Step 4: Fetch CSAT ratings for the week (good + bad) in parallel
    const { baseUrl, auth } = getAuth();
    const csatHeaders = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };
    const weekStartTs = Math.floor(weekStart.getTime() / 1000);

    const [goodResp, badResp] = await Promise.all([
      fetch(`${baseUrl}/api/v2/satisfaction_ratings.json?score=good&start_time=${weekStartTs}&per_page=100`, { headers: csatHeaders }).then(r => r.ok ? r.json() : { satisfaction_ratings: [] }),
      fetch(`${baseUrl}/api/v2/satisfaction_ratings.json?score=bad&start_time=${weekStartTs}&per_page=100`, { headers: csatHeaders }).then(r => r.ok ? r.json() : { satisfaction_ratings: [] }),
    ]);

    // Build per-agent CSAT map by userId
    const csatByUser = {};
    for (const r of (goodResp.satisfaction_ratings || [])) {
      if (!csatByUser[r.assignee_id]) csatByUser[r.assignee_id] = { good: 0, bad: 0 };
      csatByUser[r.assignee_id].good++;
    }
    for (const r of (badResp.satisfaction_ratings || [])) {
      if (!csatByUser[r.assignee_id]) csatByUser[r.assignee_id] = { good: 0, bad: 0 };
      csatByUser[r.assignee_id].bad++;
    }

    // Attach CSAT to each agent
    const totalGood = (goodResp.satisfaction_ratings || []).length;
    const totalBad = (badResp.satisfaction_ratings || []).length;
    const teamTotal = totalGood + totalBad;
    const teamCsatPct = teamTotal > 0 ? Math.round((totalGood / teamTotal) * 100) : null;

    for (const a of agents) {
      if (!a.userId) continue;
      const c = csatByUser[a.userId] || { good: 0, bad: 0 };
      const total = c.good + c.bad;
      a.csat = {
        good: c.good,
        bad: c.bad,
        total,
        pct: total > 0 ? Math.round((c.good / total) * 100) : null,
      };
    }

    res.json({ agents, teamCsat: { good: totalGood, bad: totalBad, total: teamTotal, pct: teamCsatPct }, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
