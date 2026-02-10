// propagate-jira.js — POST /api/propagate-jira
// Links Jira issues from a Problem ticket onto an incident ticket
// via the Zendesk-Jira integration (creates actual sidebar links,
// not just comments).

const { zdRequest, getJiraLinks, getAuth } = require('../_zendesk');

async function createJiraLink(ticketId, issueId, issueKey) {
  const { baseUrl, auth } = getAuth();
  const url = `${baseUrl}/api/services/jira/links`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticket_id: String(ticketId), issue_id: String(issueId), issue_key: issueKey }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jira link ${resp.status}: ${body.substring(0, 200)}`);
  }
  return resp.status === 204 ? null : resp.json();
}

// Backfill mode: GET /api/propagate-jira?backfill=1 (dry run) or ?backfill=run (execute)
async function handleBackfill(req, res) {
  const execute = req.query.backfill === 'run';
  const problemData = await zdRequest('/search.json', {
    params: { query: 'type:ticket ticket_type:problem status<solved', sort_by: 'created_at', sort_order: 'desc', per_page: '100' },
  });
  const problems = problemData.results || [];
  const details = [];
  let totalLinked = 0, totalSkipped = 0, totalNoJira = 0;

  for (const p of problems) {
    const jiraLinks = await getJiraLinks(p.id);
    if (jiraLinks.length === 0) { totalNoJira++; continue; }
    let incidentData;
    try { incidentData = await zdRequest('/tickets/' + p.id + '/incidents.json', { params: { per_page: '100' } }); } catch { continue; }
    const incidents = incidentData.tickets || [];
    if (incidents.length === 0) continue;
    const pr = { problemId: p.id, subject: p.subject, jira: jiraLinks.map(j => j.issueKey).join(', '), incidents: [] };
    for (const inc of incidents) {
      const existing = await getJiraLinks(inc.id);
      if (existing.length > 0) { totalSkipped++; continue; }
      if (execute) {
        for (const j of jiraLinks) {
          try { await createJiraLink(inc.id, j.issueId, j.issueKey); } catch {}
        }
        pr.incidents.push({ id: inc.id, subject: inc.subject, action: 'LINKED' });
      } else {
        pr.incidents.push({ id: inc.id, subject: inc.subject, action: 'WOULD LINK' });
      }
      totalLinked++;
    }
    if (pr.incidents.length > 0) details.push(pr);
  }
  return res.json({ mode: execute ? 'EXECUTED' : 'DRY RUN (?backfill=run to execute)', problemsScanned: problems.length, problemsWithoutJira: totalNoJira, incidentsLinked: totalLinked, incidentsSkipped: totalSkipped, details });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Backfill mode
  if (req.query.backfill) return handleBackfill(req, res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only (or use ?backfill=1 for backfill)' });

  try {
    let { ticketId, problemId } = req.body;
    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId required' });
    }

    // If problemId not provided, look it up from the ticket
    if (!problemId) {
      const ticketData = await zdRequest('/tickets/' + ticketId + '.json');
      const ticket = ticketData.ticket;
      if (!ticket || !ticket.problem_id) {
        return res.json({ success: true, ticketId, message: 'Ticket has no linked Problem' });
      }
      problemId = ticket.problem_id;
    }

    // Check if this ticket already has Jira links (skip if so)
    const existingLinks = await getJiraLinks(ticketId);
    if (existingLinks.length > 0) {
      return res.json({ success: true, ticketId, problemId, message: 'Already has Jira links', existingLinks });
    }

    // Fetch Jira links from the Problem ticket
    const jiraLinks = await getJiraLinks(problemId);

    if (jiraLinks.length === 0) {
      return res.json({ success: true, ticketId, problemId, jiraLinks: [], message: 'No Jira links on Problem ticket' });
    }

    // Create actual Jira links on the incident ticket via the integration API
    const results = await Promise.all(
      jiraLinks.map(j => createJiraLink(ticketId, j.issueId, j.issueKey).catch(err => ({ error: err.message, issueKey: j.issueKey })))
    );

    const linked = results.filter(r => !r || !r.error);
    const failed = results.filter(r => r && r.error);

    res.json({
      success: true,
      ticketId,
      problemId,
      jiraLinks,
      linkedCount: linked.length,
      failedCount: failed.length,
      failures: failed.length > 0 ? failed : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
