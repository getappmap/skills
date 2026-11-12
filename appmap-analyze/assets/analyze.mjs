#!/usr/bin/env node
// Helpers for an AppMap runtime analysis: reading recordings the way a
// reviewer needs when there is no committed baseline to diff against.
//
//   node analyze.mjs tree FILE [--depth N] [--params] [--hide a,b] [--focus text]
//   node analyze.mjs countdiff BASE_DIR HEAD_DIR [--limit N]
//   node analyze.mjs coverage --base REV [--head REV] [--appmap-dir DIR] [--path PREFIX]
//   node analyze.mjs noise [DIR|FILE...] [--own a,b] [--max-kb N] [--max-calls N] [--min-own PCT]
//
// tree       One recording as a compact call tree, one line per call, with
//            repeated siblings collapsed ("4309x [ ... ]"). A run of the same
//            few calls repeated many times with no I/O under them is how a
//            spin loop looks; `appmap query tree` prints every repetition.
// countdiff  Two directories of recordings of the same tests (one per
//            revision): per function, the change in call count, summed over the
//            tests whose count changed, plus exceptions and HTTP calls. Finds
//            drift that a structural diff renders at package granularity.
// coverage   Which functions a source diff touches, and how many times the
//            recordings under --appmap-dir called each one. A function the diff
//            changed that no recording runs is a gap to close with a test.
// noise      The noise check to run before any analysis: size per recording,
//            the share of calls per package, and the functions called most
//            often in one recording. Exits 2 when a recording is over the size
//            budget or, with --own, when too few calls are in the project's own
//            code. Defaults to the appmap_dir from appmap.yml.
//
// Zero-install: Node 18+ and git only.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Reading recordings
// ---------------------------------------------------------------------------

export function readAppmap(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function functionId(event) {
  const cls = event.defined_class ?? '?';
  return `${cls}${event.static ? '.' : '#'}${event.method_id}`;
}

// The call events as a forest, one tree per thread's top-level calls. Each node
// is { call, ret, children }. Returns pair with calls by parent_id; the nesting
// comes from a per-thread stack, which is how the agents emit events.
export function buildForest(appmap) {
  const roots = [];
  const stacks = new Map();
  const byId = new Map();
  for (const event of appmap.events ?? []) {
    const thread = event.thread_id ?? 0;
    if (!stacks.has(thread)) stacks.set(thread, []);
    const stack = stacks.get(thread);
    if (event.event === 'call') {
      const node = { call: event, ret: null, children: [] };
      byId.set(event.id, node);
      (stack.length ? stack[stack.length - 1].children : roots).push(node);
      stack.push(node);
    } else if (event.event === 'return') {
      const node = byId.get(event.parent_id);
      if (node) node.ret = event;
      // Pop up to and including the matching call; tolerate missing returns.
      while (stack.length) {
        const top = stack.pop();
        if (top.call.id === event.parent_id) break;
      }
    }
  }
  return roots;
}

function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function label(node, { params = false } = {}) {
  const { call, ret } = node;
  let text;
  if (call.http_client_request) {
    const r = call.http_client_request;
    const status = ret?.http_client_response?.status_code ?? ret?.http_client_response?.status;
    text = `HTTP ${r.request_method} ${r.url}${status ? ` -> ${status}` : ''}`;
  } else if (call.http_server_request) {
    const r = call.http_server_request;
    text = `SERVE ${r.request_method} ${r.normalized_path_info ?? r.path_info}`;
  } else if (call.sql_query) {
    text = `SQL ${clip(call.sql_query.sql, 80)}`;
  } else {
    const cls = String(call.defined_class ?? '?').split('.').pop();
    text = `${cls}${call.static ? '.' : '#'}${call.method_id}`;
    if (params && call.parameters?.length) {
      const shown = call.parameters.filter((p) => p.name !== 'self').map((p) => `${p.name}=${clip(p.value, 40)}`);
      text += `(${shown.join(', ')})`;
    }
  }
  const exception = ret?.exceptions?.[0];
  if (exception) {
    text += `  !! ${String(exception.class).split('.').pop()}: ${clip(exception.message, 70)}`;
  } else if (params && ret?.return_value) {
    text += ` -> ${clip(ret.return_value.value, 40)}`;
  }
  if (ret?.elapsed > 0.5) text += `  [${ret.elapsed.toFixed(2)}s]`;
  return text;
}

// A node's shape: its label and its children's shapes. Equal shapes collapse.
function shape(node, options) {
  return `${label(node, options)}{${node.children.map((c) => shape(c, options)).join(',')}}`;
}

export function renderTree(roots, { depth = 6, params = false, hide = [], focus = null } = {}) {
  const lines = [];
  const options = { params };
  const hidden = (node) => hide.some((h) => h && label(node, options).includes(h));

  const show = (nodes, level, indent) => {
    if (level > depth) return;
    const shapes = nodes.map((n) => shape(n, options));
    let i = 0;
    while (i < nodes.length) {
      // A run of k siblings repeated three or more times prints once.
      let collapsed = false;
      for (const k of [1, 2, 3, 4]) {
        if (i + k > nodes.length) break;
        let reps = 1;
        while (i + (reps + 1) * k <= nodes.length
          && shapes.slice(i + reps * k, i + (reps + 1) * k).join('\n') === shapes.slice(i, i + k).join('\n')) reps += 1;
        if ((k === 1 && reps >= 2) || reps >= 3) {
          const block = nodes.slice(i, i + k).filter((n) => !hidden(n));
          if (k === 1) {
            if (block.length) {
              lines.push(`${'  '.repeat(indent)}${reps}x ${label(block[0], options)}`);
              show(block[0].children, level + 1, indent + 1);
            }
          } else if (block.length) {
            lines.push(`${'  '.repeat(indent)}${reps}x [`);
            for (const n of block) lines.push(`${'  '.repeat(indent + 1)}${label(n, options)}`);
            lines.push(`${'  '.repeat(indent)}]`);
          }
          i += reps * k;
          collapsed = true;
          break;
        }
      }
      if (collapsed) continue;
      const node = nodes[i];
      if (!hidden(node)) {
        const thread = indent === 0 && node.call.thread_id !== undefined ? `   <thread ${node.call.thread_id}>` : '';
        lines.push(`${'  '.repeat(indent)}${label(node, options)}${thread}`);
        show(node.children, level + 1, indent + 1);
      }
      i += 1;
    }
  };

  if (focus) {
    const matches = [];
    const walk = (node) => {
      if (label(node, options).includes(focus)) matches.push(node);
      else node.children.forEach(walk);
    };
    roots.forEach(walk);
    show(matches, 1, 0);
  } else {
    show(roots, 1, 0);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// countdiff
// ---------------------------------------------------------------------------

export function countEvents(appmap) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const event of appmap.events ?? []) {
    if (event.event === 'call') {
      if (event.method_id !== undefined) bump(functionId(event));
      else if (event.http_client_request) {
        const r = event.http_client_request;
        // The port changes run to run for servers on port 0; keep the path.
        const url = String(r.url).replace(/^(\w+:\/\/[^/:]+):\d+/, '$1');
        bump(`HTTP ${r.request_method} ${url}`);
      } else if (event.sql_query) bump(`SQL ${event.sql_query.sql}`);
    }
    for (const exception of event.exceptions ?? []) bump(`EXCEPTION ${exception.class}`);
  }
  return counts;
}

function listAppmaps(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.appmap.json')) out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

export function countDiff(baseDir, headDir) {
  const base = new Set(listAppmaps(baseDir));
  const head = listAppmaps(headDir);
  const delta = new Map();
  const tests = new Map();
  const unmatched = { base: [...base].filter((f) => !head.includes(f)), head: head.filter((f) => !base.has(f)) };
  for (const file of head) {
    if (!base.has(file)) continue;
    const b = countEvents(readAppmap(path.join(baseDir, file)));
    const h = countEvents(readAppmap(path.join(headDir, file)));
    for (const key of new Set([...b.keys(), ...h.keys()])) {
      const d = (h.get(key) ?? 0) - (b.get(key) ?? 0);
      if (d === 0) continue;
      delta.set(key, (delta.get(key) ?? 0) + d);
      if (!tests.has(key)) tests.set(key, new Set());
      tests.get(key).add(file.replace(/\.appmap\.json$/, ''));
    }
  }
  const rows = [...delta.entries()]
    .map(([key, d]) => ({ key, delta: d, tests: [...tests.get(key)] }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || y.tests.length - x.tests.length);
  return { rows, unmatched };
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

// The line that opens a function or method, by file extension. Heuristic: it
// reads the source text, not a syntax tree, so treat a miss as "check by hand".
const DEF = /^\s*(?:async\s+)?def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/;
const JS_FUNCTION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const JS_METHOD = /^\s*(?:(?:static|async|get|set|public|private|protected|readonly|override)\s+)*\*?([A-Za-z_$#][\w$]*)\s*\([^;]*\)\s*(?::\s*[^={]+)?\{\s*$/;
const JS_ARROW = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const JAVA_METHOD = /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native|default)\s+)+(?:<[^>]+>\s+)?[\w<>[\],.?]+\s+([A-Za-z_$][\w$]*)\s*\(/;
const DEFINITIONS = {
  '.py': [DEF], '.rb': [DEF],
  '.js': [JS_FUNCTION, JS_ARROW, JS_METHOD], '.mjs': [JS_FUNCTION, JS_ARROW, JS_METHOD],
  '.cjs': [JS_FUNCTION, JS_ARROW, JS_METHOD], '.ts': [JS_FUNCTION, JS_ARROW, JS_METHOD],
  '.tsx': [JS_FUNCTION, JS_ARROW, JS_METHOD], '.jsx': [JS_FUNCTION, JS_ARROW, JS_METHOD],
  '.java': [JAVA_METHOD], '.kt': [/^\s*(?:[a-z]+\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/],
};
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'function']);

export function definitionAbove(lines, index, file = '.py') {
  const patterns = DEFINITIONS[path.extname(file)];
  if (!patterns) return null;
  for (let i = Math.min(index, lines.length - 1); i >= 0; i -= 1) {
    for (const pattern of patterns) {
      const m = lines[i].match(pattern);
      if (m && !KEYWORDS.has(m[1])) return { name: m[1], line: i + 1 };
    }
  }
  return null;
}

export function changedFunctions(diffText, readFile) {
  const changed = new Map();
  let file = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      continue;
    }
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m || !file) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const source = readFile(file);
    if (source === null) continue;
    const lines = source.split('\n');
    // Every distinct function enclosing a changed line.
    const last = count === 0 ? start : start + count - 1;
    for (let n = Math.max(start, 1); n <= Math.max(last, start); n += 1) {
      const def = definitionAbove(lines, n - 1, file);
      if (def) changed.set(`${file}\t${def.name}`, { file, name: def.name, line: def.line });
    }
  }
  return [...changed.values()];
}

export function recordedCalls(appmapDir) {
  const calls = new Map();
  for (const file of listAppmaps(appmapDir)) {
    for (const event of readAppmap(path.join(appmapDir, file)).events ?? []) {
      if (event.event !== 'call' || event.method_id === undefined || !event.path) continue;
      // Python property getters are recorded as "name (get)".
      const name = String(event.method_id).replace(/ \((get|set)\)$/, '');
      const key = `${event.path}\t${name}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------

// The package a function belongs to, cut to `depth` segments of its class
// name: `org.springframework.util.StringUtils` -> `org.springframework`.
// Ruby (`Foo::Bar`) and path-like Node names split the same way.
export function packageOf(definedClass, depth = 2) {
  const parts = String(definedClass ?? '?').split(/::|[./]/).filter(Boolean);
  return parts.slice(0, Math.max(1, Math.min(depth, parts.length - 1))).join('.') || '?';
}

function ownsClass(definedClass, own) {
  const name = String(definedClass ?? '').replaceAll('::', '.').replaceAll('/', '.');
  return own.some((prefix) => name === prefix || name.startsWith(`${prefix}.`));
}

// One recording's noise profile: size, call count, calls per package and per
// function, and how many calls fall in the `own` package prefixes.
export function noiseProfile(appmap, { bytes = 0, depth = 2, own = [] } = {}) {
  const packages = new Map();
  const functions = new Map();
  let calls = 0;
  let ownCalls = 0;
  for (const event of appmap.events ?? []) {
    if (event.event !== 'call' || event.method_id === undefined) continue;
    calls += 1;
    const pkg = packageOf(event.defined_class, depth);
    packages.set(pkg, (packages.get(pkg) ?? 0) + 1);
    const fn = functionId(event);
    functions.set(fn, (functions.get(fn) ?? 0) + 1);
    if (own.length && ownsClass(event.defined_class, own)) ownCalls += 1;
  }
  return { bytes, calls, ownCalls, packages, functions };
}

function recordingFiles(targets) {
  const files = [];
  for (const target of targets) {
    if (fs.statSync(target).isDirectory()) files.push(...listAppmaps(target).map((f) => path.join(target, f)));
    else files.push(target);
  }
  return files;
}

export function noiseReport(files, { depth = 2, own = [], maxKb = 1024, maxCalls = 1000, minOwn = 50 } = {}) {
  const packages = new Map();
  const hot = new Map();
  const oversize = [];
  let calls = 0;
  let ownCalls = 0;
  let bytes = 0;
  for (const file of files) {
    const size = fs.statSync(file).size;
    const profile = noiseProfile(readAppmap(file), { bytes: size, depth, own });
    bytes += size;
    calls += profile.calls;
    ownCalls += profile.ownCalls;
    if (size > maxKb * 1024) oversize.push({ file, bytes: size, calls: profile.calls });
    for (const [pkg, n] of profile.packages) packages.set(pkg, (packages.get(pkg) ?? 0) + n);
    for (const [fn, n] of profile.functions) {
      if (n < maxCalls) continue;
      const entry = hot.get(fn) ?? { fn, max: 0, file: null, recordings: 0 };
      entry.recordings += 1;
      if (n > entry.max) Object.assign(entry, { max: n, file });
      hot.set(fn, entry);
    }
  }
  const ownShare = own.length && calls ? (100 * ownCalls) / calls : null;
  const failures = [];
  if (oversize.length) failures.push(`${oversize.length} of ${files.length} recording(s) over ${maxKb} KiB`);
  if (ownShare !== null && ownShare < minOwn) {
    failures.push(`only ${ownShare.toFixed(0)}% of calls are in ${own.join(', ')} (minimum ${minOwn}%)`);
  }
  return {
    files: files.length,
    bytes,
    calls,
    ownShare,
    packages: [...packages.entries()].map(([pkg, n]) => ({ pkg, calls: n })).sort((a, b) => b.calls - a.calls),
    hot: [...hot.values()].sort((a, b) => b.max - a.max),
    oversize: oversize.sort((a, b) => b.bytes - a.bytes),
    failures,
  };
}

function kib(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function option(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

function appmapDirFromConfig() {
  try {
    const text = fs.readFileSync('appmap.yml', 'utf8');
    const m = text.match(/^appmap_dir:\s*(\S+)/m);
    return m ? m[1] : 'tmp/appmap';
  } catch {
    return 'tmp/appmap';
  }
}

const VALUED = new Set(['--depth', '--hide', '--focus', '--limit', '--base', '--head', '--appmap-dir', '--path',
  '--own', '--max-kb', '--max-calls', '--min-own', '--top']);

function positional(args) {
  return args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'tree') {
    const [file] = positional(args);
    if (!file) throw new Error('tree needs a recording file');
    const lines = renderTree(buildForest(readAppmap(file)), {
      depth: Number(option(args, '--depth', 6)),
      params: args.includes('--params'),
      hide: String(option(args, '--hide', '')).split(',').filter(Boolean),
      focus: option(args, '--focus'),
    });
    console.log(lines.join('\n'));
  } else if (command === 'countdiff') {
    const [baseDir, headDir] = positional(args);
    if (!headDir) throw new Error('countdiff needs BASE_DIR and HEAD_DIR');
    const limit = Number(option(args, '--limit', 40));
    const { rows, unmatched } = countDiff(baseDir, headDir);
    if (unmatched.base.length || unmatched.head.length) {
      console.log(`note: ${unmatched.base.length} recording(s) only in base, ${unmatched.head.length} only in head.`);
      console.log('      Test ids that embed paths differ when the two sides were recorded in different checkouts.');
    }
    for (const row of rows.slice(0, limit)) {
      const sign = row.delta > 0 ? '+' : '';
      console.log(`${`${sign}${row.delta}`.padStart(7)}  ${String(row.tests.length).padStart(4)} test(s)  ${row.key}`);
    }
    if (!rows.length) console.log('No difference in call counts, exceptions, HTTP calls, or SQL.');
  } else if (command === 'coverage') {
    const base = option(args, '--base');
    if (!base) throw new Error('coverage needs --base REV');
    const head = option(args, '--head');
    const appmapDir = option(args, '--appmap-dir', appmapDirFromConfig());
    const prefix = option(args, '--path', '');
    const diff = git(['diff', '-U0', head ? `${base}..${head}` : base, '--', ...(prefix ? [prefix] : [])]);
    const readFile = (file) => {
      try {
        return head ? git(['show', `${head}:${file}`]) : fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    };
    const functions = changedFunctions(diff, readFile);
    const calls = recordedCalls(appmapDir);
    let hit = 0;
    for (const f of functions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      const n = calls.get(`${f.file}\t${f.name}`) ?? 0;
      if (n) hit += 1;
      console.log(`${n ? '✅' : '❌'} ${String(n || '').padStart(6)}  ${f.file}:${f.line} ${f.name}`);
    }
    console.log(`\n${hit} of ${functions.length} changed functions ran in the recordings under ${appmapDir}.`);
  } else if (command === 'noise') {
    const targets = positional(args);
    const files = recordingFiles(targets.length ? targets : [appmapDirFromConfig()]);
    if (!files.length) throw new Error('noise found no .appmap.json files');
    const top = Number(option(args, '--top', 10));
    const own = String(option(args, '--own', '')).split(',').map((s) => s.trim()).filter(Boolean);
    const report = noiseReport(files, {
      depth: Number(option(args, '--depth', 2)),
      own,
      maxKb: Number(option(args, '--max-kb', 1024)),
      maxCalls: Number(option(args, '--max-calls', 1000)),
      minOwn: Number(option(args, '--min-own', 50)),
    });
    console.log(`${report.files} recording(s), ${kib(report.bytes)}, ${report.calls} function calls.`);
    if (report.ownShare !== null) console.log(`Own code (${own.join(', ')}): ${report.ownShare.toFixed(0)}% of calls.`);
    console.log('\nCalls by package:');
    for (const p of report.packages.slice(0, top)) {
      console.log(`  ${`${((100 * p.calls) / report.calls).toFixed(0)}%`.padStart(4)}  ${String(p.calls).padStart(9)}  ${p.pkg}`);
    }
    if (report.oversize.length) {
      console.log('\nLargest recordings over the budget:');
      for (const o of report.oversize.slice(0, top)) console.log(`  ${kib(o.bytes).padStart(9)}  ${o.file}`);
    }
    if (report.hot.length) {
      console.log('\nCalled most often in one recording (exclude a utility; keep a function the analysis is about):');
      for (const h of report.hot.slice(0, top)) {
        console.log(`  ${String(h.max).padStart(9)}x  ${h.fn}  (${h.recordings} recording(s); most in ${h.file})`);
      }
    }
    if (report.failures.length) {
      console.log(`\nFAIL: ${report.failures.join('; ')}.`);
      process.exit(2);
    }
    console.log('\nPASS');
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 27).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(command ? 1 : 0);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
