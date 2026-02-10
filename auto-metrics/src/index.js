require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ZendeskClient } = require('./zendesk');
const { TicketAnalyzer } = require('./analyzer');
const { ReportFormatter } = require('./formatter');

const config = {
  zendesk: {
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    email: process.env.ZENDESK_EMAIL,
    apiToken: process.env.ZENDESK_API_TOKEN,
  },
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  reportDays: parseInt(process.env.REPORT_DAYS || '7', 10),
};

// Validate
const missing = [];
if (!config.zendesk.subdomain) missing.push('ZENDESK_SUBDOMAIN');
if (!config.zendesk.email) missing.push('ZENDESK_EMAIL');
if (!config.zendesk.apiToken) missing.push('ZENDESK_API_TOKEN');
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

async function run() {
  const days = config.reportDays;
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(`Generating report for last ${days} days (${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]})...`);
  console.log('');

  const zd = new ZendeskClient(config.zendesk);
  const analyzer = new TicketAnalyzer();

  // Fetch data in parallel
  console.log('Fetching data from Zendesk...');
  const [created, resolved, open, agents, groups] = await Promise.all([
    zd.getTicketsInRange(startDate, endDate).then(r => { console.log(`  Created tickets: ${r.length}`); return r; }),
    zd.getResolvedTicketsInRange(startDate, endDate).then(r => { console.log(`  Resolved tickets: ${r.length}`); return r; }),
    zd.getOpenTickets().then(r => { console.log(`  Open tickets: ${r.length}`); return r; }),
    zd.getAgents().then(r => { console.log(`  Agents: ${r.length}`); return r; }),
    zd.getGroups().then(r => { console.log(`  Groups: ${r.length}`); return r; }),
  ]);

  console.log('');
  console.log('Analyzing...');

  const report = analyzer.generateReport(created, resolved, open, agents, groups, days);
  const output = ReportFormatter.toConsole(report);
  console.log(output);

  // Post to Slack if webhook configured
  if (config.slackWebhookUrl) {
    console.log('Posting to Slack...');
    const slackPayload = ReportFormatter.toSlack(report);
    const response = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    });
    if (response.ok) {
      console.log('Slack report posted.');
    } else {
      console.error('Slack post failed:', await response.text());
    }
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
