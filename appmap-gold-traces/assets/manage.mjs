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
// The script stores only raw baseline AppMaps and derives sequence/normalized
// artifacts at compare time. It uses AppMap's JSON sequence-diagram export as
// the comparison surface, then normalizes away minor volatility (actor
// ordering, event ids, exact timings) while retaining coarse elapsed-time
// buckets.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const securityPattern = /auth|token|session|jwt|security|identity|login|claim|verify|permission|credential|secret/i;

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

  const compareCurrentSequenceDir = tempSequenceDir(env, 'compare-current');
  const compareBaselineSequenceDir = tempSequenceDir(env, 'compare-baseline');
  await ensureDir(compareCurrentSequenceDir);
  await ensureDir(compareBaselineSequenceDir);

  for (const entry of entries) {
    const baselineAppMap = baselineAppMapPath(env, entry);
    const currentAppMap = currentAppMapPath(env, entry);
    await assertExists(baselineAppMap, `Missing baseline AppMap for ${entry.test_name}`);
    await assertExists(currentAppMap, `Missing current AppMap for ${entry.test_name}`);

    const baselineSequence = await exportSequenceDiagram(env, baselineAppMap, compareBaselineSequenceDir, entry);
    const baseline = await normalizeSequenceFile(baselineSequence);
    const currentSequence = await exportSequenceDiagram(env, currentAppMap, compareCurrentSequenceDir, entry);
    const current = await normalizeSequenceFile(currentSequence);
    const diff = diffNormalizedSequences(baseline, current);
    const flaggedFindings = buildFindings(entry, diff);

    if (diff.changed) {
      report.changed += 1;
    }
    if (flaggedFindings.length > 0) {
      report.flagged += 1;
    }

    report.entries.push({
      feature: entry.feature,
      test_file: entry.test_file,
      test_name: entry.test_name,
      appmap_path: entry.appmap_path,
      changed: diff.changed,
      summary: diff.summary,
      findings: flaggedFindings,
      diff,
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

async function exportSequenceDiagram(env, appmapFile, outputDir, entry) {
  await ensureDir(outputDir);
  const before = new Set(await listJsonFiles(outputDir));
  const [bin, ...prefix] = env.config.appmap_cli.split(/\s+/).filter(Boolean);
  runCommand(
    bin,
    [...prefix, 'sequence-diagram', appmapFile, '--directory', env.workingDir, '--format', 'json', '--output-dir', outputDir],
    { cwd: env.workingDir },
  );
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

// ---------------------------------------------------------------------------
// Normalization + diff (the comparison surface)
// ---------------------------------------------------------------------------

async function normalizeSequenceFile(sequencePath) {
  const data = JSON.parse(await fs.readFile(sequencePath, 'utf8'));
  return {
    actors: (data.actors ?? [])
      .map((actor) => ({ id: actor.id ?? null, name: actor.name ?? null }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    rootActions: (data.rootActions ?? []).map(normalizeAction),
  };
}

function normalizeAction(action) {
  return {
    nodeType: action.nodeType ?? null,
    caller: action.caller ?? null,
    callee: action.callee ?? null,
    name: action.name ?? null,
    static: Boolean(action.static),
    elapsedBucket: bucketElapsed(action.elapsed),
    stable: {
      event_type: action.stableProperties?.event_type ?? null,
      id: action.stableProperties?.id ?? null,
      raises_exception: Boolean(action.stableProperties?.raises_exception),
    },
    returnValue: normalizeReturnValue(action.returnValue),
    sql: normalizeSql(action.query),
    children: (action.children ?? []).map(normalizeAction),
  };
}

function bucketElapsed(elapsedSeconds) {
  if (typeof elapsedSeconds !== 'number' || Number.isNaN(elapsedSeconds) || elapsedSeconds < 0) {
    return null;
  }
  const elapsedMs = elapsedSeconds * 1000;
  if (elapsedMs <= 0.1) return 'le_0.1ms';
  if (elapsedMs <= 1) return 'le_1ms';
  if (elapsedMs <= 10) return 'le_10ms';
  if (elapsedMs <= 100) return 'le_100ms';
  if (elapsedMs <= 1000) return 'le_1000ms';
  return 'gt_1000ms';
}

function normalizeReturnValue(returnValue) {
  if (!returnValue) {
    return null;
  }
  return {
    raisesException: Boolean(returnValue.raisesException),
    type: normalizeReturnType(returnValue.returnValueType),
  };
}

function normalizeReturnType(typeInfo) {
  if (!typeInfo) {
    return null;
  }
  return {
    name: typeInfo.name ?? null,
    properties: [...(typeInfo.properties ?? [])].sort(),
  };
}

// ---------------------------------------------------------------------------
// SQL fingerprinting
//
// The sequence diagram carries the full statement on each database action in
// `action.query` (appmap prefixes executemany with "-- N times"). The positional
// action diff deliberately ignores it: a benign projection change (a new SELECT
// column) would otherwise flag every query node, and the positional walk is
// already fragile to inserted frames. Instead we reduce each statement to a
// structural FINGERPRINT — operation + tables + filter (WHERE/JOIN/HAVING)
// columns — and diff the per-sequence MULTISET of fingerprints, order-independent.
// That surfaces the regressions a reviewer cares about while staying quiet on
// cosmetics:
//   - a dropped WHERE/JOIN predicate, or a query that no longer runs -> removed
//   - a new write, or a newly touched table                          -> added
//   - the same query now run more times (N+1 / fan-out)              -> count delta
//   - a new projected column (e.g. `abandoned_at`)         -> same fingerprint (quiet)
// Literals, bind params, projection lists, aliases, and whitespace are stripped.

const SQL_OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH'];

function normalizeSql(query) {
  if (typeof query !== 'string') return null;
  let text = query;
  // appmap collapses executemany into a "-- N times\n<stmt>" prefix.
  let repeat = 1;
  const repeatMatch = text.match(/^\s*--\s*(\d+|\?)\s*times\s*\r?\n/i);
  if (repeatMatch) {
    repeat = repeatMatch[1] === '?' ? null : Number(repeatMatch[1]);
    text = text.slice(repeatMatch[0].length);
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  // Transaction/session noise is not a behavioral signal.
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|SHOW|PRAGMA)\b/i.test(text)) return null;
  const op = (SQL_OPS.find((candidate) => new RegExp(`^${candidate}\\b`, 'i').test(text)) ?? 'OTHER').toUpperCase();
  return { op, tables: extractTables(text), filters: extractFilterColumns(text), repeat };
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
  // Columns in WHERE/ON/HAVING predicates — the access-control- and correctness-
  // relevant surface. Take each clause body up to the next clause boundary and
  // pull identifiers sitting immediately left of a comparison operator. Heuristic
  // but deterministic, which is all a fingerprint needs.
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

function sqlFingerprintKey(fingerprint) {
  return `${fingerprint.op} {${fingerprint.tables.join(',')}} [${fingerprint.filters.join(',')}]`;
}

function collectSqlProfile(rootActions) {
  const profile = new Map(); // key -> { fingerprint, count }
  const visit = (actions) => {
    for (const action of actions ?? []) {
      if (action.sql) {
        const key = sqlFingerprintKey(action.sql);
        const entry = profile.get(key) ?? { fingerprint: action.sql, count: 0 };
        entry.count += action.sql.repeat === null ? 1 : action.sql.repeat;
        profile.set(key, entry);
      }
      visit(action.children);
    }
  };
  visit(rootActions);
  return profile;
}

function diffSqlProfiles(baseline, current, changes) {
  const baseProfile = collectSqlProfile(baseline.rootActions ?? []);
  const currProfile = collectSqlProfile(current.rootActions ?? []);
  for (const [key, entry] of currProfile) {
    if (!baseProfile.has(key)) {
      changes.push({ type: 'sql_query_added', key, op: entry.fingerprint.op, tables: entry.fingerprint.tables, filters: entry.fingerprint.filters, count: entry.count });
    }
  }
  for (const [key, entry] of baseProfile) {
    if (!currProfile.has(key)) {
      changes.push({ type: 'sql_query_removed', key, op: entry.fingerprint.op, tables: entry.fingerprint.tables, filters: entry.fingerprint.filters, count: entry.count });
    }
  }
  for (const [key, entry] of currProfile) {
    const baseEntry = baseProfile.get(key);
    if (baseEntry && baseEntry.count !== entry.count) {
      changes.push({ type: 'sql_count_changed', key, op: entry.fingerprint.op, before: baseEntry.count, after: entry.count });
    }
  }
}

function diffNormalizedSequences(baseline, current) {
  const changes = [];

  const baselineActors = new Set((baseline.actors ?? []).map((actor) => actor.id));
  const currentActors = new Set((current.actors ?? []).map((actor) => actor.id));
  for (const actor of currentActors) {
    if (!baselineActors.has(actor)) {
      changes.push({ type: 'actor_added', actor });
    }
  }
  for (const actor of baselineActors) {
    if (!currentActors.has(actor)) {
      changes.push({ type: 'actor_removed', actor });
    }
  }

  diffActionLists(baseline.rootActions ?? [], current.rootActions ?? [], 'rootActions', changes);
  diffSqlProfiles(baseline, current, changes);

  // `elapsedBucket` is wall-clock timing: it drifts across bucket boundaries between two
  // recordings of identical code, so a timing-only delta is noise, not a behavioral change.
  // Keep it in `changes` (a dramatic le_1ms -> gt_1000ms shift is still worth a human glance),
  // but don't let it mark an entry changed/flagged on its own — otherwise every run flags timing
  // jitter, and an auth trace's jitter even raises a false high security-review.
  const isTimingOnly = (change) => change.type === 'action_changed' && change.field === 'elapsedBucket';
  const behavioralChanges = changes.filter((change) => !isTimingOnly(change));

  return {
    changed: behavioralChanges.length > 0,
    summary: summarizeChanges(changes),
    changes,
  };
}

function diffActionLists(baselineActions, currentActions, pathLabel, changes) {
  const count = Math.max(baselineActions.length, currentActions.length);
  for (let index = 0; index < count; index += 1) {
    const baselineAction = baselineActions[index];
    const currentAction = currentActions[index];
    const currentPath = `${pathLabel}[${index}]`;
    if (!baselineAction && currentAction) {
      changes.push({ type: 'action_added', path: currentPath, id: currentAction.stable.id, name: currentAction.name });
      continue;
    }
    if (baselineAction && !currentAction) {
      changes.push({ type: 'action_removed', path: currentPath, id: baselineAction.stable.id, name: baselineAction.name });
      continue;
    }
    diffAction(baselineAction, currentAction, currentPath, changes);
  }
}

function diffAction(baselineAction, currentAction, currentPath, changes) {
  const fields = [
    ['caller', baselineAction.caller, currentAction.caller],
    ['callee', baselineAction.callee, currentAction.callee],
    ['name', baselineAction.name, currentAction.name],
    ['static', baselineAction.static, currentAction.static],
    ['elapsedBucket', baselineAction.elapsedBucket, currentAction.elapsedBucket],
    ['stable.id', baselineAction.stable.id, currentAction.stable.id],
    ['stable.event_type', baselineAction.stable.event_type, currentAction.stable.event_type],
    ['stable.raises_exception', baselineAction.stable.raises_exception, currentAction.stable.raises_exception],
    ['returnValue', JSON.stringify(baselineAction.returnValue), JSON.stringify(currentAction.returnValue)],
  ];

  for (const [field, baselineValue, currentValue] of fields) {
    if (baselineValue !== currentValue) {
      changes.push({
        type: 'action_changed',
        path: currentPath,
        field,
        before: baselineValue,
        after: currentValue,
        id: currentAction.stable.id ?? baselineAction.stable.id,
        name: currentAction.name ?? baselineAction.name,
      });
    }
  }

  diffActionLists(baselineAction.children, currentAction.children, `${currentPath}.children`, changes);
}

function summarizeChanges(changes) {
  if (changes.length === 0) {
    return 'No structural behavior changes after normalization.';
  }
  const counts = new Map();
  for (const change of changes) {
    counts.set(change.type, (counts.get(change.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${count} ${type.replaceAll('_', ' ')}`)
    .join(', ');
}

function buildFindings(entry, diff) {
  if (!diff.changed) {
    return [];
  }

  const findings = [];
  const securityRelevant = entry.feature === 'auth' || diff.changes.some((change) => securityPattern.test(JSON.stringify(change)));
  if (securityRelevant) {
    findings.push({
      severity: 'high',
      category: 'security-review',
      message: 'Behavior changed in a security-sensitive area. Review auth, token, session, identity, or permission side effects.',
    });
  }

  const exceptionChanges = diff.changes.filter(
    (change) => change.type === 'action_changed' && (change.field === 'stable.raises_exception' || change.field === 'returnValue'),
  );
  if (exceptionChanges.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'exception-behavior',
      message: 'Exception or return-shape behavior changed. Check whether new failures, suppressed failures, or validation changes are intentional.',
    });
  }

  const actorChanges = diff.changes.filter((change) => change.type === 'actor_added' || change.type === 'actor_removed');
  if (actorChanges.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'side-effects',
      message: 'The set of participating packages changed. Review for unexpected new dependencies or side effects.',
    });
  }

  // A vanished query shape is the access-control & correctness red flag: a dropped
  // WHERE/JOIN predicate (fog-of-war / authorization filter), or a guard read that
  // no longer runs. High on a security-relevant path, medium otherwise.
  const sqlRemoved = diff.changes.filter((change) => change.type === 'sql_query_removed');
  if (sqlRemoved.length > 0) {
    findings.push({
      severity: securityRelevant || sqlRemoved.some((change) => change.op === 'SELECT') ? 'high' : 'medium',
      category: 'sql-query-removed',
      message: 'A SQL query shape disappeared from this path (a dropped WHERE/JOIN predicate, a guard query that no longer runs, or a removed read). Confirm no access-control or correctness check was lost.',
    });
  }

  // A new write or newly-touched table is a side effect worth confirming.
  const sqlWritesAdded = diff.changes.filter(
    (change) => change.type === 'sql_query_added' && (change.op === 'INSERT' || change.op === 'UPDATE' || change.op === 'DELETE'),
  );
  if (sqlWritesAdded.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'sql-write-added',
      message: 'A new INSERT/UPDATE/DELETE shape appears on this path. Confirm the new write is intended.',
    });
  }

  // Same query shape, more executions => N+1 / fan-out (often a query inside a loop).
  const sqlFanOut = diff.changes.filter((change) => change.type === 'sql_count_changed' && change.after > change.before);
  if (sqlFanOut.length > 0) {
    findings.push({
      severity: 'medium',
      category: 'sql-n-plus-one',
      message: 'A SQL query shape now runs more times than the baseline (possible N+1 / fan-out). Check for a query issued inside a loop.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'low',
      category: 'behavior-change',
      message: 'Normalized call structure changed. Review whether the trace delta matches the intended feature work.',
    });
  }

  return findings;
}

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
    if (entry.diff.changes.length > 0) {
      lines.push('- Changes:');
      for (const change of entry.diff.changes.slice(0, 20)) {
        lines.push(`  - ${formatChange(change)}`);
      }
      if (entry.diff.changes.length > 20) {
        lines.push(`  - ... ${entry.diff.changes.length - 20} more changes`);
      }
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function formatChange(change) {
  if (change.type === 'actor_added' || change.type === 'actor_removed') {
    return `${change.type.replaceAll('_', ' ')}: ${change.actor}`;
  }
  if (change.type === 'action_added' || change.type === 'action_removed') {
    return `${change.type.replaceAll('_', ' ')} at ${change.path}: ${change.id ?? change.name}`;
  }
  if (change.type === 'sql_query_added' || change.type === 'sql_query_removed') {
    const filters = change.filters && change.filters.length ? ` filter[${change.filters.join(',')}]` : '';
    return `${change.type.replaceAll('_', ' ')}: ${change.op} {${change.tables.join(',')}}${filters} (x${change.count})`;
  }
  if (change.type === 'sql_count_changed') {
    return `sql count changed: ${change.key} ${change.before} -> ${change.after}`;
  }
  return `${change.type.replaceAll('_', ' ')} at ${change.path} field ${change.field}: ${change.before} -> ${change.after}`;
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

function runCommand(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    throw new Error(`Command failed to start: ${command} (${result.error.message})`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
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

export { parseYaml, normalizeSql, sqlFingerprintKey, normalizeAction, diffNormalizedSequences };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
