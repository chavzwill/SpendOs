CREATE TABLE IF NOT EXISTS spend_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_id TEXT,
  location_id TEXT,
  department_id TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, source, source_record_id, event_type, source_version)
);

CREATE TABLE IF NOT EXISTS source_versions (
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  latest_version INTEGER NOT NULL,
  latest_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, source, source_record_id, event_type)
);

CREATE TABLE IF NOT EXISTS spend_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES spend_events(id),
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL,
  supplier_id TEXT,
  location_id TEXT,
  department_id TEXT,
  sku TEXT,
  description TEXT,
  quantity REAL NOT NULL DEFAULT 0,
  unit_amount REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spend_facts_tenant_time ON spend_facts(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_spend_facts_supplier ON spend_facts(tenant_id, supplier_id, sku, occurred_at);
CREATE INDEX IF NOT EXISTS idx_spend_facts_location ON spend_facts(tenant_id, location_id, occurred_at);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, scope_type, scope_id, currency, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS savings_opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'identified',
  currency TEXT,
  estimated_savings REAL NOT NULL DEFAULT 0,
  verified_savings REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL,
  details_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, opportunity_key)
);

CREATE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(tenant_id, scope_type, scope_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_savings_opportunities_status ON savings_opportunities(tenant_id, status, kind);

CREATE TABLE IF NOT EXISTS allocation_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES spend_events(id),
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  sku TEXT,
  description TEXT,
  quantity REAL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT,
  purpose TEXT,
  expense_category TEXT,
  valuation_status TEXT NOT NULL DEFAULT 'declared',
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_allocation_target
  ON allocation_facts(tenant_id,target_type,target_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_allocation_category
  ON allocation_facts(tenant_id,expense_category,occurred_at);
