// @ts-check
//
// Test-framework registry for the gold-traces engine.
//
// The manifest names a framework (`commands.framework: pytest`) and, if needed, the
// launcher (`commands.runner`) and trailing flags (`commands.args`). This module
// owns the part that is the same in every project and easy to get wrong: how a
// framework names one test on its command line, and how it names several tests in
// one invocation so the whole gold set can be recorded in a few processes instead
// of one per test.
//
// Each framework exposes `plan(entries)`: it groups the manifest entries into as few
// runner invocations as the framework's selector grammar allows and returns, per
// group, the entries it covers and the selector arguments. The engine turns a group
// into a shell command with `buildCommand` and records the group's entries together.
//
// Three selector shapes exist and each framework uses one:
//
//   one selector per test, space-joined   pytest, unittest, rspec (file:line),
//                                         rails-test (file:line), gradle (--tests)
//   files once, plus ONE name regex       minitest -n, rails-test -n, jest -t,
//                                         vitest -t, mocha --grep
//   one comma list with its own grammar   maven -Dtest=Class#a+b,Other#c
//
// Every AppMap agent still writes one recording per test inside a batch run, so an
// entry's appmap_path is unchanged by batching.

import path from 'node:path';
import process from 'node:process';
import { accessSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * @typedef {{ test_file: string, test_name: string }} Entry
 * @typedef {{ entries: Entry[], args: string[] }} Group
 * @typedef {{
 *   runner: string,
 *   detectRunner?: (cwd: string) => string | null,
 *   runnerNote?: string,
 *   env: Record<string, string>,
 *   testName: string,
 *   plan: (entries: Entry[]) => Group[],
 * }} Framework
 */

// ---------------------------------------------------------------------------
// Launcher detection
// ---------------------------------------------------------------------------
//
// The default launcher is chosen per project when `commands.runner` is unset.
// The cases worth detecting are the ones where the plain command would run the
// wrong thing:
//
//   Python  `appmap-python` sets a few APPMAP_* variables and then execs the
//           command it was given, found through PATH. It does not put its own
//           virtualenv on PATH, so `.venv/bin/appmap-python pytest` runs whatever
//           pytest the shell finds, from a different interpreter, and records
//           nothing. Name both tools by path. uv, Poetry, and Pipenv fix PATH
//           themselves, so `<tool> run appmap-python pytest` is enough there.
//   Java    Prefer the project's wrapper script (`mvnw`, `gradlew`) when present.
//
// Node needs nothing: `npx` resolves node_modules/.bin under npm, yarn, and pnpm.
// Ruby needs nothing: `bundle exec` is universal.

function fileExists(cwd, relative) {
  try {
    accessSync(path.join(cwd, relative));
    return true;
  } catch {
    return false;
  }
}

/** The venv's scripts dir, if a venv with appmap-python installed sits in cwd. */
function venvBin(cwd) {
  for (const venv of ['.venv', 'venv']) {
    for (const bin of ['bin', 'Scripts']) {
      if (fileExists(cwd, `${venv}/${bin}/appmap-python`)) return `${venv}/${bin}`;
    }
  }
  return null;
}

/**
 * @param {string} cwd
 * @param {string} tool  the command after appmap-python: `pytest` or `python -m unittest`
 */
function pythonLauncher(cwd, tool) {
  const bin = venvBin(cwd);
  if (bin) {
    const [exe, ...rest] = tool.split(' ');
    return [`${bin}/appmap-python`, `${bin}/${exe}`, ...rest].join(' ');
  }
  if (fileExists(cwd, 'uv.lock')) return `uv run appmap-python ${tool}`;
  if (fileExists(cwd, 'poetry.lock')) return `poetry run appmap-python ${tool}`;
  if (fileExists(cwd, 'Pipfile.lock') || fileExists(cwd, 'Pipfile')) return `pipenv run appmap-python ${tool}`;
  return null;
}

const PYTHON_RUNNER_NOTE = 'detected: .venv or venv (both tools by path), else uv.lock, poetry.lock, or Pipfile';

// A `#` starts a comment only at the start of a word, so `-Dtest=Foo#bar` is safe bare.
const SAFE_ARG = /^[\w./:@=+,%-][\w./:@=+,%#-]*$/;

/** Quote one argument for `sh`. Plain path-like tokens pass through untouched. */
export function shellQuote(arg) {
  return SAFE_ARG.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function isLineNumber(name) {
  return /^\d+$/.test(String(name));
}

/** Regex alternation over test names. One name stays a plain (escaped) string. */
function nameUnion(names) {
  const escaped = names.map((name) => escapeRegex(String(name)));
  return escaped.length === 1 ? escaped[0] : `(${escaped.join('|')})`;
}

/** Group entries by test_file, preserving manifest order within each file. */
function byFile(entries) {
  /** @type {Map<string, Entry[]>} */
  const groups = new Map();
  for (const entry of entries) {
    const list = groups.get(entry.test_file) ?? [];
    list.push(entry);
    groups.set(entry.test_file, list);
  }
  return [...groups.entries()];
}

function uniqueFiles(entries) {
  return [...new Set(entries.map((entry) => entry.test_file))];
}

/** `tests/test_a.py` -> `tests.test_a`; an already-dotted module name passes through. */
function pythonModule(testFile) {
  return testFile.replace(/^\.\//, '').replace(/\.py$/, '').replace(/[\\/]/g, '.');
}

/**
 * Java: `test_name` is `Class#method` or `Class.method`. When it carries no class,
 * the class is the test file's basename (`src/test/java/.../FooTest.java` -> FooTest).
 */
function javaTarget(entry) {
  const name = String(entry.test_name);
  const match = /^(.*)[#.]([^#.]+)$/.exec(name);
  if (match) return { className: match[1], method: match[2] };
  return { className: path.basename(String(entry.test_file)).replace(/\.(java|kt|scala|groovy)$/, ''), method: name };
}

/**
 * Split a file's entries into a `file:line` group (numeric names) and a named group,
 * so a line selector and a name filter never share one invocation.
 */
function splitLinesAndNames(entries) {
  return {
    lines: entries.filter((entry) => isLineNumber(entry.test_name)),
    names: entries.filter((entry) => !isLineNumber(entry.test_name)),
  };
}

/** @type {Record<string, Framework>} */
export const FRAMEWORKS = {
  pytest: {
    runner: 'appmap-python pytest',
    detectRunner: (cwd) => pythonLauncher(cwd, 'pytest'),
    runnerNote: PYTHON_RUNNER_NOTE,
    env: {},
    testName: 'the node id after the file: test_x, or TestY::test_z for a method',
    plan(entries) {
      return [{ entries, args: entries.map((entry) => `${entry.test_file}::${entry.test_name}`) }];
    },
  },

  unittest: {
    runner: 'appmap-python python -m unittest',
    detectRunner: (cwd) => pythonLauncher(cwd, 'python -m unittest'),
    runnerNote: PYTHON_RUNNER_NOTE,
    env: {},
    testName: 'TestClass.test_method; test_file is the module file (tests/test_a.py)',
    plan(entries) {
      return [{ entries, args: entries.map((entry) => `${pythonModule(entry.test_file)}.${entry.test_name}`) }];
    },
  },

  rspec: {
    runner: 'bundle exec rspec',
    env: { APPMAP: 'true' },
    testName: 'the example description (matched with -e), or the example\'s line number',
    plan(entries) {
      const { lines, names } = splitLinesAndNames(entries);
      /** @type {Group[]} */
      const groups = [];
      if (lines.length > 0) {
        groups.push({ entries: lines, args: lines.map((entry) => `${entry.test_file}:${entry.test_name}`) });
      }
      for (const [file, fileEntries] of byFile(names)) {
        groups.push({ entries: fileEntries, args: [file, ...fileEntries.flatMap((entry) => ['-e', String(entry.test_name)])] });
      }
      return groups;
    },
  },

  minitest: {
    runner: 'bundle exec ruby -Itest',
    env: { APPMAP: 'true' },
    testName: 'the test method name (test_foo); one invocation per test file',
    plan(entries) {
      return byFile(entries).map(([file, fileEntries]) => {
        const names = fileEntries.map((entry) => String(entry.test_name));
        const filter = names.length === 1 ? names[0] : `/^${nameUnion(names)}$/`;
        return { entries: fileEntries, args: [file, '-n', filter] };
      });
    },
  },

  'rails-test': {
    runner: 'bin/rails test',
    env: { APPMAP: 'true' },
    testName: 'the test method name, or the test\'s line number',
    plan(entries) {
      const { lines, names } = splitLinesAndNames(entries);
      /** @type {Group[]} */
      const groups = [];
      if (lines.length > 0) {
        groups.push({ entries: lines, args: lines.map((entry) => `${entry.test_file}:${entry.test_name}`) });
      }
      for (const [file, fileEntries] of byFile(names)) {
        const testNames = fileEntries.map((entry) => String(entry.test_name));
        const filter = testNames.length === 1 ? testNames[0] : `/^${nameUnion(testNames)}$/`;
        groups.push({ entries: fileEntries, args: [file, '-n', filter] });
      }
      return groups;
    },
  },

  jest: {
    runner: 'npx appmap-node npx jest',
    env: {},
    testName: 'the test title as jest prints it (matched as a -t regex)',
    plan(entries) {
      return [{ entries, args: [...uniqueFiles(entries), '-t', nameUnion(entries.map((entry) => entry.test_name))] }];
    },
  },

  vitest: {
    runner: 'npx appmap-node npx vitest run',
    env: {},
    testName: 'the test title (matched as a -t regex)',
    plan(entries) {
      return [{ entries, args: [...uniqueFiles(entries), '-t', nameUnion(entries.map((entry) => entry.test_name))] }];
    },
  },

  mocha: {
    runner: 'npx appmap-node npx mocha',
    env: {},
    testName: 'the test title (matched as a --grep regex)',
    plan(entries) {
      return [{ entries, args: [...uniqueFiles(entries), '--grep', nameUnion(entries.map((entry) => entry.test_name))] }];
    },
  },

  maven: {
    runner: 'mvn test',
    detectRunner: (cwd) => (fileExists(cwd, 'mvnw') ? './mvnw test' : null),
    runnerNote: 'detected: ./mvnw when the wrapper is present',
    env: {},
    testName: 'Class#method or Class.method; a bare method name takes the class from the file name',
    plan(entries) {
      /** @type {Map<string, string[]>} */
      const methodsByClass = new Map();
      for (const entry of entries) {
        const { className, method } = javaTarget(entry);
        const methods = methodsByClass.get(className) ?? [];
        if (!methods.includes(method)) methods.push(method);
        methodsByClass.set(className, methods);
      }
      const spec = [...methodsByClass.entries()].map(([className, methods]) => `${className}#${methods.join('+')}`).join(',');
      return [{ entries, args: [`-Dtest=${spec}`, '-Dsurefire.failIfNoSpecifiedTests=false'] }];
    },
  },

  gradle: {
    runner: 'gradle appmap test',
    detectRunner: (cwd) => (fileExists(cwd, 'gradlew') ? './gradlew appmap test' : null),
    runnerNote: 'detected: ./gradlew when the wrapper is present',
    env: {},
    testName: 'Class.method or Class#method; a bare method name takes the class from the file name',
    plan(entries) {
      const seen = new Set();
      const args = [];
      for (const entry of entries) {
        const { className, method } = javaTarget(entry);
        const selector = `${className}.${method}`;
        if (seen.has(selector)) continue;
        seen.add(selector);
        args.push('--tests', selector);
      }
      return [{ entries, args }];
    },
  },
};

export function frameworkNames() {
  return Object.keys(FRAMEWORKS);
}

/**
 * @param {string} name
 * @returns {Framework}
 */
export function getFramework(name) {
  const framework = FRAMEWORKS[name];
  if (!framework) {
    throw new Error(`Unknown commands.framework '${name}'. Supported: ${frameworkNames().join(', ')}.`);
  }
  return framework;
}

/**
 * The launcher for a project: `commands.runner` if set, else the framework's
 * detection for the directory the commands run from, else its plain default.
 * @param {{ framework: string, runner?: string | null }} commands
 * @param {string} [cwd]
 */
export function resolveRunner(commands, cwd = process.cwd()) {
  const framework = getFramework(commands.framework);
  return commands.runner ?? framework.detectRunner?.(cwd) ?? framework.runner;
}

/**
 * Build the shell command for one group: `<runner> <selectors> <args>`.
 * @param {{ framework: string, runner?: string | null, args?: string | null }} commands
 * @param {Group} group
 * @param {string} [cwd]  where the command runs; used for launcher detection
 */
export function buildCommand(commands, group, cwd = process.cwd()) {
  return [resolveRunner(commands, cwd), ...group.args.map(shellQuote), commands.args ?? ''].filter(Boolean).join(' ');
}

// How long one record command may be, measured on this machine.
//
// The engine runs the command through `sh -c "<command>"`, so the command is one
// argument to the shell and then, after the shell splits it, a full argv to the
// runner. Both steps are bounded by the OS:
//
//   POSIX    ARG_MAX (`getconf ARG_MAX`) is the total for argv plus the environment,
//            so subtract the environment. Linux additionally caps a single argument
//            at 128 KB (MAX_ARG_STRLEN), which is the binding limit for the `sh -c`
//            step there.
//   Windows  cmd.exe stops at 8191 characters per line.
//
// A margin is kept under each so the runner's own argv (the shell re-execs it) and
// any wrapper it launches still fit.
const MARGIN = 4096;
const LINUX_MAX_ARG_STRLEN = 131072;
const WINDOWS_CMD_LINE = 8191;

/**
 * @param {string} [platform]
 * @param {Record<string, string | undefined>} [env]
 */
export function detectMaxCommandLength(platform = process.platform, env = process.env) {
  if (platform === 'win32') return WINDOWS_CMD_LINE - 512;

  let argMax = LINUX_MAX_ARG_STRLEN;
  try {
    const result = spawnSync('getconf', ['ARG_MAX'], { encoding: 'utf8' });
    const parsed = Number.parseInt(result.stdout, 10);
    if (result.status === 0 && Number.isInteger(parsed) && parsed > 0) argMax = parsed;
  } catch {
    // getconf missing: keep the conservative default
  }
  const envBytes = Object.entries(env).reduce((total, [key, value]) => total + key.length + (value?.length ?? 0) + 2, 0);
  let limit = argMax - envBytes - MARGIN;
  if (platform === 'linux') limit = Math.min(limit, LINUX_MAX_ARG_STRLEN - MARGIN);
  return Math.max(limit, MARGIN);
}

let detectedMaxCommandLength;
function maxCommandLengthOnThisMachine() {
  detectedMaxCommandLength ??= detectMaxCommandLength();
  return detectedMaxCommandLength;
}

/**
 * Plan the record commands for a set of entries.
 *
 * Grouping is the framework's, then two limits split a group further:
 * `batchSize` (a count, from `commands.batch_size`) caps how many entries share a
 * run, and `maxCommandLength` (detected from this machine's shell limit, see
 * above) splits any group whose command would be too long, halving it until each
 * piece fits or is a single entry.
 *
 * @param {{ framework: string, runner?: string | null, args?: string | null }} commands
 * @param {Entry[]} entries
 * @param {{ batchSize?: number | null, maxCommandLength?: number | null, cwd?: string }} [limits]
 * @returns {{ entries: Entry[], command: string, env: Record<string, string> }[]}
 */
export function planRecordCommands(commands, entries, limits = {}) {
  const framework = getFramework(commands.framework);
  const maxCommandLength = limits.maxCommandLength ?? maxCommandLengthOnThisMachine();
  const batchSize = limits.batchSize && limits.batchSize > 0 ? limits.batchSize : Infinity;
  const cwd = limits.cwd ?? process.cwd();
  const result = [];

  const planChunk = (chunk) => {
    for (const group of framework.plan(chunk)) {
      const command = buildCommand(commands, group, cwd);
      if (command.length > maxCommandLength && group.entries.length > 1) {
        const half = Math.ceil(group.entries.length / 2);
        planChunk(group.entries.slice(0, half));
        planChunk(group.entries.slice(half));
        continue;
      }
      result.push({ entries: group.entries, command, env: { ...framework.env } });
    }
  };

  for (let start = 0; start < entries.length; start += batchSize) {
    planChunk(entries.slice(start, start + batchSize));
  }
  return result;
}

/** One line per framework, for `--help` and the `plan` command. */
export function describeFrameworks() {
  const width = Math.max(...frameworkNames().map((name) => name.length));
  const pad = ''.padEnd(width);
  return frameworkNames()
    .map((name) => {
      const framework = FRAMEWORKS[name];
      const lines = [`  ${name.padEnd(width)}  runner: ${framework.runner}`];
      if (framework.runnerNote) lines.push(`  ${pad}  ${framework.runnerNote}`);
      lines.push(`  ${pad}  test_name: ${framework.testName}`);
      return lines.join('\n');
    })
    .join('\n');
}
