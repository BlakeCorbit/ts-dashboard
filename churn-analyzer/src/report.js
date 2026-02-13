/**
 * Report Generator
 *
 * Generates output in three formats:
 *   - Console: Pretty-printed summary
 *   - Dashboard JSON: For the web dashboard (churn-dashboard.json)
 *   - CSV: Exportable spreadsheet
 *
 * Usage:
 *   node src/index.js report
 *   node src/index.js report --dashboard
 *   node src/index.js report --csv
 */

const fs = require('fs');
const path = require('path');
const { getDb, close } = require('./db');

// ─── Dashboard JSON Output ─────────────────────────────────────

function generateDashboardJSON(db) {
  // Summary counts
  const total = db.prepare('SELECT COUNT(*) as n FROM sf_accounts').get().n;
  const matched = db.prepare('SELECT COUNT(*) as n FROM account_org_map').get().n;

  const riskCounts = db.prepare(`
    SELECT risk_level, COUNT(*) as n FROM risk_scores GROUP BY risk_level
  `).all();

  const countByLevel = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of riskCounts) {
    countByLevel[r.risk_level] = r.n;
  }

  // Model recall (if churn data exists)
  const churnedTotal = db.prepare("SELECT COUNT(*) as n FROM sf_accounts WHERE churn_date IS NOT NULL").get().n;
  let modelRecall = null;
  if (churnedTotal > 0) {
    const predicted = db.prepare(`
      SELECT COUNT(*) as n FROM sf_accounts s
      JOIN risk_scores r ON r.sf_account_id = s.sf_account_id
      WHERE s.churn_date IS NOT NULL AND r.risk_level IN ('high', 'critical')
    `).get().n;
    modelRecall = Math.round(predicted / churnedTotal * 100);
  }

  // Risk distribution
  const riskDistribution = [
    { name: 'Critical', count: countByLevel.critical },
    { name: 'High', count: countByLevel.high },
    { name: 'Medium', count: countByLevel.medium },
    { name: 'Low', count: countByLevel.low },
  ];

  // Top risk factors across all accounts
  const allScores = db.prepare('SELECT risk_factors FROM risk_scores').all();
  const factorCounts = {};
  for (const row of allScores) {
    const factors = JSON.parse(row.risk_factors || '[]');
    for (const f of factors) {
      // Normalize factor to a category
      let category = 'Other';
      if (f.includes('volume increased') || f.includes('volume trending')) category = 'Ticket volume increasing';
      else if (f.includes('escalated')) category = 'High escalation rate';
      else if (f.includes('CSAT') || f.includes('bad')) category = 'Bad CSAT ratings';
      else if (f.includes('High ticket volume')) category = 'High ticket volume';
      else if (f.includes('resolution time')) category = 'Slow resolution times';
      else if (f.includes('categories')) category = 'Broad issue categories';
      else if (f.includes('open') || f.includes('Last ticket')) category = 'Recent activity';

      factorCounts[category] = (factorCounts[category] || 0) + 1;
    }
  }

  const topRiskFactors = Object.entries(factorCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Account details sorted by risk score
  const accounts = db.prepare(`
    SELECT r.*, s.account_name, s.mrr, s.status as sf_status, s.churn_date, o.name as zd_org_name
    FROM risk_scores r
    JOIN sf_accounts s ON s.sf_account_id = r.sf_account_id
    LEFT JOIN zd_organizations o ON o.id = r.zd_org_id
    ORDER BY r.overall_score DESC
  `).all().map(r => ({
    name: r.account_name,
    sfAccountId: r.sf_account_id,
    zdOrgId: r.zd_org_id,
    zdOrgName: r.zd_org_name,
    riskScore: r.overall_score,
    riskLevel: r.risk_level,
    sfStatus: r.sf_status,
    isChurned: !!r.churn_date,
    tickets30d: r.ticket_count_30d,
    tickets60d: r.ticket_count_60d,
    tickets90d: r.ticket_count_90d,
    trend: r.trend_direction,
    topCategory: (() => {
      try {
        const cats = JSON.parse(r.top_categories || '[]');
        return cats.length > 0 ? cats[0].category : null;
      } catch { return null; }
    })(),
    escalations30d: r.escalation_count_30d,
    badCsat: r.bad_satisfaction_count,
    avgResolutionHours: r.avg_resolution_hours ? Math.round(r.avg_resolution_hours) : null,
    mrr: r.mrr,
    scores: {
      volume: r.volume_score,
      escalation: r.escalation_score,
      sentiment: r.sentiment_score,
      velocity: r.velocity_score,
      resolution: r.resolution_score,
      breadth: r.breadth_score,
      recency: r.recency_score,
    },
    riskFactors: JSON.parse(r.risk_factors || '[]'),
  }));

  // Churn correlation analysis
  let churnCorrelation = { hasChurnData: false };
  if (churnedTotal > 0) {
    const churnedMetrics = db.prepare(`
      SELECT
        AVG(r.ticket_count_90d) / 3.0 as avg_tickets_monthly,
        AVG(CASE WHEN r.ticket_count_30d > 0 THEN CAST(r.escalation_count_30d AS REAL) / r.ticket_count_30d ELSE 0 END) as avg_escalation_rate,
        AVG(r.avg_resolution_hours) as avg_resolution
      FROM risk_scores r
      JOIN sf_accounts s ON s.sf_account_id = r.sf_account_id
      WHERE s.churn_date IS NOT NULL
    `).get();

    const activeMetrics = db.prepare(`
      SELECT
        AVG(r.ticket_count_90d) / 3.0 as avg_tickets_monthly,
        AVG(CASE WHEN r.ticket_count_30d > 0 THEN CAST(r.escalation_count_30d AS REAL) / r.ticket_count_30d ELSE 0 END) as avg_escalation_rate,
        AVG(r.avg_resolution_hours) as avg_resolution
      FROM risk_scores r
      JOIN sf_accounts s ON s.sf_account_id = r.sf_account_id
      WHERE s.churn_date IS NULL
    `).get();

    churnCorrelation = {
      hasChurnData: true,
      avgTicketsChurned: round(churnedMetrics.avg_tickets_monthly),
      avgTicketsActive: round(activeMetrics.avg_tickets_monthly),
      avgEscalationRateChurned: round(churnedMetrics.avg_escalation_rate),
      avgEscalationRateActive: round(activeMetrics.avg_escalation_rate),
      avgResolutionChurned: round(churnedMetrics.avg_resolution),
      avgResolutionActive: round(activeMetrics.avg_resolution),
    };
  }

  return {
    summary: {
      totalAccounts: total,
      matched,
      critical: countByLevel.critical,
      high: countByLevel.high,
      medium: countByLevel.medium,
      low: countByLevel.low,
      unscored: total - (countByLevel.critical + countByLevel.high + countByLevel.medium + countByLevel.low),
      modelRecall,
    },
    riskDistribution,
    topRiskFactors,
    accounts,
    churnCorrelation,
    generatedAt: new Date().toISOString(),
  };
}

function round(val) {
  if (val == null) return null;
  return Math.round(val * 10) / 10;
}

// ─── CSV Output ────────────────────────────────────────────────

function generateCSV(db) {
  const rows = db.prepare(`
    SELECT r.*, s.account_name, s.mrr, s.status as sf_status, s.churn_date
    FROM risk_scores r
    JOIN sf_accounts s ON s.sf_account_id = r.sf_account_id
    ORDER BY r.overall_score DESC
  `).all();

  const headers = [
    'Account Name', 'Risk Score', 'Risk Level', 'MRR', 'SF Status', 'Churned',
    'Tickets 30d', 'Tickets 90d', 'Trend', 'Escalations 30d',
    'Bad CSAT', 'Avg Resolution Hours', 'Unique Categories',
    'Volume Score', 'Escalation Score', 'Sentiment Score', 'Velocity Score',
    'Resolution Score', 'Breadth Score', 'Recency Score', 'Risk Factors',
  ];

  const csvRows = rows.map(r => [
    `"${(r.account_name || '').replace(/"/g, '""')}"`,
    r.overall_score,
    r.risk_level,
    r.mrr || '',
    r.sf_status || '',
    r.churn_date ? 'Yes' : 'No',
    r.ticket_count_30d,
    r.ticket_count_90d,
    r.trend_direction,
    r.escalation_count_30d,
    r.bad_satisfaction_count,
    r.avg_resolution_hours ? Math.round(r.avg_resolution_hours) : '',
    r.unique_categories,
    r.volume_score, r.escalation_score, r.sentiment_score, r.velocity_score,
    r.resolution_score, r.breadth_score, r.recency_score,
    `"${(JSON.parse(r.risk_factors || '[]')).join('; ').replace(/"/g, '""')}"`,
  ].join(','));

  return [headers.join(','), ...csvRows].join('\n');
}

// ─── Console Report ────────────────────────────────────────────

function printConsoleReport(db) {
  const data = generateDashboardJSON(db);
  const s = data.summary;

  console.log('=== Churn Risk Report ===');
  console.log('');
  console.log(`  Total Accounts: ${s.totalAccounts} | Matched: ${s.matched} | Scored: ${s.critical + s.high + s.medium + s.low}`);
  console.log('');
  console.log('  Risk Distribution:');
  console.log(`    Critical: ${s.critical}`);
  console.log(`    High:     ${s.high}`);
  console.log(`    Medium:   ${s.medium}`);
  console.log(`    Low:      ${s.low}`);

  if (s.modelRecall !== null) {
    console.log('');
    console.log(`  Model Recall: ${s.modelRecall}%`);
  }

  if (data.topRiskFactors.length > 0) {
    console.log('');
    console.log('  Top Risk Factors:');
    for (const f of data.topRiskFactors.slice(0, 5)) {
      console.log(`    ${f.count.toString().padStart(4)} accounts: ${f.name}`);
    }
  }

  if (data.churnCorrelation.hasChurnData) {
    const c = data.churnCorrelation;
    console.log('');
    console.log('  Churn vs Active Comparison:');
    console.log('  ──────────────────────────────────────────');
    console.log(`    Avg tickets/month:    Churned ${c.avgTicketsChurned} vs Active ${c.avgTicketsActive}`);
    console.log(`    Avg escalation rate:  Churned ${(c.avgEscalationRateChurned * 100).toFixed(0)}% vs Active ${(c.avgEscalationRateActive * 100).toFixed(0)}%`);
    console.log(`    Avg resolution (hrs): Churned ${c.avgResolutionChurned} vs Active ${c.avgResolutionActive}`);
  }

  // Top 15 highest risk
  if (data.accounts.length > 0) {
    console.log('');
    console.log('  Highest Risk Accounts:');
    console.log('  ──────────────────────────────────────────────────────────────');
    console.log('    Score  Level     Tickets  Trend       Account');
    console.log('  ──────────────────────────────────────────────────────────────');

    for (const a of data.accounts.slice(0, 15)) {
      const mrr = a.mrr ? ` ($${a.mrr}/mo)` : '';
      const trend = a.trend === 'increasing' ? ' ^' : a.trend === 'decreasing' ? ' v' : '  ';
      console.log(`    ${a.riskScore.toString().padStart(5)}  ${a.riskLevel.padEnd(9)} ${String(a.tickets30d).padStart(5)}/30d${trend}  ${a.name}${mrr}`);
    }
  }
}

// ─── Status Command ────────────────────────────────────────────

function status() {
  const { getStats } = require('./db');
  const stats = getStats();

  console.log('=== Churn Analyzer Status ===');
  console.log('');
  console.log('  Database:');
  console.log(`    SF Accounts:     ${stats.sfAccounts} (${stats.sfChurned} churned)`);
  console.log(`    ZD Organizations: ${stats.zdOrgs}`);
  console.log(`    ZD Tickets:      ${stats.zdTickets}`);
  console.log(`    Matched:         ${stats.matched} (${stats.confirmed} confirmed)`);
  console.log(`    Risk Scores:     ${stats.riskScores}`);

  if (stats.lastTicketFetch) {
    console.log(`    Last ZD fetch:   ${stats.lastTicketFetch}`);
  }

  close();
}

// ─── Main ──────────────────────────────────────────────────────

function run(args) {
  const dashboard = args.includes('--dashboard');
  const csv = args.includes('--csv');

  const db = getDb();

  if (dashboard) {
    const data = generateDashboardJSON(db);
    const outDir = path.join(__dirname, '..', '..', 'dashboard', 'data');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'churn-dashboard.json');
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`Dashboard JSON written to ${outPath}`);
    console.log(`  ${data.accounts.length} accounts, ${data.summary.critical} critical, ${data.summary.high} high risk`);
  } else if (csv) {
    const csvData = generateCSV(db);
    const outPath = path.join(__dirname, '..', 'data', 'churn-risk-scores.csv');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, csvData);
    console.log(`CSV written to ${outPath}`);
  } else {
    printConsoleReport(db);
  }

  close();
}

module.exports = { run, status };
