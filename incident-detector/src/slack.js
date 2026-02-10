/**
 * Slack notification sender for incident alerts.
 * Uses Slack Incoming Webhooks to post to #emergency-updates.
 */

class SlackNotifier {
  constructor({ webhookUrl }) {
    this.webhookUrl = webhookUrl;
  }

  /**
   * Send an incident alert to Slack.
   */
  async sendIncidentAlert(cluster) {
    const ticketLinks = cluster.tickets
      .map(t => `<https://bayiq.zendesk.com/agent/tickets/${t.id}|ZD#${t.id}>`)
      .join(', ');

    const shopList = cluster.organizations.length > 0
      ? `${cluster.organizations.length} shop(s) affected`
      : 'Shop info not available (check tickets)';

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':rotating_light: POTENTIAL INCIDENT DETECTED',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Pattern:*\n${cluster.pattern}`,
          },
          {
            type: 'mrkdwn',
            text: `*Cluster Size:*\n${cluster.tickets.length} tickets in ${cluster.timeSpanMinutes} min`,
          },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Affected:*\n${shopList}`,
          },
          {
            type: 'mrkdwn',
            text: `*Tickets:*\n${ticketLinks}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Detected by Incident Detector at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT | Threshold: ${cluster.tickets.length}/${process.env.CLUSTER_THRESHOLD || 3} tickets`,
          },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':point_right: *Next steps:* Verify in Zendesk, check #emergency-alerts for monitoring alerts, and follow <https://autovitals.atlassian.net/wiki/spaces/PEOP/pages/2821357573|TS Emergency SOP v2>.',
        },
      },
    ];

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Slack webhook ${response.status}: ${body}`);
    }

    console.log(`[SLACK] Alert sent for cluster: "${cluster.pattern}"`);
  }
}

module.exports = { SlackNotifier };
