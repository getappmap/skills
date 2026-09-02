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

/**
 * @typedef {{ test_file: string, test_name: string }} Entry
 * @typedef {{ entries: Entry[], args: string[] }} Group
 * @typedef {{
 *   runner: string,
 *   env: Record<string, string>,
 *   testName: string,
 *   plan: (entries: Entry[]) => Group[],
 * }} Framework
 */

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
    env: {},
    testName: 'the node id after the file: test_x, or TestY::test_z for a method',
    plan(entries) {
      return [{ entries, args: entries.map((entry) => `${entry.test_file}::${entry.test_name}`) }];
    },
  },

  unittest: {
    runner: 'appmap-python python -m unittest',
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
 * Build the shell command for one group: `<runner> <selectors> <args>`.
 * @param {{ framework: string, runner?: string | null, args?: string | null }} commands
 * @param {Group} group
 */
export function buildCommand(commands, group) {
  const framework = getFramework(commands.framework);
  const runner = commands.runner ?? framework.runner;
  return [runner, ...group.args.map(shellQuote), commands.args ?? ''].filter(Boolean).join(' ');
}

/**
 * Plan the record commands for a set of entries.
 * @param {{ framework: string, runner?: string | null, args?: string | null }} commands
 * @param {Entry[]} entries
 * @returns {{ entries: Entry[], command: string, env: Record<string, string> }[]}
 */
export function planRecordCommands(commands, entries) {
  const framework = getFramework(commands.framework);
  return framework.plan(entries).map((group) => ({
    entries: group.entries,
    command: buildCommand(commands, group),
    env: { ...framework.env },
  }));
}

/** One line per framework, for `--help` and the `plan` command. */
export function describeFrameworks() {
  const width = Math.max(...frameworkNames().map((name) => name.length));
  return frameworkNames()
    .map((name) => `  ${name.padEnd(width)}  runner: ${FRAMEWORKS[name].runner}\n  ${''.padEnd(width)}  test_name: ${FRAMEWORKS[name].testName}`)
    .join('\n');
}
