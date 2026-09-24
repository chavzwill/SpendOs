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
