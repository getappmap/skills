#!/usr/bin/env node

// Make an AppMap archive from loose recordings, without touching them.
//
//   node <skill>/assets/archive.mjs --revision base --out base.tar <recording or directory>...
//
// The helper copies the recordings into one temporary directory, each at the
// path it will have in the archive, and archives that copy. So a list of files
// and directories becomes one archive, and the originals are never written to.
//
// With an AppMap CLI whose archive takes --appmap-dir, that is one command:
// `archive --appmap-dir <copy> --revision <name> --output-file <out>`, and no
// appmap.yml is needed. An older CLI indexes only the appmap_dir named by an
// appmap.yml in its working directory, puts its tar under that directory, and
// mangles an absolute --output-file; for it the helper also copies the
// project's appmap.yml in, archives there, and copies the tar out.
//
// `appmap compare` pairs a recording on one side with the recording at the same
// path on the other. A file is archived under its own name and a directory's
// recordings under their paths below it; two that would share a path are refused.
//
// Needs Node and the AppMap CLI. Run it inside the project, so the nearest
// appmap.yml above the current directory is the one used (an older CLI needs
// one; a newer CLI uses it when it is there).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// The appmap.yml lookup and the CLI resolution are the gold-traces engine's.
import { locateAppmap, defaultAppmapCli } from '../../appmap-gold-traces/assets/manage.mjs';

async function main() {
  const { options, inputs } = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await archive(options, inputs);
}

function parseArgs(args) {
  const options = { help: false, revision: null, out: null, appmapCli: null };
  const valued = { '--revision': 'revision', '--out': 'out', '--appmap-cli': 'appmapCli' };
  const inputs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg in valued) {
      index += 1;
      if (args[index] === undefined) throw new Error(`${arg} needs a value.`);
      options[valued[arg]] = args[index];
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }
  return { options, inputs };
}

function printHelp() {
  console.log(`Usage:
  node <skill>/assets/archive.mjs --revision NAME --out FILE.tar [--appmap-cli CMD] PATH...

Makes an AppMap archive from recordings, working on a copy so the recordings and
the project are left as they were.

  --revision NAME   The name the archive is made under: a commit SHA, or a label such as base.
  --out FILE.tar    Where to write it. An existing file is not overwritten.
  --appmap-cli CMD  The AppMap CLI to run (default: ~/.appmap/bin/appmap if present, else
                    appmap on PATH).
  PATH...           Recordings (.appmap.json) and directories of them. A file is archived
                    under its own name, a directory's recordings under their paths below it.
                    Two recordings that would get the same path are refused.
  --help            Show this help.

Run it inside the project: the nearest appmap.yml above the current directory is used.
An AppMap CLI whose archive command has --appmap-dir works without one.
`);
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

async function archive(options, inputs) {
  if (!options.revision) {
    throw new Error('--revision NAME is required: a commit SHA, or a label such as base.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.revision)) {
    throw new Error(`--revision ${options.revision} becomes a file name; use letters, digits, '.', '_' and '-' only.`);
  }
  if (!options.out) {
    throw new Error('--out FILE.tar is required: where to write the archive.');
  }
  const outFile = path.resolve(options.out);
  if (await exists(outFile)) {
    throw new Error(`Refusing to overwrite ${outFile}. Remove it, or name another --out.`);
  }
  const planned = await planArchive(inputs);
  const cli = cliInvocation(options.appmapCli ?? defaultAppmapCli());
  // A CLI whose archive takes --appmap-dir archives a directory as it is, writes the
  // tar where it is told, and needs no appmap.yml. An older one needs all three
  // arranged for it.
  const direct = cliArchivesDirectory(cli);
  let located = null;
  try {
    located = await locateAppmap(process.cwd());
  } catch (error) {
    if (!direct) throw error;
  }
  const appmapYml = located && path.join(located.appmapYmlDir, 'appmap.yml');
  const appmapDir = direct ? 'recordings' : located.appmapDir;
  if (path.isAbsolute(appmapDir) || appmapDir.split(/[\\/]/).includes('..')) {
    throw new Error(`appmap_dir in ${appmapYml} is '${appmapDir}', which points outside the project; the archive is made from a copy, so it needs a path inside the project.`);
  }

  // Either way the recordings are copied first: the list becomes one directory with
  // each recording at its planned path, and the originals are never written to.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'appmap-archive-'));
  try {
    if (appmapYml) await fs.copyFile(appmapYml, path.join(work, 'appmap.yml'));
    for (const [name, source] of planned) {
      const target = path.join(work, appmapDir, ...name.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    if (direct) {
      runCli(cli, ['archive', '--appmap-dir', path.join(work, appmapDir), '--revision', options.revision, '--output-file', outFile], work);
    } else {
      runCli(cli, ['archive', '--revision', options.revision], work);
      await fs.copyFile(path.join(work, '.appmap', 'archive', 'full', `${options.revision}.tar`), outFile);
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  console.log(`Archive:  ${outFile}`);
  console.log(`Revision: ${options.revision}`);
  console.log(`Config:   ${appmapYml ?? 'none (no appmap.yml above the current directory)'}`);
  console.log(`Recordings: ${planned.size}`);
  for (const name of [...planned.keys()].sort()) console.log(`  ${name.replace(/\.appmap\.json$/, '')}`);
  console.log('');
  console.log('Compare it with another: appmap-review/assets/review.mjs compare --base-archive <tar> --head-archive <tar>.');
  console.log('A recording pairs with the one at the same path in the other archive.');
}

// Which recording goes at which path in the archive: Map of path (with '/')
// to source file. A file keeps its name; a directory's recordings keep their
// paths below it. `appmap compare` pairs the two sides by these paths, so two
// recordings that would share one are refused, never silently overwritten.
export async function planArchive(inputs) {
  if (inputs.length === 0) {
    throw new Error('Name at least one recording (.appmap.json) or directory of recordings.');
  }
  const planned = new Map();
  const add = (relative, source) => {
    const name = relative.split(path.sep).join('/');
    if (planned.has(name)) {
      throw new Error(
        `Two recordings would both be archived as ${name}:\n  ${planned.get(name)}\n  ${source}\n` +
          'Pass a directory that holds both, or rename one, so each keeps a path of its own.',
      );
    }
    planned.set(name, source);
  };
  for (const input of inputs) {
    const full = path.resolve(input);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Recording not found: ${full}`);
      throw error;
    }
    if (stat.isDirectory()) {
      const found = await listAppmaps(full);
      if (found.length === 0) throw new Error(`No recordings (.appmap.json) under ${full}.`);
      for (const relative of found) add(relative, path.join(full, relative));
    } else if (full.endsWith('.appmap.json')) {
      add(path.basename(full), full);
    } else {
      throw new Error(`Not an AppMap recording: ${full}. Expected a .appmap.json file or a directory.`);
    }
  }
  return planned;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function listAppmaps(root, dir = root) {
  const found = [];
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) found.push(...(await listAppmaps(root, full)));
    else if (dirent.name.endsWith('.appmap.json')) found.push(path.relative(root, full));
  }
  return found;
}

// Whether this CLI's 'archive' takes --appmap-dir (and with it an --output-file
// used as given). Asked of the CLI itself, since one built from source reports
// an older version.
function cliArchivesDirectory(cli) {
  try {
    // Not in the working directory: the CLI leaves .appmap/run-stats wherever it runs.
    return runCli(cli, ['archive', '--help'], os.tmpdir()).includes('--appmap-dir');
  } catch {
    return false;
  }
}

function cliInvocation(appmapCli) {
  const [bin, ...prefix] = appmapCli.split(/\s+/).filter(Boolean);
  return { bin, prefix };
}

// Quiet on success; the CLI prints progress for every AppMap.
function runCli(cli, args, cwd) {
  const result = spawnSync(cli.bin, [...cli.prefix, ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const command = [cli.bin, ...cli.prefix, ...args].join(' ');
  if (result.error) {
    throw new Error(`Could not start the AppMap CLI: ${command} (${result.error.message}).`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Command failed in ${cwd}: ${command}\n${detail}`);
  }
  return result.stdout;
}

function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (invokedAsScript()) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
