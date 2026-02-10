// agents.js — GET /api/agents
// Agent performance data for Blake Corbit, Brien Nunn, Jacob Ryder.
// Returns period-based and daily stats with category breakdowns, velocity scores, and CSAT.

const { zdRequest, getJiraLinks, getAuth } = require('../_zendesk');

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

/**
 * Calculate the start date for a given period.
 * @param {'week'|'month'|'quarter'|'year'} period
 * @returns {Date}
 */
function getPeriodStart(period) {
  const now = new Date();
  switch (period) {
    case 'week': {
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(now);
      monday.setDate(now.getDate() + mondayOffset);
      monday.setHours(0, 0, 0, 0);
      return monday;
    }
    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3) * 3;
      return new Date(now.getFullYear(), q, 1, 0, 0, 0, 0);
    }
    case 'year':
      return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    case 'month':
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
}

/**
 * Compute the median of an array of numbers.
 * @param {number[]} arr
 * @returns {number|null}
 */
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Solve rate score tiers (25 pts max)
 */
function solveRateScore(solveRate) {
  if (solveRate >= 98) return 25;
  if (solveRate >= 95) return 20;
  if (solveRate >= 90) return 15;
  if (solveRate >= 80) return 5;
  return 0;
}

/**
 * First reply time score tiers (25 pts max)
 * @param {number|null} medianHours
 */
function firstReplyScore(medianHours) {
  if (medianHours === null) return 0;
  if (medianHours <= 0.15) return 25;
  if (medianHours <= 0.30) return 20;
  if (medianHours <= 0.60) return 15;
  if (medianHours <= 1.00) return 10;
  return 5;
}

/**
 * Resolution time score tiers (25 pts max)
 * @param {number|null} medianHours
 */
function resolutionTimeScore(medianHours) {
  if (medianHours === null) return 0;
  if (medianHours <= 1) return 25;
  if (medianHours <= 2) return 20;
  if (medianHours <= 4) return 15;
  if (medianHours <= 6) return 10;
  return 5;
}

/**
 * Velocity bonus payout tier
 * @param {number} totalScore
 * @returns {string}
 */
function velocityTier(totalScore) {
  if (totalScore >= 90) return '125%';
  if (totalScore >= 80) return '100%';
  if (totalScore >= 70) return '75%';
  if (totalScore >= 60) return '60%';
  return '50%';
}

/**
 * CSAT bonus payout tier
 * @param {number|null} pct
 * @returns {string}
 */
function csatTier(pct) {
  if (pct === null) return '50%';
  if (pct >= 95) return '125%';
  if (pct >= 90) return '100%';
  if (pct >= 80) return '75%';
  if (pct >= 70) return '60%';
  return '50%';
}

/**
 * Fetch ticket metrics for a single ticket.
 * Returns the metrics entry or null.
 */
async function fetchTicketMetrics(ticketId) {
  try {
    const data = await zdRequest(`/tickets/${ticketId}/metrics.json`);
    return data && data.ticket_metric ? data.ticket_metric : null;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Parse period parameter (default: month)
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const period = ['week', 'month', 'quarter', 'year'].includes(url.searchParams.get('period'))
      ? url.searchParams.get('period')
      : 'month';

    const periodStart = getPeriodStart(period);
    const periodStartStr = periodStart.toISOString().split('T')[0];

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

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

    // Step 2: Fetch base data for each agent
    const agentsData = await Promise.all(
      agentResults.map(async (agent) => {
        if (!agent.userId) {
          return { name: agent.name, userId: null, error: 'User not found', currentPeriod: null, today: null };
        }

        // Fetch assigned, solved, open, today assigned — in parallel
        const [assignedData, solvedData, openData, todayData] = await Promise.all([
          zdRequest('/search.json', {
            params: { query: 'type:ticket assignee:' + agent.userId + ' created>=' + periodStartStr, per_page: '100' },
          }),
          zdRequest('/search.json', {
            params: { query: 'type:ticket assignee:' + agent.userId + ' solved>=' + periodStartStr, per_page: '100' },
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

        // Compute categories from assigned tickets this period
        const categories = {};
        const periodTickets = (assignedData.results || []);
        periodTickets.forEach(t => {
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
        const solvedTickets = (solvedData.results || []).slice(0, 20);
        let avgResolutionHours = null;
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

        // --- Velocity: fetch ticket metrics for up to 20 most recent solved tickets ---
        // Sort solved tickets by updated_at descending (most recent first)
        const sortedSolved = (solvedData.results || [])
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
          .slice(0, 20);

        // Fetch metrics and Jira links in parallel for each ticket
        const ticketDetails = await Promise.all(
          sortedSolved.map(async (ticket) => {
            const [metrics, jiraLinks] = await Promise.all([
              fetchTicketMetrics(ticket.id),
              getJiraLinks(ticket.id),
            ]);
            return { ticket, metrics, hasJira: jiraLinks && jiraLinks.length > 0 };
          })
        );

        // Compute first reply times (all solved tickets in sample)
        const firstReplyHours = [];
        for (const td of ticketDetails) {
          if (td.metrics && td.metrics.reply_time_in_minutes && td.metrics.reply_time_in_minutes.business != null) {
            firstReplyHours.push(td.metrics.reply_time_in_minutes.business / 60);
          }
        }

        // Compute resolution times excluding Jira-linked tickets
        const resolutionHoursNoJira = [];
        for (const td of ticketDetails) {
          if (!td.hasJira && td.metrics && td.metrics.full_resolution_time_in_minutes && td.metrics.full_resolution_time_in_minutes.business != null) {
            resolutionHoursNoJira.push(td.metrics.full_resolution_time_in_minutes.business / 60);
          }
        }

        const medianFirstReply = median(firstReplyHours);
        const medianResolution = median(resolutionHoursNoJira);

        return {
          name: agent.name,
          userId: agent.userId,
          assigned,
          solved,
          openCount,
          avgResolutionHours,
          categoryBreakdown,
          todayAssigned,
          todaySolved,
          medianFirstReply,
          medianResolution,
        };
      })
    );

    // Step 3: Compute team average assigned for volume score
    const validAgents = agentsData.filter(a => a.userId);
    const teamAvgAssigned = validAgents.length > 0
      ? validAgents.reduce((sum, a) => sum + a.assigned, 0) / validAgents.length
      : 1;

    // Step 4: Compute velocity scores per agent and build final response
    const agents = agentsData.map(a => {
      if (!a.userId) {
        return {
          name: a.name,
          userId: null,
          error: 'User not found',
          currentPeriod: null,
          csat: null,
          today: null,
        };
      }

      // Component 1: Volume score (25 pts max)
      const volumeScore = teamAvgAssigned > 0
        ? Math.min(25, Math.round(((a.assigned / teamAvgAssigned) * 25) * 10) / 10)
        : 0;

      // Component 2: Solve rate score (25 pts max)
      const solveRate = a.assigned > 0 ? (a.solved / a.assigned) * 100 : 0;
      const solveScore = solveRateScore(solveRate);

      // Component 3: First reply score (25 pts max)
      const frtScore = firstReplyScore(a.medianFirstReply);

      // Component 4: Resolution score excluding Jira (25 pts max)
      const resScore = resolutionTimeScore(a.medianResolution);

      const totalVelocity = Math.round((volumeScore + solveScore + frtScore + resScore) * 10) / 10;

      return {
        name: a.name,
        userId: a.userId,
        currentPeriod: {
          assigned: a.assigned,
          solved: a.solved,
          open: a.openCount,
          avgResolutionHours: a.avgResolutionHours,
          categories: a.categoryBreakdown,
          velocity: {
            volumeScore: Math.round(volumeScore * 10) / 10,
            solveScore,
            firstReplyScore: frtScore,
            resolutionScore: resScore,
            total: totalVelocity,
            tier: velocityTier(totalVelocity),
            details: {
              solveRate: Math.round(solveRate * 10) / 10,
              medianFirstReplyHours: a.medianFirstReply !== null ? Math.round(a.medianFirstReply * 100) / 100 : null,
              medianResolutionHours: a.medianResolution !== null ? Math.round(a.medianResolution * 10) / 10 : null,
              teamAvgAssigned: Math.round(teamAvgAssigned * 10) / 10,
            },
          },
        },
        today: {
          assigned: a.todayAssigned,
          solved: a.todaySolved,
        },
      };
    });

    // Step 5: Fetch CSAT ratings for the period
    const { baseUrl, auth } = getAuth();
    const csatHeaders = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };
    const periodStartTs = Math.floor(periodStart.getTime() / 1000);

    const [goodResp, badResp] = await Promise.all([
      fetch(`${baseUrl}/api/v2/satisfaction_ratings.json?score=good&start_time=${periodStartTs}&per_page=100`, { headers: csatHeaders }).then(r => r.ok ? r.json() : { satisfaction_ratings: [] }),
      fetch(`${baseUrl}/api/v2/satisfaction_ratings.json?score=bad&start_time=${periodStartTs}&per_page=100`, { headers: csatHeaders }).then(r => r.ok ? r.json() : { satisfaction_ratings: [] }),
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
      const pct = total > 0 ? Math.round((c.good / total) * 100) : null;
      a.csat = {
        good: c.good,
        bad: c.bad,
        total,
        pct,
        tier: csatTier(pct),
      };
    }

    res.json({
      agents,
      teamCsat: { good: totalGood, bad: totalBad, total: teamTotal, pct: teamCsatPct },
      period,
      periodStart: periodStart.toISOString(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
