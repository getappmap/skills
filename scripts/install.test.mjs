// Tests for the install script. Zero-install: run with the built-in test runner:
//
//   node --test scripts/install.test.mjs
//
// Each test builds a throwaway checkout (directories, some with a SKILL.md) and
// a throwaway skills directory, so nothing here reads or changes ~/.claude.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { plan, planUninstall, apply } from './install.mjs';

const INSTALL = fileURLToPath(new URL('./install.mjs', import.meta.url));

// A checkout with two skills, a directory that is not a skill, and a loose file.
function makeDirs(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-install-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'checkout');
  const dir = path.join(root, 'skills');
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(repo, name), { recursive: true });
    fs.writeFileSync(path.join(repo, name, 'SKILL.md'), `# ${name}\n`);
  }
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'README.md'), '');
  fs.mkdirSync(dir);
  return { root, repo, dir };
}

const link = (target, at) => fs.symlinkSync(target, at, 'junction');
const targetOf = (file) => path.resolve(path.dirname(file), fs.readlinkSync(file));
const summary = (steps) => steps.map((step) => `${step.action} ${step.name}`);

test('plan: only directories with a SKILL.md are skills; each gets a link', (t) => {
  const { repo, dir } = makeDirs(t);
  const steps = plan(repo, dir);
  assert.deepEqual(summary(steps), ['add alpha', 'add beta']);
  apply(steps);
  assert.equal(targetOf(path.join(dir, 'alpha')), path.join(repo, 'alpha'));
  assert.equal(targetOf(path.join(dir, 'beta')), path.join(repo, 'beta'));
  assert.equal(fs.readFileSync(path.join(dir, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');
  // A second run has nothing to do.
  assert.deepEqual(summary(plan(repo, dir)), ['keep alpha', 'keep beta']);
});

test('plan: a skills directory that does not exist yet is created', (t) => {
  const { root, repo } = makeDirs(t);
  const dir = path.join(root, 'not', 'made', 'yet');
  const steps = plan(repo, dir);
  assert.deepEqual(summary(steps), ['add alpha', 'add beta']);
  apply(steps);
  assert.equal(targetOf(path.join(dir, 'alpha')), path.join(repo, 'alpha'));
});

test('plan: a link that goes somewhere else is repointed, and says where it went', (t) => {
  const { root, repo, dir } = makeDirs(t);
  const released = path.join(root, 'released', 'alpha');
  fs.mkdirSync(released, { recursive: true });
  link(released, path.join(dir, 'alpha'));
  const steps = plan(repo, dir);
  assert.deepEqual(summary(steps), ['repoint alpha', 'add beta']);
  assert.equal(steps[0].was, released);
  apply(steps);
  assert.equal(targetOf(path.join(dir, 'alpha')), path.join(repo, 'alpha'));
  assert.ok(fs.existsSync(released), 'the old target itself is untouched');
});

test('plan: a real directory or file of the same name is left alone', (t) => {
  const { repo, dir } = makeDirs(t);
  fs.mkdirSync(path.join(dir, 'alpha'));
  fs.writeFileSync(path.join(dir, 'alpha', 'mine.txt'), 'keep me');
  fs.writeFileSync(path.join(dir, 'beta'), 'a file');
  const steps = plan(repo, dir);
  assert.deepEqual(summary(steps), ['skip alpha', 'skip beta']);
  apply(steps);
  assert.equal(fs.readFileSync(path.join(dir, 'alpha', 'mine.txt'), 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(path.join(dir, 'beta'), 'utf8'), 'a file');
});

test('plan: removes a link to a skill this checkout no longer has, and no other link', (t) => {
  const { root, repo, dir } = makeDirs(t);
  // Was a skill here once; the directory is gone.
  link(path.join(repo, 'gone'), path.join(dir, 'gone'));
  // Points into the checkout at something that still exists but is not a skill.
  link(path.join(repo, 'docs'), path.join(dir, 'docs'));
  // Broken, but it never pointed into this checkout.
  link(path.join(root, 'elsewhere', 'other'), path.join(dir, 'other'));
  // Someone's own skill.
  fs.mkdirSync(path.join(dir, 'theirs'));

  const steps = plan(repo, dir);
  assert.deepEqual(summary(steps), ['add alpha', 'add beta', 'remove gone']);
  apply(steps);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['alpha', 'beta', 'docs', 'other', 'theirs']);
});

test('uninstall: links into the checkout go back to the released copy, or are removed; others stay', (t) => {
  const { root, repo, dir } = makeDirs(t);
  const released = path.join(root, 'released');
  fs.mkdirSync(path.join(released, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(released, 'alpha', 'SKILL.md'), '# alpha, released\n');
  fs.mkdirSync(path.join(released, 'unfinished')); // no SKILL.md: not a copy to go back to
  apply(plan(repo, dir)); // alpha and beta now point into the checkout
  link(path.join(repo, 'unfinished'), path.join(dir, 'unfinished')); // into the checkout too
  link(path.join(root, 'elsewhere', 'other'), path.join(dir, 'other'));
  fs.mkdirSync(path.join(dir, 'theirs'));

  const steps = planUninstall(repo, dir, released);
  assert.deepEqual(summary(steps), ['restore alpha', 'remove beta', 'remove unfinished']);
  apply(steps);
  assert.equal(targetOf(path.join(dir, 'alpha')), path.join(released, 'alpha'));
  assert.equal(fs.readFileSync(path.join(dir, 'alpha', 'SKILL.md'), 'utf8'), '# alpha, released\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['alpha', 'other', 'theirs']);
  assert.ok(fs.existsSync(path.join(repo, 'beta', 'SKILL.md')), 'the checkout itself is untouched');
  // Nothing points into the checkout any more, so a second run has nothing to do.
  assert.deepEqual(planUninstall(repo, dir, released), []);
  // And installing again brings the checkout's copies back.
  assert.deepEqual(summary(plan(repo, dir)), ['repoint alpha', 'add beta']);
});

test('command line: --uninstall after an install, with a dry run first', (t) => {
  const { root } = makeDirs(t);
  const dir = path.join(root, 'cli-skills');
  const released = path.join(root, 'released');
  fs.mkdirSync(path.join(released, 'appmap-review'), { recursive: true });
  fs.writeFileSync(path.join(released, 'appmap-review', 'SKILL.md'), 'released\n');
  const run = (...args) => spawnSync(process.execPath, [INSTALL, '--dir', dir, '--released', released, ...args], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const before = fs.readdirSync(dir).sort();

  const dry = run('--uninstall', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^Would put back the released skills from /);
  assert.match(dry.stdout, /\n {2}restore {2}appmap-review {2}\(to .*released.appmap-review\)\n/);
  assert.match(dry.stdout, /\n {2}remove {3}appmap-config {2}\(no released copy\)\n/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);

  const real = run('--uninstall');
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(fs.readdirSync(dir), ['appmap-review']);
  assert.equal(fs.readFileSync(path.join(dir, 'appmap-review', 'SKILL.md'), 'utf8'), 'released\n');
  assert.match(run('--uninstall').stdout, /nothing to do: no link there points into /);
});

test('command line: --dry-run changes nothing; a real run links; a bad option fails', (t) => {
  const { root } = makeDirs(t);
  const dir = path.join(root, 'cli-skills');
  const run = (...args) => spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8' });

  const dry = run('--dir', dir, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^Would link the skills in /);
  assert.match(dry.stdout, /\n {2}add {6}appmap-review\n/);
  assert.ok(!fs.existsSync(dir), '--dry-run does not even make the directory');

  const real = run('--dir', dir);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /^Linking the skills in /);
  // The real checkout: every linked entry is a skill, so scripts/ itself is not linked.
  const linked = fs.readdirSync(dir);
  assert.ok(linked.includes('appmap-review'));
  assert.ok(!linked.includes('scripts'));
  for (const name of linked) assert.ok(fs.existsSync(path.join(dir, name, 'SKILL.md')), name);

  const bad = run('--nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown argument: --nope/);
  const noValue = run('--dir');
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /--dir needs a value/);
});
