/**
 * Matches incoming tickets against an active incident's pattern.
 * Uses a scoring system with safeguards against false positives.
 */

// Words too generic to use as standalone keywords — these match way too many tickets
const STOP_WORDS = new Set([
  // Common English
  'auto', 'work', 'working', 'does', 'that', 'this', 'with', 'from',
  'have', 'been', 'they', 'their', 'about', 'into', 'causing', 'other',
  'when', 'what', 'where', 'which', 'every', 'time', 'some', 'also',
  'just', 'only', 'more', 'very', 'still', 'back', 'after', 'before',
  // Generic support words
  'issue', 'issues', 'problem', 'problems', 'help', 'need', 'please',
  'shop', 'customer', 'support', 'ticket', 'call', 'called', 'report',
  'reports', 'device', 'devices', 'resolved', 'update', 'release',
  'unable', 'error', 'able', 'getting', 'showing', 'trying', 'tried',
  'says', 'said', 'told', 'want', 'wants', 'like', 'goes', 'going',
  // Generic tech words
  'data', 'system', 'page', 'screen', 'button', 'click', 'open',
  'close', 'save', 'send', 'receive', 'check', 'find', 'view',
  'text', 'messages', 'notes', 'labor', 'lines', 'techs', 'user',
  'users', 'account', 'login', 'email', 'phone', 'number',
]);

class TicketMatcher {
  constructor({ keywords = [], posTag = '', problemTicketId = null }) {
    this.keywords = keywords.map(k => k.toLowerCase().trim()).filter(Boolean);
    // Filter out single stop words (but keep multi-word phrases containing them)
    this.strongKeywords = this.keywords.filter(k => k.includes(' ') || !STOP_WORDS.has(k));
    this.posTag = posTag.toLowerCase().trim();
    this.problemTicketId = problemTicketId ? parseInt(problemTicketId, 10) : null;
  }

  /**
   * Check if a ticket matches the active incident pattern.
   * Returns { matched, score, reasons }
   */
  matches(ticket) {
    // Don't match the Problem ticket itself
    if (ticket.id === this.problemTicketId) return { matched: false, score: 0, reasons: [] };

    // Already linked to this problem
    if (ticket.problemId === this.problemTicketId) return { matched: false, score: 0, reasons: [] };

    // Already linked to a different problem
    if (ticket.problemId) return { matched: false, score: 0, reasons: [] };

    let score = 0;
    const reasons = [];
    let hasKeywordMatch = false;

    // Check POS tag match (strong signal)
    const posMatched = this.posTag && ticket.tags.some(t => t.toLowerCase() === this.posTag);
    if (posMatched) {
      score += 3;
      reasons.push(`POS tag: ${this.posTag}`);
    }

    // Check keyword matches in subject + description (only strong keywords)
    const text = `${ticket.subject} ${ticket.description}`.toLowerCase();
    let keywordHits = 0;
    for (const kw of this.strongKeywords) {
      if (text.includes(kw)) {
        score += 2;
        keywordHits++;
        hasKeywordMatch = true;
        reasons.push(`keyword: "${kw}"`);
      }
    }

    // Emergency flag (minor boost, not enough alone)
    if (ticket.tags.includes('high_slack') || ticket.subject.toLowerCase().startsWith('(emergency)')) {
      score += 1;
      reasons.push('emergency flag');
    }

    // System/integration tags (minor boost)
    if (ticket.tags.includes('system_issue') || ticket.tags.includes('integrations')) {
      score += 1;
      reasons.push('system/integration tag');
    }

    // Matching logic:
    // - Need at least 1 strong keyword match OR a POS tag match
    // - Score threshold of 3 (up from 2) to reduce false positives
    // - Without any keyword or POS match, generic tags alone aren't enough
    const hasSubstantiveMatch = hasKeywordMatch || posMatched;
    const matched = hasSubstantiveMatch && score >= 3;

    return { matched, score, reasons };
  }
}

module.exports = { TicketMatcher };
