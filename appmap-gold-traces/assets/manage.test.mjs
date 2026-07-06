// Tests for the gold-traces maintenance engine's pure logic. Zero-install: run with
// the built-in test runner, no dependencies:
//
//   node --test appmap-gold-traces/assets/manage.test.mjs
//
// The engine's only non-trivial logic is the digest (which gates the bless) and the
// bundled YAML reader. Recording and copying are exercised by running `update`
// against a real project, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml, diagramDigest } from './manage.mjs';

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

// --- YAML reader (config supports the `expand` list) ---------------------

test('parseYaml: reads a top-level block list (the expand option)', () => {
  const cfg = parseYaml('appmap_dir: tmp/appmap\nexpand:\n  - "package:a/b"\n  - "package:c/d"\n');
  assert.deepEqual(cfg.expand, ['package:a/b', 'package:c/d']);
});
