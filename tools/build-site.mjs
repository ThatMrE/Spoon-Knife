/**
 * Assemble the static site that gets deployed.
 *
 * The client imports `/shared/protocol.js` and `/core/*.js`, which live outside
 * `public/`, so the deployable tree has to be staged rather than published
 * straight from `public/`. This mirrors what the Android build stages into the
 * APK's assets, from the same single source of truth.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site');

/** Everything a host needs to serve, and where it has to appear. */
const TREE = [
  ['public', '.'],
  ['shared', 'shared'],
  ['core', 'core'],
];

/** A partial copy would deploy a page that 404s on its own modules. */
const REQUIRED = [
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/loopback.js',
  'js/party.js',
  'js/side.js',
  'js/find.js',
  'host/bridge.js',
  'shared/protocol.js',
  'shared/looks.js',
  'core/rooms.js',
  'core/game.js',
  'core/panel.js',
  'core/jargon.js',
  'core/sealed.js',
  'core/games/index.js',
  'core/games/bids.js',
  'core/games/superlatives.js',
  'core/games/taboo.js',
];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const [from, to] of TREE) {
  await cp(join(ROOT, from), join(OUT, to), { recursive: true });
}

const missing = [];
for (const path of REQUIRED) {
  try {
    const info = await stat(join(OUT, path));
    if (!info.isFile()) missing.push(path);
  } catch {
    missing.push(path);
  }
}

if (missing.length) {
  console.error(`site build incomplete, missing:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

console.log(`site/ built: ${REQUIRED.length} required files present`);
