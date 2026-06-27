#!/usr/bin/env node

// Gold-traces engine for the appmap-gold-traces skill.
//
// Config-driven and dependency-free: all project-specific commands and paths
// live in <dir>/config.yaml; the curated recording list lives in
// <dir>/appmap_golden_set.yaml. Run from the target project root:
//
//   node <skill>/assets/manage.mjs compare --dir gold_traces --record
//   node <skill>/assets/manage.mjs update  --dir gold_traces --only test_foo
//
// The script stores only raw baseline AppMaps and derives sequence/diff
// artifacts at compare time. Comparison is a two-tier pass per recording:
//
//   1. HIGH-LEVEL  Export each AppMap to AppMap's JSON sequence diagram and
//      compare a single digest over the root subtree digests. Equal digests =
//      no behavioral change, full stop. The digest is built from AppMap's
//      `stableProperties` (normalized SQL, code-object identity, exceptions) and
//      explicitly excludes volatile data — elapsed time, object ids, parameter
//      and return *values*, random strings — so timing jitter and unstable test
//      data never register as a change.
//
//   2. DRILL-DOWN  When the digests differ, run `appmap sequence-diagram-diff`
//      (an edit-distance alignment, robust to inserted/removed frames) to get
//      the structured diff (added/removed/changed actions) and a compact text
//      rendering for the report. Each changed action is classified into a
//      finding; severity is raised when the action carries a `security.*`
//      AppMap label (read straight from the diagram) or sits on an auth path.
//
// SQL is normalized to a structural FINGERPRINT (operation + tables + WHERE/
// JOIN/HAVING columns) only to *classify* a changed query: a projection-only
// change stays quiet (low), while a dropped predicate, a new write, or a newly
// touched table is loud. The alignment itself is done by the AppMap CLI.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const securityPattern = /auth|token|session|jwt|security|identity|login|claim|verify|permission|credential|secret/i;
const securityLabelPattern = /^security\./;

// Sequence-diagram node + diff enums (mirror @appland/sequence-diagram `types.ts`).
const NodeType = { Loop: 1, Conditional: 2, Function: 3, ServerRPC: 4, ClientRPC: 5, Query: 6 };
const DiffMode = { Insert: 1, Delete: 2, Change: 3 };

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || options.help) {
    printHelp();
    return;
  }

  const projectRoot = process.cwd();
  const goldDir = path.resolve(projectRoot, options.dir);
  const paths = {
    projectRoot,
    goldDir,
    configPath: path.join(goldDir, 'config.yaml'),
    manifestPath: path.join(goldDir, 'appmap_golden_set.yaml'),
    baselineRoot: path.join(goldDir, 'baseline'),
    reportsRoot: path.join(goldDir, 'reports'),
    tempRoot: path.join(goldDir, '.tmp'),
  };

  const config = await loadConfig(paths.configPath);
  const workingDir = path.resolve(projectRoot, config.cwd);
  const env = { ...paths, config, workingDir };

  const manifest = await loadManifest(paths.manifestPath);
  let entries = selectEntries(manifest, options.includeOptional);
  if (options.only.length > 0) {
    const wanted = new Set(options.only);
    entries = entries.filter((entry) => wanted.has(entry.test_name));
    const found = new Set(entries.map((entry) => entry.test_name));
    const missing = options.only.filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new Error(`--only names not found in manifest: ${missing.join(', ')}`);
    }
  }

  if (command === 'update') {
    await updateBaseline(env, entries, options);
    return;
  }
  if (command === 'compare') {
    await compareAgainstBaseline(env, entries, options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(args) {
  const options = {
    help: false,
    dir: 'gold_traces',
    includeOptional: false,
    record: false,
    failOnChanges: false,
    only: [],
    outputJson: null,
    outputMarkdown: null,
  };

  let command = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!command && !arg.startsWith('--')) {
      command = arg;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dir') {
      index += 1;
      options.dir = args[index] ?? 'gold_traces';
      continue;
    }
    if (arg === '--include-optional') {
      options.includeOptional = true;
      continue;
    }
    if (arg === '--record') {
      options.record = true;
      continue;
    }
    if (arg === '--fail-on-changes') {
      options.failOnChanges = true;
      continue;
    }
    if (arg === '--only') {
      index += 1;
      if (args[index]) {
        options.only.push(args[index]);
      }
      continue;
    }
    if (arg === '--output-json') {
      index += 1;
      options.outputJson = args[index] ?? null;
      continue;
    }
    if (arg === '--output-markdown') {
      index += 1;
      options.outputMarkdown = args[index] ?? null;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, options };
}

function printHelp() {
  console.log(`Usage:
  node <skill>/assets/manage.mjs update  [--dir DIR] [--include-optional] [--only TEST] [--record]
  node <skill>/assets/manage.mjs compare [--dir DIR] [--include-optional] [--only TEST] [--record] [--fail-on-changes] [--output-json FILE] [--output-markdown FILE]

Commands:
  update   Copy current AppMaps into the stored baseline (bless).
  compare  Compare current AppMaps against the stored baseline and write a report.

Options:
  --dir DIR           Managed gold-traces directory, relative to the project root (default: gold_traces).
  --include-optional  Include manifest entries from the optional list.
  --only TEST         Limit to the named test (repeatable). Bless/compare just those entries.
  --record            Re-record each selected test before updating or comparing (needs commands.record in config).
  --fail-on-changes   Exit non-zero when behavioral changes are detected (compare).
  --output-json       Override the JSON report output path for compare.
  --output-markdown   Override the Markdown report output path for compare.
  --help              Show this help.
`);
}

// ---------------------------------------------------------------------------
// Config + manifest
// ---------------------------------------------------------------------------

async function loadConfig(configPath) {
  const raw = await readFileOrNull(configPath);
  if (raw === null) {
    throw new Error(`Missing config: ${configPath}\nBootstrap the gold-traces directory first (see the appmap-gold-traces skill).`);
  }
  const config = parseYaml(raw);
  if (!config || typeof config !== 'object') {
    throw new Error(`Invalid config: ${configPath}`);
  }
  if (!config.appmap_dir) {
    throw new Error(`Config is missing required field 'appmap_dir': ${configPath}`);
  }
  const commands = config.commands ?? {};
  return {
    cwd: config.cwd ?? '.',
    appmap_dir: config.appmap_dir,
    record: commands.record ?? null,
    record_env: stringifyEnv(commands.record_env ?? {}),
    appmap_cli: commands.appmap_cli ?? 'appmap',
    // Optional per-run expand list: package code-object ids rendered at function
    // granularity in the diagram. Default empty — package granularity is enough
    // for detection (every recorded function is still a node), so this is a
    // presentation knob for security-critical traces only.
    expand: Array.isArray(config.expand) ? config.expand.map(String) : [],
  };
}

async function loadManifest(manifestPath) {
  const raw = await readFileOrNull(manifestPath);
  if (raw === null) {
    throw new Error(`Missing manifest: ${manifestPath}\nBootstrap the gold-traces directory first (see the appmap-gold-traces skill).`);
  }
  const manifest = parseYaml(raw);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Invalid manifest: ${manifestPath}`);
  }
  manifest.core = manifest.core ?? [];
  manifest.optional = manifest.optional ?? [];
  if (!Array.isArray(manifest.core) || !Array.isArray(manifest.optional)) {
    throw new Error(`Manifest 'core' and 'optional' must be lists: ${manifestPath}`);
  }
  return manifest;
}

function selectEntries(manifest, includeOptional) {
  return includeOptional ? [...manifest.core, ...manifest.optional] : [...manifest.core];
}

function stringifyEnv(envObject) {
  const out = {};
  for (const [key, value] of Object.entries(envObject)) {
    out[key] = String(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function updateBaseline(env, entries, options) {
  if (options.record) {
    await rerecordEntries(env, entries);
  }

  for (const entry of entries) {
    const appmapSource = currentAppMapPath(env, entry);
    await assertExists(appmapSource, `Missing AppMap for ${entry.test_name}`);
    const baselineAppMap = baselineAppMapPath(env, entry);
    await ensureDir(path.dirname(baselineAppMap));
    await fs.copyFile(appmapSource, baselineAppMap);
  }

  console.log(`Updated baseline raw AppMaps for ${entries.length} recording(s).`);
}

async function compareAgainstBaseline(env, entries, options) {
  if (options.record) {
    await rerecordEntries(env, entries);
  }

  const report = {
    generated_at: process.env.GOLD_TRACES_NOW ?? null,
    include_optional: options.includeOptional,
    compared: entries.length,
    changed: 0,
    flagged: 0,
    entries: [],
  };

  const baselineSequenceDir = tempSequenceDir(env, 'compare-baseline');
  const currentSequenceDir = tempSequenceDir(env, 'compare-current');
  const diffDir = path.join(env.tempRoot, 'compare-diff');
  await ensureDir(baselineSequenceDir);
  await ensureDir(currentSequenceDir);
  await ensureDir(diffDir);

  for (const entry of entries) {
    const baselineAppMap = baselineAppMapPath(env, entry);
    const currentAppMap = currentAppMapPath(env, entry);
    await assertExists(baselineAppMap, `Missing baseline AppMap for ${entry.test_name}`);
    await assertExists(currentAppMap, `Missing current AppMap for ${entry.test_name}`);

    const baselineSeqFile = await exportSequenceDiagram(env, baselineAppMap, baselineSequenceDir, entry);
    const currentSeqFile = await exportSequenceDiagram(env, currentAppMap, currentSequenceDir, entry);
    const baseline = await readJson(baselineSeqFile);
    const current = await readJson(currentSeqFile);

    // 1. High-level pass: a single digest over the root subtree digests. Equal =
    //    no behavioral change. Volatile data is not in the digest, so this is
    //    immune to timing jitter and unstable test data.
    const changed = diagramDigest(baseline) !== diagramDigest(current);

    let summary;
    let findings = [];
    let textDiff = '';
    let diffActions = [];
    let actorDelta = { added: [], removed: [] };

    if (!changed) {
      summary = 'No behavioral change (sequence-diagram digest identical).';
    } else {
      // 2. Drill-down: edit-distance diff via the AppMap CLI.
      const diffEntryDir = path.join(diffDir, safeName(entry.test_name));
      await ensureDir(diffEntryDir);
      const diffDiagram = await runSequenceDiff(env, baselineSeqFile, currentSeqFile, diffEntryDir, 'json');
      textDiff = await runSequenceDiffText(env, baselineSeqFile, currentSeqFile, diffEntryDir);
      diffActions = diffDiagram ? collectDiffActions(diffDiagram) : [];
      actorDelta = diffActors(baseline, current);
      findings = classifyChanges(entry, diffActions, actorDelta);
      summary = summarizeChanges(diffActions, actorDelta);
    }

    if (changed) {
      report.changed += 1;
    }
    if (findings.length > 0) {
      report.flagged += 1;
    }

    report.entries.push({
      feature: entry.feature,
      test_file: entry.test_file,
      test_name: entry.test_name,
      appmap_path: entry.appmap_path,
      changed,
      summary,
      findings,
      changes: diffActions,
      actor_delta: actorDelta,
      text_diff: textDiff,
    });
  }

  const jsonPath = options.outputJson ?? path.join(env.reportsRoot, 'latest-compare.json');
  const markdownPath = options.outputMarkdown ?? path.join(env.reportsRoot, 'latest-compare.md');
  await ensureDir(path.dirname(jsonPath));
  await ensureDir(path.dirname(markdownPath));
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(markdownPath, renderMarkdownReport(report));

  console.log(`Compared ${report.compared} recording(s). Changed: ${report.changed}. Flagged: ${report.flagged}.`);
  console.log(`JSON report: ${path.relative(env.projectRoot, jsonPath)}`);
  console.log(`Markdown report: ${path.relative(env.projectRoot, markdownPath)}`);

  if (options.failOnChanges && report.changed > 0) {
    process.exitCode = 1;
  }
}

async function rerecordEntries(env, entries) {
  if (!env.config.record) {
    throw new Error(`--record requires 'commands.record' in ${env.configPath}`);
  }
  for (const entry of entries) {
    const appmapOutput = currentAppMapPath(env, entry);
    await fs.rm(appmapOutput, { force: true });
    const command = substitute(env.config.record, {
      test_file: entry.test_file,
      test_name: entry.test_name,
      appmap_path: entry.appmap_path,
    });
    runShell(command, {
      cwd: env.workingDir,
      env: { ...process.env, ...env.config.record_env },
    });
  }
}

// ---------------------------------------------------------------------------
// AppMap CLI surface (sequence-diagram export + diff)
// ---------------------------------------------------------------------------

function cliInvocation(env) {
  const [bin, ...prefix] = env.config.appmap_cli.split(/\s+/).filter(Boolean);
  return { bin, prefix };
}

async function exportSequenceDiagram(env, appmapFile, outputDir, entry) {
  await ensureDir(outputDir);
  const before = new Set(await listJsonFiles(outputDir));
  const { bin, prefix } = cliInvocation(env);
  const args = [...prefix, 'sequence-diagram', appmapFile, '--directory', env.workingDir, '--format', 'json', '--output-dir', outputDir];
  for (const id of env.config.expand) {
    args.push('--expand', id);
  }
  runCommandQuiet(bin, args, { cwd: env.workingDir });
  const after = new Set(await listJsonFiles(outputDir));
  for (const candidate of after) {
    if (!before.has(candidate)) {
      return candidate;
    }
  }

  const fallback = path.join(outputDir, `${entry.test_name}.sequence.json`);
  await assertExists(fallback, `Unable to locate generated sequence diagram for ${entry.test_name}`);
  return fallback;
}

// Run `sequence-diagram-diff` in JSON form and return the parsed diff diagram, or
// null when the two diagrams turn out to be identical (no diff file produced).
async function runSequenceDiff(env, baseFile, headFile, outputDir, format) {
  const { bin, prefix } = cliInvocation(env);
  runCommandQuiet(
    bin,
    [...prefix, 'sequence-diagram-diff', baseFile, headFile, '--format', format, '--output-dir', outputDir],
    { cwd: env.workingDir },
  );
  const diffFile = path.join(outputDir, `diff.${format}`);
  const raw = await readFileOrNull(diffFile);
  return raw === null ? null : JSON.parse(raw);
}

async function runSequenceDiffText(env, baseFile, headFile, outputDir) {
  const { bin, prefix } = cliInvocation(env);
  runCommandQuiet(
    bin,
    [...prefix, 'sequence-diagram-diff', baseFile, headFile, '--format', 'text', '--output-dir', outputDir],
    { cwd: env.workingDir },
  );
  return (await readFileOrNull(path.join(outputDir, 'diff.txt'))) ?? '';
}

// ---------------------------------------------------------------------------
// High-level pass: diagram digest
// ---------------------------------------------------------------------------

// Mirror @appland/cli SequenceDiagramDigest: a single sha256 over the root
// subtree digests. The subtree digests come straight from the diagram and carry
// only AppMap `stableProperties`, so elapsed time, object ids, and value-level
// volatility are already excluded.
function diagramDigest(diagram) {
  const hash = createHash('sha256');
  for (const action of diagram.rootActions ?? []) {
    hash.update(action.subtreeDigest ?? '');
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Drill-down: walk the diff diagram
// ---------------------------------------------------------------------------

// Flatten the diff diagram into the actions that actually changed. An action with
// no `diffMode` is unchanged (the alignment kept it in place); we still recurse
// into its children, since a parent can be unchanged while a descendant differs.
function collectDiffActions(diagram) {
  const out = [];
  // `ancestorSecurity` carries a security.* label seen on any enclosing action.
  // A changed child query/log/etc. is the *evidence* of a behavior change, but the
  // security label usually sits on the enclosing function (which may itself be
  // unchanged). Propagating the label down lets a changed descendant inherit the
  // security context of its labeled ancestor.
  const visit = (action, depth, ancestorSecurity) => {
    const ownLabels = Array.isArray(action.labels) ? action.labels : [];
    const securityContext = ancestorSecurity || ownLabels.some((label) => securityLabelPattern.test(label));
    if (action.diffMode !== undefined && action.nodeType !== NodeType.Loop) {
      out.push({
        diffMode: action.diffMode,
        nodeType: action.nodeType,
        name: nodeLabel(action),
        formerName: action.formerName ?? null,
        formerResult: action.formerResult ?? null,
        id: action.stableProperties?.id ?? null,
        labels: ownLabels,
        securityContext,
        query: action.nodeType === NodeType.Query ? (action.query ?? null) : null,
        raisesException: Boolean(action.returnValue?.raisesException),
        depth,
      });
    }
    for (const child of action.children ?? []) {
      visit(child, depth + 1, securityContext);
    }
  };
  for (const root of diagram.rootActions ?? []) {
    visit(root, 0, false);
  }
  return out;
}

function nodeLabel(action) {
  if (action.nodeType === NodeType.Query) return 'SQL';
  if (action.nodeType === NodeType.ServerRPC || action.nodeType === NodeType.ClientRPC) {
    return action.route ?? 'HTTP';
  }
  return action.name ?? '(anonymous)';
}

function diffActors(baseline, current) {
  const baseIds = new Set((baseline.actors ?? []).map((a) => a.id));
  const currIds = new Set((current.actors ?? []).map((a) => a.id));
  const added = [...currIds].filter((id) => !baseIds.has(id));
  const removed = [...baseIds].filter((id) => !currIds.has(id));
  return { added, removed };
}

const diffModeName = (mode) =>
  mode === DiffMode.Insert ? 'added' : mode === DiffMode.Delete ? 'removed' : 'changed';

function summarizeChanges(diffActions, actorDelta) {
  if (diffActions.length === 0 && actorDelta.added.length === 0 && actorDelta.removed.length === 0) {
    return 'Digest differs but no aligned action change was surfaced.';
  }
  const counts = new Map();
  for (const action of diffActions) {
    const key = `${diffModeName(action.diffMode)} ${nodeTypeName(action.nodeType)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([key, count]) => `${count} ${key}`);
  if (actorDelta.added.length > 0) parts.push(`${actorDelta.added.length} actor added`);
  if (actorDelta.removed.length > 0) parts.push(`${actorDelta.removed.length} actor removed`);
  return parts.join(', ');
}

function nodeTypeName(nodeType) {
  switch (nodeType) {
    case NodeType.Function:
      return 'function';
    case NodeType.ServerRPC:
      return 'server request';
    case NodeType.ClientRPC:
      return 'client request';
    case NodeType.Query:
      return 'SQL';
    default:
      return 'action';
  }
}

// ---------------------------------------------------------------------------
// SQL fingerprinting (classification only)
//
// The CLI does the alignment; the fingerprint only decides how loud a changed
// query is. We reduce a statement to operation + tables + filter (WHERE/JOIN/
// HAVING) columns. A projection-only change (a new SELECT column) keeps the same
// fingerprint and stays quiet; a dropped predicate, a new write, or a newly
// touched table is loud.
// ---------------------------------------------------------------------------

const SQL_OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH'];

function normalizeSql(query) {
  if (typeof query !== 'string') return null;
  let text = query;
  // appmap collapses executemany into a "-- N times\n<stmt>" prefix.
  const repeatMatch = text.match(/^\s*--\s*(\d+|\?)\s*times\s*\r?\n/i);
  if (repeatMatch) {
    text = text.slice(repeatMatch[0].length);
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  // Transaction/session noise is not a behavioral signal.
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|SHOW|PRAGMA)\b/i.test(text)) return null;
  const op = (SQL_OPS.find((candidate) => new RegExp(`^${candidate}\\b`, 'i').test(text)) ?? 'OTHER').toUpperCase();
  return { op, tables: extractTables(text), filters: extractFilterColumns(text) };
}

function stripSqlQuotes(identifier) {
  return identifier.replace(/["`]/g, '');
}

function extractTables(text) {
  const tables = new Set();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w."]*)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    tables.add(stripSqlQuotes(match[1]).toLowerCase());
  }
  return [...tables].sort();
}

function extractFilterColumns(text) {
  const cols = new Set();
  const clauseRe = /\b(?:WHERE|ON|HAVING)\b(.*?)(?:\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|\bRETURNING\b|$)/gis;
  let clause;
  while ((clause = clauseRe.exec(text)) !== null) {
    const colRe = /([A-Za-z_][\w."]*)\s*(?:=|<>|!=|<=|>=|<|>|\bIN\b|\bIS\b|\bLIKE\b|\bBETWEEN\b)/gi;
    let column;
    while ((column = colRe.exec(clause[1])) !== null) {
      const ident = stripSqlQuotes(column[1]).toLowerCase();
      if (!['and', 'or', 'not', 'null', 'true', 'false'].includes(ident)) cols.add(ident);
    }
  }
  return [...cols].sort();
}

function sameFingerprintKey(fingerprint) {
  if (!fingerprint) return '';
  return `${fingerprint.op} {${fingerprint.tables.join(',')}} [${fingerprint.filters.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyChanges(entry, diffActions, actorDelta) {
  if (diffActions.length === 0 && actorDelta.added.length === 0 && actorDelta.removed.length === 0) {
    return [];
  }

  const findings = [];

  // Security: prefer AppMap labels (read from the diagram), fall back to the
  // feature flag and a name heuristic. A label on *any* changed action wins.
  const labeledSecurity = diffActions.some((action) => action.securityContext);
  const securityRelevant =
    labeledSecurity ||
    entry.feature === 'auth' ||
    entry.feature === 'authz' ||
    diffActions.some((action) => securityPattern.test(action.name ?? '') || securityPattern.test(action.formerName ?? ''));
  if (securityRelevant) {
    findings.push({
      severity: 'high',
      category: 'security-review',
      message: labeledSecurity
        ? 'A security-labeled action changed. Review the auth/identity/permission side effects on this path.'
        : 'Behavior changed on a security-sensitive path. Review auth, token, session, identity, or permission side effects.',
    });
  }

  // SQL queries that vanished: a dropped WHERE/JOIN predicate, a guard query that
  // no longer runs, or a removed read — the access-control & correctness red flag.
  const sqlRemoved = diffActions.filter((a) => a.nodeType === NodeType.Query && a.diffMode === DiffMode.Delete);
  if (sqlRemoved.length > 0) {
    const anySelect = sqlRemoved.some((a) => normalizeSql(a.query)?.op === 'SELECT');
    findings.push({
      severity: securityRelevant || anySelect ? 'high' : 'medium',
      category: 'sql-query-removed',
      message: 'A SQL query disappeared from this path (a dropped WHERE/JOIN predicate, a guard query that no longer runs, or a removed read). Confirm no access-control or correctness check was lost.',
    });
  }

  // New writes / newly-touched tables.
  const sqlWritesAdded = diffActions.filter((a) => {
    if (a.nodeType !== NodeType.Query || a.diffMode !== DiffMode.Insert) return false;
    const op = normalizeSql(a.query)?.op;
    return op === 'INSERT' || op === 'UPDATE' || op === 'DELETE';
  });
  if (sqlWritesAdded.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'sql-write-added',
      message: 'A new INSERT/UPDATE/DELETE appears on this path. Confirm the new write is intended.',
    });
  }

  // Changed query: projection-only stays quiet; a table/predicate change is loud.
  const sqlChangedPredicate = diffActions.filter((a) => {
    if (a.nodeType !== NodeType.Query || a.diffMode !== DiffMode.Change) return false;
    return sameFingerprintKey(normalizeSql(a.formerName)) !== sameFingerprintKey(normalizeSql(a.query));
  });
  if (sqlChangedPredicate.length > 0) {
    findings.push({
      severity: securityRelevant ? 'high' : 'medium',
      category: 'sql-query-changed',
      message: 'A SQL query changed its tables or WHERE/JOIN predicate (not just projected columns). Confirm the access pattern is intended.',
    });
  }

  // Same query shape inserted multiple times => possible N+1 / fan-out.
  const insertedQueryKeys = new Map();
  for (const action of diffActions) {
    if (action.nodeType === NodeType.Query && action.diffMode === DiffMode.Insert) {
      const key = sameFingerprintKey(normalizeSql(action.query));
      insertedQueryKeys.set(key, (insertedQueryKeys.get(key) ?? 0) + 1);
    }
  }
  if ([...insertedQueryKeys.values()].some((count) => count >= 2)) {
    findings.push({
      severity: 'medium',
      category: 'sql-n-plus-one',
      message: 'The same SQL query shape now runs multiple additional times (possible N+1 / fan-out). Check for a query issued inside a loop.',
    });
  }

  // Exception / return-shape changes on a function.
  const returnChanges = diffActions.filter(
    (a) => a.nodeType === NodeType.Function && a.diffMode === DiffMode.Change && a.formerResult !== null,
  );
  if (returnChanges.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'exception-behavior',
      message: 'A function changed its return shape or exception behavior. Check whether new failures, suppressed failures, or validation changes are intentional.',
    });
  }

  // Participating-package (actor) changes.
  if (actorDelta.added.length > 0 || actorDelta.removed.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'side-effects',
      message: 'The set of participating packages changed. Review for unexpected new dependencies or side effects.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'low',
      category: 'behavior-change',
      message: 'Call structure changed. Review whether the trace delta matches the intended feature work.',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Gold Trace Compare Report');
  lines.push('');
  lines.push(`Generated: ${report.generated_at ?? '(unstamped)'}`);
  lines.push(`Compared: ${report.compared}`);
  lines.push(`Changed: ${report.changed}`);
  lines.push(`Flagged: ${report.flagged}`);
  lines.push('');

  for (const entry of report.entries) {
    lines.push(`## ${entry.test_name}`);
    lines.push('');
    lines.push(`- Feature: ${entry.feature}`);
    lines.push(`- Test: ${entry.test_file}::${entry.test_name}`);
    lines.push(`- AppMap: ${entry.appmap_path}`);
    lines.push(`- Changed: ${entry.changed ? 'yes' : 'no'}`);
    lines.push(`- Summary: ${entry.summary}`);
    if (entry.findings.length > 0) {
      lines.push('- Findings:');
      for (const finding of entry.findings) {
        lines.push(`  - [${finding.severity}] ${finding.category}: ${finding.message}`);
      }
    }
    if (entry.actor_delta && (entry.actor_delta.added.length > 0 || entry.actor_delta.removed.length > 0)) {
      const parts = [];
      for (const id of entry.actor_delta.added) parts.push(`+${id}`);
      for (const id of entry.actor_delta.removed) parts.push(`-${id}`);
      lines.push(`- Participants: ${parts.join(', ')}`);
    }
    if (entry.text_diff && entry.text_diff.trim() !== '') {
      lines.push('- Diff:');
      lines.push('');
      lines.push('  ```');
      for (const line of entry.text_diff.replace(/\s+$/, '').split('\n')) {
        lines.push(`  ${line}`);
      }
      lines.push('  ```');
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function currentAppMapPath(env, entry) {
  return path.join(env.workingDir, env.config.appmap_dir, entry.appmap_path);
}

function baselineAppMapPath(env, entry) {
  return path.join(env.baselineRoot, 'appmaps', entry.appmap_path);
}

function tempSequenceDir(env, name) {
  return path.join(env.tempRoot, name, 'sequences');
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

// ---------------------------------------------------------------------------
// Process + fs helpers
// ---------------------------------------------------------------------------

function substitute(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

async function listJsonFiles(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function assertExists(filePath, message) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`${message}: ${filePath}`);
  }
}

// Run a command, capturing stdout/stderr. The AppMap CLI is chatty (per-export
// "Printed diagram ..." lines, and @appland/models logs SQL it can't parse), so
// we stay quiet on success and surface the captured output only on failure.
function runCommandQuiet(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw new Error(`Command failed to start: ${command} (${result.error.message})`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${detail}`);
  }
}

function runShell(command, options) {
  const result = spawnSync(command, { stdio: 'inherit', shell: true, ...options });
  if (result.error) {
    throw new Error(`Command failed to start: ${command} (${result.error.message})`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal YAML reader
// ---------------------------------------------------------------------------
//
// Dependency-free so the skill is zero-install. Handles the constrained schema
// used by config.yaml and appmap_golden_set.yaml: block maps, block sequences
// of maps, one level of nested maps, and scalar values (strings, numbers,
// booleans, null). Not a general YAML parser — no flow collections, anchors,
// multi-line scalars, or inline comments. Put no `#` comments on the same line
// as a value; quote a value if it would otherwise be ambiguous.

function parseYaml(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const withoutTrailing = raw.replace(/\s+$/, '');
    if (!withoutTrailing.trim()) {
      continue;
    }
    const stripped = withoutTrailing.replace(/^\s*/, '');
    if (stripped.startsWith('#')) {
      continue;
    }
    const indent = withoutTrailing.length - stripped.length;
    lines.push({ indent, content: stripped });
  }
  const [value] = parseBlock(lines, 0, 0);
  return value;
}

function parseBlock(lines, index, minIndent) {
  if (index >= lines.length || lines[index].indent < minIndent) {
    return [null, index];
  }
  const indent = lines[index].indent;
  if (lines[index].content.startsWith('- ') || lines[index].content === '-') {
    return parseList(lines, index, indent);
  }
  return parseMap(lines, index, indent);
}

function parseList(lines, index, indent) {
  const arr = [];
  while (index < lines.length && lines[index].indent === indent && (lines[index].content.startsWith('- ') || lines[index].content === '-')) {
    const inline = lines[index].content === '-' ? '' : lines[index].content.slice(2);
    const itemLines = [];
    if (inline) {
      itemLines.push({ indent: indent + 2, content: inline });
    }
    index += 1;
    while (index < lines.length && lines[index].indent > indent) {
      itemLines.push(lines[index]);
      index += 1;
    }
    if (itemLines.length === 0) {
      arr.push(null);
    } else if (itemLines.length === 1 && !/^[^:\s][^:]*:(\s|$)/.test(itemLines[0].content)) {
      arr.push(parseScalar(itemLines[0].content));
    } else {
      const [value] = parseBlock(itemLines, 0, itemLines[0].indent);
      arr.push(value);
    }
  }
  return [arr, index];
}

function parseMap(lines, index, indent) {
  const obj = {};
  while (index < lines.length && lines[index].indent === indent) {
    const match = lines[index].content.match(/^([^:]+):(?:\s+(.*))?$/);
    if (!match) {
      break;
    }
    const key = match[1].trim();
    const inlineValue = match[2];
    if (inlineValue === undefined || inlineValue === '') {
      index += 1;
      const [value, next] = parseBlock(lines, index, indent + 1);
      obj[key] = value;
      index = next;
    } else {
      obj[key] = parseScalar(inlineValue);
      index += 1;
    }
  }
  return [obj, index];
}

function parseScalar(raw) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return value;
}

export { parseYaml, normalizeSql, sameFingerprintKey, diagramDigest, collectDiffActions, classifyChanges };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
