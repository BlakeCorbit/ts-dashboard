// triage-queue.js — GET /api/triage-queue?hours=2
// Returns recent unsolved tickets enriched with PT match recommendations and suggested replies.

const { zdRequest, cachedZdRequest, getJiraLinks } = require('../_zendesk');
const { TicketClusterer } = require('../_clusterer');

// Reply templates (same as create-problem.js)
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

const STOPWORDS = new Set(['the','a','an','is','are','was','were','not','no','and','or','to','in','on','of','for','with','has','have','had','my','our','your','this','that','it','i','we','they','from','but','at','be','by','do','does','did','can','will','would','should','could','been','being','get','got','just','also','its','than','into','about','up','out','if','all','so','what','when','how','who','which']);

function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function scoreMatch(ticket, pt) {
  let score = 0;
  let hasAnchor = false;

  // Error pattern match (+40) — ANCHOR
  if (ticket.errorPattern !== 'other' && ticket.errorPattern === pt.errorPattern) {
    score += 40;
    hasAnchor = true;
  }

  // Same category (+15) — modifier only
  if (ticket.category === pt.category && ticket.category !== 'general') {
    score += 15;
  }

  // Same POS (+20) — modifier only
  if (ticket.pos && pt.pos && ticket.pos.toLowerCase() === pt.pos.toLowerCase()) {
    score += 20;
  }

  // Combined keyword overlap: subject + description (up to +25) — ANCHOR if >= 40%
  const ticketWords = new Set([
    ...tokenize(ticket.subject),
    ...tokenize(ticket.description),
  ]);
  const ptWords = new Set([
    ...tokenize(pt.subject),
    ...tokenize(pt.description || ''),
  ]);
  if (ptWords.size > 0) {
    const overlap = [...ticketWords].filter(w => ptWords.has(w));
    const overlapRatio = overlap.length / ptWords.size;
    score += Math.round(overlapRatio * 25);
    if (overlapRatio >= 0.4) hasAnchor = true;
  }

  // No anchor = no match (POS + category alone is not enough)
  if (!hasAnchor) return 0;

  return score;
}

function buildMatchReason(ticket, pt) {
  const reasons = [];
  if (ticket.errorPattern !== 'other' && ticket.errorPattern === pt.errorPattern) {
    reasons.push('Same error pattern: ' + ticket.errorPattern);
  }
  if (ticket.category === pt.category && ticket.category !== 'general') {
    reasons.push('Same category: ' + ticket.category);
  }
  if (ticket.pos && pt.pos && ticket.pos.toLowerCase() === pt.pos.toLowerCase()) {
    reasons.push('Same POS: ' + ticket.pos);
  }
  const ticketWords = new Set([...tokenize(ticket.subject), ...tokenize(ticket.description)]);
  const ptWords = new Set([...tokenize(pt.subject), ...tokenize(pt.description || '')]);
  if (ptWords.size > 0) {
    const overlap = [...ticketWords].filter(w => ptWords.has(w));
    const pct = Math.round((overlap.length / ptWords.size) * 100);
    if (pct >= 20) {
      reasons.push('Keyword overlap: ' + pct + '% (' + overlap.slice(0, 5).join(', ') + ')');
    }
  }
  return reasons.join('; ') || 'Keyword overlap';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=25');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const hours = parseInt(url.searchParams.get('hours') || '2', 10);
    const since = new Date(Date.now() - hours * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const clusterer = new TicketClusterer();

    // Fetch recent tickets + active PTs in parallel
    const [ticketsData, problemsData] = await Promise.all([
      zdRequest('/search.json', {
        params: {
          query: `type:ticket created>${since} status<solved -tags:triage_dismissed`,
          sort_by: 'created_at',
          sort_order: 'desc',
          per_page: '100',
        },
      }),
      zdRequest('/search.json', {
        params: {
          query: 'type:ticket ticket_type:problem status<solved',
          sort_by: 'created_at',
          sort_order: 'desc',
          per_page: '25',
        },
      }),
    ]);

    // Normalize tickets — exclude already-linked and problem-type
    const tickets = (ticketsData.results || [])
      .filter(t => !t.problem_id && t.type !== 'problem' && !clusterer.shouldIgnore(t))
      .filter(t => !(t.tags || []).includes('triage_dismissed'))
      .map(t => ({
        id: t.id,
        subject: t.subject || '',
        description: (t.description || '').substring(0, 300),
        status: t.status,
        priority: t.priority,
        tags: t.tags || [],
        createdAt: t.created_at,
        assigneeId: t.assignee_id,
        category: clusterer.categorize(t),
        pos: clusterer.extractPOS(t),
        errorPattern: clusterer.extractErrorPattern(t),
      }));

    // Normalize PTs + fetch Jira links
    const problems = await Promise.all(
      (problemsData.results || []).map(async (p) => {
        const jiraLinks = await getJiraLinks(p.id);
        return {
          problemId: p.id,
          subject: p.subject || '',
          description: (p.description || '').substring(0, 300),
          status: p.status,
          tags: p.tags || [],
          createdAt: p.created_at,
          jiraLinks,
          category: clusterer.categorize(p),
          pos: clusterer.extractPOS(p),
          errorPattern: clusterer.extractErrorPattern(p),
        };
      })
    );

    // Score each ticket against each PT
    const queue = tickets.map(ticket => {
      const matches = problems
        .map(pt => ({ pt, score: scoreMatch(ticket, pt) }))
        .filter(m => m.score >= 40)
        .sort((a, b) => b.score - a.score);

      const best = matches[0] || null;
      const confidence = best
        ? (best.score >= 70 ? 'high' : best.score >= 40 ? 'medium' : 'low')
        : 'none';

      // Generate suggested reply
      let suggestedReply = null;
      if (best && confidence !== 'low' && confidence !== 'none') {
        const pt = best.pt;
        const posName = ticket.pos || pt.pos || '';
        const posPrefix = posName ? posName.charAt(0).toUpperCase() + posName.slice(1) + ' ' : '';
        const template = REPLY_TEMPLATES[ticket.errorPattern] || REPLY_TEMPLATES[pt.errorPattern] || DEFAULT_TEMPLATE;
        suggestedReply = template
          .replace('{pos}', posPrefix)
          .replace('{problemId}', String(pt.problemId))
          .replace('{pattern}', ticket.errorPattern !== 'other' ? ticket.errorPattern : 'the reported issue');
      }

      return {
        ticketId: ticket.id,
        subject: ticket.subject,
        description: ticket.description,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt,
        assigneeId: ticket.assigneeId,
        category: ticket.category,
        pos: ticket.pos,
        errorPattern: ticket.errorPattern,
        match: best && confidence !== 'none' ? {
          problemId: best.pt.problemId,
          problemSubject: best.pt.subject,
          jiraLinks: best.pt.jiraLinks,
          score: best.score,
          confidence,
          matchReason: buildMatchReason(ticket, best.pt),
        } : null,
        suggestedReply,
      };
    });

    res.json({
      queue,
      count: queue.length,
      matchedCount: queue.filter(q => q.match).length,
      activeProblems: problems.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
