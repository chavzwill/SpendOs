const { getLatestVersion, insertEvent, setLatestVersion } = require('./store');
const { factsFromEvent, insertFacts } = require('./facts');

function validateEvent(event) {
  const required = ['id','type','occurredAt','tenantId','source','sourceRecordId','sourceVersion'];
  for (const key of required) {
    if (event[key] === undefined || event[key] === null || event[key] === '') {
      throw Object.assign(new Error(`Missing required field: ${key}`), { statusCode: 400 });
    }
  }
  if (!Number.isInteger(Number(event.sourceVersion)) || Number(event.sourceVersion) < 1) {
    throw Object.assign(new Error('sourceVersion must be a positive integer'), { statusCode: 400 });
  }
}

function ingestEvent(db, event) {
  validateEvent(event);
  const latest = getLatestVersion(db, event);

  if (latest && Number(event.sourceVersion) < Number(latest.latest_version)) {
    return { status: 'stale', latestVersion: Number(latest.latest_version) };
  }
  if (latest && Number(event.sourceVersion) === Number(latest.latest_version)) {
    if (event.id === latest.latest_event_id) return { status: 'duplicate', latestVersion: Number(latest.latest_version) };
    return { status: 'conflict', latestVersion: Number(latest.latest_version) };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    insertEvent(db, event);
    insertFacts(db, factsFromEvent(event));
    setLatestVersion(db, event);
    db.exec('COMMIT');
    return { status: 'accepted', latestVersion: Number(event.sourceVersion) };
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error.message).includes('UNIQUE constraint failed: spend_events.id')) {
      return { status: 'duplicate', latestVersion: Number(event.sourceVersion) };
    }
    throw error;
  }
}

module.exports = { validateEvent, ingestEvent };
