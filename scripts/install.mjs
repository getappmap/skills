#!/usr/bin/env node

// Link every skill in this checkout into a skills directory, so an agent uses
// the checkout's copy of each one.
//
//   node scripts/install.mjs [--dir DIR] [--dry-run]
//   node scripts/install.mjs --uninstall [--dir DIR] [--released DIR] [--dry-run]
//
// A skill is a directory at the top of the checkout with a SKILL.md. Each gets a link of the same
// name in DIR (default: ~/.claude/skills). The skills call each other's
// scripts by relative path, so they work only when all of them come from the
// same place; linking some from here and some from a release mixes versions.
//
// What it changes in DIR, and nothing else:
//   - adds a link for each skill that has none;
//   - repoints a link of that name that goes somewhere else;
//   - removes a link that points into this checkout at a skill that is gone.
// A real file or directory of the same name is left alone and reported.
//
// --uninstall undoes it: every link in DIR that points into this checkout goes
// back to the released copy of that skill (in ~/.appmap/skills, where the
// AppMap extension for VS Code keeps them), or is removed when there is no
// released copy. Links that point anywhere else are not touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The checkout: this script lives in its scripts/ directory.
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args) {
  const options = {
    dir: path.join(os.homedir(), '.claude', 'skills'),
    released: path.join(os.homedir(), '.appmap', 'skills'),
    uninstall: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--dir' || arg === '--released') {
      index += 1;
      if (args[index] === undefined) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = path.resolve(args[index]);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** The link's target as an absolute path, or null when `file` is not a link. */
function linkTarget(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined; // nothing there
  }
  if (!stat.isSymbolicLink()) return null;
  return path.resolve(path.dirname(file), fs.readlinkSync(file));
}

export function plan(repo, dir) {
  const skills = fs
    .readdirSync(repo, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repo, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  const steps = [];
  for (const name of skills) {
    const link = path.join(dir, name);
    const source = path.join(repo, name);
    const target = linkTarget(link);
    if (target === undefined) steps.push({ action: 'add', name, link, source });
    else if (target === null) steps.push({ action: 'skip', name, link, why: 'a real file or directory is there, not a link' });
    else if (target === source) steps.push({ action: 'keep', name, link });
    else steps.push({ action: 'repoint', name, link, source, was: target });
  }
  // Links left behind by a skill this checkout no longer has.
  let existing = [];
  try {
    existing = fs.readdirSync(dir);
  } catch {
    existing = [];
  }
  for (const name of existing.sort()) {
    if (skills.includes(name)) continue;
    const link = path.join(dir, name);
    const target = linkTarget(link);
    if (target && path.dirname(target) === repo && !fs.existsSync(target)) {
      steps.push({ action: 'remove', name, link, was: target });
    }
  }
  return steps;
}

/** The steps that undo an install: each link in `dir` that points into `repo` goes back to the
 * skill of the same name in `released`, or is removed when `released` has none. */
export function planUninstall(repo, dir, released) {
  let existing = [];
  try {
    existing = fs.readdirSync(dir);
  } catch {
    existing = [];
  }
  const steps = [];
  for (const name of existing.sort()) {
    const link = path.join(dir, name);
    const target = linkTarget(link);
    if (!target || path.dirname(target) !== repo) continue;
    const source = path.join(released, name);
    if (fs.existsSync(path.join(source, 'SKILL.md'))) steps.push({ action: 'restore', name, link, source });
    else steps.push({ action: 'remove', name, link, why: 'no released copy' });
  }
  return steps;
}

export function apply(steps) {
  for (const step of steps) {
    if (['repoint', 'restore', 'remove'].includes(step.action)) fs.unlinkSync(step.link);
    if (['add', 'repoint', 'restore'].includes(step.action)) {
      fs.mkdirSync(path.dirname(step.link), { recursive: true });
      // A junction needs no special permission on Windows; elsewhere the type is ignored.
      fs.symlinkSync(step.source, step.link, 'junction');
    }
  }
}

function describe(step) {
  switch (step.action) {
    case 'add':
      return `add      ${step.name}`;
    case 'repoint':
      return `repoint  ${step.name}  (was ${step.was})`;
    case 'restore':
      return `restore  ${step.name}  (to ${step.source})`;
    case 'remove':
      return `remove   ${step.name}  (${step.why ?? `pointed at ${step.was}, which is gone`})`;
    case 'keep':
      return `keep     ${step.name}`;
    default:
      return `skip     ${step.name}  (${step.why})`;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/install.mjs [--dir DIR] [--dry-run]
       node scripts/install.mjs --uninstall [--dir DIR] [--released DIR] [--dry-run]

Links every skill in this checkout into DIR (default: ~/.claude/skills).
--uninstall points each of those links back at the released copy of the skill in
the --released directory (default: ~/.appmap/skills, kept by the AppMap extension
for VS Code), and removes a link whose skill has no released copy.
--dry-run prints what would change and changes nothing.`);
    return;
  }
  if (options.uninstall) {
    const steps = planUninstall(checkout, options.dir, options.released);
    console.log(
      `${options.dryRun ? 'Would put' : 'Putting'} back the released skills from ${options.released} in ${options.dir}:`,
    );
    for (const step of steps) console.log(`  ${describe(step)}`);
    if (steps.length === 0) console.log(`  nothing to do: no link there points into ${checkout}`);
    if (!options.dryRun) apply(steps);
    return;
  }
  const steps = plan(checkout, options.dir);
  console.log(`${options.dryRun ? 'Would link' : 'Linking'} the skills in ${checkout} into ${options.dir}:`);
  for (const step of steps) console.log(`  ${describe(step)}`);
  if (!options.dryRun) apply(steps);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
