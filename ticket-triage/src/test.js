/**
 * Test triage rules against the last 24 hours of real tickets.
 * READ-ONLY — does not modify anything in Zendesk.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ZendeskClient } = require('./zendesk');
const { TriageEngine } = require('./rules');

const zendesk = new ZendeskClient({
  subdomain: process.env.ZENDESK_SUBDOMAIN,
  email: process.env.ZENDESK_EMAIL,
  apiToken: process.env.ZENDESK_API_TOKEN,
});

const engine = new TriageEngine();

async function test() {
  console.log('=== Triage Test: Last 24 hours of tickets ===');
  console.log('READ-ONLY — nothing is modified in Zendesk');
  console.log('');

  const tickets = await zendesk.getRecentTickets(1440); // 24 hours
  console.log(`Fetched ${tickets.length} tickets\n`);

  const stats = { ignored: 0, matched: 0, unmatched: 0, byCategory: {}, byRule: {} };

  for (const ticket of tickets) {
    const result = engine.triage(ticket);

    if (result.ignored) {
      stats.ignored++;
      continue;
    }

    if (result.rule === 'unmatched') {
      stats.unmatched++;
      console.log(`  ? ZD#${ticket.id} - UNMATCHED - ${ticket.subject.substring(0, 60)}`);
    } else {
      stats.matched++;
      const flag = result.suggestedPriority === 'high' ? ' !!!' : '';
      console.log(`  ✓ ZD#${ticket.id}${flag} [${result.subcategory}] ${ticket.subject.substring(0, 50)}`);
    }

    const cat = result.category;
    stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
    stats.byRule[result.rule] = (stats.byRule[result.rule] || 0) + 1;
  }

  console.log('\n── TRIAGE STATS ────────────────────────────');
  console.log(`  Total:      ${tickets.length}`);
  console.log(`  Ignored:    ${stats.ignored}`);
  console.log(`  Matched:    ${stats.matched} (${Math.round(stats.matched / (tickets.length - stats.ignored) * 100)}%)`);
  console.log(`  Unmatched:  ${stats.unmatched} (${Math.round(stats.unmatched / (tickets.length - stats.ignored) * 100)}%)`);

  console.log('\n── BY CATEGORY ─────────────────────────────');
  const sortedCats = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats) {
    console.log(`  ${String(count).padStart(4)}  ${cat}`);
  }

  console.log('\n── BY RULE ─────────────────────────────────');
  const sortedRules = Object.entries(stats.byRule).sort((a, b) => b[1] - a[1]);
  for (const [rule, count] of sortedRules) {
    console.log(`  ${String(count).padStart(4)}  ${rule}`);
  }
}

test().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
