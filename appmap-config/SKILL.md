---
name: appmap-config
description: Configure what AppMap records. Covers appmap.yml (packages, exclude, shallow, appmap_dir, one config per project) and function labels, with syntax for Ruby, Python, Node, and Java. Use when creating the starting config, cutting noise from recordings, or applying labels the review suggested.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

# Configure what AppMap records

Two things decide what a recording contains:

- **`appmap.yml`** — which code is recorded, how deep, what is left out, and
  where the files go.
- **Labels** — names attached to functions in the source. The recorder
  always records a labeled function, and **appmap-review** uses the label to
  work out what a change means.

This skill is the syntax reference for both. 

To make a recording once the config is right, see **appmap-record**.

## The starting config

Each language agent creates a default `appmap.yml` if none exists. The
default records your own code in full and leaves frameworks out. Start from
it and change as little as possible.

```yaml
name: my_project          # any name; shows up in recording metadata
language: ruby            # ruby | python | javascript | java
appmap_dir: tmp/appmap    # where recordings are written (this is the default)
packages:
- path: app               # your own code: recorded in full
- gem: rails              # a framework: entry and exit only
  shallow: true
```

Two rules:

- **Record your own code in full.** Do not put `shallow: true` on the package
  that holds the application. Shallow records only the call into the package
  and the return out of it. A trace made that way has no call structure
  inside it.
- **Frameworks and vendor code are shallow or absent.** `shallow: true` on a
  framework shows that the framework was called without recording its
  internals (which is a good default). HTTP requests, SQL queries, and exceptions are captured by
  built-in hooks whether or not the framework is listed.

After editing the config, record one test and open the `.appmap.json`: your
application's classes should appear in `classMap`, and the events should
carry parameters. **appmap-record** has the record commands.

## Cutting noise

A recording gets big when one small function runs thousands of times. The fix
is `exclude:`, which removes named classes or methods from the recording
while their callers stay in it.

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
noisy leaf and keeps everything around it; shallow removes everything.

**Quote every YAML value that contains `#`.** In YAML, a `#` preceded by
whitespace starts a comment. Unquoted, `- MyClass#method` is read as
`MyClass` and the whole class is excluded.

```yaml
exclude:
  - "MyClass#instance_method"    # quoted: excludes one method
  - MyClass.class_method         # no "#", no quotes needed
```

## Labels

A label is a short name attached to a function. It does two things:

- The recorder always records a labeled function, with parameters and return
  value, even if the function's package is shallow or not listed.
- **appmap-review** reads labels from the recording to interpret a change. A
  changed function labeled `security.authorization` gets a security finding; the
  same change on an unlabeled function is just "a function changed".

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
  function. Use this for code you own. Syntax per language below.
- **In `appmap.yml`**, for code you cannot edit, such as a framework or a
  vendored library. Ruby, Node, and Java have a config form that names the
  function and gives it a label in one place. Syntax per language below.

Labels apply to functions only. If the thing you want to see is a field read
or an environment variable, there is nothing to label. You'll have to add an accessor
function and label that.

## Layout: how many `appmap.yml` files

One `appmap.yml` per recorded project. A recorder reads the nearest one above
the directory it runs in, and writes recordings under that file's
`appmap_dir`.

| Project shape | Config files |
| --- | --- |
| One language, one package | one `appmap.yml` at the root |
| Two languages (a Python or Java backend and a JS frontend) | one `appmap.yml` per language, each in its own directory. Required, because each agent reads its own file. |
| One language, many packages (a Java or JS monorepo) | one at the root works. One per package also works and lets packages be recorded and reviewed on their own. This is an ownership choice. |

A Maven multi-module build reads a separate config and writes a separate
output directory per module by default. To share one of each across the
build, point the Maven plugin at the root; **appmap-record** has the
`pom.xml` snippet.

**appmap-gold-traces** keeps one `gold_traces/` directory per `appmap.yml`.
Its engine runs the record command from the `gold_traces` parent directory
and reads recordings from the nearest `appmap.yml` above it, so put
`gold_traces/` inside the project the config belongs to.

---

## Ruby

### `appmap.yml`

```yaml
name: my_project
language: ruby
appmap_dir: tmp/appmap
packages:
- path: app                       # own code, recorded in full
  exclude:
  - "Geometry#distance"           # one instance method; quoted because of "#"
  - Geometry.origin               # one class method
  - GeneratedSchema               # a whole class
- gem: rails
  shallow: true                   # framework: entry and exit only

# Labels for code you cannot edit: a top-level functions: block
functions:
- package: app
  class: Auth
  functions: [authenticate, validate_token]
  labels: [security.authentication]
```

`exclude:` under a `path:` entry accepts class names, `Class#instance_method`,
and `Class.class_method`. The top-level `functions:` block records the named
methods and labels them in one pass.

### Label syntax

A comment on the line above the method:

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

---

## Python

### `appmap.yml`

```yaml
name: my_python_app
language: python
appmap_dir: tmp/appmap
packages:
- path: myapp                     # own code, recorded in full
  exclude:
  - geometry.distance             # function under myapp
  - schema.GeneratedModel         # class under myapp
- dist: flask                     # third-party, by distribution name
  shallow: true
```

`path:` is dot-separated and matches by prefix against the function's full
name (`myapp.auth.AuthService.login`), so a class name as `path:` records
that one class. `exclude:` names are relative to the package `path:`. Use
`dist:` for third-party code.

Python has no config form for labels. Label with the decorator, or record the
third-party package shallow and rely on its name.

### Label syntax

A decorator from the public `appmap` package:

```python
from appmap import labels

@labels("security.authentication")
def authenticate(user, password):
    pass

@labels("security.authentication", "audit")
def login(user):
    pass
```

Import from `appmap`, not from `_appmap.labels`.

---

## Node / JavaScript / TypeScript

### `appmap.yml`

```yaml
name: MyApp
language: javascript
appmap_dir: tmp/appmap
packages:
- path: src                       # own code, recorded in full
  exclude:
  - src/util/geometry.ts          # a file
  - formatCurrency                # a function name
- path: node_modules/express      # vendor: entry and exit only
  shallow: true

# Labels for code you cannot edit: a functions: list under the package
- path: node_modules/some-auth-lib
  shallow: true
  functions:
  - names: [authenticate, validateToken]
    labels: [security.authentication]
```

Node has no class keyword in the config. Scope by file path instead; one
class per file is the usual layout. The `functions:` list records the named
functions and labels them in one pass.

### Label syntax

A comment on the line above the function:

```javascript
// @label security.authentication
function authenticate(user, password) {
  // ...
}

// @labels security.authentication audit
async function login(user) {
  // ...
}
```

---

## Java

### `appmap.yml`

```yaml
name: MyProject
language: java
appmap_dir: tmp/appmap
packages:
- path: com.mycorp.myproject      # own code, recorded in full
  exclude:
  - com.mycorp.myproject.generated        # a package
  - com.mycorp.myproject.util.Geometry    # a class
- path: org.springframework       # framework: entry and exit only
  shallow: true

# Labels for code you cannot edit: classes: and methods: under the package
- path: org.somevendor.auth
  shallow: true
  classes:
  - name: org.somevendor.auth.Authenticator
    methods:
    - name: authenticate
      labels: [security.authentication]
```

`exclude:` accepts package, class, and method paths. The `classes:` block is
the cleanest per-class control of the four agents: a class listed there is
recorded in full even when its package is shallow.

### Label syntax

An annotation from `com.appland:appmap-annotation`:

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

---

## Verify a config change

1. Record one test with **appmap-record**.
2. Confirm what landed. The gold-traces engine prints events, bytes, code
   objects, and labels for a recording:
   ```sh
   node "<appmap-gold-traces>/assets/manage.mjs" check --dir gold_traces --record --only <test_name>
   ```
   Without gold traces, open the `.appmap.json` and check `classMap` for your
   classes and for the `labels` you added.
3. Find every label in the source when you need an inventory:
   ```sh
   git grep -n "@label\|@labels\|@Labels"
   ```

## Related skills

- **appmap-record** — making recordings once the config is set.
- **appmap-setup** — first-time setup of recording in a repository.
- **appmap-gold-traces** — the committed baseline these recordings feed.
- **appmap-review** — the review that reads the labels.
