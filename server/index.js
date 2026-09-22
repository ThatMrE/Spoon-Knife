/**
 * Entry point. Serves the client over the local network and upgrades /ws.
 *
 * Run it on a laptop that's on the same WiFi as everybody's phones, then read
 * the printed address out loud. No install, no app store, no internet.
 */
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostname } from 'node:os';

import { RoomManager } from '../core/rooms.js';
import { attachWebSocketServer } from './ws.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
/**
 * Directories outside public/ that the browser may import from.
 *
 * `core/` holds the game rules, which are host-agnostic on purpose: the Node
 * server and the Android host run the same files rather than two copies of the
 * rules. Serving them is why a browser can host a game at all.
 */
const EXPOSED_DIRS = ['shared', 'core'];
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Map a request path to a file on disk, or null if it escapes the served dirs.
 * Exported for tests — path traversal is the one thing a LAN server still owes
 * you care about.
 */
export function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;

  // Normalising an *absolute* path clamps `..` at the root, so a request can
  // never climb above the document root no matter how it is spelled.
  const rooted = normalize(`/${decoded.replace(/^[/\\]+/, '')}`);
  const relative = rooted === sep || rooted === '/' ? 'index.html' : rooted.slice(1);

  // Root-level module directories the browser is allowed to import from;
  // everything else resolves inside public/.
  const exposed = EXPOSED_DIRS.find(
    (dir) => relative === dir || relative.startsWith(dir + sep),
  );
  const allowed = exposed ? join(ROOT, exposed) : PUBLIC_DIR;
  const full = exposed ? join(ROOT, relative) : join(PUBLIC_DIR, relative);

  // Belt and braces: confirm containment on the resolved path itself.
  return full === allowed || full.startsWith(allowed + sep) ? full : null;
}

/**
 * A marker the Android app probes for while sweeping the local subnet, so
 * nobody has to read an IP address out loud. Deliberately tiny and
 * dependency-free: the app fires one of these at every address on the /24.
 */
export const DISCOVERY_APP_ID = 'spaceteam-lan';

function serveDiscovery(res, rooms) {
  const body = JSON.stringify({
    app: DISCOVERY_APP_ID,
    host: hostname(),
    rooms: rooms.rooms.size,
    players: [...rooms.rooms.values()].reduce((n, room) => n + room.players.size, 0),
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // The app is not a browser, but a phone's browser may probe this too.
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const path = resolveStatic(req.url ?? '/');
  if (!path) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      // Phones reload this constantly while you're tweaking; never cache.
      'Cache-Control': 'no-cache',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

/** Every IPv4 address this machine can be reached on. Exported for tests. */
export function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

export function createGameServer() {
  const rooms = new RoomManager();
  const server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] === '/discover') serveDiscovery(res, rooms);
    else serveStatic(req, res);
  });
  attachWebSocketServer(server, { path: '/ws', onConnection: (c) => rooms.attach(c) });
  server.rooms = rooms;
  return server;
}

// Only take over the terminal when run directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const server = createGameServer();
  server.listen(PORT, HOST, () => {
    const addresses = lanAddresses();
    console.log('\n  🚀 SPACETEAM LAN\n');
    console.log('  Open this on every phone (same WiFi):\n');
    if (addresses.length === 0) {
      console.log(`    http://localhost:${PORT}   (no LAN address found — is WiFi on?)`);
    }
    for (const address of addresses) console.log(`    http://${address}:${PORT}`);
    console.log(`\n  Also here: http://localhost:${PORT}`);
    console.log('  One phone taps NEW SHIP and reads out the code. Ctrl-C to shut down.\n');
  });
}
