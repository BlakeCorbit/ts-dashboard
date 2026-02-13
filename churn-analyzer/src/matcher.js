/**
 * Account-Organization Matcher
 *
 * Fuzzy-matches Salesforce accounts to Zendesk organizations using
 * multi-pass matching: exact, token overlap (Jaccard), Levenshtein, domain.
 *
 * Usage:
 *   node src/index.js match
 *   node src/index.js match --link "Company Name" 12345
 *   node src/index.js match --reset
 */

const { getDb, close } = require('./db');

// ─── String Normalization ──────────────────────────────────────

const STRIP_WORDS = new Set([
  'inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company',
  'the', 'auto', 'automotive', 'repair', 'shop', 'service',
  'services', 'center', 'centre', 'group', 'of', 'and', '&',
]);

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => !STRIP_WORDS.has(w) && w.length > 0)
    .join(' ')
    .trim();
}

function tokenize(name) {
  return normalize(name).split(/\s+/).filter(w => w.length > 0);
}

// ─── Similarity Algorithms ─────────────────────────────────────

function jaccard(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

function levenshteinRatio(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ─── Domain Matching ───────────────────────────────────────────

function extractDomains(domainsJson) {
  try {
    const domains = JSON.parse(domainsJson || '[]');
    return domains.map(d => d.toLowerCase().trim()).filter(d => d.length > 0);
  } catch {
    return [];
  }
}

// ─── Multi-Pass Matching ───────────────────────────────────────

function findBestMatches(sfAccounts, zdOrgs) {
  const results = {
    highConfidence: [],   // score >= 0.85
    needsReview: [],      // 0.5 <= score < 0.85
    unmatched: [],        // no match found
  };

  // Build ZD org lookup by normalized name
  const zdByNormalized = new Map();
  const zdByDomain = new Map();

  for (const org of zdOrgs) {
    const norm = normalize(org.name);
    if (norm) {
      if (!zdByNormalized.has(norm)) {
        zdByNormalized.set(norm, []);
      }
      zdByNormalized.get(norm).push(org);
    }

    // Index by domain
    const domains = extractDomains(org.domain_names);
    for (const domain of domains) {
      zdByDomain.set(domain, org);
    }
  }

  for (const sf of sfAccounts) {
    const sfNorm = normalize(sf.account_name);
    if (!sfNorm) {
      results.unmatched.push({ sf, bestOrg: null, score: 0, method: 'none' });
      continue;
    }

    let bestOrg = null;
    let bestScore = 0;
    let bestMethod = '';

    // Pass 1: Exact match on normalized name
    const exactMatches = zdByNormalized.get(sfNorm);
    if (exactMatches && exactMatches.length > 0) {
      bestOrg = exactMatches[0];
      bestScore = 1.0;
      bestMethod = 'exact';
    }

    // Pass 2: Token overlap (Jaccard)
    if (!bestOrg) {
      for (const org of zdOrgs) {
        const score = jaccard(sf.account_name, org.name);
        if (score > bestScore) {
          bestOrg = org;
          bestScore = score;
          bestMethod = 'fuzzy';
        }
      }
    }

    // Pass 3: Levenshtein if Jaccard didn't find a good match
    if (bestScore < 0.5) {
      for (const org of zdOrgs) {
        const score = levenshteinRatio(sf.account_name, org.name);
        if (score > bestScore) {
          bestOrg = org;
          bestScore = score;
          bestMethod = 'levenshtein';
        }
      }
    }

    // Threshold: minimum 0.5 to be considered a match
    if (bestScore >= 0.85) {
      results.highConfidence.push({ sf, bestOrg, score: Math.round(bestScore * 100) / 100, method: bestMethod });
    } else if (bestScore >= 0.5) {
      results.needsReview.push({ sf, bestOrg, score: Math.round(bestScore * 100) / 100, method: bestMethod });
    } else {
      results.unmatched.push({ sf, bestOrg, score: Math.round(bestScore * 100) / 100, method: bestMethod });
    }
  }

  return results;
}

// ─── Main ──────────────────────────────────────────────────────

function run(args) {
  const db = getDb();

  // Handle --link command
  const linkIdx = args.indexOf('--link');
  if (linkIdx >= 0) {
    const sfName = args[linkIdx + 1];
    const zdOrgId = parseInt(args[linkIdx + 2]);

    if (!sfName || !zdOrgId) {
      console.error('Usage: node src/index.js match --link "Company Name" 12345');
      process.exit(1);
    }

    const sf = db.prepare('SELECT * FROM sf_accounts WHERE account_name = ? COLLATE NOCASE').get(sfName);
    if (!sf) {
      console.error(`No SF account found with name: "${sfName}"`);
      process.exit(1);
    }

    const zd = db.prepare('SELECT * FROM zd_organizations WHERE id = ?').get(zdOrgId);
    if (!zd) {
      console.error(`No ZD organization found with ID: ${zdOrgId}`);
      process.exit(1);
    }

    db.prepare(`
      INSERT OR REPLACE INTO account_org_map (sf_account_id, zd_org_id, match_method, match_score, confirmed)
      VALUES (?, ?, 'manual', 1.0, 1)
    `).run(sf.sf_account_id, zdOrgId);

    console.log(`Linked: "${sf.account_name}" -> "${zd.name}" (ZD #${zdOrgId}) [manual, confirmed]`);
    close();
    return;
  }

  // Handle --reset
  if (args.includes('--reset')) {
    const deleted = db.prepare('DELETE FROM account_org_map WHERE confirmed = 0').run();
    console.log(`Cleared ${deleted.changes} unconfirmed matches.`);
    close();
    return;
  }

  // Main matching flow
  console.log('=== Account Matching ===');

  const sfAccounts = db.prepare('SELECT * FROM sf_accounts').all();
  const zdOrgs = db.prepare('SELECT * FROM zd_organizations').all();

  if (sfAccounts.length === 0) {
    console.error('No SF accounts found. Run: node src/index.js import-sf <file.csv>');
    close();
    process.exit(1);
  }

  if (zdOrgs.length === 0) {
    console.error('No ZD organizations found. Run: node src/index.js import-zendesk');
    close();
    process.exit(1);
  }

  console.log(`  SF Accounts: ${sfAccounts.length} | ZD Organizations: ${zdOrgs.length}`);
  console.log('');

  // Check for existing confirmed matches (skip those)
  const confirmedMap = new Map();
  const existingMatches = db.prepare('SELECT sf_account_id, zd_org_id FROM account_org_map WHERE confirmed = 1').all();
  for (const m of existingMatches) {
    confirmedMap.set(m.sf_account_id, m.zd_org_id);
  }

  const toMatch = sfAccounts.filter(a => !confirmedMap.has(a.sf_account_id));
  console.log(`  Already confirmed: ${existingMatches.length} | To match: ${toMatch.length}`);

  if (toMatch.length === 0) {
    console.log('  All accounts already matched and confirmed.');
    close();
    return;
  }

  const results = findBestMatches(toMatch, zdOrgs);

  // Save high-confidence matches
  const insertMatch = db.prepare(`
    INSERT OR REPLACE INTO account_org_map (sf_account_id, zd_org_id, match_method, match_score, confirmed)
    VALUES (@sf_account_id, @zd_org_id, @match_method, @match_score, @confirmed)
  `);

  const saveMatches = db.transaction((matches, confirmed) => {
    let count = 0;
    for (const m of matches) {
      if (!m.bestOrg) continue;
      insertMatch.run({
        sf_account_id: m.sf.sf_account_id,
        zd_org_id: m.bestOrg.id,
        match_method: m.method,
        match_score: m.score,
        confirmed: confirmed ? 1 : 0,
      });
      count++;
    }
    return count;
  });

  // Auto-confirm high confidence
  const highSaved = saveMatches(results.highConfidence, true);

  // Save needs-review as unconfirmed
  const reviewSaved = saveMatches(results.needsReview, false);

  // Print results
  console.log('');
  console.log(`  --- High Confidence (auto-confirmed): ${results.highConfidence.length} ---`);
  for (const m of results.highConfidence.slice(0, 10)) {
    console.log(`    [OK] "${m.sf.account_name}" -> "${m.bestOrg.name}" (${m.method}, ${m.score})`);
  }
  if (results.highConfidence.length > 10) {
    console.log(`    ... and ${results.highConfidence.length - 10} more`);
  }

  console.log('');
  console.log(`  --- Needs Review: ${results.needsReview.length} ---`);
  for (const m of results.needsReview.slice(0, 20)) {
    console.log(`    [?] "${m.sf.account_name}" -> "${m.bestOrg.name}" (${m.method}, ${m.score})`);
  }
  if (results.needsReview.length > 20) {
    console.log(`    ... and ${results.needsReview.length - 20} more`);
  }
  if (results.needsReview.length > 0) {
    console.log('');
    console.log('  To confirm a match: node src/index.js match --link "Company Name" <zd_org_id>');
  }

  console.log('');
  console.log(`  --- Unmatched: ${results.unmatched.length} ---`);
  for (const m of results.unmatched.slice(0, 15)) {
    const closest = m.bestOrg ? ` (closest: "${m.bestOrg.name}" at ${m.score})` : '';
    console.log(`    [ ] "${m.sf.account_name}"${closest}`);
  }
  if (results.unmatched.length > 15) {
    console.log(`    ... and ${results.unmatched.length - 15} more`);
  }

  console.log('');
  console.log('  Summary:');
  console.log(`    Auto-confirmed: ${highSaved}`);
  console.log(`    Needs review:   ${reviewSaved}`);
  console.log(`    Unmatched:      ${results.unmatched.length}`);

  close();
}

module.exports = { run, normalize, jaccard, levenshteinRatio };
