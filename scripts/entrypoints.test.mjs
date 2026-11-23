// Every skill script must run when it is reached through a link. Zero-install:
// run with the built-in test runner:
//
//   node --test scripts/entrypoints.test.mjs
//
// The AppMap extension for VS Code and scripts/install.mjs install each skill as
// a link in ~/.claude/skills, and agents run the scripts by that path. Node
// resolves the module's own URL to the real path, so a "run as main" check that
// compares it with the unresolved argv[1] fails through a link: the script
// then prints nothing and exits 0, which reads as a passing check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Scripts with a "run as main" block, relative to the checkout.
const scripts = [
  ...fs
    .readdirSync(checkout)
    .filter((dir) => dir.startsWith('appmap-'))
    .flatMap((dir) => {
      const assets = path.join(checkout, dir, 'assets');
      if (!fs.existsSync(assets)) return [];
      return fs
        .readdirSync(assets)
        .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
        .map((f) => path.join(dir, 'assets', f));
    }),
  path.join('scripts', 'install.mjs'),
].filter((rel) => fs.readFileSync(path.join(checkout, rel), 'utf8').includes('process.argv[1]'));

// No arguments prints usage or an argument error; install.mjs needs --help so
// that it does not install anything.
const argsFor = (rel) => (rel.startsWith('scripts') ? ['--help'] : []);

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, output: r.stdout + r.stderr };
}

test('finds the scripts to check', () => {
  assert.ok(scripts.includes(path.join('appmap-analyze', 'assets', 'analyze.mjs')), scripts.join(', '));
});

for (const rel of scripts) {
  test(`${rel} runs through a link to its skill`, (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-entrypoint-test-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const [top, ...rest] = rel.split(path.sep);
    fs.symlinkSync(path.join(checkout, top), path.join(root, top), 'dir');

    const direct = run(path.join(checkout, rel), argsFor(rel), root);
    const linked = run(path.join(root, top, ...rest), argsFor(rel), root);

    assert.notEqual(direct.output, '', 'the script prints something when run directly');
    assert.deepEqual(linked, direct);
  });
}
