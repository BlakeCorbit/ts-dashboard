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
const { FEATURE_LABELS, fmtFeatureValue } = require('./churn-signature');

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

  // Account details sorted by risk score — only include scored accounts with activity
  const accounts = db.prepare(`
    SELECT r.*, s.account_name, s.mrr, s.status as sf_status, s.churn_date, o.name as zd_org_name
    FROM risk_scores r
    JOIN sf_accounts s ON s.sf_account_id = r.sf_account_id
    LEFT JOIN zd_organizations o ON o.id = r.zd_org_id
    WHERE r.overall_score > 0 OR s.churn_date IS NOT NULL
    ORDER BY r.overall_score DESC
    LIMIT 1000
  `).all().map(r => ({
    name: r.account_name,
    zdOrgId: r.zd_org_id,
    riskScore: r.overall_score,
    riskLevel: r.risk_level,
    isChurned: !!r.churn_date,
    tickets30d: r.ticket_count_30d,
    trend: r.trend_direction,
    topCategory: (() => {
      try {
        const cats = JSON.parse(r.top_categories || '[]');
        return cats.length > 0 ? cats[0].category : null;
      } catch { return null; }
    })(),
    escalations30d: r.escalation_count_30d,
    mrr: r.mrr,
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

  // Churn signature data (if available)
  let churnSignature = { available: false };
  let predictions = [];
  let earlyWarnings = [];

  const latestSig = db.prepare(
    'SELECT * FROM churn_signatures ORDER BY computed_at DESC LIMIT 1'
  ).get();

  if (latestSig) {
    const sig = JSON.parse(latestSig.signature_json);
    const quality = latestSig.model_quality ? JSON.parse(latestSig.model_quality) : null;

    churnSignature = {
      available: true,
      computedAt: latestSig.computed_at,
      windowDays: latestSig.window_days,
      churnedSampleSize: latestSig.churned_sample_size,
      activeSampleSize: latestSig.active_sample_size,
      features: Object.entries(sig.features)
        .map(([name, f]) => ({
          name,
          label: FEATURE_LABELS[name] || name,
          churnedMean: f.churned_mean,
          activeMean: f.active_mean,
          separation: f.separation,
          direction: f.direction,
          weight: f.weight,
          threshold: f.threshold,
        }))
        .sort((a, b) => b.separation - a.separation),
      modelQuality: quality,
    };

    // Get predictions — top 500, no feature vectors (saves ~90% of size)
    predictions = db.prepare(`
      SELECT p.*, s.account_name, s.mrr, o.name as zd_org_name
      FROM churn_predictions p
      JOIN sf_accounts s ON s.sf_account_id = p.sf_account_id
      LEFT JOIN zd_organizations o ON o.id = p.zd_org_id
      WHERE p.churn_risk_level IN ('critical', 'high', 'medium')
      ORDER BY p.churn_score DESC
      LIMIT 500
    `).all().map(p => {
      // Only keep top 3 signals per prediction to save space
      const signals = JSON.parse(p.matched_signals).slice(0, 3).map(s => ({
        feature: s.feature,
        explanation: s.explanation,
        severity: s.severity,
      }));
      return {
        name: p.account_name,
        zdOrgId: p.zd_org_id,
        churnScore: p.churn_score,
        churnRiskLevel: p.churn_risk_level,
        matchedSignals: signals,
        signalCount: p.signal_count,
        confidence: p.confidence,
        mrr: p.mrr,
      };
    });

    // Build early warning signal aggregation
    const signalCounts = {};
    const atRisk = predictions.filter(p => p.churnRiskLevel === 'critical' || p.churnRiskLevel === 'high');
    for (const p of atRisk) {
      for (const signal of p.matchedSignals) {
        const key = signal.feature;
        if (!signalCounts[key]) {
          signalCounts[key] = {
            feature: key,
            label: FEATURE_LABELS[key] || key,
            count: 0,
            avgSeverity: 0,
          };
        }
        signalCounts[key].count++;
        signalCounts[key].avgSeverity += signal.severity;
      }
    }
    for (const sc of Object.values(signalCounts)) {
      sc.avgSeverity = Math.round(sc.avgSeverity / sc.count);
    }
    earlyWarnings = Object.values(signalCounts).sort((a, b) => b.count - a.count);
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
    churnSignature,
    predictions,
    earlyWarnings,
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
    SELECT r.*, s.account_name, s.mrr, s.status as sf_status, s.churn_date,
      p.churn_score, p.churn_risk_level, p.signal_count, p.confidence, p.matched_signals
    FROM risk_scores r
    JOIN sf_accounts s ON s.sf_account_id = r.sf_account_id
    LEFT JOIN churn_predictions p ON p.sf_account_id = r.sf_account_id
    ORDER BY COALESCE(p.churn_score, r.overall_score) DESC
  `).all();

  const headers = [
    'Account Name', 'Churn Score', 'Churn Risk', 'Signals', 'Confidence',
    'Heuristic Score', 'Heuristic Level', 'MRR', 'SF Status', 'Churned',
    'Tickets 30d', 'Tickets 90d', 'Trend', 'Escalations 30d',
    'Bad CSAT', 'Avg Resolution Hours', 'Unique Categories',
    'Volume Score', 'Escalation Score', 'Sentiment Score', 'Velocity Score',
    'Resolution Score', 'Breadth Score', 'Recency Score',
    'Risk Factors', 'Warning Signals',
  ];

  const csvRows = rows.map(r => {
    const signals = r.matched_signals
      ? JSON.parse(r.matched_signals).map(s => s.explanation).join('; ')
      : '';
    return [
      `"${(r.account_name || '').replace(/"/g, '""')}"`,
      r.churn_score != null ? r.churn_score : '',
      r.churn_risk_level || '',
      r.signal_count != null ? r.signal_count : '',
      r.confidence || '',
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
      `"${signals.replace(/"/g, '""')}"`,
    ].join(',');
  });

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

  // Churn signature info
  if (data.churnSignature.available) {
    console.log('');
    console.log('  === Churn Early Warning System ===');
    console.log(`  Signature: ${data.churnSignature.churnedSampleSize} churned accounts, ${data.churnSignature.windowDays}-day window`);

    if (data.churnSignature.modelQuality) {
      const q = data.churnSignature.modelQuality;
      console.log(`  Model: Recall ${q.recall}% | Precision ${q.precision}% | F1 ${q.f1}%`);
    }

    if (data.churnSignature.features.length > 0) {
      console.log('');
      console.log('  Top predictive signals:');
      for (const f of data.churnSignature.features.slice(0, 5)) {
        console.log(`    ${f.label.padEnd(24)} separation: ${f.separation.toFixed(2)}  weight: ${(f.weight * 100).toFixed(0)}%`);
      }
    }

    const atRisk = data.predictions.filter(p => p.churnRiskLevel === 'critical' || p.churnRiskLevel === 'high');
    if (atRisk.length > 0) {
      console.log('');
      console.log(`  Early Warning Alerts: ${atRisk.length} accounts match pre-churn patterns`);
      for (const p of atRisk.slice(0, 10)) {
        const mrr = p.mrr ? ` ($${p.mrr}/mo)` : '';
        const topSignal = p.matchedSignals.length > 0 ? p.matchedSignals[0].explanation : '';
        console.log(`    ${p.churnScore.toString().padStart(5)} [${p.churnRiskLevel.padEnd(8)}] ${p.name}${mrr}`);
        if (topSignal) {
          console.log(`          ${topSignal}`);
        }
      }
    }
  }

  // Top 15 highest risk (heuristic)
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
  console.log(`    Churn Signatures: ${stats.churnSignatures}`);
  console.log(`    Churn Predictions: ${stats.churnPredictions}`);

  if (stats.lastSignature) {
    console.log(`    Last signature:  ${stats.lastSignature}`);
  }
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
    fs.writeFileSync(outPath, JSON.stringify(data));
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
