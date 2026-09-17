// Standalone entry point for configAdminKeyGuard.test.ts — importing config.ts has a real
// module-level side effect (it throws at import time for unsafe production config), which can't
// be exercised inside the shared vitest process without corrupting every other test's already-
// imported config singleton. Run in a fresh child process instead, once per case.
import '../../src/lib/config';
// eslint-disable-next-line no-console
console.log('config loaded ok');
