'use strict';
// One image, four roles. ROLE decides what this container is: gateway | shard | backup | control.
const role = process.env.ROLE;
const port = Number(process.env.PORT || 3000);
const roles = {
  gateway: () => require('./gateway'),
  shard: () => require('./shard'),
  backup: () => require('./backup'),
  control: () => require('./control'),
};
if (!roles[role]) {
  console.error(`ROLE must be one of: ${Object.keys(roles).join(', ')} (got "${role || ''}")`);
  process.exit(1);
}
roles[role]().start(port);
process.on('SIGTERM', () => process.exit(0)); // Kubernetes sends SIGTERM on pod deletion
// Local mode only: if the control process that started us disappears, do not linger as an orphan.
if (process.env.PARENT_PID) {
  setInterval(() => { try { process.kill(Number(process.env.PARENT_PID), 0); } catch { process.exit(0); } }, 1000).unref();
}
