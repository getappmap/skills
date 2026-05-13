---
name: appmap-label
description: Configure what AppMap records — per-function labels (surgical) and `appmap.yml` packages: scoping (broader). Two levers for choosing recording scope, with verified syntax for Ruby/Python/Node/Java.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

# Configure AppMap recording scope

A recording's contents are determined by two levers:

- **Labels** — applied per-function via comment / decorator /
  annotation. A labeled function is recorded with full call data
  (params, return value, file:line) regardless of `appmap.yml`. The
  surgical lever.
- **`appmap.yml` `packages:`** — declarative scoping by file / module
  / package / class path. The broad lever.

Built-ins (HTTP, SQL, exceptions) record without either lever — start
there. Add labels and `packages:` only when the recording proves too
sparse.

For the *decision logic* of when to add a label, when to extend
`packages:`, see **appmap-fix** (the orchestrating loop). This skill
is the syntax reference. **appmap-record** covers how to actually
produce a recording once configuration is set.

## Two reasons to label

- **Functional-role labels.** Names that describe what the function
  does — `auth.entry`, `pricing.discount-loop`, `lock.acquire`,
  `payment.charge`, `cart.merge`. Self-documenting, survive past any
  specific investigation, match the canonical-label naming
  convention. Use these by default.
- **Canonical labels.** Domain semantics the AppMap scanner and other
  tooling key on (e.g. `log`, `security.authentication`). Run
  `list_labels` against an existing recording to see what's defined,
  or check the `@appland/scanner` rule catalog.

Avoid `bug.<id>` style labels — they read poorly in `find_calls
label=...` output and force themselves into churn-on-cleanup.
Functional names work just as well during the investigation and stay
useful after.

## When to label vs. extend `packages:`

- **Label one or two functions** when you want their params/returns
  surfaced — fastest, no scope expansion, works inside vendor code.
- **Extend `packages:`** when you need broader coverage of a code area
  whose internals you don't yet know well enough to label
  individually. Default to `shallow: true` (records entry/exit at the
  package boundary without recursing into internals); drop `shallow:`
  only when you've confirmed you need the package's interior detail.

`shallow: true` is generally the right default for any package added
during an investigation. It keeps recordings small while letting you
see the package being called.

## Wrap raw field access in a function

Labels apply to functions only. If the value you want recorded is a
direct field / attribute / env-var read, wrap it in a function and
label the wrapper. Name it for what it returns, not how it accesses
(`tenantConfig()` not `getTenantConfig()`) — some agents skip trivial
getters.

```python
@labels("tenant.context")
def active_tenant():
    return os.environ["TENANT_ID"]
```

Update callers to invoke `active_tenant()` instead of reading
`os.environ["TENANT_ID"]` directly. The recording now captures every
read with full call data.

---

## Ruby

### Label syntax

Comment line directly above the method definition:

```ruby
# @label auth.entry
def authenticate(user, password)
  # ...
end

# @labels security.authentication audit
def login(user)
  # ...
end
```

Parsed by `lib/appmap/class_map.rb`.

### `appmap.yml` packages

```yaml
# Rung 1 — built-ins only (HTTP, SQL, exceptions, labeled functions)
name: my_project
packages: []

# Rung 2 — own code + framework, both shallow by default
name: my_project
packages:
- path: app
  shallow: true              # entry/exit only — drop when you need internals
- gem: rails
  shallow: true              # default for gem entries

# Rung 3 — class-level scoping via top-level functions: block
name: my_project
packages:
- path: app
  shallow: true
functions:
- package: app
  class: Auth
  functions: [authenticate, validate_token]
  labels: [security.authentication]
```

`exclude:` accepts method names: `MyClass#instance_method`,
`MyClass.class_method`. The top-level `functions:` block (separate
from `packages:`) is the supported way to scope by class — list the
methods to record, optionally apply labels to them in the same pass.

### Where labels and yaml meet

The `functions:` block applies labels to functions you may not own
(e.g. third-party gem code where you can't add a `# @label` comment).
For your own code, prefer the inline comment form.

---

## Python

### Label syntax

Decorator from the public `appmap` package:

```python
from appmap import labels

@labels("auth.entry")
def authenticate(user, password):
    pass

@labels("security.authentication", "audit")
def login(user):
    pass
```

Import from `appmap` (the public re-export); don't import from
`_appmap.labels` directly.

### `appmap.yml` packages

```yaml
# Rung 1 — built-ins only
name: my_python_app
packages: []

# Rung 2 — own module + a shallow third-party dist
name: my_python_app
packages:
- path: myapp
  shallow: true
- dist: flask
  shallow: true

# Rung 3 — class-level scoping via class FQN as path:
name: my_python_app
packages:
- path: myapp.auth.AuthService    # matches all methods of AuthService
- path: myapp                     # broader fallback
  shallow: true
```

`path:` is `.`-separated and prefix-matches against function
fqnames. Since Python fqnames include the class
(`myapp.auth.AuthService.login`), a class FQN as `path:` scopes to
that class's methods. Use `dist:` for third-party packages by
distribution name.

`exclude:` accepts class names within a module path.

---

## Node / JavaScript / TypeScript

### Label syntax

Single-line comment directly above the function:

```javascript
// @label auth.entry
function authenticate(user, password) {
  // ...
}

// @labels security.authentication audit
async function login(user) {
  // ...
}
```

### `appmap.yml` packages

```yaml
# Rung 1 — built-ins only
name: MyApp
packages: []

# Rung 2 — own code + a shallow vendor module
name: MyApp
packages:
- path: src
  shallow: true
- path: node_modules/express
  shallow: true

# Rung 3a — file-path scoping (one class per file is the JS norm)
name: MyApp
packages:
- path: src/auth/AuthService.ts    # class file
- path: src
  shallow: true                    # broader fallback

# Rung 3b — function-name scoping with optional inline labels
name: MyApp
packages:
- path: src
  shallow: true
  functions:
  - names: [authenticate, validateToken]
    labels: [security.authentication]
```

Node has no class-name YAML keyword. File-path scoping (3a) works as
class-level when one class per file — the JS/TS norm. The `functions:`
form (3b) both records the named functions and applies labels in one
pass — useful for third-party functions you can't add a `// @label`
comment to.

---

## Java

### Label syntax

Annotation from `com.appland:appmap-annotation`:

```java
import com.appland.appmap.annotation.Labels;

@Labels("auth.entry")
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

### `appmap.yml` packages

```yaml
# Rung 1 — built-ins only
name: MyProject
language: java
packages: []

# Rung 2 — own package + shallow framework
name: MyProject
language: java
packages:
- path: com.mycorp.myproject
  shallow: true
- path: org.springframework
  shallow: true

# Rung 3 — class- and method-level scoping
name: MyProject
language: java
packages:
- path: com.mycorp.myproject
  shallow: true
  classes:
  - name: com.mycorp.myproject.Auth
    methods:
    - name: authenticate
      labels: [security.authentication]
    - name: validateToken
```

Java's `classes:` keyword is the cleanest class+method scoping of the
four agents. Use it directly when you want a class fully recorded but
its surrounding package shallow.

---

## Cleanup

```sh
git grep -n "@label\|@labels"        # audit all labels in the diff
```

Functional-role labels you added during a hunt that read like real
semantics (e.g. `lock.acquire`, `payment.charge`) — keep them; they
help the next investigation. Genuinely transient names (rare, since
functional naming is preferred) — remove before merge.

## Related skills

- **appmap-record** — making recordings (test, HTTP, programmatic)
  once configuration is set.
- **appmap-analyze** — querying labeled calls via `find_calls
  label=<name>`.
- **appmap-fix** — the loop that decides *when* to add a label vs
  extend `packages:`.
