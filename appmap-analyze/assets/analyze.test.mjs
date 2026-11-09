// Tests for the analysis helper. Zero-install: run with the built-in test runner:
//
//   node --test appmap-analyze/assets/analyze.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildForest, renderTree, countDiff, changedFunctions, definitionAbove } from './analyze.mjs';

// A recording built from a list of nested calls: [name, children, extra].
function recording(calls) {
  const events = [];
  let id = 0;
  const emit = ([name, children = [], extra = {}], thread = 1) => {
    const callId = (id += 1);
    events.push({ id: callId, event: 'call', thread_id: thread, defined_class: 'pkg.C', method_id: name, path: 'pkg/c.py', ...extra.call });
    for (const child of children) emit(child, thread);
    events.push({ id: (id += 1), event: 'return', thread_id: thread, parent_id: callId, ...extra.ret });
  };
  calls.forEach((c) => emit(c));
  return { events };
}

test('tree collapses a repeating run of siblings into one block', () => {
  const loop = [];
  for (let i = 0; i < 50; i += 1) loop.push(['read'], ['decode']);
  const appmap = recording([['send', [['write'], ...loop, ['raise']], { ret: { exceptions: [{ class: 'x.Timeout', message: 'timed out' }] } }]]);
  const lines = renderTree(buildForest(appmap));
  assert.deepEqual(lines, [
    'C#send  !! Timeout: timed out   <thread 1>',
    '  C#write',
    '  50x [',
    '    C#read',
    '    C#decode',
    '  ]',
    '  C#raise',
  ]);
});

test('tree collapses identical single siblings and honors --focus and --hide', () => {
  const appmap = recording([['outer', [['noise'], ['inner', [['leaf'], ['leaf']]]]]]);
  assert.deepEqual(renderTree(buildForest(appmap), { focus: 'inner', hide: ['noise'] }), [
    'C#inner   <thread 1>',
    '  2x C#leaf',
  ]);
});

test('countdiff sums per-function deltas over matching recordings and reports unmatched ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-'));
  const write = (side, name, calls) => {
    fs.mkdirSync(path.join(dir, side), { recursive: true });
    fs.writeFileSync(path.join(dir, side, `${name}.appmap.json`), JSON.stringify(recording(calls)));
  };
  write('base', 't1', [['a', [['b']]]]);
  write('head', 't1', [['a', [['b'], ['b'], ['c']]]]);
  write('base', 't2', [['a']]);
  write('head', 't2', [['a']]);
  write('base', 'only_base', [['a']]);
  const { rows, unmatched } = countDiff(path.join(dir, 'base'), path.join(dir, 'head'));
  assert.deepEqual(rows.map((r) => [r.key, r.delta, r.tests]), [
    ['pkg.C#b', 1, ['t1']],
    ['pkg.C#c', 1, ['t1']],
  ]);
  assert.deepEqual(unmatched, { base: ['only_base.appmap.json'], head: [] });
});

test('changedFunctions maps diff hunks to the enclosing function, per language', () => {
  const sources = {
    'pkg/c.py': 'class C:\n    def a(self):\n        return 1\n\n    def b(self):\n        raise ValueError(x)\n',
    'web/x.js': 'export function go() {\n  return 1;\n}\nclass K {\n  async run(a) {\n    return a;\n  }\n}\n',
  };
  const diff = [
    '+++ b/pkg/c.py', '@@ -6 +6 @@', '+++ b/web/x.js', '@@ -2 +2 @@', '@@ -6,0 +6,1 @@', '+++ b/README.md', '@@ -1 +1 @@',
  ].join('\n');
  const found = changedFunctions(diff, (f) => sources[f] ?? 'text\n');
  assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.name}`), ['pkg/c.py:5 b', 'web/x.js:1 go', 'web/x.js:5 run']);
  assert.equal(definitionAbove(['raise ValueError(x)'], 0, 'a.py'), null);
});
