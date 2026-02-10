require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ZendeskClient } = require('./zendesk');
const { TicketClusterer } = require('./clusterer');
const { SlackNotifier } = require('./slack');

const config = {
  zendesk: {
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    email: process.env.ZENDESK_EMAIL,
    apiToken: process.env.ZENDESK_API_TOKEN,
  },
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
  },
  clusterThreshold: parseInt(process.env.CLUSTER_THRESHOLD || '3', 10),
  clusterWindowMinutes: parseInt(process.env.CLUSTER_WINDOW_MINUTES || '15', 10),
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10),
  keywords: {
    pos: (process.env.POS_KEYWORDS || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
    comms: (process.env.COMMS_KEYWORDS || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
    access: (process.env.ACCESS_KEYWORDS || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
  },
};

// Validate required config
const missing = [];
if (!config.zendesk.subdomain) missing.push('ZENDESK_SUBDOMAIN');
if (!config.zendesk.email) missing.push('ZENDESK_EMAIL');
if (!config.zendesk.apiToken) missing.push('ZENDESK_API_TOKEN');
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

const dryRun = !config.slack.webhookUrl;
if (dryRun) {
  console.log('** DRY-RUN MODE: No SLACK_WEBHOOK_URL set. Alerts will log to console only. **');
  console.log('');
}

const zendesk = new ZendeskClient(config.zendesk);
const clusterer = new TicketClusterer(config);
const slack = new SlackNotifier(config.slack);

// Track which clusters we've already alerted on (fingerprint -> {size, timestamp})
const alertedClusters = new Map();

async function poll() {
  try {
    const tickets = await zendesk.getRecentTickets(config.clusterWindowMinutes);
    if (tickets.length === 0) return;

    console.log(`[${new Date().toISOString()}] Fetched ${tickets.length} tickets from last ${config.clusterWindowMinutes} min`);

    const clusters = clusterer.findClusters(tickets);

    for (const cluster of clusters) {
      if (cluster.tickets.length < config.clusterThreshold) continue;

      const fingerprint = cluster.fingerprint;
      const prev = alertedClusters.get(fingerprint);
      if (prev && cluster.tickets.length <= prev.size + 2) continue;

      console.log(`[ALERT] Cluster detected: "${cluster.pattern}" with ${cluster.tickets.length} tickets`);
      await slack.sendIncidentAlert(cluster);
      alertedClusters.set(fingerprint, { size: cluster.tickets.length, timestamp: Date.now() });
    }

    // Clean up old fingerprints (older than 2x the window)
    const cutoff = Date.now() - (config.clusterWindowMinutes * 2 * 60 * 1000);
    for (const [fp, data] of alertedClusters.entries()) {
      if (data.timestamp < cutoff) {
        alertedClusters.delete(fp);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
  }
}

async function run() {
  console.log('=== AutoVitals Incident Detector ===');
  console.log(`Polling Zendesk every ${config.pollIntervalSeconds}s`);
  console.log(`Cluster threshold: ${config.clusterThreshold} tickets in ${config.clusterWindowMinutes} min`);
  console.log(`Monitoring keyword categories: POS (${config.keywords.pos.length}), Comms (${config.keywords.comms.length}), Access (${config.keywords.access.length})`);
  console.log('');

  // Initial poll
  await poll();

  // Schedule recurring polls
  setInterval(poll, config.pollIntervalSeconds * 1000);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
