// Tests for the gold-traces maintenance engine. Zero-install: run with the
// built-in test runner, no dependencies:
//
//   node --test appmap-gold-traces/assets/manage.test.mjs
//
// Pure logic (digest, YAML reader, snapshot diff) is tested directly. The
// `discover` command is tested end-to-end: the engine runs as a subprocess
// against a throwaway fixture project whose record command is a stub recorder
// script — no AppMap CLI or real recorder needed. `update`'s bless path needs
// the real CLI (sanitize/sequence-diagram), so it is exercised against a real
// project, not here — but its record+missing-path error path is covered below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml, diagramDigest, changedAppmaps, assessAppMap } from './manage.mjs';

const MANAGE = fileURLToPath(new URL('./manage.mjs', import.meta.url));

// A fixture project: appmap.yml (appmap_dir: tmp/appmap), a stub recorder script
// standing in for "{test_file}", and a gold_traces/manifest.yaml whose record
// command runs it. The recorder's behavior is switched by {test_name}, mirroring
// how a real recorder decides output paths on its own:
//   one_recording   -> pytest/one_recording.appmap.json (+ a non-appmap noise file)
//   two_recordings  -> pytest/a.appmap.json + requests/b.appmap.json
//   no_recording    -> writes nothing
function makeFixture(t, { entries = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-traces-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'appmap.yml'), 'name: fixture\nappmap_dir: tmp/appmap\n');
  fs.writeFileSync(
    path.join(dir, 'recorder.mjs'),
    `import fs from 'node:fs';
const name = process.argv[2];
const write = (rel) => {
  fs.mkdirSync('tmp/appmap/' + rel.split('/').slice(0, -1).join('/'), { recursive: true });
  fs.writeFileSync('tmp/appmap/' + rel, JSON.stringify({ name, stamp: Date.now(), pad: Math.random() }));
};
if (name === 'two_recordings') { write('pytest/a.appmap.json'); write('requests/b.appmap.json'); }
else if (name === 'no_recording') { /* records nothing */ }
else { write('pytest/' + name + '.appmap.json'); fs.writeFileSync('tmp/appmap/noise.log', 'not an appmap'); }
`,
  );
  fs.mkdirSync(path.join(dir, 'gold_traces/baseline/appmaps'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'gold_traces/manifest.yaml'),
    `schema_version: 1
commands:
  record: 'node "{test_file}" {test_name}'
entries:
${entries}`,
  );
  return dir;
}

function runEngine(cwd, ...args) {
  const result = spawnSync(process.execPath, [MANAGE, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result;
}

function runDiscover(cwd, testName) {
  return runEngine(cwd, 'discover', '--dir', 'gold_traces', '--test-file', 'recorder.mjs', '--test-name', testName);
}

// --- discover (end-to-end, subprocess against a fixture project) ----------

test('discover: reports the produced recording path and a manifest entry stub', (t) => {
  const dir = makeFixture(t);
  const result = runDiscover(dir, 'one_recording');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pytest\/one_recording\.appmap\.json/);
  assert.match(result.stdout, /appmap_path: pytest\/one_recording\.appmap\.json/);
  assert.match(result.stdout, /test_file: recorder\.mjs/);
  assert.match(result.stdout, /test_name: one_recording/);
  // Non-appmap files the recorder wrote alongside are not candidates.
  assert.doesNotMatch(result.stdout, /noise\.log/);
});

test('discover: an overwritten recording on a re-run is still reported', (t) => {
  const dir = makeFixture(t);
  assert.equal(runDiscover(dir, 'one_recording').status, 0);
  const rerun = runDiscover(dir, 'one_recording');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /appmap_path: pytest\/one_recording\.appmap\.json/);
});

test('discover: multiple recordings are all listed, with a pick-one note', (t) => {
  const dir = makeFixture(t);
  const result = runDiscover(dir, 'two_recordings');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pytest\/a\.appmap\.json/);
  assert.match(result.stdout, /requests\/b\.appmap\.json/);
  assert.match(result.stdout, /Multiple recordings/);
});

test('discover: pre-existing recordings from other tests are not reported', (t) => {
  const dir = makeFixture(t);
  assert.equal(runDiscover(dir, 'earlier_test').status, 0);
  const result = runDiscover(dir, 'one_recording');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /earlier_test/);
});

test('discover: a test that records nothing fails with a clear verdict', (t) => {
  const dir = makeFixture(t);
  const result = runDiscover(dir, 'no_recording');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wrote no AppMap/);
  assert.match(result.stderr, /not a gold-trace candidate/);
});

test('discover: --test-file and --test-name are required', (t) => {
  const dir = makeFixture(t);
  const result = runEngine(dir, 'discover', '--dir', 'gold_traces', '--test-file', 'recorder.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --test-file and --test-name/);
});

test('update --record: a wrong appmap_path fails, reporting what the run produced', (t) => {
  const dir = makeFixture(t, {
    entries: `  - feature: demo
    test_file: recorder.mjs
    test_name: one_recording
    appmap_path: pytest/wrong_guess.appmap.json
    summary: wrong path on purpose
`,
  });
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /one_recording: missing/);
  assert.match(result.stderr, /The record step produced: pytest\/one_recording\.appmap\.json/);
  assert.match(result.stderr, /discover/);
});

test('update --record: refuses to seed an empty recording', (t) => {
  const dir = makeFixture(t, {
    entries: `  - feature: demo
    test_file: recorder.mjs
    test_name: empty
    appmap_path: pytest/empty.appmap.json
    summary: empty on purpose
`,
  });
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains zero events/);
  assert.match(result.stderr, /contains no function, HTTP, or SQL calls/);
});

// --- suitability assessment ------------------------------------------------

test('assessAppMap: reports useful shape metrics', () => {
  const assessment = assessAppMap({
    classMap: [{ type: 'class', children: [
      { type: 'function', labels: ['security.authentication'] },
    ] }],
    events: [
      { event: 'call', defined_class: 'Auth', method_id: 'login', static: false, path: 'src/auth.js' },
      { event: 'call', http_server_request: { request_method: 'POST' } },
      { event: 'call', sql_query: { sql: 'select 1' } },
      ...Array.from({ length: 17 }, () => ({ event: 'return' })),
    ],
  }, {
    expect: ['Auth#login'],
    expect_labels: ['security.authentication'],
  }, 4096, ['src']);

  assert.equal(assessment.events, 20);
  assert.equal(assessment.calls, 3);
  assert.equal(assessment.http_requests, 1);
  assert.equal(assessment.sql_queries, 1);
  assert.deepEqual(assessment.labels, ['security.authentication']);
  assert.deepEqual(assessment.project_code_objects, ['Auth#login']);
  assert.deepEqual(assessment.errors, []);
});

test('assessAppMap: rejects empty traces and missing required coverage', () => {
  const empty = assessAppMap({ events: [] }, {}, 100);
  assert.match(empty.errors.join(' '), /zero events/);
  assert.match(empty.errors.join(' '), /no function/);

  const missing = assessAppMap({
    classMap: [],
    events: [{ event: 'call', defined_class: 'Auth', method_id: 'login', static: false }],
  }, {
    expect: ['Policy#check!'],
    expect_labels: ['security.authorization'],
  }, 100);
  assert.match(missing.errors.join(' '), /missing required code objects: Policy#check!/);
  assert.match(missing.errors.join(' '), /missing required labels: security.authorization/);
});

test('assessAppMap: requires manifest entries to declare expected coverage', () => {
  const assessment = assessAppMap({
    events: [{ event: 'call', defined_class: 'Auth', method_id: 'login', static: false }],
  }, { test_name: 'login works', require_expect: true }, 100);
  assert.match(assessment.errors.join(' '), /has no expect coverage declaration/);
});

test('assessAppMap: warns on large, repetitive traces', () => {
  const assessment = assessAppMap({
    events: Array.from({ length: 400 }, () => (
      { event: 'call', defined_class: 'Kernel', method_id: 'eval', static: false }
    )),
  }, {}, 600 * 1024);
  assert.match(assessment.warnings.join(' '), /is large/);
  assert.match(assessment.warnings.join(' '), /400x Kernel#eval/);
});

test('assessAppMap: path dot does not classify absolute dependencies as project code', () => {
  const assessment = assessAppMap({
    events: [
      { event: 'call', defined_class: 'App', method_id: 'run', path: 'src/app.js' },
      { event: 'call', defined_class: 'Gem', method_id: 'run', path: '/opt/gems/gem.rb' },
    ],
  }, {}, 100, ['.', '/repo']);
  assert.deepEqual(assessment.project_code_objects, ['App#run']);
});

// --- diagram digest (the bless gate) -------------------------------------

test('diagramDigest: identical root subtree digests hash equal', () => {
  const a = { rootActions: [{ subtreeDigest: 'x' }, { subtreeDigest: 'y' }] };
  const b = { rootActions: [{ subtreeDigest: 'x' }, { subtreeDigest: 'y' }] };
  assert.equal(diagramDigest(a), diagramDigest(b));
});

test('diagramDigest: a differing subtree digest hashes differently', () => {
  const a = { rootActions: [{ subtreeDigest: 'x' }] };
  const b = { rootActions: [{ subtreeDigest: 'z' }] };
  assert.notEqual(diagramDigest(a), diagramDigest(b));
});

// --- snapshot diff (what discover reports) --------------------------------

test('changedAppmaps: reports files new since the before-snapshot', () => {
  const before = new Map([['pytest/old.appmap.json', '1:10']]);
  const after = new Map([['pytest/old.appmap.json', '1:10'], ['pytest/new.appmap.json', '2:20']]);
  assert.deepEqual(changedAppmaps(before, after), ['pytest/new.appmap.json']);
});

test('changedAppmaps: an overwritten recording (changed signature) counts as produced', () => {
  const before = new Map([['pytest/t.appmap.json', '1:10']]);
  const after = new Map([['pytest/t.appmap.json', '5:12']]);
  assert.deepEqual(changedAppmaps(before, after), ['pytest/t.appmap.json']);
});

test('changedAppmaps: untouched files are not reported', () => {
  const same = new Map([['pytest/t.appmap.json', '1:10']]);
  assert.deepEqual(changedAppmaps(same, new Map(same)), []);
});

// --- YAML reader (config supports the `expand` list) ---------------------

test('parseYaml: reads a top-level block list (the expand option)', () => {
  const cfg = parseYaml('appmap_dir: tmp/appmap\nexpand:\n  - "package:a/b"\n  - "package:c/d"\n');
  assert.deepEqual(cfg.expand, ['package:a/b', 'package:c/d']);
});

test('parseYaml: reads nested expected code objects', () => {
  const cfg = parseYaml(`entries:
  - test_name: login
    expect:
      - "Auth#login"
      - Session.create
`);
  assert.deepEqual(cfg.entries[0].expect, ['Auth#login', 'Session.create']);
});

test('parseYaml: preserves a quoted list scalar containing colon-space', () => {
  const cfg = parseYaml(`allow_values:
  - "status: active"
`);
  assert.deepEqual(cfg.allow_values, ['status: active']);
});

test('manifest: rejects unsupported schema versions', (t) => {
  const dir = makeFixture(t);
  fs.writeFileSync(path.join(dir, 'gold_traces/manifest.yaml'), 'schema_version: two\nentries:\n');
  const invalid = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unsupported gold-traces schema_version/);

  fs.writeFileSync(path.join(dir, 'gold_traces/manifest.yaml'), 'schema_version: 3\nentries:\n');
  const future = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(future.status, 1);
  assert.match(future.stderr, /Unsupported gold-traces schema_version/);
});

test('manifest: schema version 1 remains compatible without expect', (t) => {
  const dir = makeFixture(t, {
    entries: `  - feature: legacy
    test_file: recorder.mjs
    test_name: legacy
    appmap_path: pytest/legacy.appmap.json
    summary: existing schema version 1 entry
`,
  });
  const baseline = path.join(dir, 'gold_traces/baseline/appmaps/pytest/legacy.appmap.json');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  fs.writeFileSync(baseline, JSON.stringify({
    events: [
      { event: 'call', defined_class: 'Legacy', method_id: 'run' },
      ...Array.from({ length: 9 }, () => ({ event: 'return' })),
    ],
  }));
  const result = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checked 1 baseline trace/);
});
