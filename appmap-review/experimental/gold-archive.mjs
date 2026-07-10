#!/usr/bin/env node

// PROTOTYPE: gold-traces reimagined on top of `appmap archive` + `appmap compare`
// + `appmap compare-report`, instead of a bespoke sequence-diagram differ.
//
//   update  — archive the freshly-recorded gold AppMaps and store that tar as the
//             committed BASELINE archive (the "bless").
//   compare — archive the fresh gold AppMaps as HEAD, unpack baseline + head into
//             the compare layout, run `appmap compare` (+ `compare-report`), then
//             OVERLAY the gold-traces value-add the stock report lacks: a
//             security-label-aware severity pass driven by `security.*` labels
//             carried on the diagram (read from the diff sequence diagrams).
//
// What this migrates from the bespoke gold-traces engine:
//   * the bless/baseline lifecycle              -> a stored .tar (the base archive)
//   * curated-subset comparison                 -> archive only the gold AppMaps
//   * security severity ("stop and ask")        -> the label overlay below
//   * the CI gate                               -> --fail-on-changes
// What it gets for free from `appmap compare` that the bespoke engine reimplemented
// or lacked: new/removed/changed classification, the SQL diff, OpenAPI diff,
// scanner findings, source locations, and precomputed (cached) sequence diagrams.
//
// Usage:
//   node gold-archive.mjs update  --src DIR --store BASE.tar [--cli "node cli.js"]
//   node gold-archive.mjs compare --src DIR --base BASE.tar --work DIR
//                                 [--cli "node cli.js"] [--fail-on-changes]
//
// --src is an archivable working dir: it has an appmap.yml and the appmap_dir
// (e.g. tmp/appmap) holding the gold AppMaps.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SECURITY = /^security\./;
const DiffMode = { Insert: 1, Delete: 2, Change: 3 };
const DiffModeName = { 1: 'added', 2: 'removed', 3: 'changed' };

function parseArgs(argv) {
  const o = { cli: 'appmap', failOnChanges: false };
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!cmd && !a.startsWith('--')) { cmd = a; continue; }
    if (a === '--fail-on-changes') { o.failOnChanges = true; continue; }
    if (a.startsWith('--')) { o[a.slice(2)] = argv[++i]; continue; }
  }
  return { cmd, o };
}

function cli(o) {
  const [bin, ...prefix] = o.cli.split(/\s+/).filter(Boolean);
  return { bin, prefix };
}

function run(o, args, cwd) {
  const { bin, prefix } = cli(o);
  const r = spawnSync(bin, [...prefix, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`appmap ${args.join(' ')} failed:\n${(r.stdout || '') + (r.stderr || '')}`);
  }
  return r.stdout || '';
}

// Archive to a pinned absolute path. `--type full` keeps the archive
// self-contained (an incremental archive would only carry changed AppMaps, which
// breaks a from-scratch baseline comparison).
function archive(o, srcDir, outFile) {
  const out = path.resolve(outFile);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(o, ['archive', '--directory', srcDir, '--revision', 'gold', '--type', 'full',
    '--output-dir', path.dirname(out), '--output-file', path.basename(out)], srcDir);
  if (!fs.existsSync(out)) throw new Error(`archive not produced: ${out}`);
  return out;
}

// Unpack a gold archive tar into a compare revision dir (base/ or head/).
function unpackArchive(tar, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const stage = path.join(destDir, '.stage');
  fs.mkdirSync(stage, { recursive: true });
  spawnSync('tar', ['xf', tar, '-C', stage], { stdio: 'inherit' });
  spawnSync('tar', ['xzf', path.join(stage, 'appmaps.tar.gz'), '-C', destDir], { stdio: 'inherit' });
  for (const extra of ['openapi.yml', 'appmap_archive.json']) {
    const s = path.join(stage, extra);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(destDir, extra));
  }
  fs.rmSync(stage, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Interpretation-ready change digest.
//
// `appmap compare` produces a precise structural inventory but no interpretation:
// "2 new queries", "1 changed AppMap". This builds a compact, LABEL-ANNOTATED
// digest of that inventory — every change tagged with the AppMap labels in its
// context (ANY namespace: security.*, io.*, format.*, cache.*, …) plus a
// label-agnostic structural classification. Labels are interpretation HINTS, not
// a severity gate. An LLM (the agent, in the skill model) reads this digest and
// produces the actionable narrative the stock report lacks.
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const NodeType = { Loop: 1, Function: 3, ServerRPC: 4, ClientRPC: 5, Query: 6 };

function sqlOp(query) {
  const m = (query || '').replace(/^\s*--[^\n]*\n/, '').trim().match(/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// Classify a changed action structurally (label-agnostic) for interpretation.
function classifyNode(a) {
  if (a.nodeType === NodeType.Query) {
    const op = sqlOp(a.query);
    const write = op === 'INSERT' || op === 'UPDATE' || op === 'DELETE';
    return { kind: 'sql', op, write, text: (a.query || '').replace(/\s+/g, ' ').slice(0, 80) };
  }
  if (a.nodeType === NodeType.ServerRPC || a.nodeType === NodeType.ClientRPC) {
    return { kind: 'http', text: a.route || '?' };
  }
  return { kind: 'function', text: a.name || '(anonymous)' };
}

// Walk a diff sequence diagram, collecting changed actions with their full label
// context (own + inherited from enclosing functions) and the enclosing labeled fn.
function changesInDiff(diagram) {
  const out = [];
  const walk = (actions, labelCtx, fnCtx) => {
    for (const a of actions ?? []) {
      const own = a.labels ?? [];
      const ctx = own.length ? [...new Set([...labelCtx, ...own])] : labelCtx;
      const enclosingFn = a.nodeType === NodeType.Function && own.length ? a.name : fnCtx;
      if (a.diffMode !== undefined && a.nodeType !== NodeType.Loop) {
        out.push({
          change: DiffModeName[a.diffMode] ?? 'changed',
          ...classifyNode(a),
          labels: ctx.slice().sort(),
          under: enclosingFn || null,
        });
      }
      walk(a.children, ctx, enclosingFn);
    }
  };
  walk(diagram.rootActions, [], null);
  return out;
}

function labelsInDiagram(diagram) {
  const set = new Set();
  const walk = (as) => { for (const a of as ?? []) { for (const l of a.labels ?? []) set.add(l); walk(a.children); } };
  walk(diagram.rootActions);
  return [...set].sort();
}

// Build the interpretation-ready digest from the compare output.
function buildDigest(reportDir) {
  const report = readJson(path.join(reportDir, 'change-report.json'));
  const entries = [];

  for (const changed of report.changedAppMaps ?? []) {
    const diffPath = path.join(reportDir, 'diff', `${changed.appmap}.diff.sequence.json`);
    const changes = fs.existsSync(diffPath) ? changesInDiff(readJson(diffPath)) : [];
    entries.push({
      appmap: changed.appmap,
      status: 'changed',
      labels: [...new Set(changes.flatMap((c) => c.labels))].sort(),
      changes,
    });
  }
  for (const appmap of report.newAppMaps ?? []) {
    const seqPath = path.join(reportDir, 'head', appmap, 'sequence.json');
    entries.push({
      appmap, status: 'new',
      labels: fs.existsSync(seqPath) ? labelsInDiagram(readJson(seqPath)) : [],
      changes: [],
    });
  }
  for (const appmap of report.removedAppMaps ?? []) {
    entries.push({ appmap, status: 'removed', labels: [], changes: [] });
  }

  return {
    entries,
    sqlDiff: report.sqlDiff,        // newQueries/removedQueries/newTables/removedTables
    apiDiff: report.apiDiff,        // OpenAPI changes
    findingDiff: report.findingDiff, // scanner findings delta
  };
}

function renderDigest(digest) {
  const lines = [];
  lines.push('## Change digest (label-annotated, interpretation-ready)');
  lines.push('');
  lines.push('Structural changes from `appmap compare`, each tagged with the AppMap labels');
  lines.push('in its context (any namespace). Interpretation is left to the reader/agent.');
  lines.push('');
  for (const e of digest.entries) {
    const labelTag = e.labels.length ? `  _labels: ${e.labels.join(', ')}_` : '';
    lines.push(`### \`${e.appmap}\` — **${e.status}**${labelTag}`);
    for (const c of e.changes) {
      const where = c.under ? ` under \`${c.under}\`` : '';
      const tag = c.labels.length ? `  [${c.labels.join(', ')}]` : '';
      lines.push(`- ${c.change} ${c.kind}${c.op ? ` ${c.op}` : ''}${where}: \`${c.text}\`${tag}`);
    }
    if (e.changes.length === 0 && e.status === 'changed') lines.push('- (digest-level change with no aligned action delta)');
    lines.push('');
  }
  const nq = digest.sqlDiff?.newQueries?.length ?? 0;
  const rq = digest.sqlDiff?.removedQueries?.length ?? 0;
  lines.push(`_SQL: ${nq} new / ${rq} removed query shape(s). API changes: ${(digest.apiDiff?.differences?.length) ?? 0}._`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdUpdate(o) {
  if (!o.src || !o.store) throw new Error('update needs --src and --store');
  archive(o, path.resolve(o.src), path.resolve(o.store));
  console.log(`Blessed gold baseline archive -> ${o.store}`);
}

function cmdCompare(o) {
  if (!o.src || !o.base || !o.work) throw new Error('compare needs --src, --base, --work');
  const work = path.resolve(o.work);
  const reportDir = path.join(work, 'report');
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.mkdirSync(reportDir, { recursive: true });
  // A compare working dir needs an appmap.yml present.
  const srcCfg = path.join(path.resolve(o.src), 'appmap.yml');
  if (fs.existsSync(srcCfg)) fs.copyFileSync(srcCfg, path.join(work, 'appmap.yml'));

  const headTar = archive(o, path.resolve(o.src), path.join(work, 'head.tar'));
  unpackArchive(path.resolve(o.base), path.join(reportDir, 'base'));
  unpackArchive(headTar, path.join(reportDir, 'head'));

  run(o, ['compare', '--directory', work, '--output-dir', reportDir,
    '--base-revision', 'base', '--head-revision', 'head'], work);
  run(o, ['compare-report', reportDir,
    '--include-section', 'sql-diff', '--include-section', 'changed-appmaps'], work);

  const digest = buildDigest(reportDir);
  const digestMd = renderDigest(digest);
  // Prepend the interpretation-ready digest to the stock report.
  const stock = fs.readFileSync(path.join(reportDir, 'report.md'), 'utf8');
  fs.writeFileSync(path.join(reportDir, 'gold-report.md'), `${digestMd}\n---\n\n${stock}`);
  fs.writeFileSync(path.join(reportDir, 'change-digest.json'), JSON.stringify(digest, null, 2) + '\n');

  const report = readJson(path.join(reportDir, 'change-report.json'));
  const changed = (report.changedAppMaps ?? []).length;
  const added = (report.newAppMaps ?? []).length;
  const removed = (report.removedAppMaps ?? []).length;
  const labeled = digest.entries.filter((e) => e.labels.length > 0).length;
  console.log(`Compared. changed=${changed} new=${added} removed=${removed} | ${labeled} entr(ies) touch labeled code`);
  console.log(`Digest:  ${path.relative(process.cwd(), path.join(reportDir, 'change-digest.json'))}`);
  console.log(`Report:  ${path.relative(process.cwd(), path.join(reportDir, 'gold-report.md'))}`);

  if (o.failOnChanges && (changed > 0 || removed > 0)) {
    process.exitCode = 1;
  }
}

const { cmd, o } = parseArgs(process.argv.slice(2));
try {
  if (cmd === 'update') cmdUpdate(o);
  else if (cmd === 'compare') cmdCompare(o);
  else {
    console.error('usage: gold-archive.mjs <update|compare> ...');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
