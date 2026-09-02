# Node / JavaScript / TypeScript

Part of the **appmap-config** skill. Read its `SKILL.md` first: the starting
config, cutting noise, labels, and layout apply to every language.

Verified against `getappmap/appmap-node`.

## Default file the agent writes

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

## `appmap.yml`

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

## Label syntax

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
