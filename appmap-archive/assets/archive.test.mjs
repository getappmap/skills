// Tests for the archive helper. Zero-install: run with the built-in test runner:
//
//   node --test appmap-archive/assets/archive.test.mjs
//
// A fake AppMap CLI stands in for `appmap archive`. Like the real one it needs
// appmap.yml and the recordings directory in its working directory, writes
// index files beside the recordings, and puts <revision>.tar under
// .appmap/archive/full there. The tar it writes is a JSON list of the
// recordings it found, which is what the tests read back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planArchive } from './archive.mjs';

const ARCHIVE = fileURLToPath(new URL('./archive.mjs', import.meta.url));

const FAKE_CLI = `import fs from 'node:fs';
import path from 'node:path';
const [command, ...rest] = process.argv.slice(2);
if (command !== 'archive') process.exit(1);
// FAKE_APPMAP_NEW: a CLI whose archive takes --appmap-dir and --output-file, with no appmap.yml.
const NEW = Boolean(process.env.FAKE_APPMAP_NEW);
if (rest.includes('--help')) { console.log(NEW ? 'archive --appmap-dir --output-file' : 'archive --revision'); process.exit(0); }
const option = (name) => rest[rest.indexOf(name) + 1];
if (NEW && rest.includes('--appmap-dir')) {
  if (process.env.FAKE_APPMAP_FAIL) { console.error('archive blew up'); process.exit(5); }
  const found = {};
  const walk = (dir, prefix = '') => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dirent.isDirectory()) walk(path.join(dir, dirent.name), prefix + dirent.name + '/');
      else if (dirent.name.endsWith('.appmap.json')) found[prefix + dirent.name] = fs.readFileSync(path.join(dir, dirent.name), 'utf8');
    }
  };
  walk(option('--appmap-dir'));
  fs.writeFileSync(path.join(option('--appmap-dir'), 'appmap_archive.json'), '{}');
  fs.writeFileSync(option('--output-file'), JSON.stringify({ cwd: process.cwd(), revision: option('--revision'), hasYml: fs.existsSync('appmap.yml'), found }));
  process.exit(0);
}
if (!fs.existsSync('appmap.yml')) { console.error('no appmap.yml in ' + process.cwd()); process.exit(3); }
if (!fs.existsSync('recs')) { console.error('AppMap directory recs does not exist'); process.exit(4); }
if (process.env.FAKE_APPMAP_FAIL) { console.error('archive blew up'); process.exit(5); }
const found = {};
const walk = (dir, prefix = '') => {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) walk(path.join(dir, dirent.name), prefix + dirent.name + '/');
    else if (dirent.name.endsWith('.appmap.json')) found[prefix + dirent.name] = fs.readFileSync(path.join(dir, dirent.name), 'utf8');
  }
};
walk('recs');
fs.writeFileSync('recs/appmap_archive.json', '{}'); // the real CLI litters the recordings directory
fs.mkdirSync('.appmap/archive/full', { recursive: true });
fs.writeFileSync('.appmap/archive/full/' + rest[rest.indexOf('--revision') + 1] + '.tar', JSON.stringify({ cwd: process.cwd(), found }));
`;

function makeProject(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appmap-archive-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(project, 'appmap.yml'), 'name: fixture\nappmap_dir: recs\n');
  const cli = path.join(root, 'fake-cli.mjs');
  fs.writeFileSync(cli, FAKE_CLI);
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const run = (args, env = {}, cwd = path.join(project, 'sub')) => {
    const result = spawnSync(process.execPath, [ARCHIVE, '--appmap-cli', `${process.execPath} ${cli}`, ...args],
      { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(result.error, undefined);
    return result;
  };
  const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  return { root, project, write, run, tree };
}

test('archive: files and directories, each at its own path, from a copy', (t) => {
  const { root, project, write, run, tree } = makeProject(t);
  write('runs/pytest/checkout.appmap.json', 'checkout');
  write('runs/pytest/notes.txt', 'not a recording');
  write('runs/http/checkout.appmap.json', 'checkout over http');
  const loose = write('elsewhere/login.appmap.json', 'login');
  const before = { runs: tree(path.join(root, 'runs')), project: tree(project) };
  const out = path.join(root, 'made', 'base.tar');

  const result = run(['--revision', 'base', '--out', out, path.join(root, 'runs'), loose]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Recordings: 3\n {2}http\/checkout\n {2}login\n {2}pytest\/checkout\n/);
  const { cwd, found } = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(found, {
    'http/checkout.appmap.json': 'checkout over http',
    'login.appmap.json': 'login',
    'pytest/checkout.appmap.json': 'checkout',
  });
  // The CLI ran in a temporary copy, which is gone; the recordings and the project are as they were.
  assert.ok(!cwd.startsWith(root));
  assert.ok(!fs.existsSync(cwd));
  assert.deepEqual(tree(path.join(root, 'runs')), before.runs);
  assert.deepEqual(tree(project), before.project);

  const again = run(['--revision', 'base', '--out', out, loose]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Refusing to overwrite .*base\.tar/);
});

test('archive: refuses two recordings at one path, and bad input', (t) => {
  const { root, write, run } = makeProject(t);
  const a = write('a/login.appmap.json', 'a');
  const b = write('b/login.appmap.json', 'b');
  const out = path.join(root, 'x.tar');
  const clash = run(['--revision', 'x', '--out', out, a, b]);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /Two recordings would both be archived as login\.appmap\.json:\n.*a.login\.appmap\.json\n.*b.login\.appmap\.json/);
  fs.mkdirSync(path.join(root, 'empty'));
  const cases = [
    [['--out', out, a], /--revision NAME is required/],
    [['--revision', 'feature/x', '--out', out, a], /becomes a file name/],
    [['--revision', 'x', a], /--out FILE\.tar is required/],
    [['--revision', 'x', '--out', out], /Name at least one recording/],
    [['--revision', 'x', '--out', out, path.join(root, 'nope.appmap.json')], /Recording not found: .*nope/],
    [['--revision', 'x', '--out', out, path.join(root, 'empty')], /No recordings \(\.appmap\.json\) under .*empty/],
    [['--revision', 'x', '--out', out, write('notes.txt', 'x')], /Not an AppMap recording: .*notes\.txt/],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message);
  }
  assert.ok(!fs.existsSync(out));
});

test('archive: a failing CLI leaves no archive and no temporary copy', (t) => {
  const { root, write, run } = makeProject(t);
  const out = path.join(root, 'x.tar');
  const temps = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('appmap-archive-') && !name.startsWith('appmap-archive-test-')).sort();
  const before = temps();
  const result = run(['--revision', 'x', '--out', out, write('one.appmap.json', '1')], { FAKE_APPMAP_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive blew up/);
  assert.ok(!fs.existsSync(out));
  assert.deepEqual(temps(), before);
});

test('planArchive: a directory keeps paths below it, with forward slashes', async (t) => {
  const { root, write } = makeProject(t);
  write('runs/a/b/deep.appmap.json', '1');
  const planned = await planArchive([path.join(root, 'runs')]);
  assert.deepEqual([...planned.keys()], ['a/b/deep.appmap.json']);
  assert.equal(planned.get('a/b/deep.appmap.json'), path.join(root, 'runs', 'a', 'b', 'deep.appmap.json'));
});

test('newer CLI: one archive command, the same paths, and no appmap.yml needed', (t) => {
  const { root, project, write, run, tree } = makeProject(t);
  write('runs/pytest/checkout.appmap.json', 'checkout');
  const loose = write('elsewhere/login.appmap.json', 'login');
  const before = { runs: tree(path.join(root, 'runs')), project: tree(project) };
  const newCli = { FAKE_APPMAP_NEW: '1' };

  const inProject = path.join(root, 'in-project.tar');
  const first = run(['--revision', 'abc123', '--out', inProject, path.join(root, 'runs'), loose], newCli);
  assert.equal(first.status, 0, first.stderr);
  const made = JSON.parse(fs.readFileSync(inProject, 'utf8'));
  assert.deepEqual(made.found, { 'login.appmap.json': 'login', 'pytest/checkout.appmap.json': 'checkout' });
  assert.equal(made.revision, 'abc123');
  assert.equal(made.hasYml, true, "the project's appmap.yml is used when there is one");
  assert.ok(!fs.existsSync(made.cwd), 'the temporary copy is gone');
  assert.deepEqual(tree(path.join(root, 'runs')), before.runs);
  assert.deepEqual(tree(project), before.project);

  // Outside any project: the older CLI cannot, the newer one can.
  const outside = path.join(root, 'no-project');
  fs.mkdirSync(outside);
  const refused = run(['--revision', 'x', '--out', path.join(root, 'x.tar'), loose], {}, outside);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /No appmap\.yml found/);
  const alone = path.join(root, 'alone.tar');
  const second = run(['--revision', 'x', '--out', alone, loose], newCli, outside);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Config: {3}none /);
  assert.equal(JSON.parse(fs.readFileSync(alone, 'utf8')).hasYml, false);

  const failed = run(['--revision', 'y', '--out', path.join(root, 'y.tar'), loose], { ...newCli, FAKE_APPMAP_FAIL: '1' });
  assert.equal(failed.status, 1);
  assert.ok(!fs.existsSync(path.join(root, 'y.tar')));
});
