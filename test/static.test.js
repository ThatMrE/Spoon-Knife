import { strict as assert } from 'node:assert';
import test from 'node:test';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStatic } from '../server/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const SHARED_DIR = join(ROOT, 'shared');

/** The only safety property that matters: nothing resolves outside these two. */
function isContained(path) {
  return [PUBLIC_DIR, SHARED_DIR].some((dir) => path === dir || path.startsWith(dir + sep));
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

test('traversal out of the served directories is refused', () => {
  for (const attempt of [
    '/../package.json',
    '/../../etc/passwd',
    '/js/../../server/rooms.js',
    '/%2e%2e/package.json',
    '/%2e%2e%2f%2e%2e%2fetc/passwd',
    '/shared/../server/game.js',
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
  for (const attempt of ['/../server/game.js', '/js/../../server/ws.js', '/../package.json']) {
    const resolved = resolveStatic(attempt);
    assert.equal(resolved === join(ROOT, 'server', 'game.js'), false);
    assert.equal(resolved === join(ROOT, 'server', 'ws.js'), false);
    assert.equal(resolved === join(ROOT, 'package.json'), false);
  }
});

test('malformed encodings are refused rather than guessed at', () => {
  assert.equal(resolveStatic('/%E0%A4%A'), null);
});
