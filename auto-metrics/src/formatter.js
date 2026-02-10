/**
 * Formats metrics report for console and Slack output.
 */

class ReportFormatter {
  /**
   * Format report for console output.
   */
  static toConsole(report) {
    const lines = [];
    const { summary } = report;

    lines.push('');
    lines.push('╔══════════════════════════════════════════════════════╗');
    lines.push('║        TECH SUPPORT METRICS REPORT                  ║');
    lines.push(`║        Period: Last ${report.period.padEnd(34)}║`);
    lines.push('╚══════════════════════════════════════════════════════╝');
    lines.push('');

    // Summary
    lines.push('── SUMMARY ─────────────────────────────────────────');
    lines.push(`  Tickets Created:    ${summary.created}`);
    lines.push(`  Tickets Resolved:   ${summary.resolved}`);
    lines.push(`  Currently Open:     ${summary.open}`);
    lines.push(`  Avg/Day:            ${summary.avgPerDay}`);
    lines.push(`  Net Change:         ${summary.newVsResolved > 0 ? '+' : ''}${summary.newVsResolved}`);
    lines.push('');

    // By Category
    lines.push('── BY CATEGORY ─────────────────────────────────────');
    lines.push(this.formatTable(report.byCategory));

    // By POS
    lines.push('── BY POS SYSTEM ───────────────────────────────────');
    lines.push(this.formatTable(report.byPOS));

    // By Source
    lines.push('── BY SOURCE ───────────────────────────────────────');
    lines.push(this.formatTable(report.bySource));

    // By Priority
    lines.push('── BY PRIORITY ─────────────────────────────────────');
    lines.push(this.formatTable(report.byPriority));

    // By Assignee
    lines.push('── BY ASSIGNEE ─────────────────────────────────────');
    lines.push(this.formatTable(report.byAssignee));

    // By Group
    lines.push('── BY GROUP ────────────────────────────────────────');
    lines.push(this.formatTable(report.byGroup));

    // Daily volume
    lines.push('── DAILY VOLUME ────────────────────────────────────');
    for (const { date, count } of report.byDay) {
      const bar = '█'.repeat(Math.min(count, 40));
      lines.push(`  ${date}  ${bar} ${count}`);
    }
    lines.push('');

    // Top subjects
    lines.push('── TOP TICKET PATTERNS ─────────────────────────────');
    for (const { subject, count } of report.topSubjects) {
      lines.push(`  ${String(count).padStart(4)}x  ${subject}`);
    }
    lines.push('');

    // High priority tickets
    if (report.highPriority.length > 0) {
      lines.push('── HIGH/URGENT TICKETS ─────────────────────────────');
      for (const t of report.highPriority) {
        lines.push(`  ZD#${t.id} [${t.priority}] ${t.subject.substring(0, 55)}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  static formatTable(data) {
    const lines = [];
    for (const { name, count, pct } of data) {
      const bar = '▓'.repeat(Math.max(1, Math.round(pct / 3)));
      lines.push(`  ${String(count).padStart(4)}  ${String(pct).padStart(3)}%  ${bar}  ${name}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Format report for Slack.
   */
  static toSlack(report) {
    const { summary } = report;

    const categoryLines = report.byCategory.slice(0, 8)
      .map(c => `${c.name}: *${c.count}* (${c.pct}%)`).join('\n');

    const posLines = report.byPOS.slice(0, 8)
      .map(c => `${c.name}: *${c.count}* (${c.pct}%)`).join('\n');

    const assigneeLines = report.byAssignee.slice(0, 5)
      .map(c => `${c.name}: *${c.count}*`).join('\n');

    return {
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `TS Weekly Report — Last ${report.period}`, emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Created:* ${summary.created}\n*Resolved:* ${summary.resolved}` },
            { type: 'mrkdwn', text: `*Open:* ${summary.open}\n*Avg/Day:* ${summary.avgPerDay}` },
          ],
        },
        { type: 'divider' },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*By Category:*\n${categoryLines}` },
            { type: 'mrkdwn', text: `*By POS:*\n${posLines}` },
          ],
        },
        { type: 'divider' },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*By Assignee:*\n${assigneeLines}` },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT | Auto Metrics` },
          ],
        },
      ],
    };
  }
}

module.exports = { ReportFormatter };
