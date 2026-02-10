// backfill-jira.js — GET = dry run, POST = execute
// Scans all incidents linked to Problem tickets and adds missing Jira links.
// Safe: only adds links, never modifies or deletes anything.
// Idempotent: skips tickets that already have Jira links.

const { zdRequest, getJiraLinks, getAuth } = require('./_zendesk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dryRun = req.method === 'GET';

  try {
    // Step 1: Get all active Problem tickets
    const problemData = await zdRequest('/search.json', {
      params: { query: 'type:ticket ticket_type:problem status<solved', sort_by: 'created_at', sort_order: 'desc', per_page: '100' },
    });
    const problems = problemData.results || [];

    const results = [];
    let totalLinked = 0;
    let totalSkipped = 0;
    let totalNoJira = 0;

    // Step 2: For each Problem, check Jira links and linked incidents
    for (const p of problems) {
      const jiraLinks = await getJiraLinks(p.id);
      if (jiraLinks.length === 0) {
        totalNoJira++;
        continue;
      }

      // Get incidents linked to this Problem
      let incidentData;
      try {
        incidentData = await zdRequest('/tickets/' + p.id + '/incidents.json', { params: { per_page: '100' } });
      } catch { continue; }

      const incidents = incidentData.tickets || [];
      if (incidents.length === 0) continue;

      const problemResult = {
        problemId: p.id,
        subject: p.subject,
        jira: jiraLinks.map(j => j.issueKey).join(', '),
        incidents: [],
      };

      // Step 3: Check each incident for existing Jira links
      for (const inc of incidents) {
        const existingLinks = await getJiraLinks(inc.id);
        if (existingLinks.length > 0) {
          totalSkipped++;
          continue;
        }

        // This incident needs Jira links
        if (dryRun) {
          problemResult.incidents.push({ id: inc.id, subject: inc.subject, action: 'WOULD LINK' });
          totalLinked++;
        } else {
          // Actually create the links
          const { baseUrl, auth } = getAuth();
          for (const j of jiraLinks) {
            try {
              await fetch(`${baseUrl}/api/services/jira/links`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket_id: String(inc.id), issue_id: String(j.issueId), issue_key: j.issueKey }),
              });
            } catch {}
          }
          problemResult.incidents.push({ id: inc.id, subject: inc.subject, action: 'LINKED' });
          totalLinked++;
        }
      }

      if (problemResult.incidents.length > 0) {
        results.push(problemResult);
      }
    }

    res.json({
      mode: dryRun ? 'DRY RUN (GET to preview, POST to execute)' : 'EXECUTED',
      problemsScanned: problems.length,
      problemsWithoutJira: totalNoJira,
      incidentsLinked: totalLinked,
      incidentsSkipped: totalSkipped,
      details: results,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
