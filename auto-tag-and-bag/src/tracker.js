/**
 * Tracks multiple active incidents by auto-detecting Problem tickets.
 * For each active Problem ticket, finds matching child tickets and links them.
 * Also fetches linked Jira tickets for each Problem.
 */

const { TicketMatcher } = require('./matcher');

// Keywords commonly found in incident-related tickets, grouped by pattern
const INCIDENT_PATTERNS = {
  ro_missing: {
    keywords: ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating',
               'ros not showing', 'not showing up', 'not transferring', 'not populating',
               'data transfer delay', 'no tiles', 'tiles not', 'repair order'],
    description: 'ROs Not Showing',
  },
  platform_down: {
    keywords: ['tvp down', 'page not loading', 'blank page', 'can\'t access', 'error 500',
               'error 503', 'error 504', 'site down', 'not loading', 'completely down'],
    description: 'Platform Down',
  },
  app_issues: {
    keywords: ['app crash', 'app freeze', 'app not working', 'crashing', 'freezing',
               'white screen', 'glitch', 'lagging'],
    description: 'App Issues',
  },
  email_sms: {
    keywords: ['email not sending', 'text not sending', 'reminders not', 'mailgun',
               'twilio down', 'sms not', 'messages not sending'],
    description: 'Email/SMS Down',
  },
  integration: {
    keywords: ['integration', 'binary', 'partner api', 'overnight compare'],
    description: 'Integration Issue',
  },
  media_upload: {
    keywords: ['media not uploading', 'photo not uploading', 'image not uploading',
               'upload fail', 'can\'t upload', 'media upload', 'photo upload'],
    description: 'Media Upload Issue',
  },
  camera_photo: {
    keywords: ['camera', 'photo', 'multiple photos', 'auto rotate', 'image editor'],
    description: 'Camera/Photo Issue',
  },
  notifications: {
    keywords: ['not alerting', 'notifications', 'excessive notif', 'push notification'],
    description: 'Notification Issue',
  },
};

// POS tags we recognize
const POS_TAGS = [
  'napaenterprise', 'napa_binary', 'protractor_partner_api', 'tekmetric_partner_api',
  'tekmetric_pos', 'shopware_partner_api', 'mitchell_binary', 'rowriter_binary',
  'winworks_binary', 'vast_binary', 'maxxtraxx_binary', 'alldata_binary',
  'autofluent_binary', 'yes_binary',
];

class IncidentTracker {
  constructor(zendesk) {
    this.zendesk = zendesk;
    // Map of Problem ticket ID -> incident state
    this.activeIncidents = new Map();
    // All tickets we've already processed (across all incidents)
    this.processedTickets = new Set();
    // Known Problem ticket IDs (to detect new ones)
    this.knownProblemIds = new Set();
  }

  /**
   * Scan Zendesk for active (open/pending) Problem tickets.
   * Auto-discovers new incidents and fetches their Jira links.
   */
  async scanForProblemTickets() {
    const data = await this.zendesk.request('/search.json', {
      params: {
        query: 'type:ticket ticket_type:problem status<solved',
        sort_by: 'created_at',
        sort_order: 'desc',
        per_page: '25',
      },
    });

    const problems = data.results || [];

    for (const problem of problems) {
      if (this.knownProblemIds.has(problem.id)) continue;

      // New Problem ticket detected
      this.knownProblemIds.add(problem.id);

      const incident = this.analyzeIncident(problem);

      // Fetch linked Jira tickets
      const jiraLinks = await this.zendesk.getJiraLinks(problem.id);
      incident.jiraLinks = jiraLinks;

      this.activeIncidents.set(problem.id, incident);

      console.log('');
      console.log(`  ╔═ NEW INCIDENT DETECTED ═══════════════════════════`);
      console.log(`  ║  Problem:    ZD#${problem.id}`);
      console.log(`  ║  Subject:    ${problem.subject.substring(0, 50)}`);
      console.log(`  ║  Pattern:    ${incident.patternDescription}`);
      console.log(`  ║  POS:        ${incident.posTag || '(any)'}`);
      console.log(`  ║  Keywords:   ${incident.keywords.slice(0, 5).join(', ')}`);
      if (jiraLinks.length > 0) {
        for (const jira of jiraLinks) {
          console.log(`  ║  Jira:       ${jira.issueKey} → ${jira.url}`);
        }
      } else {
        console.log(`  ║  Jira:       (none linked)`);
      }
      console.log(`  ║  Created:    ${problem.created_at}`);
      console.log(`  ╚══════════════════════════════════════════════════`);
      console.log('');
    }

    // Check for resolved incidents
    for (const [problemId, incident] of this.activeIncidents.entries()) {
      const found = problems.find(p => p.id === problemId);
      if (!found) {
        console.log(`\n  [RESOLVED] Incident ZD#${problemId} no longer active (solved/closed)`);
        this.activeIncidents.delete(problemId);
      }
    }
  }

  /**
   * Analyze a Problem ticket to extract matching patterns.
   */
  analyzeIncident(problemTicket) {
    const text = `${problemTicket.subject} ${problemTicket.description || ''}`.toLowerCase();
    const tags = problemTicket.tags || [];

    // Detect POS type from tags
    let posTag = '';
    for (const tag of tags) {
      if (POS_TAGS.includes(tag.toLowerCase())) {
        posTag = tag.toLowerCase();
        break;
      }
    }

    // Also try to detect POS from text
    if (!posTag) {
      const posNames = {
        'napa tracs': 'napaenterprise',
        'napa': 'napaenterprise',
        'protractor': 'protractor_partner_api',
        'tekmetric': 'tekmetric_partner_api',
        'shop-ware': 'shopware_partner_api',
        'mitchell': 'mitchell_binary',
        'ro writer': 'rowriter_binary',
        'winworks': 'winworks_binary',
      };
      for (const [name, tag] of Object.entries(posNames)) {
        if (text.includes(name)) {
          posTag = tag;
          break;
        }
      }
    }

    // Detect incident pattern
    let matchedPattern = null;
    let keywords = [];

    for (const [key, pattern] of Object.entries(INCIDENT_PATTERNS)) {
      for (const kw of pattern.keywords) {
        if (text.includes(kw)) {
          matchedPattern = pattern;
          keywords = pattern.keywords;
          break;
        }
      }
      if (matchedPattern) break;
    }

    // If no pattern matched, build multi-word phrases from the subject.
    // 2-word phrases are much more distinctive than single words.
    if (!matchedPattern) {
      // Strip the common "PT - " prefix from subject
      const cleanSubject = problemTicket.subject.replace(/^PT\s*-\s*/i, '');
      const words = cleanSubject.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2);

      // Build 2-word phrases (bigrams) — these are specific enough to match on
      const bigrams = [];
      for (let i = 0; i < words.length - 1; i++) {
        bigrams.push(`${words[i]} ${words[i + 1]}`);
      }

      // Also keep distinctive single words (5+ chars, not common)
      const COMMON = new Set([
        'auto', 'work', 'working', 'issue', 'issues', 'problem', 'device',
        'devices', 'unable', 'error', 'showing', 'notes', 'labor', 'lines',
        'techs', 'about', 'their', 'other', 'causing', 'receiving', 'requires',
        'resolved', 'does', 'android',
      ]);
      const distinctive = words.filter(w => w.length >= 5 && !COMMON.has(w));

      keywords = [...bigrams.slice(0, 4), ...distinctive.slice(0, 3)];
      matchedPattern = { description: 'Custom Pattern', keywords };
    }

    return {
      problemId: problemTicket.id,
      subject: problemTicket.subject,
      posTag,
      keywords,
      patternDescription: matchedPattern.description + (posTag ? ` (${posTag})` : ''),
      linkedCount: 0,
      jiraLinks: [],
      matcher: new TicketMatcher({
        keywords,
        posTag,
        problemTicketId: problemTicket.id,
      }),
    };
  }

  /**
   * Process all active incidents — find and link matching tickets.
   * Each ticket is only linked to the BEST matching incident (highest score).
   */
  async processAllIncidents() {
    if (this.activeIncidents.size === 0) {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: true });
      process.stdout.write(`\r[${timestamp}] No active incidents. Watching for Problem tickets...`);
      return;
    }

    // Fetch recent tickets once
    const tickets = await this.zendesk.getRecentTickets(120);

    // For each ticket, find the BEST matching incident (not all of them)
    for (const ticket of tickets) {
      let bestMatch = null;
      let bestScore = 0;
      let bestProblemId = null;
      let bestReasons = [];

      for (const [problemId, incident] of this.activeIncidents.entries()) {
        const processKey = `${problemId}:${ticket.id}`;
        if (this.processedTickets.has(processKey)) continue;

        const result = incident.matcher.matches(ticket);
        if (result.matched && result.score > bestScore) {
          bestMatch = incident;
          bestScore = result.score;
          bestProblemId = problemId;
          bestReasons = result.reasons;
        }
      }

      // Mark this ticket as processed for ALL incidents (so we don't re-check it)
      for (const [problemId] of this.activeIncidents.entries()) {
        this.processedTickets.add(`${problemId}:${ticket.id}`);
      }

      if (!bestMatch) continue;

      bestMatch.linkedCount++;

      const jiraStr = bestMatch.jiraLinks.length > 0
        ? bestMatch.jiraLinks.map(j => j.issueKey).join(', ')
        : '';

      console.log('');
      console.log(`  ┌─ MATCH → Incident ZD#${bestProblemId}${jiraStr ? ` (${jiraStr})` : ''}`);
      console.log(`  │  Ticket:  ZD#${ticket.id} (score: ${bestScore})`);
      console.log(`  │  Subject: ${ticket.subject.substring(0, 60)}`);
      console.log(`  │  Reasons: ${bestReasons.join(', ')}`);

      await this.zendesk.linkToProblem(ticket.id, bestProblemId);

      // Add internal note with Jira context so the agent knows immediately
      if (bestMatch.jiraLinks.length > 0) {
        const jiraInfo = bestMatch.jiraLinks
          .map(j => `${j.issueKey}: ${j.url}`)
          .join('\n');
        const note = [
          `🔗 Auto-linked to Problem ZD#${bestProblemId}: ${bestMatch.subject}`,
          ``,
          `Jira: ${jiraInfo}`,
          `Pattern: ${bestMatch.patternDescription}`,
          `Match score: ${bestScore} (${bestReasons.join(', ')})`,
          ``,
          `— Auto Tag-and-Bag`,
        ].join('\n');
        await this.zendesk.addInternalNote(ticket.id, note);
      }

      console.log(`  └─ Incident total: ${bestMatch.linkedCount} linked`);
    }

    // Status line
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: true });
    const incidentSummary = Array.from(this.activeIncidents.values())
      .map(i => {
        const jira = i.jiraLinks.length > 0 ? `/${i.jiraLinks[0].issueKey}` : '';
        return `ZD#${i.problemId}${jira}(${i.linkedCount})`;
      })
      .join(', ');
    process.stdout.write(`\r[${timestamp}] Active: ${incidentSummary} | Scanned: ${tickets.length} tickets`);
  }
}

module.exports = { IncidentTracker };
