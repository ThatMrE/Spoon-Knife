import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ID } from '../shared/protocol.js';
import { resolveStatic } from '../server/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const SHARED_DIR = join(ROOT, 'shared');
const CORE_DIR = join(ROOT, 'core');

/** The only safety property that matters: nothing resolves outside these. */
function isContained(path) {
  return [PUBLIC_DIR, SHARED_DIR, CORE_DIR].some(
    (dir) => path === dir || path.startsWith(dir + sep),
  );
}

test('the document root serves the client', () => {
  assert.match(resolveStatic('/'), new RegExp(`public\\${sep}index\\.html$`));
});

test('client assets resolve under public/', () => {
  assert.match(resolveStatic('/js/app.js'), new RegExp(`public\\${sep}js\\${sep}app\\.js$`));
  assert.match(resolveStatic('/css/style.css?v=2'), new RegExp(`public\\${sep}css\\${sep}style\\.css$`));
});

test('the shared protocol module is reachable by both halves of the app', () => {
  assert.match(resolveStatic('/shared/protocol.js'), new RegExp(`shared\\${sep}protocol\\.js$`));
});

test('the game rules are importable by a browser that wants to host', () => {
  // The Android host and a browser load these same files; that is the whole
  // point of core/ being separate from server/.
  for (const module of ['rooms.js', 'game.js', 'panel.js', 'jargon.js', 'sealed.js']) {
    assert.match(resolveStatic(`/core/${module}`), new RegExp(`core\\${sep}${module.replace('.', '\\.')}$`));
  }
});

test('the party games are importable too, one directory down', () => {
  for (const module of ['index.js', 'bids.js', 'superlatives.js', 'taboo.js']) {
    const resolved = resolveStatic(`/core/games/${module}`);
    assert.match(resolved, new RegExp(`core\\${sep}games\\${sep}${module.replace('.', '\\.')}$`));
  }
});

test('Node-only transport is still not reachable', () => {
  // core/ is exposed, server/ is not.
  for (const attempt of ['/server/ws.js', '/server/index.js', '/core/../server/ws.js']) {
    const resolved = resolveStatic(attempt);
    assert.ok(resolved === null || isContained(resolved), `${attempt} -> ${resolved}`);
  }
});

test('traversal out of the served directories is refused', () => {
  for (const attempt of [
    '/../package.json',
    '/../../etc/passwd',
    '/js/../../server/ws.js',
    '/%2e%2e/package.json',
    '/%2e%2e%2f%2e%2e%2fetc/passwd',
    '/shared/../server/index.js',
    '/shared/../../etc/hosts',
    '/....//....//package.json',
    '//etc/passwd',
    '/js/%00../../package.json',
  ]) {
    const resolved = resolveStatic(attempt);
    assert.ok(
      resolved === null || isContained(resolved),
      `${attempt} escaped the document root: ${resolved}`,
    );
  }
});

test('server source is never reachable, however it is spelled', () => {
  for (const attempt of ['/../server/index.js', '/js/../../server/ws.js', '/../package.json']) {
    const resolved = resolveStatic(attempt);
    assert.equal(resolved === join(ROOT, 'server', 'index.js'), false);
    assert.equal(resolved === join(ROOT, 'server', 'ws.js'), false);
    assert.equal(resolved === join(ROOT, 'package.json'), false);
  }
});

test('malformed encodings are refused rather than guessed at', () => {
  assert.equal(resolveStatic('/%E0%A4%A'), null);
});

/**
 * Java cannot import shared/protocol.js or host/bridge.js, so the Android half
 * carries its own spelling of three names the two halves have to agree on. Each
 * of them fails silently and confusingly when it drifts — the subnet sweep finds
 * nothing, or the WebView answers a call that isn't there — so they are checked
 * here rather than discovered in a pub.
 */
const javaSource = async (file) => {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(ROOT, 'android/app/src/main/java/io/github/thatmre/sociovia', file), 'utf8');
};

test('the Android app and the server agree on what this app is called', async () => {
  const declared = (await javaSource('HostFinder.java')).match(/APP_ID\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(declared, 'could not find APP_ID in HostFinder.java — has it been renamed?');
  assert.equal(declared, APP_ID, 'HostFinder.java and shared/protocol.js disagree');

  // The phone answers /discover from its own socket before the engine has said
  // anything, so this placeholder has to carry the same marker.
  const fallback = (await javaSource('HostServer.java')).match(/\{\\"app\\":\\"([^\\"]+)/)?.[1];
  assert.equal(fallback, APP_ID, 'HostServer.java greets a sweep with the wrong name');
});

test('both ends of the WebView bridge use the same two names', async () => {
  const engine = await javaSource('HostEngine.java');
  const bridge = await readFile(join(ROOT, 'public/host/bridge.js'), 'utf8');

  // Java calls into these; the page defines them. A rename on one side alone is
  // a host that starts, serves the client, and then never ticks.
  for (const name of ['socioviaHost', 'SocioviaNative']) {
    assert.ok(engine.includes(name), `HostEngine.java no longer mentions ${name}`);
    assert.ok(bridge.includes(name), `bridge.js no longer defines ${name}`);
  }
});
