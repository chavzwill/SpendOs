const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openStore(filename = process.env.SPENDOS_DB || path.join(process.cwd(), 'spendos.db')) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

function getLatestVersion(db, event) {
  return db.prepare(`SELECT latest_version, latest_event_id
    FROM source_versions
    WHERE tenant_id=? AND source=? AND source_record_id=? AND event_type=?`)
    .get(event.tenantId, event.source, event.sourceRecordId, event.type);
}

function insertEvent(db, event) {
  db.prepare(`INSERT INTO spend_events
    (id,tenant_id,event_type,source,source_record_id,source_version,occurred_at,actor_id,location_id,department_id,payload_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.id, event.tenantId, event.type, event.source, event.sourceRecordId,
      event.sourceVersion, event.occurredAt, event.actorId || null,
      event.locationId || null, event.departmentId || null, JSON.stringify(event.payload || {})
    );
}

function setLatestVersion(db, event) {
  db.prepare(`INSERT INTO source_versions
    (tenant_id,source,source_record_id,event_type,latest_version,latest_event_id)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(tenant_id,source,source_record_id,event_type)
    DO UPDATE SET latest_version=excluded.latest_version,
      latest_event_id=excluded.latest_event_id,
      updated_at=CURRENT_TIMESTAMP`).run(
        event.tenantId,event.source,event.sourceRecordId,event.type,event.sourceVersion,event.id
      );
}

module.exports = { openStore, getLatestVersion, insertEvent, setLatestVersion };
