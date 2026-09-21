// Tests for the review helper. Zero-install: run with the built-in test runner:
//
//   node --test appmap-review/assets/review.test.mjs
//
// Each test builds a throwaway git repo whose project sits in server/, as in a
// monorepo, and runs the helper as a subprocess. A fake AppMap CLI stands in for
// archive, restore, and compare: archive packs the trace contents it finds, restore
// unpacks them, and compare writes a change report from the two sides. That
// proves which traces reached each side, and with what contents, without the real
// CLI. The real CLI is exercised against a real project, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeDiff, compareVersions } from './review.mjs';

const REVIEW = fileURLToPath(new URL('./review.mjs', import.meta.url));

// The diff diagram the fake compare writes for every changed trace: one block
// moved to another caller (with a label) and one added query.
const DIFF_DIAGRAM = {
  actors: [{ id: 'a', name: 'Orders' }, { id: 'b', name: 'Auth' }],
  rootActions: [{
    nodeType: 3, name: 'create', callee: 'a', children: [
      { nodeType: 3, name: 'check', callee: 'b', diffMode: 4, movedFrom: { name: 'Orders#validate', actorId: 'a' }, labels: ['security.authorization'], children: [] },
      { nodeType: 6, query: 'SELECT 1', callee: 'a', diffMode: 1, children: [] },
    ],
  }],
};

const FAKE_CLI = `import fs from 'node:fs';
import path from 'node:path';
const [command, ...rest] = process.argv.slice(2);
const option = (name) => rest[rest.indexOf(name) + 1];
if (command === '--version') { console.log(process.env.FAKE_APPMAP_VERSION ?? '3.204.0'); process.exit(0); }
if (!fs.existsSync('appmap.yml')) { console.error('no appmap.yml in ' + process.cwd()); process.exit(3); }
function walk(dir, prefix = '') {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + dirent.name;
    if (dirent.isDirectory()) Object.assign(out, walk(path.join(dir, dirent.name), rel + '/'));
    else if (rel.endsWith('.appmap.json')) out[rel.slice(0, -'.appmap.json'.length)] = fs.readFileSync(path.join(dir, dirent.name), 'utf8');
  }
  return out;
}
if (command === 'archive') {
  // Like the real CLI, archive fails when appmap_dir is missing, even with nothing to archive.
  if (!fs.existsSync('tmp/appmap')) { console.error('AppMap directory tmp/appmap does not exist'); process.exit(4); }
  fs.mkdirSync('.appmap/archive/full', { recursive: true });
  fs.writeFileSync('.appmap/archive/full/' + option('--revision') + '.tar', JSON.stringify(walk('tmp/appmap')));
} else if (command === 'restore') {
  const out = option('--output-dir');
  if (fs.existsSync(out)) { console.error('exists: ' + out); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync('.appmap/archive/full/' + option('--revision') + '.tar', path.join(out, 'traces.json'));
  // Like the real archive, each trace's index sits beside it: <trace>/sequence.json.
  const traces = JSON.parse(fs.readFileSync(path.join(out, 'traces.json'), 'utf8'));
  for (const [name, content] of Object.entries(traces)) {
    fs.mkdirSync(path.join(out, name), { recursive: true });
    fs.writeFileSync(path.join(out, name, 'sequence.json'), content);
  }
} else if (command === 'compare') {
  const out = option('--output-dir');
  const read = (side) => JSON.parse(fs.readFileSync(path.join(out, side, 'traces.json'), 'utf8'));
  const base = read('base');
  const head = read('head');
  const changed = Object.keys(head).filter((name) => name in base && base[name] !== head[name]).sort();
  for (const name of changed) {
    const file = path.join(out, 'diff', name + '.diff.sequence.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ${JSON.stringify(JSON.stringify(DIFF_DIAGRAM))});
  }
  fs.writeFileSync(path.join(out, 'change-report.json'), JSON.stringify({
    testFailures: [],
    newAppMaps: Object.keys(head).filter((name) => !(name in base)).sort(),
    removedAppMaps: Object.keys(base).filter((name) => !(name in head)).sort(),
    changedAppMaps: changed.map((name) => ({ appmap: name, sequenceDiagramDiff: name + '.diff.sequence.json' })),
    sqlDiff: { newQueries: ['select 1'], removedQueries: [], newTables: ['coupons'], removedTables: [] },
    apiDiff: { breakingDifferencesFound: false, nonBreakingDifferences: [], unclassifiedDifferences: [] },
    findingDiff: { new: [], resolved: [] },
  }));
} else if (command === 'sequence-diagram-diff') {
  // Like the real CLI: both inputs must exist, the output is diff.txt under --output-dir,
  // and the text has no trailing newline.
  for (const file of rest.slice(0, 2)) if (!fs.existsSync(file)) { console.error(file + ' does not exist'); process.exit(5); }
  fs.mkdirSync(option('--output-dir'), { recursive: true });
  fs.writeFileSync(path.join(option('--output-dir'), 'diff.txt'), 'moved function call \`Auth#check\` from \`Orders#validate\`\\n  added SQL \`SELECT 1\`');
} else {
  process.exit(1);
}
`;

const ENTRIES = [
  ['alpha', 'pytest/alpha.appmap.json'],
  ['beta', 'x/same.appmap.json'],
  ['gamma', 'y/same.appmap.json'],
];

// base commit: alpha v1, x/same v1.  head commit: alpha v2, x/same v1, y/same v1.
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appmap-review-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const server = path.join(repo, 'server');
  const cli = path.join(root, 'fake-cli.mjs');
  fs.mkdirSync(path.join(server, 'gold_traces', 'baseline', 'appmaps'), { recursive: true });
  fs.writeFileSync(cli, FAKE_CLI);
  fs.writeFileSync(path.join(server, 'appmap.yml'), 'name: fixture\nappmap_dir: tmp/appmap\n');
  fs.writeFileSync(path.join(server, 'gold_traces', 'manifest.yaml'), `schema_version: 2
commands:
  framework: pytest
  appmap_cli: ${JSON.stringify(`${process.execPath} ${cli}`)}
entries:
${ENTRIES.map(([name, appmapPath]) => `  - feature: demo
    test_file: tests/test_demo.py
    test_name: ${name}
    appmap_path: ${appmapPath}
    summary: ${name}
`).join('')}`);

  const gitRun = (...args) => {
    const result = spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  gitRun('init', '-q');
  writeTrace(server, 'pytest/alpha.appmap.json', 'alpha v1');
  writeTrace(server, 'x/same.appmap.json', 'same v1');
  gitRun('add', '.');
  gitRun('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  gitRun('tag', 'base');
  writeTrace(server, 'pytest/alpha.appmap.json', 'alpha v2');
  writeTrace(server, 'y/same.appmap.json', 'same v1');
  gitRun('add', '.');
  gitRun('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'head');
  return { root, server, workspace: path.join(root, 'workspace') };
}

function writeTrace(dir, relative, content, under = path.join('gold_traces', 'baseline', 'appmaps')) {
  const file = path.join(dir, under, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ content }));
}

function runReview(cwd, ...args) {
  const env = typeof args[0] === 'object' ? args.shift() : {};
  const result = spawnSync(process.execPath, [REVIEW, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.error, undefined);
  return result;
}

test('compare: two revisions from git, head defaulting to HEAD', (t) => {
  const { server, workspace } = makeRepo(t);
  const result = runReview(server, 'compare', '--base', 'base', '--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Base: base = \w+ base \(2 gold traces\)/);
  assert.match(result.stdout, /Head: HEAD = \w+ head \(3 gold traces\)/);
  assert.match(result.stdout, /Traces: 1 changed, 1 new, 0 removed\./);
  // Per changed trace: the diff measured, each moved block with where it went,
  // the labels on the changed nodes, and the same diff rendered as text.
  assert.match(result.stdout, new RegExp([
    'changed  pytest/alpha',
    ' {11}2 of 3 nodes: 1 added, 0 removed, 0 changed, 1 moved  \\(diff/pytest/alpha\\.diff\\.sequence\\.json\\)',
    ' {11}moved:   Auth#check from Orders#validate to Orders#create',
    ' {11}labels:  security\\.authorization',
    ' {11}text:    text/pytest/alpha\\.diff\\.txt',
  ].join('\n')));
  const text = path.join(workspace, 'out', 'report', 'text', 'pytest', 'alpha.diff.txt');
  assert.equal(fs.readFileSync(text, 'utf8'), 'moved function call `Auth#check` from `Orders#validate`\n  added SQL `SELECT 1`\n');
  assert.ok(!fs.existsSync(path.join(workspace, 'out', 'report', 'text', 'pytest', 'alpha')));
  assert.match(result.stdout, /Diff text:     \S+[\\/]text\n/);
  assert.doesNotMatch(result.stdout, /Moved blocks:/);
  assert.doesNotMatch(result.stderr, /note: AppMap CLI/);
  // Two traces share a basename; both keep their own directory.
  assert.match(result.stdout, /new      y\/same/);
  assert.match(result.stdout, /SQL: 1 new queries, 0 removed; tables \+coupons\./);
  assert.match(result.stdout, /Source diff:   git diff \w+\.\.\w+/);
  // The command line is echoed as typed, and the directory it ran in.
  assert.match(result.stdout, /Command:       node \S+review\.mjs compare --base base --workspace \S+\n/);
  assert.match(result.stdout, /Run in:        \S+[\\/]repo[\\/]server\n/);
  const report = path.join(workspace, 'out', 'report', 'change-report.json');
  assert.ok(fs.existsSync(report));
  assert.ok(result.stdout.includes(report));
});

test('compare: an older CLI is told about, since it shows a move as removed plus added', (t) => {
  const { server, workspace } = makeRepo(t);
  const result = runReview(server, { FAKE_APPMAP_VERSION: '3.203.1' }, 'compare', '--base', 'base', '--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /note: AppMap CLI 3\.203\.1 shows a block that moved .* 3\.204\.0 or later reports it as a move\./);
  assert.match(result.stdout, /Moved blocks: shown as removed plus added \(AppMap CLI 3\.203\.1; 3\.204\.0 or later reports a move\)\./);
});

test('summarizeDiff: counts by mode, a move with both callers, a reorder, a move to the top level, labels', () => {
  const summary = summarizeDiff(DIFF_DIAGRAM);
  assert.deepEqual({ ...summary, labels: [...summary.labels] }, {
    total: 3, diff: 2, added: 1, removed: 0, changed: 0,
    moved: [{ name: 'Auth#check', from: 'Orders#validate', to: 'Orders#create', reordered: false }],
    labels: ['security.authorization'],
  });
  // A block whose old and new parent are the same node was reordered among its
  // siblings. The parents are compared by actor as well as name, so a same-named
  // method on another class is a move. Static calls use a dot.
  const reorder = summarizeDiff({
    actors: [{ id: 'a', name: 'Orders' }, { id: 'b', name: 'Legacy' }],
    rootActions: [
      { nodeType: 3, name: 'create', callee: 'a', children: [
        { nodeType: 3, name: 'total', callee: 'a', static: true, diffMode: 4, movedFrom: { name: 'Orders#create', actorId: 'a' }, children: [] },
        { nodeType: 3, name: 'audit', callee: 'a', diffMode: 4, movedFrom: { name: 'Orders#create', actorId: 'b' }, children: [] },
      ] },
      { nodeType: 4, route: 'GET /health', callee: 'a', diffMode: 4, movedFrom: { name: 'Orders#create', actorId: 'a' }, children: [
        { nodeType: 6, query: 'SELECT 2', callee: 'a', diffMode: 3, children: [] },
      ] },
    ],
  });
  assert.deepEqual(reorder.moved, [
    { name: 'Orders.total', from: 'Orders#create', to: 'Orders#create', reordered: true },
    { name: 'Orders#audit', from: 'Orders#create', to: 'Orders#create', reordered: false },
    { name: 'GET /health', from: 'Orders#create', to: 'the top level', reordered: false },
  ]);
  assert.deepEqual([reorder.total, reorder.diff, reorder.changed], [5, 4, 1]);
});

test('compareVersions', () => {
  assert.equal(compareVersions('3.203.1', '3.204.0'), -1);
  assert.equal(compareVersions('3.204.0', '3.204.0'), 0);
  assert.equal(compareVersions('4.0.0', '3.204.0'), 1);
  assert.equal(compareVersions('3.204', '3.204.0'), 0);
});

test('compare: an explicit --head', (t) => {
  const { server, workspace } = makeRepo(t);
  const result = runReview(server, 'compare', '--base', 'base', '--head', 'base', '--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Traces: 0 changed, 0 new, 0 removed\./);
});

test('compare --uncommitted: head is the working tree baselines', (t) => {
  const { server, workspace } = makeRepo(t);
  writeTrace(server, 'x/same.appmap.json', 'same v2, blessed but not committed');
  const result = runReview(server, 'compare', '--base', 'base', '--uncommitted', '--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Head: working tree, baselines under/);
  assert.match(result.stdout, /Traces: 2 changed, 1 new, 0 removed\./);
  assert.match(result.stdout, /changed  x\/same/);
  assert.match(result.stdout, /Source diff:   git diff \w+\n/);
});

test('compare --fresh: head is the recordings for the manifest entries', (t) => {
  const { server, workspace } = makeRepo(t);
  const recordings = path.join('tmp', 'appmap');
  writeTrace(server, 'pytest/alpha.appmap.json', 'alpha v1', recordings);
  writeTrace(server, 'x/same.appmap.json', 'same v3', recordings);
  const missing = runReview(server, 'compare', '--base', 'base', '--fresh', '--workspace', workspace);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--fresh needs a recording for every manifest entry/);
  assert.match(missing.stderr, /gamma: /);
  assert.match(missing.stderr, /check --record/);

  writeTrace(server, 'y/same.appmap.json', 'same v1', recordings);
  const result = runReview(server, 'compare', '--base', 'base', '--fresh', '--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Traces: 1 changed, 1 new, 0 removed\./);
  assert.match(result.stdout, /changed  x\/same/);
});

test('compare: a base with no gold traces notes that every trace is new', (t) => {
  const { server, workspace } = makeRepo(t);
  const result = runReview(server, 'compare', '--base', 'base', '--head', 'HEAD', '--dir', 'gold_traces', '--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /has no gold traces/);

  fs.renameSync(path.join(server, 'gold_traces'), path.join(server, 'other_traces'));
  const empty = runReview(server, 'compare', '--base', 'base', '--uncommitted', '--dir', 'other_traces', '--workspace', workspace);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stderr, /base has no gold traces/);
  assert.match(empty.stdout, /Traces: 0 changed, 3 new, 0 removed\./);
});

test('compare: rejects a bad revision, conflicting heads, and a missing --base', (t) => {
  const { server, workspace } = makeRepo(t);
  const bad = runReview(server, 'compare', '--base', 'no-such-ref', '--workspace', workspace);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Cannot resolve 'no-such-ref' to a commit/);

  const both = runReview(server, 'compare', '--base', 'base', '--head', 'HEAD', '--fresh');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /at most one of --head, --fresh, and --uncommitted/);

  const noBase = runReview(server, 'compare');
  assert.equal(noBase.status, 1);
  assert.match(noBase.stderr, /requires --base/);
});

test('compare: refuses to clear a workspace it did not make, and reuses one it did', (t) => {
  const { root, server, workspace } = makeRepo(t);
  const foreign = path.join(root, 'precious');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'keep me');
  const refused = runReview(server, 'compare', '--base', 'base', '--workspace', foreign);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to clear/);
  assert.ok(fs.existsSync(path.join(foreign, 'notes.txt')));

  assert.equal(runReview(server, 'compare', '--base', 'base', '--workspace', workspace).status, 0);
  const again = runReview(server, 'compare', '--base', 'base', '--workspace', workspace);
  assert.equal(again.status, 0, again.stderr);
});

// Ad-hoc mode: two recordings named on the command line, no gold traces involved.
function writeRecording(root, name, content) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ content }));
  return file;
}

test('compare ad-hoc: two files compare as one trace, whatever their names', (t) => {
  const { root, server, workspace } = makeRepo(t);
  const cli = `${process.execPath} ${path.join(root, 'fake-cli.mjs')}`;
  fs.rmSync(path.join(server, 'gold_traces'), { recursive: true }); // not needed in this mode
  const before = writeRecording(root, 'runs/2026-09-16T10-00-00.appmap.json', 'orders v1');
  const after = writeRecording(root, 'runs/2026-09-16T11-30-00.appmap.json', 'orders v2');
  const result = runReview(server, 'compare', '--base-appmap', before, '--head-appmap', after, '--appmap-cli', cli, '--workspace', workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Base: recording .*2026-09-16T10-00-00\.appmap\.json\n/);
  assert.match(result.stdout, /Head: recording .*2026-09-16T11-30-00\.appmap\.json\n/);
  assert.match(result.stdout, /Traces: 1 changed, 0 new, 0 removed\./);
  assert.match(result.stdout, /changed  adhoc\/recording\n {11}2 of 3 nodes: .*  \(diff\/adhoc\/recording\.diff\.sequence\.json\)\n/);
  assert.match(result.stdout, / {11}text:    text\/adhoc\/recording\.diff\.txt\n/);
  assert.match(result.stdout, /Source diff:   not named; pass --base REV/);

  // A name, and revisions for the source diff. A shared basename is the default name.
  const named = runReview(server, 'compare', '--base-appmap', before, '--head-appmap', after, '--name', 'checkout',
    '--base', 'base', '--head', 'HEAD', '--appmap-cli', cli, '--workspace', workspace);
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /Base: base = \w+ base, recording /);
  assert.match(named.stdout, /changed  adhoc\/checkout/);
  assert.match(named.stdout, /Source diff:   git diff \w+\.\.\w+/);
  const same1 = writeRecording(root, 'a/login.appmap.json', 'login v1');
  const same2 = writeRecording(root, 'b/login.appmap.json', 'login v1');
  const shared = runReview(server, 'compare', '--base-appmap', same1, '--head-appmap', same2, '--appmap-cli', cli, '--workspace', workspace);
  assert.equal(shared.status, 0, shared.stderr);
  assert.match(shared.stdout, /Traces: 0 changed, 0 new, 0 removed\./);
  assert.ok(fs.existsSync(path.join(workspace, 'head', 'tmp', 'appmap', 'adhoc', 'login.appmap.json')));
});

test('compare ad-hoc: rejects one side only, a mix with --fresh, and a missing file', (t) => {
  const { root, server, workspace } = makeRepo(t);
  const cli = `${process.execPath} ${path.join(root, 'fake-cli.mjs')}`;
  const one = writeRecording(root, 'one.appmap.json', 'v1');
  const oneSided = runReview(server, 'compare', '--base-appmap', one, '--appmap-cli', cli, '--workspace', workspace);
  assert.equal(oneSided.status, 1);
  assert.match(oneSided.stderr, /needs both sides/);
  const mixed = runReview(server, 'compare', '--base-appmap', one, '--head-appmap', one, '--fresh', '--appmap-cli', cli, '--workspace', workspace);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /cannot be combined with --fresh/);
  const missing = runReview(server, 'compare', '--base-appmap', one, '--head-appmap', path.join(root, 'nope.appmap.json'), '--appmap-cli', cli, '--workspace', workspace);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Recording not found: .*nope\.appmap\.json/);
});
