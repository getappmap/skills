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
agents differ from each other in ways that matter, so read the section for
your language before writing the file. 

To make a recording once the config is right, see **appmap-record**.

## The starting config

Each language agent creates a default `appmap.yml` if none exists. The
default records your own code and leaves frameworks out. Start from it and
change as little as possible. The per-language sections show the exact
default each agent writes.

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
`module:`. Each language section shows its form.

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
  differently. Syntax per language below.

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
build, point the Maven plugin at the root; **appmap-record** has the
`pom.xml` snippet.


---

## Ruby

Verified against `getappmap/appmap-ruby`.

### Default file the agent writes

```yaml
name: my_project
packages:
- path: app          # whichever of app/ and lib/ exist
- path: lib
language: ruby
appmap_dir: tmp/appmap
```

### `appmap.yml`

```yaml
name: my_project
language: ruby
appmap_dir: tmp/appmap           # ignored by the Ruby agent; keep the default
packages:
- path: app                      # own code, recorded in full
  exclude:                       # FILE PATH substrings, always a list
  - app/models/generated
- gem: rails                     # a gem; shallow is the default for gems
- gem: devise
  shallow: false                 # record a gem's internals

exclude:                         # CLASS and METHOD names, exact match
- GeneratedSchema
- "Geometry#distance"            # instance method; quote because of "#"

functions:                       # record and label methods, including gem code
- methods:
  - "Devise::Strategies::Authenticatable#authenticate!"
  gem: devise
  labels: [security.authentication]
- methods:
  - "Auth#validate_token"
  - Auth.issue_token             # class method: dot, no quotes needed
  path: app
  labels: [security.authentication]
```

What each part does:

- **`packages[].path`** is a directory, prefix-matched against the source
  file path. Subdirectories become sub-packages on their own.
- **`packages[].gem`** must be in the bundle. A gem that is not loaded raises
  at startup and no recording happens. Gems default to `shallow: true`.
- **`packages[].exclude`** is a list of **file path** substrings. It does not
  take class names. A bare string instead of a list breaks at hook time, so
  always write a list.
- **Top-level `exclude`** takes exact class names (`Foo::Bar`, fully
  qualified) and `Foo::Bar#method`. No prefixes, no globs. This is the way
  to drop one noisy class or method. Class methods (`Foo.bar`) are not
  reliably excluded here; the hook sees a singleton class with no name.
- **`functions`** entries take `methods:` (a list of `Class#method` or
  `Class.method` strings) or `method:` (one string), `labels:` or `label:`,
  and one of `gem:` or `path:`. Class names must be written in full. This is
  the one Ruby form that both records a method and labels it, and the only
  way to reach gem code you cannot edit. An older form with `package:`,
  `class:`, `functions:` still loads but cannot reach gem code.
- A `labels:` key under a `packages:` entry is silently ignored.
- Never hooked from `packages:` regardless of config: `initialize`, methods
  named `call`, `attr_accessor` methods, and anything in `Marshal`,
  `AppMap`, or `ActiveSupport`.

### Label syntax

A comment above the method. Several labels are separated by spaces, not
commas. The parser walks up from the `def` through comment and blank lines,
so the label can sit above other comment lines.

```ruby
# @label security.authentication
def authenticate(user, password)
  # ...
end

# @labels security.authentication audit
def login(user)
  # ...
end
```

A `# @label` above a `class` line does nothing. `## @label` does not match.

---

## Python

Verified against `getappmap/appmap-python`.

### Default file the agent writes

```yaml
appmap_dir: tmp/appmap
language: python
name: my_python_app
packages:
- path: myapp        # each top-level directory with an __init__.py, tests skipped
record_test_cases: false
```

### `appmap.yml`

```yaml
name: my_python_app
language: python
appmap_dir: tmp/appmap
packages:
- path: myapp.util.Geometry     # a class; put narrow or shallow entries FIRST
  shallow: true
- path: myapp                   # own code, recorded in full
  exclude:                      # dotted names RELATIVE to path, prefix match
  - geometry.distance           # the function myapp.geometry.distance
  - schema.GeneratedModel       # the class myapp.schema.GeneratedModel
  - generated                   # the whole subpackage myapp.generated
- dist: flask                   # third-party, by distribution name; shallow by default

labels:                         # label -> fully qualified name(s); also records them
  security.authentication: myapp.auth.AuthService.login
  audit:
  - myapp.auth.AuthService.login
  - myapp.billing.Ledger.post
```

What each part does:

- **`path`** is a dotted module path, compared component by component
  against each function's full name (`myapp.auth.AuthService.login`). So
  `myapp` does not match `myapp2`, and a class or even a single function can
  be a `path`.
- **The first matching entry wins.** A narrow entry placed after a broad one
  never fires. Put class-level and shallow entries above the package entry.
- **`exclude`** names are relative to the entry's `path` and match by
  prefix. An absolute name (`myapp.geometry.distance` under `path: myapp`)
  matches nothing.
- **`dist`** names a distribution. It defaults to `shallow: true`; `path`
  entries default to full depth. `dist` and `path` can be combined to narrow
  within a distribution.
- **`labels`** is a top-level map from label to one fully qualified function
  name or a list of them. A function named here is recorded even when no
  `packages:` entry covers it. Use it for code you cannot edit.
- **`record_test_cases`** controls whether the test function itself appears
  as a call event. Per-test recordings happen without it.
- There is no top-level `exclude`.

### Label syntax

A decorator from the `appmap` package, for code you own. Like the Java
annotation, it needs the package present at runtime. The package exports
`labels` when the `APPMAP` environment variable is `true`, so import it
through a small shim that gives every other run a no-op decorator. Put the
shim in one module and import it from there:

```python
# myapp/appmap_labels.py
try:
    from appmap import labels
except ImportError:          # APPMAP is not "true": not recording
    def labels(*_names):
        return lambda fn: fn
```

```python
from myapp.appmap_labels import labels

class AuthService:
    @labels("security.authentication", "audit")   # several labels: varargs
    def login(self, user):
        pass

    @staticmethod
    @labels("secret")                             # directly above def, under
    def signing_key():                            # @staticmethod / @classmethod
        pass
```

The labeled function's package must be in `packages:`, the same rule as the
Java annotation. Label a function in one place: an entry in the `labels:`
key replaces the decorator's labels on the same function.

---

## Node / JavaScript / TypeScript

Verified against `getappmap/appmap-node`.

### Default file the agent writes

```yaml
name: my-app             # package.json name, else the directory name
language: javascript
appmap_dir: tmp/appmap
packages:
  - path: .
    exclude:
      - node_modules
      - .yarn
```

### `appmap.yml`

```yaml
name: my-app
language: javascript
appmap_dir: tmp/appmap
packages:
  - path: src                   # own code, recorded in full
    exclude:
      - node_modules            # re-add these whenever you write packages: yourself
      - .yarn
      - src/util/geometry.ts    # a file: matched as a substring of the full path
      - formatCurrency          # a function, by exact name
      - Cart.recalculate        # a method: Class.method (no "#" form)
  - module: express             # a library, by its require()/import id
    shallow: true
  - module: some-auth-lib
    shallow: true
    functions:                  # record-and-label is NOT what this does; it only labels
      - names: [authenticate, validateToken]
        labels: [security.authentication]
```

What each part does:

- **`path`** is a file system path relative to `appmap.yml`, prefix-matched.
  A bare string entry (`- src`) means `{path: src}`.
- **Defaults vanish when you write `packages:`.** The default excludes for
  `node_modules` and `.yarn` are only present when the key is absent.
  Add them back to every `path: .` entry.
- **`exclude`** entries are checked as substrings of the absolute file path
  first, then as exact function names, then as `Class.method`. No globs. A
  short word like `test` excludes every file with that word anywhere in its
  path.
- **`module`** names a library by its exact import id (`express`,
  `node:console`; the `node:` prefix is optional). It wraps the module's
  exports. Use it instead of `path: node_modules/...`, which is untested.
  `path` and `module` cannot be combined.
- **`shallow`** must be a YAML boolean; `"true"` in quotes is ignored.
- **`functions`** under a package attaches labels to functions of that
  package, by bare name only. Singular `name:` and `label:` also work.
  `Class.method` inside `names` does not work in the current release. It
  does not make anything get recorded, and does not override `shallow`. The
  tested use is on a `module:` package.
- There is no top-level `exclude`.

### Label syntax

A `//` comment above the function. Block comments and JSDoc are ignored. The
parser walks up through consecutive `//` lines; a blank line stops it.

```javascript
// @label security.authentication
function authenticate(user, password) {
  // ...
}

// @labels security.authentication audit
async function login(user) {
  // ...
}

class Session {
  // @label security.logout
  destroy() {}
}

// @label pricing.discount
const applyDiscount = (cart) => { /* ... */ };   // const only; let/var are not instrumented
```

Works in TypeScript and through source maps. Not applied to anonymous
functions, generator methods, or methods of unnamed classes.

---

## Java

Verified against `getappmap/appmap-java`.

### Default file the agent writes

```yaml
name: my-project
packages:
- path: com.mycorp.myproject     # every package under src/main/java that holds a .java file
```

### `appmap.yml`

```yaml
name: my-project
language: java
appmap_dir: tmp/appmap
packages:
- path: com.mycorp.myproject     # own code, recorded in full, subpackages included
  exclude:                       # relative or absolute; prefix match on the name
  - generated                    # the subpackage com.mycorp.myproject.generated
  - util.Geometry                # a class
  - "cache.Cache#clear"          # a method; "#" or "." both work
  - com.mycorp.myproject.legacy  # absolute form
- path: org.springframework      # framework: first call in, no internals
  shallow: true

# Label methods in code you cannot edit: methods: with class/name regexes.
# This entry records ONLY the listed methods of that exact package.
- path: org.somevendor.auth
  methods:
  - class: Authenticator         # simple or fully qualified; anchored regex
    name: authenticate
    labels: [security.authentication]
  - class: Authenticator
    name: validateToken          # recorded, no labels
```

What each part does:

- **`path`** is a package name, matched on whole segments, subpackages
  included (`com.example` matches `com.example.sub`, not `com.examples`). A
  class name works as `path` for the unnamed package.
- **`exclude`** entries are relative to `path` or absolute. Matching is a
  raw prefix on `sub.Class.method`, so `Cache.clear` also excludes
  `Cache.clearAll` and `Internal` also excludes `InternalFoo`. `#` is
  accepted and rewritten to `.`; quote it in YAML.
- **The four keys under a package are `path`, `exclude`, `shallow`, and
  `methods`.** Any other key, for example `classes:` or `labels:`, is a
  fatal parse error and the agent exits.
- **`methods`** is a list of `{class, name, labels}`. `class` and `name` are
  anchored regular expressions: `name: process` does not match
  `processData`; write `handle.*` or `(info|debug)`. Escape `$` in inner
  class names (`Outer\$Inner`). A package entry with `methods` records only
  those methods, its `exclude` is ignored, and `path` must equal the method's
  package exactly, subpackages not included.
- **Entry order matters for labels.** The first package entry whose `path`
  matches wins. To label a few methods and still record the rest of the
  same package, put the `methods` entry first and a plain `path` entry for
  the same package after it.
- Never recorded regardless of config: private methods (unless
  `-Dappmap.record.private=true`), constructors, static initializers,
  getters and setters, `equals`, `hashCode`, `toString`, `iterator`,
  generated code without line numbers, and anything in `java.`, `jdk.`,
  `sun.`. A `methods` entry naming `getToken` records nothing.
- `-Dappmap.config.file` or `APPMAP_CONFIG_FILE` points at the file; when
  set, the file must exist. `-Dappmap.output.directory` overrides
  `appmap_dir`.

### Label syntax

An annotation from `com.appland:appmap-annotation`, on methods only. The
class must be on the runtime classpath, not just at compile time.

```java
import com.appland.appmap.annotation.Labels;

@Labels("security.authentication")
public boolean authenticate(String user, String password) {
    // ...
}

@Labels({"security.authentication", "audit"})
public User login(String user) {
    // ...
}
```

Add the dependency:

```xml
<dependency>
  <groupId>com.appland</groupId>
  <artifactId>appmap-annotation</artifactId>
  <version>LATEST</version>
</dependency>
```

Annotation labels replace, not merge with, labels from a `methods:` entry
for the same method. The method's package must still be in `packages:`.

---

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
