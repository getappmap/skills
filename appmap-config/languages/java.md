# Java

Part of the **appmap-config** skill. Read its `SKILL.md` first: the starting
config, cutting noise, labels, and layout apply to every language.

Verified against `getappmap/appmap-java`.

## Default file the agent writes

```yaml
name: my-project
packages:
- path: com.mycorp.myproject     # every package under src/main/java that holds a .java file
```

## `appmap.yml`

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

## Label syntax

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
