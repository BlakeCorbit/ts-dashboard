require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ZendeskClient } = require('./zendesk');
const { IncidentTracker } = require('./tracker');

const config = {
  zendesk: {
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    email: process.env.ZENDESK_EMAIL,
    apiToken: process.env.ZENDESK_API_TOKEN,
    liveMode: process.env.LIVE_MODE === 'true',
  },
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10),
};

if (!config.zendesk.subdomain || !config.zendesk.email || !config.zendesk.apiToken) {
  console.error('Missing Zendesk credentials. Check .env file.');
  process.exit(1);
}

const zendesk = new ZendeskClient(config.zendesk);
const tracker = new IncidentTracker(zendesk);

async function poll() {
  try {
    // 1. Scan for new/active Problem tickets (auto-detect incidents)
    await tracker.scanForProblemTickets();

    // 2. For each active incident, find and link matching tickets
    await tracker.processAllIncidents();

  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
  }
}

async function run() {
  const mode = config.zendesk.liveMode ? 'LIVE' : 'DRY-RUN (read-only)';

  console.log('=== Auto Tag-and-Bag (Multi-Incident) ===');
  console.log(`Mode:            ${mode}`);
  console.log(`Poll Interval:   ${config.pollIntervalSeconds}s`);
  console.log('');
  console.log('Auto-detecting Problem tickets in Zendesk...');
  console.log('Supports multiple simultaneous incidents.');
  console.log('');

  await poll();
  setInterval(poll, config.pollIntervalSeconds * 1000);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
