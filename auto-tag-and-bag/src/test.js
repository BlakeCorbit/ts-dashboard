/**
 * Test the tag-and-bag system against live data. READ-ONLY.
 * Shows detected incidents with Jira links and matching tickets.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ZendeskClient } = require('./zendesk');
const { IncidentTracker } = require('./tracker');

const zendesk = new ZendeskClient({
  subdomain: process.env.ZENDESK_SUBDOMAIN,
  email: process.env.ZENDESK_EMAIL,
  apiToken: process.env.ZENDESK_API_TOKEN,
  liveMode: false,
});

async function test() {
  console.log('=== Auto Tag-and-Bag Test ===');
  console.log('READ-ONLY — detecting incidents and matching tickets');
  console.log('');

  const tracker = new IncidentTracker(zendesk);

  // Scan for Problem tickets (this also fetches Jira links)
  await tracker.scanForProblemTickets();

  // Process matching
  await tracker.processAllIncidents();

  // Summary
  console.log('\n\n=== Summary ===');
  for (const [problemId, incident] of tracker.activeIncidents.entries()) {
    const jiraStr = incident.jiraLinks.length > 0
      ? incident.jiraLinks.map(j => `${j.issueKey} (${j.url})`).join(', ')
      : 'none';
    console.log(`  ZD#${problemId}: ${incident.subject.substring(0, 55)}`);
    console.log(`    Pattern:  ${incident.patternDescription}`);
    console.log(`    Jira:     ${jiraStr}`);
    console.log(`    Linked:   ${incident.linkedCount} tickets`);
    console.log(`    Keywords: ${incident.matcher.strongKeywords.slice(0, 4).join(', ')}`);
    console.log('');
  }
}

test().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
