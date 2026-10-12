'use strict';
// Shared by the gateway (auto-heal loop) and the control panel (explicit resync / recovery).
const C = require('./common');

// Copy one login's data from the backup into a shard.
async function hydrate(shardUrl, backupUrl, login) {
  const d = await C.call(`${backupUrl}/internal/data/${encodeURIComponent(login)}`, { internal: true });
  if (d.status !== 200) throw new Error(`backup has no data for ${login} (HTTP ${d.status})`);
  const r = await C.call(`${shardUrl}/internal/data/${encodeURIComponent(login)}`, {
    method: 'PUT', internal: true, body: { list: d.json.list, rev: d.json.rev, create: true },
  });
  // 409 older-than-held means the shard already has something newer: nothing to do
  if (r.status !== 200 && r.status !== 409) throw new Error(`shard refused ${login} (HTTP ${r.status})`);
}

async function evict(shardUrl, login) {
  await C.call(`${shardUrl}/internal/data/${encodeURIComponent(login)}`, { method: 'DELETE', internal: true });
}

module.exports = { hydrate, evict };
