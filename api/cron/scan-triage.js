// Vercel Cron: Background triage scanner (every 15 minutes)
// Auto-links high-confidence matches, detects late arrivals, logs to audit trail.

const { zdRequest, getJiraLinks, getAuth } = require('../_zendesk');
const { isKVConfigured, kvListPush, kvSetJSON, kvGetJSON } = require('../_kv');
const { buildReply } = require('../_templates');

// Verify cron secret to prevent unauthorized invocations
function verifyCronAuth(req) {
  const secret = req.headers['authorization'];
  return secret === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // In production, verify cron secret
  if (process.env.CRON_SECRET && !verifyCronAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const autoApproveThreshold = parseInt(process.env.AUTO_APPROVE_THRESHOLD || '0', 10);
    const sendAutoReply = process.env.AUTO_REPLY_ENABLED === 'true';

    // 1. Fetch triage queue
    const triageResp = await fetch(
      `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/triage-queue?hours=2`,
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!triageResp.ok) {
      return res.json({ success: false, error: 'Failed to fetch triage queue' });
    }

    const triageData = await triageResp.json();
    const queue = triageData.queue || [];

    // 2. Get previously handled tickets from KV to avoid re-processing
    let handledSet = {};
    if (isKVConfigured()) {
      const handled = await kvGetJSON('cron:handled_ids') || {};
      handledSet = handled;
    }

    let autoLinked = 0;
    let skipped = 0;
    const results = [];

    for (const item of queue) {
      // Skip already handled
      if (handledSet[item.ticketId]) {
        skipped++;
        continue;
      }

      // Auto-link if above threshold
      if (autoApproveThreshold > 0 && item.match && item.match.score >= autoApproveThreshold) {
        try {
          // Link ticket as incident
          await zdRequest(`/tickets/${item.ticketId}.json`, {
            method: 'PUT',
            body: { ticket: { type: 'incident', problem_id: item.match.problemId } },
          });

          // Post auto-reply if enabled
          if (sendAutoReply && item.suggestedReply) {
            await zdRequest(`/tickets/${item.ticketId}.json`, {
              method: 'PUT',
              body: { ticket: { comment: { body: item.suggestedReply, public: false } } },
            });
          }

          // Propagate Jira links
          if (item.match.jiraLinks && item.match.jiraLinks.length) {
            const { baseUrl, auth } = getAuth();
            await Promise.allSettled(
              item.match.jiraLinks.map(j =>
                fetch(`${baseUrl}/api/services/jira/links`, {
                  method: 'POST',
                  headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ticket_id: String(item.ticketId), issue_id: String(j.issueId), issue_key: j.issueKey }),
                }).catch(() => {})
              )
            );
          }

          handledSet[item.ticketId] = { at: new Date().toISOString(), auto: true };
          autoLinked++;

          results.push({
            ticketId: item.ticketId,
            problemId: item.match.problemId,
            score: item.match.score,
            action: 'auto-linked',
          });

          // Log to audit trail
          if (isKVConfigured()) {
            kvListPush('audit:log', JSON.stringify({
              action: 'cron-auto-link',
              agent: 'cron',
              ticketId: item.ticketId,
              problemId: item.match.problemId,
              score: item.match.score,
              at: new Date().toISOString(),
            }), 500).catch(() => {});

            kvListPush('activity:feed', JSON.stringify({
              action: 'auto-approve',
              agent: 'Cron Scanner',
              ticketId: item.ticketId,
              problemId: item.match.problemId,
              detail: `Score: ${item.match.score}%`,
              at: new Date().toISOString(),
            }), 500).catch(() => {});
          }
        } catch (err) {
          results.push({
            ticketId: item.ticketId,
            action: 'error',
            error: err.message,
          });
        }
      }
    }

    // 3. Save handled IDs to KV (prune entries older than 24h)
    if (isKVConfigured()) {
      const cutoff = Date.now() - 24 * 3600000;
      for (const [id, data] of Object.entries(handledSet)) {
        if (typeof data === 'object' && data.at && new Date(data.at).getTime() < cutoff) {
          delete handledSet[id];
        }
      }
      await kvSetJSON('cron:handled_ids', handledSet, 86400);

      // Store scan results for dashboard display
      await kvSetJSON('cron:last_scan', {
        at: new Date().toISOString(),
        queueSize: queue.length,
        autoLinked,
        skipped,
        threshold: autoApproveThreshold,
      }, 3600);
    }

    res.json({
      success: true,
      scannedAt: new Date().toISOString(),
      queueSize: queue.length,
      autoLinked,
      skipped,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
