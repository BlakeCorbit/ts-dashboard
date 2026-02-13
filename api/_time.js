// Shared time utilities used by metrics.js and agents.js

function getPeriodStart(period) {
  const now = new Date();
  switch (period) {
    case 'week': {
      const dow = now.getDay();
      const off = dow === 0 ? -6 : 1 - dow;
      const mon = new Date(now);
      mon.setDate(now.getDate() + off);
      mon.setHours(0, 0, 0, 0);
      return mon;
    }
    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3) * 3;
      return new Date(now.getFullYear(), q, 1, 0, 0, 0, 0);
    }
    case 'year':
      return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    case 'month':
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
}

module.exports = { getPeriodStart };
