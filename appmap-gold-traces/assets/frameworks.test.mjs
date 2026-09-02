// Tests for the test-framework registry: how each framework names one test and
// several tests on its command line. Pure functions, no runner needed:
//
//   node --test appmap-gold-traces/assets/frameworks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FRAMEWORKS, buildCommand, planRecordCommands, shellQuote, escapeRegex, frameworkNames } from './frameworks.mjs';

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
