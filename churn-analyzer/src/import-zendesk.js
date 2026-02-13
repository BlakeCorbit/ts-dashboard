/**
 * Zendesk Data Importer
 *
 * Fetches organizations and tickets from Zendesk into the local SQLite database.
 * Supports incremental fetching (only new tickets since last import).
 *
 * Usage:
 *   node src/index.js import-zendesk
 *   node src/index.js import-zendesk --days 90
 */

const { getDb, close } = require('./db');
const { createClient } = require('./zendesk');

// ─── Tag Mappings (from dashboard/collect.js) ──────────────────

const TAG_TO_POS = {
  'protractor_partner_api': 'Protractor',
  'tekmetric_partner_api': 'Tekmetric',
  'tekmetric_pos': 'Tekmetric',
  'shopware_partner_api': 'Shop-Ware',
  'mitchell_binary': 'Mitchell',
  'napa_binary': 'NAPA TRACS',
  'napaenterprise': 'NAPA TRACS',
  'rowriter_binary': 'RO Writer',
  'winworks_binary': 'Winworks',
  'vast_binary': 'VAST',
  'maxxtraxx_binary': 'MaxxTraxx',
  'alldata_binary': 'ALLDATA',
  'autofluent_binary': 'AutoFluent',
  'yes_binary': 'YES',
  'stocktrac_binary': 'StockTrac',
};

const TAG_TO_CATEGORY = {
  'system_issue': 'System Issue',
  'integrations': 'Integration',
  'app_workorder': 'App/Work Order',
  'bayiq': 'BayIQ',
  'high_slack': 'High Priority',
};

const TAG_TO_SOURCE = {
  'source_tvp': 'TVP',
  'source_email': 'Email',
  'source_phone': 'Phone',
  'source_chat': 'Chat',
  'web': 'Web',
};

const IGNORE_TAGS = ['twilio_rejected', 'twilio_category', 'voicemail'];

function extractFromTags(tags, map) {
  for (const tag of tags) {
    if (map[tag]) return map[tag];
  }
  return null;
}

function shouldIgnore(tags) {
  return tags.some(tag => IGNORE_TAGS.includes(tag));
}

// ─── Organization Import ───────────────────────────────────────

async function importOrganizations(zd, db) {
  console.log('  Fetching organizations...');
  const orgs = await zd.getAllOrganizations();
  console.log(`  Found ${orgs.length} organizations`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO zd_organizations (id, name, created_at, tags, domain_names, details, notes)
    VALUES (@id, @name, @created_at, @tags, @domain_names, @details, @notes)
  `);

  const insertMany = db.transaction((orgs) => {
    let count = 0;
    for (const org of orgs) {
      insert.run({
        id: org.id,
        name: org.name || '',
        created_at: org.created_at || null,
        tags: JSON.stringify(org.tags || []),
        domain_names: JSON.stringify(org.domain_names || []),
        details: org.details || null,
        notes: org.notes || null,
      });
      count++;
    }
    return count;
  });

  const count = insertMany(orgs);
  console.log(`  Imported ${count} organizations`);
  return count;
}

// ─── Ticket Import ─────────────────────────────────────────────

async function importTickets(zd, db, lookbackDays) {
  // Check last fetch time for incremental import
  const lastFetch = db.prepare('SELECT MAX(fetched_at) as t FROM zd_tickets').get().t;
  let sinceDate;

  if (lastFetch && !lookbackDays) {
    // Incremental: fetch since last import minus 1 day buffer
    sinceDate = new Date(new Date(lastFetch).getTime() - 24 * 60 * 60 * 1000);
    console.log(`  Incremental fetch since ${sinceDate.toISOString().split('T')[0]}`);
  } else {
    const days = lookbackDays || parseInt(process.env.CHURN_LOOKBACK_DAYS || '180');
    sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    console.log(`  Full fetch: last ${days} days (since ${sinceDate.toISOString().split('T')[0]})`);
  }

  console.log('  Fetching tickets...');
  const tickets = await zd.getTicketsSince(sinceDate, 10000);
  console.log(`  Found ${tickets.length} tickets`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO zd_tickets (
      id, org_id, subject, status, priority, ticket_type,
      tags, category, pos_system, source, assignee_id, group_id,
      satisfaction_rating, created_at, updated_at, solved_at,
      resolution_hours, is_escalation, reopen_count
    ) VALUES (
      @id, @org_id, @subject, @status, @priority, @ticket_type,
      @tags, @category, @pos_system, @source, @assignee_id, @group_id,
      @satisfaction_rating, @created_at, @updated_at, @solved_at,
      @resolution_hours, @is_escalation, @reopen_count
    )
  `);

  const insertMany = db.transaction((tickets) => {
    let imported = 0;
    let skipped = 0;

    for (const t of tickets) {
      const tags = t.tags || [];

      // Skip noise tickets
      if (shouldIgnore(tags)) {
        skipped++;
        continue;
      }

      // Calculate resolution hours
      let resolutionHours = null;
      if (t.created_at && (t.status === 'solved' || t.status === 'closed')) {
        const solvedAt = t.solved_at || t.updated_at;
        if (solvedAt) {
          resolutionHours = (new Date(solvedAt).getTime() - new Date(t.created_at).getTime()) / (1000 * 60 * 60);
          if (resolutionHours < 0) resolutionHours = null;
        }
      }

      // Detect escalation
      const isEscalation = (t.priority === 'urgent' || t.priority === 'high' || t.type === 'problem') ? 1 : 0;

      insert.run({
        id: t.id,
        org_id: t.organization_id || null,
        subject: t.subject || '',
        status: t.status || '',
        priority: t.priority || 'normal',
        ticket_type: t.type || null,
        tags: JSON.stringify(tags),
        category: extractFromTags(tags, TAG_TO_CATEGORY) || 'Other',
        pos_system: extractFromTags(tags, TAG_TO_POS),
        source: extractFromTags(tags, TAG_TO_SOURCE) || 'Unknown',
        assignee_id: t.assignee_id || null,
        group_id: t.group_id || null,
        satisfaction_rating: t.satisfaction_rating?.score || null,
        created_at: t.created_at || null,
        updated_at: t.updated_at || null,
        solved_at: t.solved_at || null,
        resolution_hours: resolutionHours,
        is_escalation: isEscalation,
        reopen_count: t.reopen_count || 0,
      });
      imported++;
    }

    return { imported, skipped };
  });

  const result = insertMany(tickets);
  console.log(`  Imported ${result.imported} tickets (skipped ${result.skipped} noise)`);
  return result;
}

// ─── Main ──────────────────────────────────────────────────────

async function run(args) {
  const daysFlag = args.indexOf('--days');
  const lookbackDays = daysFlag >= 0 ? parseInt(args[daysFlag + 1]) : null;

  console.log('=== Zendesk Data Import ===');
  const startTime = Date.now();

  const zd = createClient();
  const db = getDb();

  try {
    const orgCount = await importOrganizations(zd, db);
    const ticketResult = await importTickets(zd, db, lookbackDays);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log('  Import Complete:');
    console.log(`    Organizations: ${orgCount}`);
    console.log(`    Tickets: ${ticketResult.imported}`);
    console.log(`    Time: ${elapsed}s`);
  } finally {
    close();
  }
}

module.exports = { run };
