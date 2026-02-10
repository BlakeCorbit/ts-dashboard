require('dotenv').config();
const { ZendeskClient } = require('./src/zendesk');
const { TicketClusterer } = require('./src/clusterer');

const zd = new ZendeskClient({
  subdomain: process.env.ZENDESK_SUBDOMAIN,
  email: process.env.ZENDESK_EMAIL,
  apiToken: process.env.ZENDESK_API_TOKEN,
});

const clusterer = new TicketClusterer({
  clusterThreshold: 3,
  clusterWindowMinutes: 480,
  keywords: {
    pos: process.env.POS_KEYWORDS.split(',').map(k => k.trim().toLowerCase()),
    comms: process.env.COMMS_KEYWORDS.split(',').map(k => k.trim().toLowerCase()),
    access: process.env.ACCESS_KEYWORDS.split(',').map(k => k.trim().toLowerCase()),
  },
});

zd.getRecentTickets(480).then(tickets => {
  console.log('Total tickets:', tickets.length);

  const ignored = tickets.filter(t => clusterer.shouldIgnore(t));
  const kept = tickets.filter(t => !clusterer.shouldIgnore(t));

  if (ignored.length > 0) {
    console.log('Ignored:', ignored.length);
    ignored.forEach(t => console.log('  SKIP ZD#' + t.id, '-', t.subject.substring(0, 60)));
  }

  console.log('Processing:', kept.length);
  kept.forEach(t => {
    const pos = clusterer.extractPOS(t) || 'no-pos';
    const err = clusterer.extractErrorPattern(t);
    console.log('  ZD#' + t.id, '|', pos, '|', err, '|', t.subject.substring(0, 60));
  });

  console.log('');
  const clusters = clusterer.findClusters(tickets);
  console.log('Clusters:', clusters.length);
  clusters.forEach(c => {
    console.log('  ' + c.pattern + ': ' + c.tickets.length + ' tickets in ' + c.timeSpanMinutes + ' min');
    c.tickets.forEach(t => console.log('    ZD#' + t.id, '-', t.subject.substring(0, 55)));
  });
}).catch(err => console.error('Error:', err.message));
