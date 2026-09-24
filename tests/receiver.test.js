const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { ingestEvent } = require('../src/ingest');
const { managementSnapshot, supplierPriceHistory } = require('../src/analytics');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  return db;
}

function event(version = 1, id = `evt-${version}`) {
  return {
    id,
    type: 'purchase.requested',
    occurredAt: '2026-09-24T18:00:00.000Z',
    tenantId: 'total-tools',
    source: 'total-tools-pos',
    sourceRecordId: '42',
    sourceVersion: version,
    actorId: '7',
    locationId: '2',
    departmentId: 'Operations',
    payload: {
      supplierId: '5',
      currency: 'JMD',
      items: [{ sku: 'ABC', description: 'Drill', quantity: 4, unitCost: 12000, lineTotal: 48000 }]
    }
  };
}

test('accepts first event and normalizes spend fact', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event()).status, 'accepted');
  const snapshot = managementSnapshot(db, 'total-tools');
  assert.equal(snapshot.requested, 48000);
  assert.equal(snapshot.suppliers[0].supplier_id, '5');
});

test('duplicate replay is idempotent', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event()).status, 'accepted');
  assert.equal(ingestEvent(db, event()).status, 'duplicate');
  const count = db.prepare('SELECT COUNT(*) c FROM spend_facts').get().c;
  assert.equal(count, 1);
});

test('older source version is rejected as stale', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event(2, 'evt-2')).status, 'accepted');
  const result = ingestEvent(db, event(1, 'evt-1'));
  assert.equal(result.status, 'stale');
  assert.equal(result.latestVersion, 2);
});

test('different event id at same source version is a conflict', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event(1, 'evt-a')).status, 'accepted');
  assert.equal(ingestEvent(db, event(1, 'evt-b')).status, 'conflict');
});

test('newer version appends history and updates supplier pricing', () => {
  const db = freshDb();
  ingestEvent(db, event(1, 'evt-1'));
  const v2 = event(2, 'evt-2');
  v2.payload.items[0].unitCost = 13000;
  v2.payload.items[0].lineTotal = 52000;
  assert.equal(ingestEvent(db, v2).status, 'accepted');
  const history = supplierPriceHistory(db, 'total-tools', 'ABC');
  assert.equal(history.length, 2);
  assert.equal(history[0].unit_amount, 13000);
});
