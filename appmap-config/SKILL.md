---
name: appmap-config
description: Configure what AppMap records. Covers appmap.yml (packages, exclude, shallow, appmap_dir, one config per project) and function labels, with syntax for Ruby, Python, Node, and Java verified against each agent's test suite. Use when creating the starting config, cutting noise from recordings, or applying labels the review suggested.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

# Configure what AppMap records

Two things decide what a recording contains:

- **`appmap.yml`** — which code is recorded, how deep, what is left out, and
  where the files go.
- **Labels** — names attached to functions. Code review tools use labels to
  work out what a change means.

This skill is the syntax reference for both. The
agents differ from each other in ways that matter, so read the file for
your language (see *Language reference*) before writing the config.

To make a recording once the config is right, see **appmap-record**.

## The starting config

Each language agent creates a default `appmap.yml` if none exists. The
default records your own code and leaves frameworks out. Start from it and
change as little as possible. The language files show the exact default
each agent writes.

```yaml
name: my-project              # any name; shows up in recording metadata
language: java                # ruby | python | javascript | java | other-lang
appmap_dir: tmp/appmap        # where recordings are written (the default everywhere)
packages:
- path: com.mycorp.myproject  # your own code: recorded in full
- path: org.springframework   # a framework: first call in, no internals
  shallow: true
```

Java names a package by its dotted name in both entries. Ruby names a gem
with `gem:`, Python a distribution with `dist:`, Node a library with
`module:`. Each language file shows its form.

Two rules:

- **Record your own code in full.** List the package that holds the
  application as a plain `path:` entry with no `shallow` key. Every call
  inside it is then recorded, and the trace shows the full call structure.
- **Record frameworks and vendor code shallow, or leave them out.** Give a
  framework entry `shallow: true` when you want to see that it was called.
  Shallow keeps the first call into a package and drops the calls that
  package makes to itself. HTTP requests, SQL queries, and exceptions are
  captured by built-in hooks whether or not the framework is listed.

Two keys to always set the same way:

- `language` is required.
- `appmap_dir` is always `tmp/appmap`, the default every agent and tool
  already uses.

After editing the config, record one test and open the `.appmap.json`: your
application's classes should appear in `classMap`, and the events should
carry parameters. **appmap-record** has the record commands.

## Cutting noise

A recording gets big when one small function runs thousands of times. The fix
is `exclude:`, which removes named code from the recording while its callers
stay in it.

Measure before excluding. The AppMap CLI lists the most-called functions and
how much of the file they account for:

```sh
~/.appmap/bin/appmap stats --appmap-file tmp/appmap/<framework>/<test>.appmap.json --limit 20
```

Aim for well under 1 MB per recording. Excluding one or two leaves usually
shrinks a recording 5-10x. After excluding, re-record and check that the
callers of the excluded function still appear.

Good candidates to exclude:

- generated code: schema classes, protobuf messages, builders
- small helpers called hundreds of times per test: assertion helpers,
  formatters, geometry, string utilities
- anything whose behavior a unit test already covers and whose calls add
  repetition, not structure

Never exclude:

- the package or class whose call structure the gold traces exist to guard
- a function that carries a label

Prefer `exclude:` over `shallow:` for your own code. Exclude removes the
noisy leaf and keeps everything around it; shallow removes everything under the package entry point.

**What `exclude:` matches is different in every agent.** This is the most
common mistake.

| Agent | Where `exclude:` goes | What an entry matches |
| --- | --- | --- |
| Ruby | under a package | a **file path** substring, for example `app/models/helpers` |
| Ruby | top level | an exact class name `Foo::Bar`, or `Foo::Bar#method` |
| Python | under a package | a dotted name **relative to the package path**, prefix match |
| Node | under a package | a substring of the file path, or an exact function name, or `Class.method` |
| Java | under a package | a package, class, or `Class.method` name, relative or absolute, prefix match |

**Quote every YAML value that contains `#`.** In YAML, a `#` preceded by
whitespace starts a comment. Unquoted, `- MyClass#method` is read as
`MyClass` and the whole class is excluded.

```yaml
exclude:
  - "MyClass#instance_method"    # quoted: excludes one method
  - MyClass.class_method         # no "#", no quotes needed
```

## Labels

A label is a short name attached to a function. Code review tools read
labels from the recording to interpret a change. A changed function labeled
`security.authorization` gets a security finding; the same change on an
unlabeled function is just "a function changed".

**A label is attached to a function that is already being recorded.** In
all four agents, `packages:` and `exclude:` decide which functions are
recorded, and the label is then added to those functions' entries in the
recording. So to label a function, first make sure its package is listed
and the function is not excluded, then add the label. Two config forms do
both steps at once, naming the function and recording it: Python's
top-level `labels:` key and Ruby's `functions:` block.

### The taxonomy

Use these names. They are the ones the AppMap scanner and the review
recognize.

- `access.public` — request allows public access (no auth/authz); controller methods, not ordinary functions.
- `audit` — writes a permanent audit record of application activity.
- `command.perform` — invocation of a command-line command or script.
- `crypto.encrypt` / `crypto.decrypt` / `crypto.digest` / `crypto.set_auth_data` — encryption / decryption / cryptographic hash / sets authenticated data.
- `dao.materialize` — loads data-access objects from the DB into memory (framework/library code, not every load).
- `deserialize.safe` / `deserialize.unsafe` / `deserialize.sanitize` — deserialization that is safe / not guaranteed safe / makes data safe-or-fails.
- `http.session.clear` — clears the HTTP session (any prior session id becomes invalid).
- `job.create` / `job.perform` / `job.cancel` — schedules / runs / cancels a background job.
- `log` — writes to the application log (framework/library code).
- `rpc.circuit_breaker` — circuit-breaker function, expected under an RPC client request.
- `secret` — returns a secret (password, key, auth token); PII does *not* count.
- `security.authentication` — verifies a user's identity.
- `security.authorization` — tests whether a user is authorized to perform an action.
- `security.logout` — logs a user out.
- `string.equals` — compares two strings for equality.
- `system.exec` / `system.exec.safe` / `system.exec.sanitize` — runs an OS command / known-safe / makes input safe-or-fails.

A project can add its own labels for things the taxonomy does not cover. Name
them for what the function does, in the same `domain.action` style:
`security.join_code`, `payment.charge`, `cart.merge`. A label like that stays
useful after the change that prompted it is merged.

### Two ways to apply a label

- **In the source**, with a comment, decorator, or annotation right above the
  function. Use this for code you own. Ruby and Node use a comment; Java uses
  an annotation; Python has a decorator.
- **In `appmap.yml`**, for code you cannot edit, such as a framework or a
  vendored library. Every agent has a config form, and each one is shaped
  differently. Syntax in the language files.

Labels apply to functions only. If the thing you want to see is a field read
or an environment variable, there is nothing to label. You'll have to add an
accessor function and label that.

## Layout: how many `appmap.yml` files

One `appmap.yml` per recorded project. A recorder looks for the file in the
directory it runs in and then each parent directory, and writes recordings
under that file's directory plus `appmap_dir`.

| Project shape | Config files |
| --- | --- |
| One language, one package | one `appmap.yml` at the root |
| Two languages (a Python or Java backend and a JS frontend) | one `appmap.yml` per language, each in its own directory. Required, because each agent reads its own file. |
| One language, many packages (a Java or JS monorepo) | one at the root works. One per package also works and lets packages be recorded and reviewed on their own. This is an ownership choice. |

A Maven multi-module build reads a separate config and writes a separate
output directory per module by default. To share one of each across the
build, point the Maven plugin at the root; **appmap-record**, `languages/java.md`,
has the `pom.xml` snippet.

## Language reference

Read the one file for the project's language. Each shows the default
`appmap.yml` the agent writes, a starting config, what `exclude:` matches,
and the label syntax for that agent.

| Language | File |
| --- | --- |
| Ruby | `languages/ruby.md` |
| Python | `languages/python.md` |
| Node / JavaScript / TypeScript | `languages/node.md` |
| Java | `languages/java.md` |

## Verify a config change

1. Record one test with **appmap-record**.
2. Confirm what landed. `appmap stats` lists the functions in a recording
   with how many times each was called and how much of the file it takes,
   most expensive first. Your own classes should be there, and the noisy
   helper you excluded should be gone:
   ```sh
   appmap stats -a tmp/appmap/<framework>/<test>.appmap.json --limit 30
   ```
   To list the labels a recording carries, read them from its `classMap`:
   ```sh
   jq -r '.classMap | .. | objects | select(.labels) | "\(.name)  \(.labels | join(" "))"' \
     tmp/appmap/<framework>/<test>.appmap.json
   ```
3. Find every label in the source when you need an inventory:
   ```sh
   git grep -n "@label\|@labels\|@Labels"
   ```
4. When something you expected is missing, turn on the agent's hook log:
   Ruby `APPMAP_LOG_HOOK=true`, Python `APPMAP_LOG_LEVEL=DEBUG`, Java
   `-Dappmap.debug=true -Dappmap.debug.classPrefix=com.mycorp`. Each prints
   why a method was skipped.

## Related skills

- **appmap-record** — making recordings once the config is set.
- **appmap-setup** — first-time setup of recording in a repository.
