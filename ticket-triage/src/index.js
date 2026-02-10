require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ZendeskClient } = require('./zendesk');
const { TriageEngine } = require('./rules');

const config = {
  zendesk: {
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    email: process.env.ZENDESK_EMAIL,
    apiToken: process.env.ZENDESK_API_TOKEN,
  },
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10),
};

const missing = [];
if (!config.zendesk.subdomain) missing.push('ZENDESK_SUBDOMAIN');
if (!config.zendesk.email) missing.push('ZENDESK_EMAIL');
if (!config.zendesk.apiToken) missing.push('ZENDESK_API_TOKEN');
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const zendesk = new ZendeskClient(config.zendesk);
const engine = new TriageEngine();

// Track tickets we've already triaged
const seen = new Set();

async function poll() {
  try {
    const tickets = await zendesk.getRecentTickets(30); // Last 30 min
    let newCount = 0;

    for (const ticket of tickets) {
      if (seen.has(ticket.id)) continue;
      seen.add(ticket.id);
      newCount++;

      const result = engine.triage(ticket);

      if (result.ignored) {
        console.log(`  SKIP  ZD#${ticket.id} - ${result.reason}`);
        continue;
      }

      const priorityFlag = result.suggestedPriority === 'high' ? ' !!!' : '';
      console.log('');
      console.log(`  ┌─ ZD#${ticket.id}${priorityFlag}`);
      console.log(`  │  Subject:    ${ticket.subject.substring(0, 70)}`);
      console.log(`  │  Category:   ${result.category} > ${result.subcategory}`);
      if (result.runbook) {
        console.log(`  │  Runbook:    ${result.runbook.title}`);
        console.log(`  │              ${result.runbook.url}`);
      }
      console.log(`  │  Action:     ${result.suggestedAction.substring(0, 100)}`);
      if (result.suggestedPriority && result.suggestedPriority !== ticket.priority) {
        console.log(`  │  Priority:   ${ticket.priority || 'none'} → suggest ${result.suggestedPriority}`);
      }
      console.log(`  │  Tags:       ${(result.autoTags || []).join(', ')}`);
      console.log(`  └─ Rule: ${result.rule}`);
    }

    if (newCount > 0) {
      console.log(`\n[${new Date().toISOString()}] Triaged ${newCount} new ticket(s)`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
  }
}

async function run() {
  console.log('=== AutoVitals Ticket Triage (READ-ONLY) ===');
  console.log('This tool only READS tickets. It does NOT modify anything in Zendesk.');
  console.log(`Polling every ${config.pollIntervalSeconds}s for new tickets...`);
  console.log('');

  await poll();
  setInterval(poll, config.pollIntervalSeconds * 1000);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
