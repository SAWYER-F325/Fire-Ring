#!/usr/bin/env node
// Fire Ring's background bridge. The app starts it with its own copy of Node
// and restarts it if it stops; it can also be run by hand from the repository:
//   cd bridge && npm start
import { DATA_DIR, VERSION } from './config.mjs';
import { currentRoute } from './egress.mjs';
import { STATE_PORT, startStateServer } from './http.mjs';

const server = startStateServer();
server.on('listening', () => {
  console.log(`[start] Fire Ring ${VERSION} on 127.0.0.1:${STATE_PORT}; data in ${DATA_DIR}; network: ${currentRoute().label}`);
});
server.on('error', (error) => {
  // Another copy already serves the port: stop, so the app can tell and retry.
  if (error.code === 'EADDRINUSE') {
    console.error(`[start] port ${STATE_PORT} is already in use; is another Fire Ring running?`);
    process.exit(3);
  }
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Started by the app: stop with it, even if it was force-quit and could not
// say so, rather than keep the port from the next copy.
const parent = Number(process.env.FIRE_RING_PARENT_PID);
if (parent > 1) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      console.log('[start] the app is gone; stopping');
      process.exit(0);
    }
  }, 5000).unref();
}
