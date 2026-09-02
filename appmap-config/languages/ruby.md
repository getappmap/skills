# Ruby

Part of the **appmap-config** skill. Read its `SKILL.md` first: the starting
config, cutting noise, labels, and layout apply to every language.

Verified against `getappmap/appmap-ruby`.

## Default file the agent writes

```yaml
name: my_project
packages:
- path: app          # whichever of app/ and lib/ exist
- path: lib
language: ruby
appmap_dir: tmp/appmap
```

## `appmap.yml`

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

## Label syntax

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
