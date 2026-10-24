import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isNewer, latestVersion, scheduleUpdate, updatePlan } from '../src/update.js';

async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sphinx-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('compares releases numerically', () => {
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.7', '0.1.7'), false);
  assert.equal(isNewer('0.1.6', '0.1.7'), false);
  assert.equal(isNewer('garbage', '0.1.7'), false);
});

test('checks the registry at most every 12 hours and never throws', async t => {
  const env = { SPHINX_HOME: await home(t) };
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ version: '9.9.9' }) }; };
  assert.equal(await latestVersion({ env, fetchImpl }), '9.9.9');
  assert.equal(await latestVersion({ env, fetchImpl }), '9.9.9');
  assert.equal(calls, 1);
  assert.equal(await latestVersion({ env: { SPHINX_HOME: await home(t) }, fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await latestVersion({ env: { ...env, SPHINX_UPDATE_CHECK: '0' }, fetchImpl }), null);
});

test('updates with the package manager that installed it, and never touches a linked checkout', async t => {
  const dir = await home(t);
  for (const [where, manager] of [['lib/node_modules/sphinx-understand', 'npm'], ['Library/pnpm/global/5/.pnpm/sphinx-understand@0.1.7/node_modules/sphinx-understand', 'pnpm'], ['.bun/install/global/node_modules/sphinx-understand', 'bun']]) {
    const root = path.join(dir, where); await mkdir(root, { recursive: true });
    assert.equal((await updatePlan({ root })).manager, manager, where);
  }
  const checkout = path.join(dir, 'sphinx'), link = path.join(dir, 'lib/node_modules/linked');
  await mkdir(checkout); await symlink(checkout, link);
  const linked = await updatePlan({ root: link });
  assert.equal(linked.manager, null); assert.match(linked.note, /git pull/);
});

test('the install waits for this process to exit and runs detached', async t => {
  const env = { SPHINX_HOME: await home(t) };
  let call;
  const spawnImpl = (...args) => { call = args; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
  assert.equal(await scheduleUpdate({ command: ['npm', 'install', '-g', "sphinx-understand@latest"], waitFor: 4242, env, spawnImpl }), true);
  assert.equal(call[0], '/bin/sh'); assert.equal(call[2].detached, true);
  assert.match(call[1][1], /kill -0 4242/); assert.match(call[1][1], /'npm' 'install' '-g' 'sphinx-understand@latest'/);
  assert.equal(await scheduleUpdate({ command: [], env, spawnImpl }), false);
  assert.equal(await scheduleUpdate({ command: ['npm'], env, spawnImpl: () => { throw new Error('no sh'); } }), false);
});
