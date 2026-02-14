/**
 * Churn Signature Learning Engine
 *
 * Learns churn patterns by analyzing Zendesk ticket data in the window
 * before historically churned accounts left. Scores active accounts
 * against that learned signature to provide early warning.
 *
 * Features extracted per account (12 dimensions):
 *   ticket_count, tickets_per_month, escalation_rate, bad_csat_rate,
 *   avg_resolution_hours, reopen_rate, unique_categories, priority_high_rate,
 *   ticket_velocity, problem_ticket_rate, avg_reopens_per_ticket, unresolved_rate
 */

const { getDb, close } = require('./db');

// ─── Feature Vector Computation ──────────────────────────────

/**
 * Compute a feature vector for a single ZD org over a time window.
 * @param {object} db - better-sqlite3 database
 * @param {number} orgId - Zendesk organization ID
 * @param {Date} referenceDate - end of the window (churn date or today)
 * @param {number} windowDays - days to look back from referenceDate
 * @returns {object|null} feature vector, or null if no tickets
 */
function computeFeatureVector(db, orgId, referenceDate, windowDays) {
  const refISO = referenceDate.toISOString();
  const windowStart = new Date(referenceDate.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const d30 = new Date(referenceDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const d30to90Start = new Date(referenceDate.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Total tickets in window
  const totalRow = db.prepare(
    'SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ?'
  ).get(orgId, windowStart, refISO);
  const ticketCount = totalRow.n;

  if (ticketCount === 0) return null;

  const months = windowDays / 30;

  // Escalation count
  const escRow = db.prepare(
    'SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ? AND is_escalation = 1'
  ).get(orgId, windowStart, refISO);

  // CSAT
  const csatRow = db.prepare(`
    SELECT
      SUM(CASE WHEN satisfaction_rating = 'bad' THEN 1 ELSE 0 END) as bad,
      SUM(CASE WHEN satisfaction_rating = 'good' THEN 1 ELSE 0 END) as good
    FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ?
  `).get(orgId, windowStart, refISO);
  const badCsat = csatRow.bad || 0;
  const goodCsat = csatRow.good || 0;
  const csatTotal = badCsat + goodCsat;

  // Resolution hours
  const resRow = db.prepare(`
    SELECT AVG(resolution_hours) as avg_hours
    FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ?
    AND resolution_hours > 0
  `).get(orgId, windowStart, refISO);

  // Unique categories
  const catRow = db.prepare(
    'SELECT COUNT(DISTINCT category) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ?'
  ).get(orgId, windowStart, refISO);

  // High priority count
  const highRow = db.prepare(
    "SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ? AND priority IN ('urgent', 'high')"
  ).get(orgId, windowStart, refISO);

  // Velocity: tickets in last 30d of window vs prior 60d average
  const recent30 = db.prepare(
    'SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ?'
  ).get(orgId, d30, refISO).n;

  const prior60 = db.prepare(
    'SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at < ?'
  ).get(orgId, d30to90Start, d30).n;
  const priorMonthlyAvg = prior60 / 2;

  // Problem tickets
  const probRow = db.prepare(
    "SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ? AND ticket_type = 'problem'"
  ).get(orgId, windowStart, refISO);

  // Reopens
  const reopenRow = db.prepare(
    'SELECT SUM(reopen_count) as total FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ?'
  ).get(orgId, windowStart, refISO);
  const totalReopens = reopenRow.total || 0;

  // Unresolved tickets (open/pending/new/hold at reference date)
  const unresolvedRow = db.prepare(
    "SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at <= ? AND status IN ('new', 'open', 'pending', 'hold')"
  ).get(orgId, windowStart, refISO);

  return {
    ticket_count: ticketCount,
    tickets_per_month: ticketCount / months,
    escalation_rate: ticketCount > 0 ? escRow.n / ticketCount : 0,
    bad_csat_rate: csatTotal > 0 ? badCsat / csatTotal : 0,
    avg_resolution_hours: resRow.avg_hours || 0,
    reopen_rate: ticketCount > 0 ? totalReopens / ticketCount : 0,
    unique_categories: catRow.n,
    priority_high_rate: ticketCount > 0 ? highRow.n / ticketCount : 0,
    ticket_velocity: priorMonthlyAvg > 0 ? recent30 / priorMonthlyAvg : (recent30 > 0 ? 2.0 : 0),
    problem_ticket_rate: ticketCount > 0 ? probRow.n / ticketCount : 0,
    avg_reopens_per_ticket: ticketCount > 0 ? totalReopens / ticketCount : 0,
    unresolved_rate: ticketCount > 0 ? unresolvedRow.n / ticketCount : 0,
  };
}

/**
 * Compute a feature vector using ALL tickets for an org (no time window).
 * Used for churned accounts to maximize data available for learning.
 */
function computeAllTimeFeatureVector(db, orgId) {
  const totalRow = db.prepare(
    'SELECT COUNT(*) as n, MIN(created_at) as first, MAX(created_at) as last FROM zd_tickets WHERE org_id = ?'
  ).get(orgId);
  const ticketCount = totalRow.n;
  if (ticketCount === 0) return null;

  // Compute span in months from first to last ticket
  const firstDate = new Date(totalRow.first);
  const lastDate = new Date(totalRow.last);
  const spanMs = lastDate.getTime() - firstDate.getTime();
  const months = Math.max(1, spanMs / (30 * 24 * 60 * 60 * 1000));

  const escRow = db.prepare(
    'SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND is_escalation = 1'
  ).get(orgId);

  const csatRow = db.prepare(`
    SELECT
      SUM(CASE WHEN satisfaction_rating = 'bad' THEN 1 ELSE 0 END) as bad,
      SUM(CASE WHEN satisfaction_rating = 'good' THEN 1 ELSE 0 END) as good
    FROM zd_tickets WHERE org_id = ?
  `).get(orgId);
  const badCsat = csatRow.bad || 0;
  const csatTotal = badCsat + (csatRow.good || 0);

  const resRow = db.prepare(
    'SELECT AVG(resolution_hours) as avg_hours FROM zd_tickets WHERE org_id = ? AND resolution_hours > 0'
  ).get(orgId);

  const catRow = db.prepare(
    'SELECT COUNT(DISTINCT category) as n FROM zd_tickets WHERE org_id = ?'
  ).get(orgId);

  const highRow = db.prepare(
    "SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND priority IN ('urgent', 'high')"
  ).get(orgId);

  const probRow = db.prepare(
    "SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND ticket_type = 'problem'"
  ).get(orgId);

  const reopenRow = db.prepare(
    'SELECT SUM(reopen_count) as total FROM zd_tickets WHERE org_id = ?'
  ).get(orgId);
  const totalReopens = reopenRow.total || 0;

  const unresolvedRow = db.prepare(
    "SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND status IN ('new', 'open', 'pending', 'hold')"
  ).get(orgId);

  // Velocity: last 30d of their history vs prior period
  const d30 = new Date(lastDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const d90 = new Date(lastDate.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const recent30 = db.prepare(
    'SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ?'
  ).get(orgId, d30).n;
  const prior60 = db.prepare(
    'SELECT COUNT(*) as n FROM zd_tickets WHERE org_id = ? AND created_at >= ? AND created_at < ?'
  ).get(orgId, d90, d30).n;
  const priorMonthlyAvg = prior60 / 2;

  return {
    ticket_count: ticketCount,
    tickets_per_month: ticketCount / months,
    escalation_rate: ticketCount > 0 ? escRow.n / ticketCount : 0,
    bad_csat_rate: csatTotal > 0 ? badCsat / csatTotal : 0,
    avg_resolution_hours: resRow.avg_hours || 0,
    reopen_rate: ticketCount > 0 ? totalReopens / ticketCount : 0,
    unique_categories: catRow.n,
    priority_high_rate: ticketCount > 0 ? highRow.n / ticketCount : 0,
    ticket_velocity: priorMonthlyAvg > 0 ? recent30 / priorMonthlyAvg : (recent30 > 0 ? 2.0 : 0),
    problem_ticket_rate: ticketCount > 0 ? probRow.n / ticketCount : 0,
    avg_reopens_per_ticket: ticketCount > 0 ? totalReopens / ticketCount : 0,
    unresolved_rate: ticketCount > 0 ? unresolvedRow.n / ticketCount : 0,
  };
}

// ─── Statistical Helpers ─────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// ─── Build Churn Signature ───────────────────────────────────

/**
 * Build a churn signature by comparing pre-churn ticket patterns
 * of churned accounts vs current patterns of active accounts.
 *
 * @param {object} db - database
 * @param {number} windowDays - pre-churn analysis window
 * @param {string[]} excludeIds - SF account IDs to exclude (for cross-validation)
 * @returns {object} signature with per-feature statistics
 */
function buildChurnSignature(db, windowDays, excludeIds) {
  excludeIds = excludeIds || [];

  // Get churned accounts matched to ZD orgs
  const churned = db.prepare(`
    SELECT s.sf_account_id, s.churn_date, m.zd_org_id
    FROM sf_accounts s
    JOIN account_org_map m ON s.sf_account_id = m.sf_account_id
    WHERE s.churn_date IS NOT NULL
  `).all().filter(c => !excludeIds.includes(c.sf_account_id));

  // Get active accounts matched to ZD orgs (with tickets)
  const active = db.prepare(`
    SELECT s.sf_account_id, m.zd_org_id
    FROM sf_accounts s
    JOIN account_org_map m ON s.sf_account_id = m.sf_account_id
    WHERE s.churn_date IS NULL
    AND m.zd_org_id IN (SELECT DISTINCT org_id FROM zd_tickets WHERE org_id IS NOT NULL)
  `).all();

  // Compute feature vectors for churned accounts using ALL their ticket history
  const churnedVectors = [];
  for (const c of churned) {
    // Check cache (use windowDays=0 as key for all-time)
    const cached = db.prepare(
      'SELECT feature_vector FROM pre_churn_snapshots WHERE sf_account_id = ? AND window_days = 0'
    ).get(c.sf_account_id);

    let fv;
    if (cached && !excludeIds.length) {
      fv = JSON.parse(cached.feature_vector);
    } else {
      fv = computeAllTimeFeatureVector(db, c.zd_org_id);
      // Cache it
      if (fv && !excludeIds.length) {
        db.prepare(`
          INSERT OR REPLACE INTO pre_churn_snapshots
          (sf_account_id, zd_org_id, churn_date, window_days, feature_vector, ticket_count)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(c.sf_account_id, c.zd_org_id, c.churn_date, 0, JSON.stringify(fv), fv.ticket_count);
      }
    }
    if (fv) churnedVectors.push(fv);
  }

  // Compute feature vectors for active accounts (trailing window from today)
  const activeVectors = [];
  const now = new Date();
  for (const a of active) {
    const fv = computeFeatureVector(db, a.zd_org_id, now, windowDays);
    if (fv) activeVectors.push(fv);
  }

  if (churnedVectors.length === 0) {
    return null;
  }

  // Compute per-feature statistics
  const featureNames = Object.keys(churnedVectors[0]);
  const features = {};

  for (const name of featureNames) {
    const churnedVals = churnedVectors.map(v => v[name]);
    const activeVals = activeVectors.map(v => v[name]);

    const cMean = mean(churnedVals);
    const cMedian = median(churnedVals);
    const cStddev = stddev(churnedVals);
    const aMean = mean(activeVals);
    const aMedian = median(activeVals);
    const aStddev = stddev(activeVals);

    // Pooled stddev for effect size
    const pooled = Math.sqrt(
      ((churnedVals.length - 1) * cStddev ** 2 + (activeVals.length - 1) * aStddev ** 2) /
      Math.max(1, churnedVals.length + activeVals.length - 2)
    );

    const separation = pooled > 0 ? Math.abs(cMean - aMean) / pooled : 0;
    const direction = cMean >= aMean ? 'higher_means_risk' : 'lower_means_risk';

    // Threshold: midpoint between means
    const threshold = direction === 'higher_means_risk'
      ? (cMean + aMean) / 2
      : (cMean + aMean) / 2;

    features[name] = {
      churned_mean: round4(cMean),
      churned_median: round4(cMedian),
      churned_stddev: round4(cStddev),
      active_mean: round4(aMean),
      active_median: round4(aMedian),
      active_stddev: round4(aStddev),
      separation: round4(separation),
      direction,
      threshold: round4(threshold),
      weight: 0, // computed below
    };
  }

  // Auto-weight by separation
  const totalSeparation = Object.values(features).reduce((s, f) => s + f.separation, 0);
  if (totalSeparation > 0) {
    for (const f of Object.values(features)) {
      f.weight = round4(f.separation / totalSeparation);
    }
  } else {
    // Equal weights if no separation found
    const n = Object.keys(features).length;
    for (const f of Object.values(features)) {
      f.weight = round4(1 / n);
    }
  }

  const signature = {
    computed_at: new Date().toISOString(),
    window_days: windowDays,
    churned_sample_size: churnedVectors.length,
    active_sample_size: activeVectors.length,
    features,
  };

  // Store in DB (unless running cross-validation)
  if (!excludeIds.length) {
    const result = db.prepare(`
      INSERT INTO churn_signatures (window_days, churned_sample_size, active_sample_size, signature_json)
      VALUES (?, ?, ?, ?)
    `).run(windowDays, churnedVectors.length, activeVectors.length, JSON.stringify(signature));
    signature.id = result.lastInsertRowid;
  }

  return signature;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ─── Score Account Against Signature ─────────────────────────

/**
 * Score a single account's feature vector against the learned churn signature.
 * @returns {{ score, riskLevel, matchedSignals, signalCount, confidence }}
 */
function scoreAccountAgainstSignature(featureVector, signature) {
  let weightedScore = 0;
  let totalWeight = 0;
  const matchedSignals = [];

  for (const [featureName, sig] of Object.entries(signature.features)) {
    const value = featureVector[featureName];
    if (value === null || value === undefined) continue;

    const weight = sig.weight;
    totalWeight += weight;

    // Score: 0 at active_mean, 100 at churned_mean
    let featureScore;
    if (sig.direction === 'higher_means_risk') {
      if (value >= sig.churned_mean) {
        featureScore = 100;
      } else if (value <= sig.active_mean) {
        featureScore = 0;
      } else {
        featureScore = ((value - sig.active_mean) / Math.max(0.001, sig.churned_mean - sig.active_mean)) * 100;
      }
    } else {
      if (value <= sig.churned_mean) {
        featureScore = 100;
      } else if (value >= sig.active_mean) {
        featureScore = 0;
      } else {
        featureScore = ((sig.active_mean - value) / Math.max(0.001, sig.active_mean - sig.churned_mean)) * 100;
      }
    }

    featureScore = Math.max(0, Math.min(100, featureScore));
    weightedScore += featureScore * weight;

    // Is this signal firing? (past threshold)
    const isFiring = sig.direction === 'higher_means_risk'
      ? value >= sig.threshold
      : value <= sig.threshold;

    if (isFiring) {
      matchedSignals.push({
        feature: featureName,
        value: round4(value),
        threshold: sig.threshold,
        churnedAvg: sig.churned_mean,
        activeAvg: sig.active_mean,
        severity: Math.round(featureScore),
        explanation: buildSignalExplanation(featureName, value, sig),
      });
    }
  }

  const normalizedScore = totalWeight > 0
    ? Math.round((weightedScore / totalWeight) * 10) / 10
    : 0;

  const criticalThreshold = parseFloat(process.env.CHURN_SCORE_CRITICAL || '75');
  const highThreshold = parseFloat(process.env.CHURN_SCORE_HIGH || '50');
  const mediumThreshold = parseFloat(process.env.CHURN_SCORE_MEDIUM || '25');

  let riskLevel;
  if (normalizedScore >= criticalThreshold) riskLevel = 'critical';
  else if (normalizedScore >= highThreshold) riskLevel = 'high';
  else if (normalizedScore >= mediumThreshold) riskLevel = 'medium';
  else riskLevel = 'low';

  const ticketCount = featureVector.ticket_count || 0;
  let confidence;
  if (ticketCount >= 10) confidence = 'high';
  else if (ticketCount >= 5) confidence = 'medium';
  else confidence = 'low';

  return {
    score: normalizedScore,
    riskLevel,
    matchedSignals: matchedSignals.sort((a, b) => b.severity - a.severity),
    signalCount: matchedSignals.length,
    confidence,
  };
}

// ─── Signal Explanations ─────────────────────────────────────

const FEATURE_LABELS = {
  ticket_count: 'Ticket volume',
  tickets_per_month: 'Monthly ticket rate',
  escalation_rate: 'Escalation rate',
  bad_csat_rate: 'Bad CSAT rate',
  avg_resolution_hours: 'Avg resolution time',
  reopen_rate: 'Ticket reopen rate',
  unique_categories: 'Issue categories',
  priority_high_rate: 'High priority rate',
  ticket_velocity: 'Ticket acceleration',
  problem_ticket_rate: 'Problem ticket rate',
  avg_reopens_per_ticket: 'Reopens per ticket',
  unresolved_rate: 'Unresolved ticket rate',
};

function fmtFeatureValue(name, value) {
  if (name.includes('rate') || name.includes('csat')) return (value * 100).toFixed(0) + '%';
  if (name.includes('hours')) return Math.round(value) + 'h';
  if (name === 'ticket_velocity') return value.toFixed(1) + 'x';
  return (Math.round(value * 10) / 10).toString();
}

function buildSignalExplanation(featureName, value, sig) {
  const label = FEATURE_LABELS[featureName] || featureName;
  const fmt = (v) => fmtFeatureValue(featureName, v);
  return `${label}: ${fmt(value)} (churned avg: ${fmt(sig.churned_mean)}, active avg: ${fmt(sig.active_mean)})`;
}

// ─── Get or Build Signature ──────────────────────────────────

function getOrBuildSignature(db, windowDays) {
  const maxAgeDays = parseInt(process.env.CHURN_SIGNATURE_MAX_AGE_DAYS || '7');
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const cached = db.prepare(
    'SELECT * FROM churn_signatures WHERE window_days = ? AND computed_at >= ? ORDER BY computed_at DESC LIMIT 1'
  ).get(windowDays, cutoff);

  if (cached) {
    console.log(`  Using cached churn signature (computed ${cached.computed_at})`);
    const sig = JSON.parse(cached.signature_json);
    sig.id = cached.id;
    if (cached.model_quality) sig.model_quality = JSON.parse(cached.model_quality);
    return sig;
  }

  console.log('  Building new churn signature...');
  return buildChurnSignature(db, windowDays);
}

// ─── Cross-Validation ────────────────────────────────────────

function runCrossValidation(db, windowDays) {
  const churned = db.prepare(`
    SELECT s.sf_account_id, s.account_name, s.churn_date, m.zd_org_id
    FROM sf_accounts s
    JOIN account_org_map m ON s.sf_account_id = m.sf_account_id
    WHERE s.churn_date IS NOT NULL
  `).all();

  // Filter to only those with ticket data in their pre-churn window
  const churnedWithData = churned.filter(c => {
    const fv = computeFeatureVector(db, c.zd_org_id, new Date(c.churn_date), windowDays);
    return fv !== null;
  });

  if (churnedWithData.length < 3) {
    console.log('  Not enough churned accounts with ticket data for cross-validation');
    return null;
  }

  console.log(`  Leave-one-out cross-validation on ${churnedWithData.length} churned accounts...`);

  let truePositives = 0;
  let falseNegatives = 0;
  const missed = [];

  for (const holdout of churnedWithData) {
    const sig = buildChurnSignature(db, windowDays, [holdout.sf_account_id]);
    if (!sig) continue;

    const fv = computeFeatureVector(db, holdout.zd_org_id, new Date(holdout.churn_date), windowDays);
    if (!fv) { falseNegatives++; continue; }

    const result = scoreAccountAgainstSignature(fv, sig);
    if (result.riskLevel === 'critical' || result.riskLevel === 'high') {
      truePositives++;
    } else {
      falseNegatives++;
      missed.push({
        name: holdout.account_name,
        score: result.score,
        level: result.riskLevel,
        signals: result.signalCount,
      });
    }
  }

  // Check false positive rate on active accounts
  const fullSig = getOrBuildSignature(db, windowDays);
  const active = db.prepare(`
    SELECT s.sf_account_id, m.zd_org_id
    FROM sf_accounts s
    JOIN account_org_map m ON s.sf_account_id = m.sf_account_id
    WHERE s.churn_date IS NULL
    AND m.zd_org_id IN (SELECT DISTINCT org_id FROM zd_tickets WHERE org_id IS NOT NULL)
  `).all();

  let falsePositives = 0;
  for (const a of active) {
    const fv = computeFeatureVector(db, a.zd_org_id, new Date(), windowDays);
    if (!fv) continue;
    const result = scoreAccountAgainstSignature(fv, fullSig);
    if (result.riskLevel === 'critical' || result.riskLevel === 'high') {
      falsePositives++;
    }
  }

  const recall = churnedWithData.length > 0 ? Math.round(truePositives / churnedWithData.length * 100) : 0;
  const precision = truePositives + falsePositives > 0
    ? Math.round(truePositives / (truePositives + falsePositives) * 100)
    : 0;
  const f1 = precision + recall > 0
    ? Math.round(2 * precision * recall / (precision + recall))
    : 0;

  const quality = { recall, precision, f1, truePositives, falseNegatives, falsePositives, missed };

  // Store quality on the latest signature
  if (fullSig.id) {
    db.prepare('UPDATE churn_signatures SET model_quality = ? WHERE id = ?')
      .run(JSON.stringify(quality), fullSig.id);
  }

  return quality;
}

// ─── CLI Command ─────────────────────────────────────────────

function runCLI(args) {
  const rebuild = args.includes('--rebuild');
  const inspect = args.includes('--inspect');
  const windowFlag = args.indexOf('--window');
  const windowDays = windowFlag >= 0 ? parseInt(args[windowFlag + 1]) : parseInt(process.env.CHURN_LOOKBACK_WINDOW || '90');

  console.log('=== Churn Signature ===');
  const db = getDb();

  const churnedCount = db.prepare(`
    SELECT COUNT(*) as n FROM sf_accounts s
    JOIN account_org_map m ON s.sf_account_id = m.sf_account_id
    WHERE s.churn_date IS NOT NULL
  `).get().n;

  if (churnedCount < 3) {
    console.log(`  Only ${churnedCount} churned accounts matched to ZD orgs.`);
    console.log('  Need at least 3 for signature learning.');
    console.log('  Import SF CSV with churn dates, then run match.');
    close();
    return;
  }

  let sig;
  if (rebuild) {
    console.log(`  Rebuilding signature (${windowDays}-day window)...`);
    sig = buildChurnSignature(db, windowDays);
  } else if (inspect) {
    sig = getOrBuildSignature(db, windowDays);
  } else {
    sig = getOrBuildSignature(db, windowDays);
  }

  if (!sig) {
    console.log('  Could not build signature (no churned accounts with ticket data in pre-churn window).');
    close();
    return;
  }

  printSignatureSummary(sig);
  close();
}

function printSignatureSummary(sig) {
  console.log(`  Based on ${sig.churned_sample_size} churned accounts (${sig.window_days}-day window)`);
  console.log(`  Compared against ${sig.active_sample_size} active accounts`);
  console.log('');
  console.log('  Most predictive signals:');
  console.log('  ──────────────────────────────────────────────────────────────');

  const ranked = Object.entries(sig.features)
    .sort((a, b) => b[1].separation - a[1].separation);

  for (const [name, f] of ranked) {
    const label = (FEATURE_LABELS[name] || name).padEnd(24);
    const sep = f.separation.toFixed(2).padStart(5);
    const cFmt = fmtFeatureValue(name, f.churned_mean);
    const aFmt = fmtFeatureValue(name, f.active_mean);
    const wt = (f.weight * 100).toFixed(0) + '%';
    console.log(`    ${label} sep: ${sep}  churned: ${cFmt.padStart(8)}  active: ${aFmt.padStart(8)}  weight: ${wt}`);
  }
}

// ─── Exports ─────────────────────────────────────────────────

module.exports = {
  computeFeatureVector,
  buildChurnSignature,
  scoreAccountAgainstSignature,
  getOrBuildSignature,
  runCrossValidation,
  printSignatureSummary,
  runCLI,
  FEATURE_LABELS,
  fmtFeatureValue,
};
