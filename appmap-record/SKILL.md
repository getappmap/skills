# Skill: Record AppMap Data

Record runtime data from applications using AppMap agents. AppMap captures
function calls, HTTP requests, SQL queries, parameters, return values, and
exceptions into `.appmap.json` files that can be analyzed for performance,
correctness, and design.

## When to use

Use this skill when the user wants to:
- Record AppMap data from tests or a running application
- Set up AppMap instrumentation for a project
- Configure `appmap.yml`
- Understand how to enable/disable AppMap recording

## General workflow

1. **Install** the AppMap agent for the project's language.
2. **Configure** `appmap.yml` in the project root.
3. **Run** tests or the application with AppMap enabled.
4. **Find** recorded data in `tmp/appmap/` (default output directory).

---

## Configuration (`appmap.yml`)

Every language uses an `appmap.yml` file in the project root. The core
structure is the same across languages:

```yaml
name: my_project          # Project name (required)
appmap_dir: tmp/appmap     # Output directory (default: tmp/appmap)
packages:
- path: app                # Source code path to instrument
  exclude:
  - SomeClass              # Exclude specific classes/methods
  shallow: false           # When true, only record entry into the package
```

Language-specific differences are noted in each section below.

---

## Ruby

### Install

Add to the **beginning** of your `Gemfile` (must be first gem):

```ruby
group :development, :test do
  gem 'appmap'
end
```

Then run `bundle install`.

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
APPMAP_RECORD_REQUESTS=true rails server
```

### Remote recording

Enabled by default in development. Control with `APPMAP_RECORD_REMOTE=true|false`.

### Environment variables

| Variable | Purpose |
|---|---|
| `APPMAP=false` | Disable all recording |
| `APPMAP_RECORD_REQUESTS=true\|false` | Toggle request recording |
| `APPMAP_RECORD_REMOTE=true\|false` | Toggle remote recording |
| `APPMAP_RECORD_RSPEC=false` | Disable RSpec recording |
| `APPMAP_RECORD_MINITEST=false` | Disable Minitest recording |

### Advanced usage

See https://appmap.io/docs/reference/appmap-ruby.html

---

## Python

### Install

```sh
pip install appmap          # pip
poetry add --group=dev appmap  # poetry
pipenv install --dev appmap    # pipenv
```

### Configuration

```yaml
name: my_python_app
packages:
- path: app.mod1            # Use Python module notation
  shallow: true
- path: app.mod2
  exclude:
  - MyClass
# - dist: Django            # Record an installed distribution package
```

### Record tests

Use the `appmap-python` wrapper to run tests. It sets `APPMAP=true` and
ensures instrumentation is properly initialized.

```sh
# Preferred - via appmap-python wrapper
appmap-python pytest              # Output: tmp/appmap/pytest/
appmap-python python -m unittest  # Output: tmp/appmap/unittest/

# Also works - explicit env var
APPMAP=true pytest
```

Without `APPMAP=true`, AppMap's conditional imports are skipped and no
recording occurs.

### Record HTTP requests

Automatic for Django, Flask, and FastAPI when running in development mode:
- **Django**: `DEBUG = True` in settings.py
- **Flask**: run with `--debug`
- **FastAPI/uvicorn**: run with `--reload`

### Record a process

```sh
appmap-python --record process python my_script.py
# or
APPMAP_RECORD_PROCESS=true python my_script.py
```

### Remote recording

Enabled automatically in development environments (Django `DEBUG=True`,
Flask `--debug`). Force with `APPMAP_RECORD_REMOTE=true`.

### Environment variables

| Variable | Purpose |
|---|---|
| `APPMAP=true\|false` | Enable/disable all recording |
| `APPMAP_RECORD_PYTEST=false` | Disable pytest recording |
| `APPMAP_RECORD_UNITTEST=false` | Disable unittest recording |
| `APPMAP_RECORD_REQUESTS=true\|false` | Toggle request recording |
| `APPMAP_RECORD_REMOTE=true\|false` | Toggle remote recording |
| `APPMAP_RECORD_PROCESS=true` | Record entire process |
| `APPMAP_CONFIG=path/to/appmap.yml` | Custom config file path |
| `APPMAP_DISPLAY_PARAMS=true\|false` | Capture and emit parameter/return values (default: false). Note that these values will be recorded by default for labeled functions. |
| `APPMAP_LOG_LEVEL=DEBUG` | Set log level |

### Advanced usage

See https://appmap.io/docs/reference/appmap-python.html

---

## Node.js

### Install

No install required -- use `npx` to run directly.

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

**Important**: If you modify `NODE_OPTIONS`, run `appmap-node` *after* the
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

### Advanced usage

See https://appmap.io/docs/reference/appmap-node.html

---

## Java

### Install

The Java agent JAR is available from Maven Central or is auto-downloaded by
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
