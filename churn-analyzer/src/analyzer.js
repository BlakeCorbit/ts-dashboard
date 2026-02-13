/**
 * Churn Analysis Engine
 *
 * Computes risk scores for each matched account across 7 dimensions:
 * volume, escalation, sentiment, velocity, resolution, breadth, recency.
 *
 * Usage:
 *   node src/index.js analyze
 *   node src/index.js analyze --validate
 */

const { getDb, close } = require('./db');

// ─── Risk Weights (configurable via .env) ──────────────────────

function getWeights() {
  return {
    volume:     parseFloat(process.env.RISK_WEIGHT_VOLUME || '0.20'),
    escalation: parseFloat(process.env.RISK_WEIGHT_ESCALATION || '0.20'),
    sentiment:  parseFloat(process.env.RISK_WEIGHT_SENTIMENT || '0.15'),
    velocity:   parseFloat(process.env.RISK_WEIGHT_VELOCITY || '0.20'),
    resolution: parseFloat(process.env.RISK_WEIGHT_RESOLUTION || '0.10'),
    breadth:    parseFloat(process.env.RISK_WEIGHT_BREADTH || '0.10'),
    recency:    parseFloat(process.env.RISK_WEIGHT_RECENCY || '0.05'),
  };
}

// ─── Component Score Functions ─────────────────────────────────

function computeVolumeScore(count30d, fleetMedian30d) {
  if (fleetMedian30d <= 0) return count30d > 0 ? 50 : 0;
  const ratio = count30d / fleetMedian30d;
  if (ratio >= 3.0) return 100;
  if (ratio >= 2.0) return 75;
  if (ratio >= 1.5) return 50;
  if (ratio >= 1.0) return 25;
  return 0;
}

function computeEscalationScore(escalation30d, total30d) {
  if (total30d === 0) return 0;
  const rate = escalation30d / total30d;
  return Math.min(100, Math.round(rate * 250));
}

function computeSentimentScore(badCount, goodCount) {
  const total = badCount + goodCount;
  if (total < 3) return 50; // Insufficient data
  const badRate = badCount / total;
  return Math.min(100, Math.round(badRate * 200));
}

function computeVelocityScore(count30d, count90d) {
  // Compare recent 30d to average monthly rate over prior 60d
  const priorMonthlyAvg = (count90d - count30d) / 2;

  if (priorMonthlyAvg === 0 && count30d === 0) return 0;
  if (priorMonthlyAvg === 0 && count30d > 0) return 80;

  const acceleration = count30d / priorMonthlyAvg;
  if (acceleration >= 2.0) return 100;
  if (acceleration >= 1.5) return 75;
  if (acceleration >= 1.2) return 50;
  if (acceleration >= 1.0) return 25;
  return 0;
}

function computeResolutionScore(avgResHours, fleetAvgHours) {
  if (!avgResHours || !fleetAvgHours || fleetAvgHours <= 0) return 0;
  const ratio = avgResHours / fleetAvgHours;
  if (ratio >= 3.0) return 100;
  if (ratio >= 2.0) return 75;
  if (ratio >= 1.5) return 50;
  if (ratio >= 1.0) return 25;
  return 0;
}

function computeBreadthScore(uniqueCategories, totalTickets) {
  if (totalTickets < 3) return 0;
  if (uniqueCategories >= 5) return 100;
  if (uniqueCategories >= 4) return 75;
  if (uniqueCategories >= 3) return 50;
  if (uniqueCategories >= 2) return 25;
  return 0;
}

function computeRecencyScore(daysSinceLastTicket, hasOpenTickets) {
  if (hasOpenTickets) return 80;
  if (daysSinceLastTicket === null) return 0;
  if (daysSinceLastTicket <= 3) return 90;
  if (daysSinceLastTicket <= 7) return 70;
  if (daysSinceLastTicket <= 14) return 50;
  if (daysSinceLastTicket <= 30) return 25;
  return 0;
}

// ─── Overall Score ─────────────────────────────────────────────

function computeOverallScore(components, weights) {
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += (components[key] || 0) * weight;
  }
  return Math.round(score * 10) / 10;
}

function riskLevel(score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

function trendDirection(count30d, count90d) {
  const priorAvg = (count90d - count30d) / 2;
  if (priorAvg === 0 && count30d === 0) return 'stable';
  if (priorAvg === 0) return 'increasing';
  const ratio = count30d / priorAvg;
  if (ratio >= 1.2) return 'increasing';
  if (ratio <= 0.8) return 'decreasing';
  return 'stable';
}

// ─── Risk Factor Explanations ──────────────────────────────────

function generateRiskFactors(metrics, components) {
  const factors = [];

  if (components.velocity >= 75) {
    const priorAvg = (metrics.count90d - metrics.count30d) / 2;
    const pct = priorAvg > 0 ? Math.round((metrics.count30d / priorAvg) * 100) : 0;
    factors.push(`Ticket volume increased ${pct}% in last 30 days (${metrics.count30d} tickets)`);
  } else if (components.velocity >= 50) {
    factors.push(`Ticket volume trending up (${metrics.count30d} in 30d vs ${metrics.count90d} in 90d)`);
  }

  if (components.escalation >= 50) {
    const rate = metrics.count30d > 0 ? Math.round(metrics.escalation30d / metrics.count30d * 100) : 0;
    factors.push(`${metrics.escalation30d} escalated tickets in 30 days (${rate}% rate)`);
  }

  if (components.sentiment >= 50 && metrics.badSatisfaction > 0) {
    factors.push(`${metrics.badSatisfaction} bad CSAT ratings in 90 days`);
  }

  if (components.volume >= 75) {
    factors.push(`High ticket volume: ${metrics.count30d} tickets in 30 days (fleet median: ${metrics.fleetMedian30d})`);
  }

  if (components.resolution >= 50 && metrics.avgResolutionHours) {
    factors.push(`Avg resolution time ${Math.round(metrics.avgResolutionHours)}h (fleet avg: ${Math.round(metrics.fleetAvgHours)}h)`);
  }

  if (components.breadth >= 50) {
    factors.push(`Issues across ${metrics.uniqueCategories} different categories`);
  }

  if (components.recency >= 70) {
    if (metrics.hasOpenTickets) {
      factors.push('Has open/pending tickets');
    } else {
      factors.push(`Last ticket ${metrics.daysSinceLastTicket} days ago`);
    }
  }

  return factors;
}

// ─── Main Analysis ─────────────────────────────────────────────

function run(args) {
  const validate = args.includes('--validate');

  console.log('=== Churn Risk Analysis ===');
  const db = getDb();
  const weights = getWeights();

  // Get all matched accounts
  const matched = db.prepare(`
    SELECT m.sf_account_id, m.zd_org_id, s.account_name, s.mrr, s.status, s.churn_date
    FROM account_org_map m
    JOIN sf_accounts s ON s.sf_account_id = m.sf_account_id
  `).all();

  if (matched.length === 0) {
    console.error('No matched accounts found. Run: node src/index.js match');
    close();
    process.exit(1);
  }

  console.log(`  Analyzing ${matched.length} matched accounts...`);

  // Compute fleet-wide stats
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const d90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Fleet median tickets per org in 30d
  const orgCounts30d = db.prepare(`
    SELECT org_id, COUNT(*) as cnt
    FROM zd_tickets
    WHERE created_at >= ? AND org_id IS NOT NULL
    GROUP BY org_id
    ORDER BY cnt
  `).all(d30);

  const fleetMedian30d = orgCounts30d.length > 0
    ? orgCounts30d[Math.floor(orgCounts30d.length / 2)].cnt
    : 1;

  // Fleet average resolution hours
  const fleetRes = db.prepare(`
    SELECT AVG(resolution_hours) as avg_hours
    FROM zd_tickets
    WHERE resolution_hours IS NOT NULL AND resolution_hours > 0 AND created_at >= ?
  `).get(d90);
  const fleetAvgHours = fleetRes ? fleetRes.avg_hours || 24 : 24;

  console.log(`  Fleet stats: median ${fleetMedian30d} tickets/30d, avg resolution ${Math.round(fleetAvgHours)}h`);

  // Prepare queries
  const qCount = db.prepare('SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ?');
  const qEscalation = db.prepare('SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND is_escalation = 1');
  const qSatisfaction = db.prepare(`
    SELECT
      SUM(CASE WHEN satisfaction_rating = 'bad' THEN 1 ELSE 0 END) as bad,
      SUM(CASE WHEN satisfaction_rating = 'good' THEN 1 ELSE 0 END) as good
    FROM zd_tickets WHERE org_id = ? AND created_at >= ?
  `);
  const qResolution = db.prepare(`
    SELECT AVG(resolution_hours) as avg_hours
    FROM zd_tickets WHERE org_id = ? AND resolution_hours > 0 AND created_at >= ?
  `);
  const qCategories = db.prepare(`
    SELECT COUNT(DISTINCT category) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ?
  `);
  const qTopCategories = db.prepare(`
    SELECT category, COUNT(*) as cnt FROM zd_tickets
    WHERE org_id = ? AND created_at >= ?
    GROUP BY category ORDER BY cnt DESC LIMIT 3
  `);
  const qLastTicket = db.prepare(`
    SELECT MAX(created_at) as last_at FROM zd_tickets WHERE org_id = ?
  `);
  const qOpenTickets = db.prepare(`
    SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND status IN ('new', 'open', 'pending', 'hold')
  `);
  const qReopened = db.prepare(`
    SELECT SUM(reopen_count) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ?
  `);

  // Clear old scores
  db.prepare('DELETE FROM risk_scores').run();

  const insertScore = db.prepare(`
    INSERT INTO risk_scores (
      sf_account_id, zd_org_id, overall_score, risk_level,
      volume_score, escalation_score, sentiment_score, velocity_score,
      resolution_score, breadth_score, recency_score,
      ticket_count_30d, ticket_count_60d, ticket_count_90d,
      escalation_count_30d, avg_resolution_hours, bad_satisfaction_count,
      unique_categories, days_since_last_ticket, reopened_ticket_count,
      top_categories, trend_direction, risk_factors
    ) VALUES (
      @sf_account_id, @zd_org_id, @overall_score, @risk_level,
      @volume_score, @escalation_score, @sentiment_score, @velocity_score,
      @resolution_score, @breadth_score, @recency_score,
      @ticket_count_30d, @ticket_count_60d, @ticket_count_90d,
      @escalation_count_30d, @avg_resolution_hours, @bad_satisfaction_count,
      @unique_categories, @days_since_last_ticket, @reopened_ticket_count,
      @top_categories, @trend_direction, @risk_factors
    )
  `);

  const d60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const analyzeAll = db.transaction((accounts) => {
    const results = { critical: 0, high: 0, medium: 0, low: 0 };

    for (const acct of accounts) {
      const orgId = acct.zd_org_id;

      // Gather raw metrics
      const count30d = qCount.get(orgId, d30).n;
      const count60d = qCount.get(orgId, d60).n;
      const count90d = qCount.get(orgId, d90).n;
      const escalation30d = qEscalation.get(orgId, d30).n;
      const sat = qSatisfaction.get(orgId, d90);
      const badSatisfaction = sat ? (sat.bad || 0) : 0;
      const goodSatisfaction = sat ? (sat.good || 0) : 0;
      const res = qResolution.get(orgId, d90);
      const avgResolutionHours = res ? res.avg_hours : null;
      const uniqueCategories = qCategories.get(orgId, d90).n;
      const topCats = qTopCategories.all(orgId, d90);
      const lastTicket = qLastTicket.get(orgId);
      const hasOpenTickets = qOpenTickets.get(orgId).n > 0;
      const reopened = qReopened.get(orgId, d90);
      const reopenCount = reopened ? (reopened.n || 0) : 0;

      let daysSinceLastTicket = null;
      if (lastTicket && lastTicket.last_at) {
        daysSinceLastTicket = Math.floor((now.getTime() - new Date(lastTicket.last_at).getTime()) / (24 * 60 * 60 * 1000));
      }

      // Compute component scores
      const components = {
        volume: computeVolumeScore(count30d, fleetMedian30d),
        escalation: computeEscalationScore(escalation30d, count30d),
        sentiment: computeSentimentScore(badSatisfaction, goodSatisfaction),
        velocity: computeVelocityScore(count30d, count90d),
        resolution: computeResolutionScore(avgResolutionHours, fleetAvgHours),
        breadth: computeBreadthScore(uniqueCategories, count90d),
        recency: computeRecencyScore(daysSinceLastTicket, hasOpenTickets),
      };

      const overall = computeOverallScore(components, weights);
      const level = riskLevel(overall);
      const trend = trendDirection(count30d, count90d);

      const metrics = {
        count30d, count90d, escalation30d, badSatisfaction,
        avgResolutionHours, fleetAvgHours, uniqueCategories,
        daysSinceLastTicket, hasOpenTickets, fleetMedian30d,
      };
      const factors = generateRiskFactors(metrics, components);

      insertScore.run({
        sf_account_id: acct.sf_account_id,
        zd_org_id: orgId,
        overall_score: overall,
        risk_level: level,
        volume_score: components.volume,
        escalation_score: components.escalation,
        sentiment_score: components.sentiment,
        velocity_score: components.velocity,
        resolution_score: components.resolution,
        breadth_score: components.breadth,
        recency_score: components.recency,
        ticket_count_30d: count30d,
        ticket_count_60d: count60d,
        ticket_count_90d: count90d,
        escalation_count_30d: escalation30d,
        avg_resolution_hours: avgResolutionHours,
        bad_satisfaction_count: badSatisfaction,
        unique_categories: uniqueCategories,
        days_since_last_ticket: daysSinceLastTicket,
        reopened_ticket_count: reopenCount,
        top_categories: JSON.stringify(topCats),
        trend_direction: trend,
        risk_factors: JSON.stringify(factors),
      });

      results[level]++;
    }

    return results;
  });

  const results = analyzeAll(matched);

  console.log('');
  console.log('  Risk Distribution:');
  console.log(`    Critical: ${results.critical}`);
  console.log(`    High:     ${results.high}`);
  console.log(`    Medium:   ${results.medium}`);
  console.log(`    Low:      ${results.low}`);

  // Model validation
  if (validate) {
    console.log('');
    console.log('  --- Model Validation ---');

    const churned = db.prepare(`
      SELECT s.sf_account_id, s.account_name, r.overall_score, r.risk_level
      FROM sf_accounts s
      LEFT JOIN risk_scores r ON r.sf_account_id = s.sf_account_id
      WHERE s.churn_date IS NOT NULL
    `).all();

    if (churned.length === 0) {
      console.log('  No churn data available for validation.');
      console.log('  Import a CSV with churn dates to enable model validation.');
    } else {
      let tp = 0, fn = 0;
      for (const c of churned) {
        if (c.risk_level === 'high' || c.risk_level === 'critical') {
          tp++;
        } else {
          fn++;
        }
      }

      const recall = churned.length > 0 ? Math.round(tp / churned.length * 100) : 0;
      console.log(`  Churned accounts: ${churned.length}`);
      console.log(`  Predicted correctly (high/critical): ${tp}`);
      console.log(`  Missed (medium/low): ${fn}`);
      console.log(`  Recall: ${recall}%`);

      if (fn > 0) {
        console.log('');
        console.log('  Missed churns:');
        for (const c of churned.filter(x => x.risk_level !== 'high' && x.risk_level !== 'critical').slice(0, 10)) {
          console.log(`    "${c.account_name}" scored ${c.overall_score} (${c.risk_level})`);
        }
      }
    }
  }

  // Show top 10 highest risk
  const topRisk = db.prepare(`
    SELECT r.*, s.account_name, s.mrr
    FROM risk_scores r
    JOIN sf_accounts s ON s.sf_account_id = r.sf_account_id
    ORDER BY r.overall_score DESC
    LIMIT 10
  `).all();

  if (topRisk.length > 0) {
    console.log('');
    console.log('  Top 10 Highest Risk:');
    console.log('  ────────────────────────────────────────────────────────');
    for (const r of topRisk) {
      const mrr = r.mrr ? ` ($${r.mrr}/mo)` : '';
      const factors = JSON.parse(r.risk_factors || '[]');
      console.log(`    ${r.overall_score.toString().padStart(5)} [${r.risk_level.padEnd(8)}] ${r.account_name}${mrr}`);
      if (factors.length > 0) {
        console.log(`          ${factors[0]}`);
      }
    }
  }

  close();
}

module.exports = { run };
