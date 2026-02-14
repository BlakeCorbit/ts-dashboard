/**
 * SQLite Database Layer
 *
 * Manages the churn-analyzer database schema and provides query helpers.
 * Uses better-sqlite3 for synchronous, fast SQLite access.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'churn.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- Salesforce accounts imported from CSV
    CREATE TABLE IF NOT EXISTS sf_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sf_account_id TEXT UNIQUE,
      account_name TEXT NOT NULL,
      status TEXT,
      owner TEXT,
      industry TEXT,
      mrr REAL,
      arr REAL,
      contract_start TEXT,
      contract_end TEXT,
      churn_date TEXT,
      churn_reason TEXT,
      pos_system TEXT,
      shop_count INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      raw_data TEXT
    );

    -- Churn events (temporal tracking separate from account status)
    CREATE TABLE IF NOT EXISTS sf_churn_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sf_account_id TEXT,
      event_type TEXT NOT NULL,
      event_date TEXT NOT NULL,
      reason TEXT,
      notes TEXT,
      revenue_impact REAL,
      imported_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (sf_account_id) REFERENCES sf_accounts(sf_account_id)
    );

    -- Zendesk organizations
    CREATE TABLE IF NOT EXISTS zd_organizations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT,
      tags TEXT,
      domain_names TEXT,
      details TEXT,
      notes TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    -- Zendesk tickets (denormalized for analysis)
    CREATE TABLE IF NOT EXISTS zd_tickets (
      id INTEGER PRIMARY KEY,
      org_id INTEGER,
      subject TEXT,
      status TEXT,
      priority TEXT,
      ticket_type TEXT,
      tags TEXT,
      category TEXT,
      pos_system TEXT,
      source TEXT,
      assignee_id INTEGER,
      group_id INTEGER,
      satisfaction_rating TEXT,
      created_at TEXT,
      updated_at TEXT,
      solved_at TEXT,
      resolution_hours REAL,
      is_escalation INTEGER DEFAULT 0,
      reopen_count INTEGER DEFAULT 0,
      fetched_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (org_id) REFERENCES zd_organizations(id)
    );

    -- SF account <-> ZD organization mapping
    CREATE TABLE IF NOT EXISTS account_org_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sf_account_id TEXT NOT NULL,
      zd_org_id INTEGER NOT NULL,
      match_method TEXT NOT NULL,
      match_score REAL,
      confirmed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (sf_account_id) REFERENCES sf_accounts(sf_account_id),
      FOREIGN KEY (zd_org_id) REFERENCES zd_organizations(id),
      UNIQUE(sf_account_id, zd_org_id)
    );

    -- Computed risk scores
    CREATE TABLE IF NOT EXISTS risk_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sf_account_id TEXT NOT NULL,
      zd_org_id INTEGER,
      computed_at TEXT DEFAULT (datetime('now')),
      overall_score REAL NOT NULL,
      risk_level TEXT NOT NULL,
      volume_score REAL,
      escalation_score REAL,
      sentiment_score REAL,
      velocity_score REAL,
      resolution_score REAL,
      breadth_score REAL,
      recency_score REAL,
      ticket_count_30d INTEGER,
      ticket_count_60d INTEGER,
      ticket_count_90d INTEGER,
      escalation_count_30d INTEGER,
      avg_resolution_hours REAL,
      bad_satisfaction_count INTEGER,
      unique_categories INTEGER,
      days_since_last_ticket INTEGER,
      reopened_ticket_count INTEGER,
      top_categories TEXT,
      trend_direction TEXT,
      risk_factors TEXT,
      FOREIGN KEY (sf_account_id) REFERENCES sf_accounts(sf_account_id)
    );

    -- Churn signatures (learned patterns from historical churn data)
    CREATE TABLE IF NOT EXISTS churn_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT DEFAULT (datetime('now')),
      window_days INTEGER NOT NULL,
      churned_sample_size INTEGER NOT NULL,
      active_sample_size INTEGER NOT NULL,
      signature_json TEXT NOT NULL,
      model_quality TEXT
    );

    -- Churn predictions (per-account scores from signature-based analysis)
    CREATE TABLE IF NOT EXISTS churn_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sf_account_id TEXT NOT NULL,
      zd_org_id INTEGER,
      signature_id INTEGER,
      computed_at TEXT DEFAULT (datetime('now')),
      churn_score REAL NOT NULL,
      churn_risk_level TEXT NOT NULL,
      feature_vector TEXT NOT NULL,
      matched_signals TEXT NOT NULL,
      signal_count INTEGER NOT NULL,
      confidence TEXT,
      FOREIGN KEY (sf_account_id) REFERENCES sf_accounts(sf_account_id),
      FOREIGN KEY (signature_id) REFERENCES churn_signatures(id)
    );

    -- Pre-churn snapshots (cached feature vectors for churned accounts)
    CREATE TABLE IF NOT EXISTS pre_churn_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sf_account_id TEXT NOT NULL,
      zd_org_id INTEGER NOT NULL,
      churn_date TEXT NOT NULL,
      window_days INTEGER NOT NULL,
      feature_vector TEXT NOT NULL,
      ticket_count INTEGER NOT NULL,
      computed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(sf_account_id, window_days)
    );

    -- Jira links for problem tickets
    CREATE TABLE IF NOT EXISTS zd_jira_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      issue_key TEXT NOT NULL,
      issue_url TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      UNIQUE(ticket_id, issue_key)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_tickets_org ON zd_tickets(org_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_created ON zd_tickets(created_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_org_created ON zd_tickets(org_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jira_links_ticket ON zd_jira_links(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_jira_links_issue ON zd_jira_links(issue_key);
    CREATE INDEX IF NOT EXISTS idx_tickets_type ON zd_tickets(ticket_type);
    CREATE INDEX IF NOT EXISTS idx_risk_level ON risk_scores(risk_level);
    CREATE INDEX IF NOT EXISTS idx_risk_score ON risk_scores(overall_score DESC);
    CREATE INDEX IF NOT EXISTS idx_sf_status ON sf_accounts(status);
    CREATE INDEX IF NOT EXISTS idx_map_sf ON account_org_map(sf_account_id);
    CREATE INDEX IF NOT EXISTS idx_map_zd ON account_org_map(zd_org_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_score ON churn_predictions(churn_score DESC);
    CREATE INDEX IF NOT EXISTS idx_predictions_level ON churn_predictions(churn_risk_level);
    CREATE INDEX IF NOT EXISTS idx_predictions_sf ON churn_predictions(sf_account_id);
  `);

  // Migration: add problem_id column to existing zd_tickets table
  try {
    db.exec('ALTER TABLE zd_tickets ADD COLUMN problem_id INTEGER DEFAULT NULL');
  } catch (e) {
    // Column already exists, ignore
  }

  // Index on problem_id (after migration ensures column exists)
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_problem ON zd_tickets(problem_id)');
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Get database stats for the status command.
 */
function getStats() {
  const db = getDb();
  return {
    sfAccounts: db.prepare('SELECT COUNT(*) as n FROM sf_accounts').get().n,
    sfChurned: db.prepare("SELECT COUNT(*) as n FROM sf_accounts WHERE churn_date IS NOT NULL").get().n,
    zdOrgs: db.prepare('SELECT COUNT(*) as n FROM zd_organizations').get().n,
    zdTickets: db.prepare('SELECT COUNT(*) as n FROM zd_tickets').get().n,
    matched: db.prepare('SELECT COUNT(*) as n FROM account_org_map').get().n,
    confirmed: db.prepare('SELECT COUNT(*) as n FROM account_org_map WHERE confirmed = 1').get().n,
    riskScores: db.prepare('SELECT COUNT(*) as n FROM risk_scores').get().n,
    churnSignatures: db.prepare('SELECT COUNT(*) as n FROM churn_signatures').get().n,
    churnPredictions: db.prepare('SELECT COUNT(*) as n FROM churn_predictions').get().n,
    problemTickets: db.prepare("SELECT COUNT(*) as n FROM zd_tickets WHERE ticket_type = 'problem'").get().n,
    incidentsLinked: db.prepare("SELECT COUNT(*) as n FROM zd_tickets WHERE problem_id IS NOT NULL").get().n,
    jiraLinks: db.prepare('SELECT COUNT(*) as n FROM zd_jira_links').get().n,
    lastSignature: db.prepare('SELECT MAX(computed_at) as t FROM churn_signatures').get().t,
    lastTicketFetch: db.prepare('SELECT MAX(fetched_at) as t FROM zd_tickets').get().t,
  };
}

module.exports = { getDb, close, getStats, DB_PATH };
