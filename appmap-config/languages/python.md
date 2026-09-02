# Python

Part of the **appmap-config** skill. Read its `SKILL.md` first: the starting
config, cutting noise, labels, and layout apply to every language.

Verified against `getappmap/appmap-python`.

## Default file the agent writes

```yaml
appmap_dir: tmp/appmap
language: python
name: my_python_app
packages:
- path: myapp        # each top-level directory with an __init__.py, tests skipped
record_test_cases: false
```

## `appmap.yml`

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

## Label syntax

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
