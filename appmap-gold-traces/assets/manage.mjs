#!/usr/bin/env node

// Gold-traces maintenance for the appmap-gold-traces skill.
//
// Config-driven and dependency-free: project-specific commands and paths live in
// <dir>/config.yaml; the curated recording list lives in <dir>/appmap_golden_set.yaml.
// Run from the target project root:
//
//   node <skill>/assets/manage.mjs update --dir gold_traces --record
//   node <skill>/assets/manage.mjs update --dir gold_traces --only test_foo --dry-run
//
// It does two things — record the gold tests, and BLESS the baselines — and nothing
// else. Diffing and interpreting a change (regression? unintended side effect?) is the
// appmap-review skill's job, not this engine's.
//
// The bless is DIGEST-GATED. Raw appmaps differ on every recording (timestamps,
// event/object ids), so a blind copy would churn every baseline in git. Instead, for
// each entry we export both the fresh recording and the committed baseline to AppMap's
// JSON sequence diagram and compare a single digest over the root subtree digests —
// which carries only AppMap `stableProperties` (normalized SQL, code-object identity,
// exceptions) and excludes volatile data (elapsed time, ids, values). A baseline is
// re-blessed only when that digest changed, so untouched baselines stay byte-identical.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

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
  throw new Error(
    `Unknown command: ${command}. This engine only maintains baselines ('update'). ` +
      `To diff/review a change, use the appmap-review skill.`,
  );
}

function parseArgs(args) {
  const options = {
    help: false,
    dir: 'gold_traces',
    includeOptional: false,
    record: false,
    dryRun: false,
    only: [],
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
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--only') {
      index += 1;
      if (args[index]) {
        options.only.push(args[index]);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, options };
}

function printHelp() {
  console.log(`Usage:
  node <skill>/assets/manage.mjs update [--dir DIR] [--include-optional] [--only TEST] [--record] [--dry-run]

Maintains the committed gold-trace baselines. Diffing/reviewing a change is the
appmap-review skill's job, not this engine's.

  update   Re-bless baselines, but only the traces whose behavior changed
           (digest-gated, so untouched baselines stay byte-identical). Seeds a
           baseline for any manifest entry that doesn't have one yet.

Options:
  --dir DIR           Managed gold-traces directory, relative to the project root (default: gold_traces).
  --include-optional  Include manifest entries from the optional list.
  --only TEST         Limit to the named test (repeatable).
  --record            Re-record each selected test first (needs commands.record in config).
  --dry-run           Report what would be blessed/seeded without writing anything.
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
    // for the digest (every recorded function is still a node).
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
// update — record + digest-gated bless
// ---------------------------------------------------------------------------

async function updateBaseline(env, entries, options) {
  if (options.record) {
    await rerecordEntries(env, entries);
  }

  const freshSeqDir = tempSequenceDir(env, 'update-current');
  const baseSeqDir = tempSequenceDir(env, 'update-baseline');
  await ensureDir(freshSeqDir);
  await ensureDir(baseSeqDir);

  let blessed = 0;
  let seeded = 0;
  let unchanged = 0;

  for (const entry of entries) {
    const freshAppMap = currentAppMapPath(env, entry);
    await assertExists(freshAppMap, `Missing AppMap for ${entry.test_name} (record it first)`);
    const baselineAppMap = baselineAppMapPath(env, entry);

    // No committed baseline yet: seed it (new manifest entry).
    if ((await readFileOrNull(baselineAppMap)) === null) {
      if (!options.dryRun) {
        await ensureDir(path.dirname(baselineAppMap));
        await fs.copyFile(freshAppMap, baselineAppMap);
      }
      seeded += 1;
      console.log(`  seed   ${entry.test_name}`);
      continue;
    }

    // Digest-gate: only re-bless when behavior actually changed.
    const freshDigest = diagramDigest(await readJson(await exportSequenceDiagram(env, freshAppMap, freshSeqDir, entry)));
    const baseDigest = diagramDigest(await readJson(await exportSequenceDiagram(env, baselineAppMap, baseSeqDir, entry)));
    if (freshDigest === baseDigest) {
      unchanged += 1;
      continue;
    }

    if (!options.dryRun) {
      await fs.copyFile(freshAppMap, baselineAppMap);
    }
    blessed += 1;
    console.log(`  bless  ${entry.test_name}`);
  }

  const verb = options.dryRun ? 'Would bless' : 'Blessed';
  console.log(`${verb} ${blessed}, seeded ${seeded}, unchanged ${unchanged} (of ${entries.length}).`);
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
// AppMap CLI surface + digest
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

// A single sha256 over the diagram's root subtree digests (mirrors @appland/cli's
// SequenceDiagramDigest). The subtree digests carry only AppMap `stableProperties`,
// so elapsed time, object ids, and value-level volatility are already excluded.
function diagramDigest(diagram) {
  const hash = createHash('sha256');
  for (const action of diagram.rootActions ?? []) {
    hash.update(action.subtreeDigest ?? '');
  }
  return hash.digest('hex');
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

export { parseYaml, diagramDigest };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
