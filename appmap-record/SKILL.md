# Skill: Record AppMap Data

Record runtime data from applications using AppMap agents. AppMap captures
function calls, HTTP requests, SQL queries, parameters, return values, and
exceptions into `.appmap.json` files that can be analyzed for performance,
correctness, and design.

## When to use

Use this skill when the user or an agent wants to:
- Record AppMap data from tests, ad-hoc programs, or a running application
- Troubleshoot why AppMap recording is not producing output

## General workflow

1. **Verify** the AppMap agent is installed for the project's language.
2. **Run** tests or the application with AppMap enabled.
3. **Find** recorded data in `tmp/appmap/` (default output directory).

## Configuration (`appmap.yml`)

A default `appmap.yml` is auto-created by each language agent if none exists.
You do not need to create this file. It is documented here for reference only.

```yaml
name: my_project          # Project name (required)
appmap_dir: tmp/appmap     # Output directory (default: tmp/appmap)
packages:
- path: app                # Source code path to instrument
  exclude:
  - SomeClass              # Exclude specific classes/methods
  shallow: false           # When true, only record entry into the package
```

Language-specific differences are noted in each section below. The `packages`
section has the most variation.

### Iterative scoping (start narrow, expand later)

`packages:` is a tunable. For an investigation — performance work,
debugging, behavioral discovery — start with the smallest package set
that still captures the area you care about. The first recording is
about *orientation*, not coverage.

- Begin with one or two packages closest to your code path.
- Set `shallow: true` on dependencies so you see entry into them but
  not their internals.
- Use the `exclude:` list to silence noisy classes/methods you've
  already ruled out.

Then expand based on what the recording shows: add a package, remove a
`shallow`, or label specific functions to surface their parameters and
return values (see the `appmap-label` skill — labels make a function
always recorded with full call data, even if the package would not
otherwise be instrumented).

For a step-by-step workflow that uses this iterative scoping to
diagnose a bug, see the `appmap-fix` skill.

---

## Ruby

### Language agent

The `appmap` gem should be present in the `test` and `development` bundles.

### Configuration

```yaml
name: my_project
packages:
- path: app
- gem: activerecord        # Record a dependency gem
  shallow: true            # Default for gem entries
exclude:
- MyClass#my_instance_method
- MyClass.my_class_method
```

### Record tests

```sh
# RSpec (automatic when appmap gem is loaded)
bundle exec rspec
# Output: tmp/appmap/rspec/

# Minitest
bundle exec rake test
# Output: tmp/appmap/minitest/

# Cucumber (requires setup in support/env.rb and support/hooks.rb)
bundle exec cucumber
# Output: tmp/appmap/cucumber/
```

### Record HTTP requests

Automatic via Rack middleware. Enabled by default when `RAILS_ENV=development`.

```sh
rails server
```

### Remote recording

Enabled by default in development. Control with `APPMAP_RECORD_REMOTE=true|false`.

### Advanced usage

See https://appmap.io/docs/reference/appmap-ruby.html

### Troubleshooting

**No AppMaps generated from tests:**
- The `appmap` gem must be the **first gem** listed in the `Gemfile`, or it
  will not properly instrument other dependencies.
- For RSpec, ensure `appmap/rspec` is required in `spec_helper.rb` **before**
  the Rails environment loads.
- For Minitest, ensure `appmap/minitest` is required in `test_helper.rb`
  **before** the Rails environment loads.
- Verify recording is not disabled: check that `APPMAP=false` and
  `APPMAP_RECORD_RSPEC=false` / `APPMAP_RECORD_MINITEST=false` are not set.

**No AppMaps from HTTP requests:**
- Request recording is only auto-enabled when `RAILS_ENV=development`. In
  other environments, set `APPMAP_RECORD_REQUESTS=true` explicitly.
- Run `rake middleware` to confirm AppMap middleware is in the Rack stack.

**Debugging environment variables:**

| Variable | Purpose |
|---|---|
| `APPMAP=false` | Disable all recording |
| `APPMAP_PROFILE_HOOK=true` | Diagnostic timing info on gem instrumentation |
| `APPMAP_LOG_HOOK=true` | Detailed instrumentation hook logging (writes to `appmap_hook.log`) |
| `APPMAP_LOG_HOOK_FILE=stderr` | Redirect hook logs to stderr or a custom file |

**Disabling recording for specific tests:**
Use the `appmap: false` RSpec tag:
```ruby
describe 'Module', appmap: false do
  # AppMap recording disabled for this group
end
```

---

## Python

### Language agent

The `appmap` package should be installed and available.

### Configuration

```yaml
name: my_python_app
packages:
- path: app.mod1            # Use Python module notation
  shallow: true
- path: app.mod2
  exclude:
  - MyClass                 # Note that app.mod2 does not need to be repeated here
```

### Record tests

Use the `appmap-python` wrapper to run tests. It enables recording and
ensures instrumentation is properly initialized.

```sh
appmap-python pytest              # Output: tmp/appmap/pytest/
appmap-python python -m unittest  # Output: tmp/appmap/unittest/
```

### Record HTTP requests

Automatic for Django, Flask, and FastAPI when running in development mode:
- **Django**: `DEBUG = True` in settings.py
- **Flask**: run with `--debug`
- **FastAPI/uvicorn**: run with `--reload`

### Record a process

```sh
appmap-python --record process python my_script.py
```

### Remote recording

Enabled automatically in development environments (Django `DEBUG=True`,
Flask `--debug`). Force with `APPMAP_RECORD_REMOTE=true`.

### Environment variables

| Variable | Purpose |
|---|---|
| `APPMAP_CONFIG=path/to/appmap.yml` | Custom config file path |
| `APPMAP_DISPLAY_PARAMS=true\|false` | Capture and emit parameter/return values (default: false). Note that these values will be recorded by default for labeled functions. |
| `APPMAP_LOG_LEVEL=DEBUG` | Set log level |

### Advanced usage

See https://appmap.io/docs/reference/appmap-python.html

### Troubleshooting

**No AppMaps generated:**
- Ensure `APPMAP=true` is set, or use the `appmap-python` wrapper which sets
  it automatically. Without it, AppMap's conditional imports are skipped and
  no recording occurs.
- Check that `APPMAP_RECORD_PYTEST=false` or `APPMAP_RECORD_UNITTEST=false`
  are not set.

**`RuntimeError: "Recording already in progress"`:**
- This occurs when `APPMAP_RECORD_PROCESS=true` conflicts with another
  recording method (requests, remote, tests). Process recording is
  incompatible with other recording types.
- Fix: disable request recording when using process recording:
  ```sh
  appmap-python --record process --no-record requests flask --app main.app
  ```

**Remote recording security warning in non-development environments:**
- The agent warns when remote recording is enabled outside development mode.
  Development is auto-detected via Django `DEBUG=True` or Flask `--debug`.
- To force in other environments: `APPMAP_RECORD_REMOTE=true`.

**Debugging:**
- Set `APPMAP_LOG_LEVEL=DEBUG` for verbose output.
- Set `APPMAP_DISABLE_LOG_FILE=true` to prevent automatic log file creation
  (logs go to stderr instead).
- Use `appmap-python --enable-log` to explicitly create log files.

**Supported versions:** Python 3.8-3.12, Django 3.2-<5, Flask 2-3,
FastAPI ~0.110.0, pytest ~6, SQLAlchemy ~1.

---

## Node.js

### Language agent

The `appmap-node` package should be prefixed to the run command. It works
on current Node LTS releases (Node 18+); newer versions including Node 22
are fine in practice — if you hit an issue, ensure you're on
`appmap-node@latest`.

> **Do not use `appmap-agent-js`.** It is deprecated and superseded by
> `appmap-node`. Always invoke recording through `npx appmap-node`.

### Usage

Wrap your existing launch command:

```sh
npx appmap-node <your command>
```

### Configuration

Auto-generated if missing. Typical `appmap.yml`:

```yaml
name: MyApp                 # Auto-detected from package.json
appmap_dir: tmp/appmap
packages:
- path: .
  exclude:
  - node_modules
  - .yarn
```

### Record tests

```sh
npx appmap-node mocha specs/test.js
npx appmap-node npx jest
npx appmap-node npx vitest
# Output: tmp/appmap/<mocha|jest|vitest>/
```

**Important**: If you modify `NODE_OPTIONS`, run `appmap-node` _after_ the
modification:

```sh
# Correct:
cross-env NODE_OPTIONS='--max-old-space-size=2048' appmap-node jest

# Wrong (appmap-node before NODE_OPTIONS change):
appmap-node cross-env NODE_OPTIONS='--max-old-space-size=2048' jest
```

### Record HTTP requests

Automatic when HTTP requests are served. Output: `tmp/appmap/requests/`.

### Process recording

Default behavior when no tests or HTTP requests are detected.

```sh
npx appmap-node node my_script.js
# Force process recording alongside other recordings:
APPMAP_RECORDER_PROCESS_ALWAYS=true npx appmap-node npm start
```

### Remote recording

Automatic -- use the AppMap remote recording API or IDE plugin to
start/stop recordings while the app is running.

### Make recordings queryable

Recording produces `.appmap.json` files; analyzing them requires indexing
into a queryable database first:

```sh
npx @appland/appmap index --appmap-dir tmp/appmap
```

This populates `~/.appmap/data/<sha>/query.db`, which is what the AppMap
MCP server and the `appmap query` verbs read from. See the
**appmap-analyze** skill for the read side of the loop.

### Advanced usage

See https://appmap.io/docs/reference/appmap-node.html

### Troubleshooting

**Babel SyntaxError when wrapping a TypeScript test runner in a monorepo:**
- Symptom: `npx appmap-node@latest npx jest …` fails to parse a `.ts`
  test file with a babel `Unexpected token` error, even though the
  bare `npx jest …` runs fine.
- Cause: appmap-node's hook bundles its own babel config and may not
  pick up a `ts-jest` (or other TS) preset configured in a sub-package's
  `jest.config.js` when invoked from a parent directory.
- Fix: run `npx appmap-node` from the package directory whose
  `jest.config.js` defines the TypeScript transform.

**No AppMaps generated or unexpected behavior:**
- Ensure you are running the latest version: `npx appmap-node@latest`.
- If you modify `NODE_OPTIONS` in your launch command, `appmap-node` **must
  come after** the modification. Getting this order wrong is a common cause
  of silent failures. See the "Record tests" section above for examples.

**Process recording not created when other recorders are active:**
- By default, process recording is suppressed when test or request recording
  is active. To force it: `APPMAP_RECORDER_PROCESS_ALWAYS=true`.

**For other issues:** File a report at https://github.com/getappmap/appmap-node.

---

## Java

### Language agent

The `appmap.jar` Java agent JAR is available from Maven Central or is auto-downloaded by
IDE plugins to `$HOME/.appmap/lib/java/appmap.jar`.

Run with the `-javaagent` JVM flag:

```sh
java -javaagent:$HOME/.appmap/lib/java/appmap.jar -jar myapp.jar
```

### Configuration

```yaml
name: MyProject
language: java
appmap_dir: tmp/appmap
packages:
- path: com.mycorp.myproject
  exclude:
  - com.mycorp.myproject.MyClass#MyMethod
- path: org.springframework.web
  shallow: true
```

### Record tests with Maven

Add to `pom.xml`:

```xml
<plugin>
    <groupId>com.appland</groupId>
    <artifactId>appmap-maven-plugin</artifactId>
    <version>LATEST</version>
    <executions>
        <execution>
            <phase>process-test-classes</phase>
            <goals>
                <goal>prepare-agent</goal>
            </goals>
        </execution>
    </executions>
</plugin>
```

Then run:

```sh
mvn test
# Output: tmp/appmap/

# Without modifying pom.xml:
mvn com.appland:appmap-maven-plugin:prepare-agent test
```

**Surefire note**: `forkCount` must not be `0`, and if `argLine` is set it
must include `@{argLine}`.

### Record tests with Gradle

Add to `build.gradle`:

```groovy
plugins {
    id "com.appland.appmap" version "<latest-version>"
}
```

Then run:

```sh
gradle appmap test
# Output: $buildDir/appmap/
```

### Record HTTP requests

Automatic for Spring Boot, Spring Web Framework, and Spark Framework.

### Process recording

```sh
java -javaagent:$HOME/.appmap/lib/java/appmap.jar \
     -Dappmap.recording.auto=true \
     -jar myapp.jar
```

### Remote recording

Requires a servlet container (Tomcat, Jetty, etc.). Start the app with the
`-javaagent` flag and use IDE or curl to start/stop recording.

### System properties

| Property | Purpose | Default |
|---|---|---|
| `appmap.config.file` | Config file path | `appmap.yml` |
| `appmap.output.directory` | Output directory | `./tmp/appmap` |
| `appmap.recording.auto` | Auto-record on boot | `false` |
| `appmap.recording.requests` | Record HTTP requests | `true` |
| `appmap.record.private` | Record private methods | `false` |
| `appmap.debug` | Enable debug logging | disabled |

### Advanced usage

- Java agent: https://appmap.io/docs/reference/appmap-java.html
- Maven plugin: https://appmap.io/docs/reference/appmap-maven-plugin.html
- Gradle plugin: https://appmap.io/docs/reference/appmap-gradle-plugin.html

### Troubleshooting

**`NoClassDefFoundError: com/appland/appmap/runtime/HookFunctions`:**
- Occurs in application servers with modular class loading (WildFly, Tomcat,
  WebSphere, WebLogic, GlassFish). The agent's classes become inaccessible
  due to class loader isolation.
- Fix: expose `com.appland.appmap.runtime` through the server's class loading
  configuration. Example for WildFly:
  ```
  -Djboss.modules.system.pkgs=org.jboss.byteman,com.appland.appmap.runtime
  ```

**`-javaagent` must come before `-jar`:**
- When using `java -jar`, the `-javaagent` argument must appear **before**
  `-jar` or the agent will not load.

**No `tmp/appmap` directory created (Maven):**
- Verify the `prepare-agent` goal is executing during the build.
- Confirm the Surefire plugin has `forkCount > 0` (not `0`).
- If `argLine` is set in Surefire config, it must include `@{argLine}`:
  ```xml
  <argLine>@{argLine} --illegal-access=permit</argLine>
  ```

**No `$buildDir/appmap` directory created (Gradle):**
- Verify the `appmap` task is explicitly called: `gradle appmap test`.
- Verify the JVM fork propagates the `javaagent` argument.

**Empty or minimal `.appmap.json` files:**
- The agent is running but no classes matching the `appmap.yml` packages
  config are being executed. Adjust the `packages` entries to match the code
  paths exercised by your tests.

**"The forked VM terminated without properly saying goodbye" (Maven/Gradle):**
- Usually caused by an invalid `appmap.yml` configuration.
- Check the agent log at `tmp/appmap/agent.log` (Maven) or
  `$buildDir/appmap/agent.log` (Gradle).
- For Maven, also check Surefire dumpstream files at
  `target/surefire-reports/*.dumpstream`.

**Tests fail only with agent attached:**
- File a report at https://github.com/getappmap/appmap-java/issues with:
  full `appmap.yml`, exact run command, complete output, and any dumpstream
  files.

**Debugging:**
- Set `-Dappmap.debug` to enable debug logging.
- Maven/Gradle plugins support `debug` parameter with comma-separated flags:
  `info`, `hooks`, `http`, `locals`.
- Debug logs default to `tmp/appmap/agent.log` (configurable via `debugFile`).
- Validate Gradle config with: `gradle appmap-validate-config`.
