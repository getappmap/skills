// Tests for the gold-traces engine's pure logic. Zero-install: run with the
// built-in test runner, no dependencies:
//
//   node --test appmap-gold-traces/assets/manage.test.mjs
//
// These cover the classification surface (digest, diff-action collection, SQL
// fingerprinting, finding rules) — the parts that decide whether a trace change
// is noise or a flag. The CLI shell-outs (export/diff) are exercised by running
// `compare` against real AppMaps, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseYaml,
  normalizeSql,
  sameFingerprintKey,
  diagramDigest,
  collectDiffActions,
  classifyChanges,
} from './manage.mjs';

const NodeType = { Loop: 1, Function: 3, ServerRPC: 4, Query: 6 };
const DiffMode = { Insert: 1, Delete: 2, Change: 3 };

// --- SQL fingerprinting --------------------------------------------------

test('normalizeSql: a projection-only change keeps the same fingerprint', () => {
  const a = normalizeSql('SELECT id FROM games WHERE games.id = 1');
  const b = normalizeSql('SELECT id, join_code, is_private FROM games WHERE games.id = 1');
  assert.equal(sameFingerprintKey(a), sameFingerprintKey(b));
});

test('normalizeSql: a dropped WHERE predicate changes the fingerprint', () => {
  const guarded = normalizeSql('SELECT * FROM maps WHERE owner_id = 1 AND id = 2');
  const unguarded = normalizeSql('SELECT * FROM maps WHERE id = 2');
  assert.notEqual(sameFingerprintKey(guarded), sameFingerprintKey(unguarded));
});

test('normalizeSql: a newly-joined table changes the fingerprint', () => {
  const one = normalizeSql('SELECT * FROM players WHERE game_id = 1');
  const two = normalizeSql('SELECT * FROM players JOIN games WHERE games.id = 1');
  assert.notEqual(sameFingerprintKey(one), sameFingerprintKey(two));
});

test('normalizeSql: transaction/session noise is dropped', () => {
  for (const noise of ['BEGIN', 'COMMIT', 'SET search_path = x', 'SAVEPOINT a']) {
    assert.equal(normalizeSql(noise), null);
  }
});

test('normalizeSql: executemany "-- N times" prefix is stripped', () => {
  const fp = normalizeSql('-- 5 times\nINSERT INTO stars (id) VALUES (1)');
  assert.equal(fp.op, 'INSERT');
  assert.deepEqual(fp.tables, ['stars']);
});

// --- diagram digest ------------------------------------------------------

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

// --- diff-action collection ----------------------------------------------

test('collectDiffActions: collects only nodes with a diffMode, skips loops', () => {
  const diagram = {
    rootActions: [
      {
        nodeType: NodeType.Function,
        name: 'unchanged_parent',
        children: [
          { nodeType: NodeType.Query, diffMode: DiffMode.Insert, query: 'SELECT 1', children: [] },
          { nodeType: NodeType.Loop, diffMode: DiffMode.Insert, children: [] },
        ],
      },
    ],
  };
  const actions = collectDiffActions(diagram);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].nodeType, NodeType.Query);
});

test('collectDiffActions: a changed child inherits its labeled ancestor security context', () => {
  const diagram = {
    rootActions: [
      {
        nodeType: NodeType.Function,
        name: '_claim_player',
        labels: ['security.authorization'],
        // The labeled function itself is unchanged; only its child query changed.
        children: [
          { nodeType: NodeType.Query, diffMode: DiffMode.Insert, query: 'SELECT * FROM games WHERE id = 1', labels: [], children: [] },
        ],
      },
    ],
  };
  const [changed] = collectDiffActions(diagram);
  assert.equal(changed.securityContext, true);
});

// --- classification ------------------------------------------------------

function changeAction(overrides) {
  return {
    diffMode: DiffMode.Insert,
    nodeType: NodeType.Function,
    name: 'f',
    formerName: null,
    formerResult: null,
    id: null,
    labels: [],
    securityContext: false,
    query: null,
    raisesException: false,
    depth: 0,
    ...overrides,
  };
}

const noActors = { added: [], removed: [] };

test('classifyChanges: security context yields a high security-review finding', () => {
  const findings = classifyChanges(
    { feature: 'lobby' },
    [changeAction({ securityContext: true })],
    noActors,
  );
  const sec = findings.find((f) => f.category === 'security-review');
  assert.ok(sec);
  assert.equal(sec.severity, 'high');
});

test('classifyChanges: a removed SELECT is a high sql-query-removed finding', () => {
  const findings = classifyChanges(
    { feature: 'graphql' },
    [changeAction({ diffMode: DiffMode.Delete, nodeType: NodeType.Query, query: 'SELECT * FROM maps WHERE owner_id = 1' })],
    noActors,
  );
  const f = findings.find((x) => x.category === 'sql-query-removed');
  assert.ok(f);
  assert.equal(f.severity, 'high');
});

test('classifyChanges: a new write is a medium sql-write-added finding', () => {
  const findings = classifyChanges(
    { feature: 'lobby' },
    [changeAction({ diffMode: DiffMode.Insert, nodeType: NodeType.Query, query: 'INSERT INTO audit_log (id) VALUES (1)' })],
    noActors,
  );
  assert.ok(findings.some((f) => f.category === 'sql-write-added' && f.severity === 'medium'));
});

test('classifyChanges: a projection-only query change is NOT flagged as a predicate change', () => {
  const findings = classifyChanges(
    { feature: 'lobby' },
    [
      changeAction({
        diffMode: DiffMode.Change,
        nodeType: NodeType.Query,
        formerName: 'SELECT id FROM games WHERE id = 1',
        query: 'SELECT id, join_code FROM games WHERE id = 1',
      }),
    ],
    noActors,
  );
  assert.equal(findings.find((f) => f.category === 'sql-query-changed'), undefined);
});

test('classifyChanges: a participating-package change is a medium side-effects finding', () => {
  const findings = classifyChanges({ feature: 'engine' }, [], { added: ['package:lib/billing'], removed: [] });
  assert.ok(findings.some((f) => f.category === 'side-effects' && f.severity === 'medium'));
});

test('classifyChanges: no changes yields no findings', () => {
  assert.deepEqual(classifyChanges({ feature: 'engine' }, [], noActors), []);
});

// --- YAML reader (config supports the new `expand` list) ------------------

test('parseYaml: reads a top-level block list (the expand option)', () => {
  const cfg = parseYaml('appmap_dir: tmp/appmap\nexpand:\n  - "package:a/b"\n  - "package:c/d"\n');
  assert.deepEqual(cfg.expand, ['package:a/b', 'package:c/d']);
});
