#!/usr/bin/env node
/**
 * Churn Analyzer CLI
 *
 * Customer churn prediction tool that correlates Salesforce account data
 * with Zendesk support ticket patterns to identify at-risk accounts.
 *
 * Commands:
 *   import-sf <file.csv>   Import Salesforce CSV export
 *   import-zendesk         Fetch Zendesk orgs + tickets into SQLite
 *   match                  Auto-match SF accounts to ZD organizations
 *   analyze                Compute churn risk scores
 *   report                 Print report (--dashboard for JSON, --csv for CSV)
 *   status                 Show database stats
 */

const path = require('path');
const fs = require('fs');

// Load .env from this project or from auto-metrics (shared creds)
const envPath = path.join(__dirname, '..', '.env');
const fallbackEnv = path.join(__dirname, '..', '..', 'auto-metrics', '.env');

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else if (fs.existsSync(fallbackEnv)) {
  require('dotenv').config({ path: fallbackEnv });
} else {
  require('dotenv').config();
}

const command = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  'import-sf': () => require('./import-csv').run(args),
  'import-zendesk': () => require('./import-zendesk').run(args),
  'match': () => require('./matcher').run(args),
  'analyze': () => require('./analyzer').run(args),
  'learn': () => require('./churn-signature').runCLI(args),
  'report': () => require('./report').run(args),
  'status': () => require('./report').status(),
};

function showHelp() {
  console.log(`
Churn Analyzer - Customer churn prediction via Salesforce + Zendesk correlation

Usage: node src/index.js <command> [options]

Commands:
  import-sf <file.csv>       Import Salesforce account/churn CSV data
    --dry-run                 Show column mapping without importing
    --map "field=Col,..."     Override auto-detected column mapping

  import-zendesk             Fetch all Zendesk orgs + tickets into SQLite
    --days <n>               Lookback period in days (default: 180)

  match                      Auto-match SF accounts to ZD organizations
    --link "Name" <org_id>   Manually link an account to a ZD org
    --reset                  Clear unconfirmed matches

  analyze                    Compute risk scores for all matched accounts
    --validate               Also run model validation against known churns
    --learn                  Force rebuild of churn signature

  learn                      Build/inspect churn signature
    --rebuild                Force rebuild even if recent signature exists
    --window <days>          Pre-churn analysis window (default: 90)
    --inspect                Show detailed signature without rebuilding

  report                     Print churn risk report to console
    --dashboard              Output JSON for the web dashboard
    --csv                    Export risk scores as CSV

  status                     Show database statistics

Examples:
  node src/index.js import-sf data/imports/accounts.csv --dry-run
  node src/index.js import-zendesk --days 90
  node src/index.js match
  node src/index.js analyze --validate
  node src/index.js report --dashboard
`);
}

if (!command || command === 'help' || command === '--help') {
  showHelp();
  process.exit(0);
}

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  showHelp();
  process.exit(1);
}

// Run (handle both sync and async commands)
const result = handler();
if (result && typeof result.catch === 'function') {
  result.catch(err => {
    console.error('Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
