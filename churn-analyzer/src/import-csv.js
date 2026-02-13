/**
 * Salesforce CSV Importer
 *
 * Imports account/churn data from Salesforce CSV exports.
 * Auto-detects column mappings by matching header names to known patterns.
 * Stores full original row as JSON for re-mapping if needed.
 *
 * Usage:
 *   node src/index.js import-sf <file.csv>
 *   node src/index.js import-sf <file.csv> --dry-run
 *   node src/index.js import-sf <file.csv> --map "churn_date=Close Date,mrr=Monthly Value"
 */

const fs = require('fs');
const path = require('path');
const { getDb, close } = require('./db');

// ─── Column Detection ──────────────────────────────────────────

const COLUMN_PATTERNS = {
  sf_account_id: ['account id', 'accountid', 'sf id', 'salesforce id', 'record id'],
  account_name:  ['account name', 'company', 'company name', 'name', 'organization', 'customer', 'customer name'],
  status:        ['account status', 'status', 'stage', 'lifecycle', 'lifecycle stage', 'account stage'],
  owner:         ['account owner', 'owner', 'csm', 'customer success', 'account manager'],
  industry:      ['industry', 'vertical', 'segment', 'type'],
  mrr:           ['mrr', 'monthly recurring', 'monthly revenue', 'monthly amount'],
  arr:           ['arr', 'annual recurring', 'annual revenue', 'acv', 'contract value', 'annual amount', 'total contract'],
  contract_start: ['contract start', 'start date', 'subscription start', 'created date', 'signed date', 'close date'],
  contract_end:  ['contract end', 'end date', 'renewal date', 'expiration', 'expiration date', 'renewal'],
  churn_date:    ['churn date', 'cancellation date', 'cancel date', 'lost date', 'churned date', 'terminated date'],
  churn_reason:  ['churn reason', 'cancel reason', 'loss reason', 'reason', 'cancellation reason'],
  pos_system:    ['pos', 'pos system', 'point of sale', 'integration', 'sms', 'shop management'],
  shop_count:    ['shops', 'shop count', 'locations', 'location count', 'sites', 'store count'],
};

const CHURN_STATUSES = ['churned', 'cancelled', 'canceled', 'lost', 'closed-lost', 'closed lost', 'inactive', 'terminated'];
const DOWNGRADE_STATUSES = ['downgraded', 'reduced', 'downsell'];

// ─── CSV Parser ────────────────────────────────────────────────

function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

// ─── Column Auto-Detection ─────────────────────────────────────

function detectMapping(headers) {
  const mapping = {};
  const normalized = headers.map(h => h.toLowerCase().trim());

  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    let bestMatch = null;
    let bestScore = 0;

    for (let i = 0; i < normalized.length; i++) {
      const header = normalized[i];

      for (const pattern of patterns) {
        // Exact match
        if (header === pattern) {
          bestMatch = i;
          bestScore = 100;
          break;
        }
        // Contains match
        if (header.includes(pattern) || pattern.includes(header)) {
          const score = pattern.length / Math.max(header.length, pattern.length) * 80;
          if (score > bestScore) {
            bestMatch = i;
            bestScore = score;
          }
        }
      }
      if (bestScore === 100) break;
    }

    if (bestMatch !== null && bestScore >= 40) {
      mapping[field] = headers[bestMatch];
    }
  }

  return mapping;
}

function applyOverrides(mapping, overrideStr) {
  if (!overrideStr) return mapping;

  const pairs = overrideStr.split(',');
  for (const pair of pairs) {
    const [field, csvCol] = pair.split('=').map(s => s.trim());
    if (field && csvCol) {
      mapping[field] = csvCol;
    }
  }
  return mapping;
}

// ─── Date Parsing ──────────────────────────────────────────────

function parseDate(str) {
  if (!str || str.trim() === '') return null;
  str = str.trim();

  // ISO format: 2024-01-15 or 2024-01-15T...
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.split('T')[0];
  }

  // MM/DD/YYYY
  const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }

  // M/D/YY
  const mdyShort = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mdyShort) {
    const year = parseInt(mdyShort[3]) > 50 ? '19' + mdyShort[3] : '20' + mdyShort[3];
    return `${year}-${mdyShort[1].padStart(2, '0')}-${mdyShort[2].padStart(2, '0')}`;
  }

  // DD-Mon-YYYY (e.g., 15-Jan-2024)
  const dmy = str.match(/^(\d{1,2})-(\w{3})-(\d{4})$/);
  if (dmy) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const m = months[dmy[2].toLowerCase()];
    if (m) return `${dmy[3]}-${m}-${dmy[1].padStart(2, '0')}`;
  }

  // Fallback: try native Date parsing
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }

  return null;
}

function parseNumber(str) {
  if (!str || str.trim() === '') return null;
  // Remove $ , and other formatting
  const cleaned = str.replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ─── Import Logic ──────────────────────────────────────────────

function run(args) {
  const filePath = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const mapFlag = args.find(a => a.startsWith('--map'));
  const mapValue = mapFlag ? args[args.indexOf(mapFlag) + 1] : null;

  if (!filePath) {
    console.error('Usage: node src/index.js import-sf <file.csv> [--dry-run] [--map "field=Column,field=Column"]');
    console.error('\nDrop your Salesforce CSV export in data/imports/ and run:');
    console.error('  node src/index.js import-sf data/imports/your-file.csv');
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log('=== Salesforce CSV Import ===');
  console.log(`  File: ${resolvedPath}`);
  console.log('');

  const text = fs.readFileSync(resolvedPath, 'utf-8');
  const { headers, rows } = parseCSV(text);

  console.log(`  Headers found: ${headers.length}`);
  console.log(`  Rows found: ${rows.length}`);
  console.log('');

  // Auto-detect + apply overrides
  let mapping = detectMapping(headers);
  if (mapValue) {
    mapping = applyOverrides(mapping, mapValue);
  }

  // Display mapping
  console.log('  Column Mapping:');
  console.log('  ───────────────────────────────────────');
  for (const [field, csvCol] of Object.entries(mapping)) {
    console.log(`    ${field.padEnd(18)} <- "${csvCol}"`);
  }

  // Show unmapped headers
  const mappedCols = new Set(Object.values(mapping));
  const unmapped = headers.filter(h => !mappedCols.has(h));
  if (unmapped.length > 0) {
    console.log('');
    console.log('  Unmapped columns (stored in raw_data):');
    unmapped.forEach(h => console.log(`    - "${h}"`));
  }

  // Check required fields
  if (!mapping.account_name) {
    console.error('\n  ERROR: Could not detect an "account_name" column.');
    console.error('  Use --map "account_name=Your Column Name" to specify it.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('\n  [DRY RUN] No data imported. Review the mapping above and run without --dry-run to import.');
    return;
  }

  // Import into SQLite
  const db = getDb();

  const insertAccount = db.prepare(`
    INSERT OR REPLACE INTO sf_accounts (
      sf_account_id, account_name, status, owner, industry,
      mrr, arr, contract_start, contract_end, churn_date,
      churn_reason, pos_system, shop_count, raw_data
    ) VALUES (
      @sf_account_id, @account_name, @status, @owner, @industry,
      @mrr, @arr, @contract_start, @contract_end, @churn_date,
      @churn_reason, @pos_system, @shop_count, @raw_data
    )
  `);

  const insertChurnEvent = db.prepare(`
    INSERT OR IGNORE INTO sf_churn_events (sf_account_id, event_type, event_date, reason, revenue_impact)
    VALUES (@sf_account_id, @event_type, @event_date, @reason, @revenue_impact)
  `);

  const importMany = db.transaction((rows) => {
    let imported = 0;
    let churnEvents = 0;

    for (const row of rows) {
      const getValue = (field) => row[mapping[field]] || null;

      const sfId = getValue('sf_account_id') || `auto_${imported}_${Date.now()}`;
      const name = getValue('account_name');
      if (!name) continue;

      const status = getValue('status');
      const mrr = parseNumber(getValue('mrr'));
      const churnDate = parseDate(getValue('churn_date'));

      const record = {
        sf_account_id: sfId,
        account_name: name,
        status: status,
        owner: getValue('owner'),
        industry: getValue('industry'),
        mrr: mrr,
        arr: parseNumber(getValue('arr')),
        contract_start: parseDate(getValue('contract_start')),
        contract_end: parseDate(getValue('contract_end')),
        churn_date: churnDate,
        churn_reason: getValue('churn_reason'),
        pos_system: getValue('pos_system'),
        shop_count: parseNumber(getValue('shop_count')),
        raw_data: JSON.stringify(row),
      };

      insertAccount.run(record);
      imported++;

      // Auto-detect churn events
      const statusLower = (status || '').toLowerCase().trim();
      if (CHURN_STATUSES.includes(statusLower) || churnDate) {
        const eventDate = churnDate || parseDate(getValue('contract_end')) || new Date().toISOString().split('T')[0];
        insertChurnEvent.run({
          sf_account_id: sfId,
          event_type: DOWNGRADE_STATUSES.includes(statusLower) ? 'downgraded' : 'churned',
          event_date: eventDate,
          reason: getValue('churn_reason'),
          revenue_impact: mrr,
        });
        churnEvents++;
      }
    }

    return { imported, churnEvents };
  });

  const result = importMany(rows);
  close();

  console.log('');
  console.log('  Import Complete:');
  console.log(`    Accounts imported: ${result.imported}`);
  console.log(`    Churn events detected: ${result.churnEvents}`);
}

module.exports = { run, parseCSV, detectMapping };
