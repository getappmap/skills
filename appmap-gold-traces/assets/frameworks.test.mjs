// Tests for the test-framework registry: how each framework names one test and
// several tests on its command line. Pure functions, no runner needed:
//
//   node --test appmap-gold-traces/assets/frameworks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FRAMEWORKS, buildCommand, planRecordCommands, resolveRunner, shellQuote, escapeRegex, frameworkNames,
  detectMaxCommandLength,
} from './frameworks.mjs';

const entry = (test_file, test_name) => ({ test_file, test_name });

function commandsFor(commands, entries) {
  return planRecordCommands(commands, entries).map((group) => group.command);
}

// --- shell quoting ----------------------------------------------------------

test('shellQuote: plain selectors pass through, regexes and spaces are single-quoted', () => {
  assert.equal(shellQuote('tests/test_a.py::test_x'), 'tests/test_a.py::test_x');
  assert.equal(shellQuote('-Dtest=FooTest#a+b,BarTest#c'), '-Dtest=FooTest#a+b,BarTest#c');
  assert.equal(shellQuote('(a|b)'), "'(a|b)'");
  assert.equal(shellQuote("it's fine"), "'it'\\''s fine'");
});

test('escapeRegex: test titles with regex characters are matched literally', () => {
  assert.equal(escapeRegex('adds 1 + 1 (fast)'), 'adds 1 \\+ 1 \\(fast\\)');
});

// --- every framework has the same shape -------------------------------------

test('registry: every framework has a runner, a test_name description, and a plan', () => {
  for (const name of frameworkNames()) {
    const framework = FRAMEWORKS[name];
    assert.ok(framework.runner.length > 0, name);
    assert.ok(framework.testName.length > 0, name);
    const groups = framework.plan([entry('a', 'x'), entry('b', 'y')]);
    assert.ok(groups.length >= 1, name);
    const covered = groups.flatMap((group) => group.entries);
    assert.equal(covered.length, 2, `${name}: every entry lands in exactly one group`);
  }
});

test('buildCommand: runner override replaces the launcher, args are appended', () => {
  const [group] = FRAMEWORKS.pytest.plan([entry('tests/test_a.py', 'test_x')]);
  assert.equal(buildCommand({ framework: 'pytest' }, group), 'appmap-python pytest tests/test_a.py::test_x');
  assert.equal(
    buildCommand({ framework: 'pytest', runner: '.venv/bin/appmap-python pytest', args: '-q -p no:cacheprovider' }, group),
    '.venv/bin/appmap-python pytest tests/test_a.py::test_x -q -p no:cacheprovider',
  );
});

test('planRecordCommands: rejects an unknown framework by name', () => {
  assert.throws(() => planRecordCommands({ framework: 'nose' }, []), /Unknown commands.framework 'nose'/);
});

// --- launcher detection ----------------------------------------------------

function projectDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameworks-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '');
  }
  return dir;
}

test('detect: a venv with appmap-python names both tools by path, so pytest runs inside it', (t) => {
  const dir = projectDir(t, ['.venv/bin/appmap-python']);
  assert.equal(resolveRunner({ framework: 'pytest' }, dir), '.venv/bin/appmap-python .venv/bin/pytest');
  assert.equal(resolveRunner({ framework: 'unittest' }, dir), '.venv/bin/appmap-python .venv/bin/python -m unittest');
  const windows = projectDir(t, ['venv/Scripts/appmap-python']);
  assert.equal(resolveRunner({ framework: 'pytest' }, windows), 'venv/Scripts/appmap-python venv/Scripts/pytest');
});

test('detect: uv, poetry, and pipenv projects run through their own `run`', (t) => {
  assert.equal(resolveRunner({ framework: 'pytest' }, projectDir(t, ['uv.lock'])), 'uv run appmap-python pytest');
  assert.equal(resolveRunner({ framework: 'pytest' }, projectDir(t, ['poetry.lock'])), 'poetry run appmap-python pytest');
  assert.equal(resolveRunner({ framework: 'pytest' }, projectDir(t, ['Pipfile'])), 'pipenv run appmap-python pytest');
});

test('detect: a venv wins over a lock file; nothing detected falls back to the plain default', (t) => {
  const both = projectDir(t, ['.venv/bin/appmap-python', 'uv.lock']);
  assert.equal(resolveRunner({ framework: 'pytest' }, both), '.venv/bin/appmap-python .venv/bin/pytest');
  assert.equal(resolveRunner({ framework: 'pytest' }, projectDir(t, [])), 'appmap-python pytest');
});

test('detect: maven and gradle prefer the wrapper scripts', (t) => {
  assert.equal(resolveRunner({ framework: 'maven' }, projectDir(t, ['mvnw'])), './mvnw test');
  assert.equal(resolveRunner({ framework: 'maven' }, projectDir(t, [])), 'mvn test');
  assert.equal(resolveRunner({ framework: 'gradle' }, projectDir(t, ['gradlew'])), './gradlew appmap test');
});

test('detect: an explicit runner is never overridden by detection', (t) => {
  const dir = projectDir(t, ['.venv/bin/appmap-python']);
  assert.equal(resolveRunner({ framework: 'pytest', runner: 'tox -e py -- ' }, dir), 'tox -e py -- ');
});

test('detect: planRecordCommands uses the cwd it is given', (t) => {
  const dir = projectDir(t, ['.venv/bin/appmap-python']);
  const [group] = planRecordCommands({ framework: 'pytest' }, [entry('tests/test_a.py', 'test_x')], { cwd: dir });
  assert.equal(group.command, '.venv/bin/appmap-python .venv/bin/pytest tests/test_a.py::test_x');
});

// --- batch limits: a count from the manifest, a length from the machine -------

test('batch_size: caps how many entries share one run, in manifest order', () => {
  const entries = ['a', 'b', 'c', 'd', 'e'].map((name) => entry('tests/test_x.py', name));
  const groups = planRecordCommands({ framework: 'pytest' }, entries, { batchSize: 2 });
  assert.deepEqual(groups.map((group) => group.entries.map((e) => e.test_name)), [['a', 'b'], ['c', 'd'], ['e']]);
});

test('command length: a group too long for the shell is halved until each piece fits', () => {
  const entries = Array.from({ length: 8 }, (_, i) => entry('tests/test_x.py', `test_${i}`));
  const full = planRecordCommands({ framework: 'pytest' }, entries)[0].command;
  const groups = planRecordCommands({ framework: 'pytest' }, entries, { maxCommandLength: Math.floor(full.length / 3) });
  assert.ok(groups.length >= 3, `${groups.length} runs`);
  for (const group of groups) assert.ok(group.command.length <= Math.floor(full.length / 3), group.command);
  assert.deepEqual(groups.flatMap((group) => group.entries), entries);
});

test('command length: a single entry is never split, even when it exceeds the limit', () => {
  const groups = planRecordCommands({ framework: 'pytest' }, [entry('tests/test_x.py', 'test_long_name')], { maxCommandLength: 10 });
  assert.equal(groups.length, 1);
});

test('command length: per-file frameworks split within a file, not across the plan', () => {
  const entries = Array.from({ length: 6 }, (_, i) => entry('test/a_test.rb', `test_${i}`));
  const groups = planRecordCommands({ framework: 'minitest' }, entries, { maxCommandLength: 60 });
  assert.ok(groups.length > 1);
  for (const group of groups) assert.match(group.command, /^bundle exec ruby -Itest test\/a_test\.rb -n /);
});

test('detectMaxCommandLength: Windows uses the cmd.exe line limit', () => {
  const limit = detectMaxCommandLength('win32', {});
  assert.ok(limit > 4096 && limit < 8191, String(limit));
});

test('detectMaxCommandLength: POSIX subtracts the environment; Linux also honors the single-argument cap', () => {
  const linux = detectMaxCommandLength('linux', {});
  assert.ok(linux > 4096 && linux <= 131072 - 4096, String(linux));
  const darwin = detectMaxCommandLength('darwin', {});
  const bigEnv = { PAYLOAD: 'x'.repeat(50_000) };
  assert.ok(detectMaxCommandLength('darwin', bigEnv) < darwin, 'a larger environment leaves less room');
  assert.ok(detectMaxCommandLength(process.platform) > 4096, 'this machine reports a usable limit');
});

// --- one selector per test, space-joined -------------------------------------

test('pytest: node ids, all tests in one run', () => {
  assert.deepEqual(
    commandsFor({ framework: 'pytest' }, [entry('tests/test_a.py', 'test_x'), entry('tests/test_b.py', 'TestY::test_z')]),
    ['appmap-python pytest tests/test_a.py::test_x tests/test_b.py::TestY::test_z'],
  );
});

test('unittest: dotted module ids derived from the file path, one run', () => {
  assert.deepEqual(
    commandsFor({ framework: 'unittest' }, [entry('tests/test_a.py', 'TestA.test_x'), entry('./tests/sub/test_b.py', 'TestB.test_y')]),
    ['appmap-python python -m unittest tests.test_a.TestA.test_x tests.sub.test_b.TestB.test_y'],
  );
});

test('gradle: repeated --tests, Class#method normalized to Class.method, bare names take the file class', () => {
  assert.deepEqual(
    commandsFor({ framework: 'gradle' }, [
      entry('src/test/java/com/x/FooTest.java', 'com.x.FooTest#a'),
      entry('src/test/java/com/x/BarTest.java', 'b'),
    ]),
    ['gradle appmap test --tests com.x.FooTest.a --tests BarTest.b'],
  );
});

// --- files once, plus one name regex ------------------------------------------

test('jest: files listed once, one -t alternation of escaped titles', () => {
  assert.deepEqual(
    commandsFor({ framework: 'jest' }, [
      entry('src/a.test.ts', 'logs in'),
      entry('src/a.test.ts', 'rejects a bad token (401)'),
      entry('src/b.test.ts', 'merges carts'),
    ]),
    ["npx appmap-node npx jest src/a.test.ts src/b.test.ts -t '(logs in|rejects a bad token \\(401\\)|merges carts)'"],
  );
});

test('jest: a single test keeps a plain -t title', () => {
  assert.deepEqual(
    commandsFor({ framework: 'jest' }, [entry('src/a.test.ts', 'logs in')]),
    ["npx appmap-node npx jest src/a.test.ts -t 'logs in'"],
  );
});

test('vitest and mocha: same shape with their own runner and flag', () => {
  const entries = [entry('test/a.js', 'one'), entry('test/b.js', 'two')];
  assert.deepEqual(commandsFor({ framework: 'vitest' }, entries), ["npx appmap-node npx vitest run test/a.js test/b.js -t '(one|two)'"]);
  assert.deepEqual(commandsFor({ framework: 'mocha' }, entries), ["npx appmap-node npx mocha test/a.js test/b.js --grep '(one|two)'"]);
});

test('minitest: one run per file with an anchored -n regex, plain name for a single test', () => {
  assert.deepEqual(
    commandsFor({ framework: 'minitest' }, [
      entry('test/a_test.rb', 'test_x'),
      entry('test/a_test.rb', 'test_y'),
      entry('test/b_test.rb', 'test_z'),
    ]),
    [
      "bundle exec ruby -Itest test/a_test.rb -n '/^(test_x|test_y)$/'",
      'bundle exec ruby -Itest test/b_test.rb -n test_z',
    ],
  );
});

// --- rspec and rails: line numbers batch across files, names group per file ---

test('rspec: line-number entries share one run as file:line; named entries get -e per file', () => {
  assert.deepEqual(
    commandsFor({ framework: 'rspec' }, [
      entry('spec/a_spec.rb', '12'),
      entry('spec/b_spec.rb', '40'),
      entry('spec/a_spec.rb', 'logs the user in'),
      entry('spec/a_spec.rb', 'rejects a bad password'),
    ]),
    [
      'bundle exec rspec spec/a_spec.rb:12 spec/b_spec.rb:40',
      "bundle exec rspec spec/a_spec.rb -e 'logs the user in' -e 'rejects a bad password'",
    ],
  );
});

test('rspec: sets APPMAP=true in the group environment', () => {
  const [group] = planRecordCommands({ framework: 'rspec' }, [entry('spec/a_spec.rb', '12')]);
  assert.deepEqual(group.env, { APPMAP: 'true' });
});

test('rails-test: file:line in one run, method names per file with -n', () => {
  assert.deepEqual(
    commandsFor({ framework: 'rails-test' }, [
      entry('test/models/user_test.rb', '7'),
      entry('test/models/cart_test.rb', 'test_merge'),
      entry('test/models/cart_test.rb', 'test_total'),
    ]),
    [
      'bin/rails test test/models/user_test.rb:7',
      "bin/rails test test/models/cart_test.rb -n '/^(test_merge|test_total)$/'",
    ],
  );
});

// --- maven: one -Dtest list --------------------------------------------------

test('maven: methods grouped per class with +, classes joined with a comma, one run', () => {
  assert.deepEqual(
    commandsFor({ framework: 'maven' }, [
      entry('src/test/java/com/x/FooTest.java', 'FooTest#a'),
      entry('src/test/java/com/x/FooTest.java', 'FooTest.b'),
      entry('src/test/java/com/x/BarTest.java', 'c'),
    ]),
    ['mvn test -Dtest=FooTest#a+b,BarTest#c -Dsurefire.failIfNoSpecifiedTests=false'],
  );
});

test('maven: runner override carries the plugin goal and profile', () => {
  assert.deepEqual(
    commandsFor(
      { framework: 'maven', runner: './mvnw -pl server -Pintegration com.appland:appmap-maven-plugin:prepare-agent test' },
      [entry('x', 'FooTest#a')],
    ),
    ['./mvnw -pl server -Pintegration com.appland:appmap-maven-plugin:prepare-agent test -Dtest=FooTest#a -Dsurefire.failIfNoSpecifiedTests=false'],
  );
});
