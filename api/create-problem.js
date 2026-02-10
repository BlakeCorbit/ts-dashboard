// create-problem.js — POST /api/create-problem
// Creates a Problem ticket in Zendesk, links all provided tickets as incidents,
// propagates Jira context, returns reply template.

const { zdRequest, getJiraLinks } = require('./_zendesk');

// Reply templates by error pattern
const REPLY_TEMPLATES = {
  'ROs not showing': 'We are aware of an issue affecting {pos}repair order syncing and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you as we have more information. Thank you for your patience.',
  'Data not syncing': 'We are aware of an issue affecting {pos}data syncing and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you as we have more information.',
  'TVP issues': 'We are aware of a platform issue and are actively working on resolution. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you shortly.',
  'Email delivery': 'We are aware of an email delivery issue and are working with our provider to resolve it. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'SMS delivery': 'We are aware of a text messaging issue and are working with our provider to resolve it. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Login/access': 'We are aware of login/access issues and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Inspection issues': 'We are aware of an issue with inspections/photos and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Media upload': 'We are aware of a media upload issue and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Camera/photo issues': 'We are aware of a camera/photo issue on the mobile app and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Audio/video issues': 'We are aware of an audio/video issue and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'App freezing/crashing': 'We are aware of app stability issues and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Notification issues': 'We are aware of a notification delivery issue and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Performance/errors': 'We are aware of performance issues and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
};

const DEFAULT_TEMPLATE = 'We are aware of an issue ({pattern}) and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you as we have more information.';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { subject, description, tags, ticketIds, errorPattern, pos } = req.body;

    if (!subject) return res.status(400).json({ error: 'subject is required' });

    // 1. Create Problem ticket
    const createData = await zdRequest('/tickets.json', {
      method: 'POST',
      body: {
        ticket: {
          subject: subject,
          comment: { body: description || subject, public: false },
          type: 'problem',
          priority: 'high',
          tags: tags || [],
        },
      },
    });

    const problemId = createData.ticket.id;

    // 2. Link all provided tickets as incidents
    let linkedCount = 0;
    const ids = ticketIds || [];

    // Fetch Jira links for the new Problem (may not have any yet)
    const jiraLinks = await getJiraLinks(problemId);
    const jiraInfo = jiraLinks.length > 0
      ? jiraLinks.map(j => j.issueKey + ': ' + j.url).join('\n')
      : '(pending Jira link)';

    // Link tickets in batches of 5 to avoid rate limits
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      await Promise.all(batch.map(async (ticketId) => {
        try {
          // Set as incident of the new Problem
          await zdRequest('/tickets/' + ticketId + '.json', {
            method: 'PUT',
            body: {
              ticket: {
                type: 'incident',
                problem_id: problemId,
                comment: {
                  body: [
                    'Linked to Problem ZD#' + problemId + ': ' + subject,
                    '',
                    'Jira: ' + jiraInfo,
                    '',
                    '-- TS Dashboard (Auto-Created Problem)',
                  ].join('\n'),
                  public: false,
                },
              },
            },
          });
          linkedCount++;
        } catch (e) {
          console.error('Failed to link ticket ' + ticketId + ':', e.message);
        }
      }));
    }

    // 3. Generate reply template
    const posPrefix = pos ? pos.charAt(0).toUpperCase() + pos.slice(1) + ' ' : '';
    let template = REPLY_TEMPLATES[errorPattern] || DEFAULT_TEMPLATE;
    template = template.replace('{pos}', posPrefix).replace('{problemId}', problemId).replace('{pattern}', errorPattern || 'the reported issue');

    res.json({
      success: true,
      problemId,
      linkedCount,
      jiraLinks,
      replyTemplate: template,
      zdUrl: 'https://bayiq.zendesk.com/agent/tickets/' + problemId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
