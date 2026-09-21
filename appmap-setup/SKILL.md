---
name: appmap-setup
description: Set up AppMap recording in a repository - confirm the AppMap tools are installed where the other skills expect them, get one unit test and one integration test recording, prune noisy classes from the recordings, and write the working record commands into gold_traces/manifest.yaml so every later session records the same way. Use when asked to set up, install, or configure AppMap recording for a project. Does not curate gold traces or run a review; see appmap-setup-review for that.
---

# Skill: AppMap Recording Setup

Get a repository recording AppMap data reliably, and write down the exact
commands so every later session can record without rediscovering them.

```
Phase 0  tools and environment
Phase 1  build and run the tests as-is
Phase 2  record ONE unit test              -> commit "config"
Phase 3  record ONE integration test
Phase 4  prune noise from the recordings   -> commit "exclusions"
Phase 5  write the record commands into gold_traces/manifest.yaml, smoke-test
                                           -> commit "commands"
```

This skill is the high-level workflow only. The how-to lives in the companion
skills: **appmap-record** (how to record, per language and build tool) and
**appmap-config** (`appmap.yml` and label syntax). It works on whatever commit is
checked out; it does not choose branches or revisions.

The setup leaves no separate document behind. Everything a later session needs
is in two files the tools read anyway: `appmap.yml` says what is recorded and
where recordings land, with a comment per exclusion saying why; and
`gold_traces/manifest.yaml` says how to record, in the `commands` block the
gold-traces engine executes. A hand-kept doc would be a third copy of the same
facts, and the copy nothing runs is the one that drifts.

Before starting, look for `appmap.yml` and `gold_traces/manifest.yaml`. If both
exist, the repo has been set up before: run
`node "${CLAUDE_SKILL_DIR}/../appmap-gold-traces/assets/manage.mjs" plan --dir gold_traces`
to see the record commands, and skip to whichever phase is still missing.

## Phase 0 — Tools and environment

Run these checks first, in parallel. If a check fails and the install listed
for it below does not fix it, stop before Phase 1 and tell the user (see "If a
tool cannot be installed").

The AppMap tools must be at the location the other skills and the gold-traces
engine look in first:

```sh
~/.appmap/bin/appmap --version        # must be 3.201 or newer (needed for sanitize)
ls ~/.appmap/lib/java/appmap.jar      # Java projects only: the agent jar
```

Each tool has one source. This table is the complete list:

| Tool | Where it comes from |
| --- | --- |
| AppMap CLI | the release manifest (below) |
| Java agent, `appmap.jar` | https://github.com/getappmap/appmap-java/releases (below) |
| Maven plugin | resolved by Maven, the way `languages/java.md` in **appmap-record** shows. Releases: https://github.com/getappmap/appmap-maven-plugin/releases |
| Gradle plugin | resolved by Gradle, the same way. Releases: https://github.com/getappmap/appmap-gradle-plugin/releases |
| Ruby agent | the `appmap` gem from RubyGems, through Bundler |
| Python agent | the `appmap` package from PyPI, through the project's package manager |
| Node agent | the `appmap-node` package from npm, through `npx` or the project's package manager |

### CLI and Java agent

The AppMap extensions for VS Code and JetBrains install both tools to
`~/.appmap`, so they may already be there. If the checks above pass, there is
nothing to install.

If a tool is missing or too old, download it as described here. Go ahead
without asking, then tell the user what you installed and where. Do not install
an IDE extension or launch an IDE yourself. Do not install the CLI from npm;
the skills and the engine look in `~/.appmap` first, so that is the one place
it goes.

Each tool is a versioned file plus a link with a fixed name:

```
~/.appmap/bin/appmap           -> ~/.appmap/lib/appmap/appmap-v<version>
~/.appmap/lib/java/appmap.jar  -> ~/.appmap/lib/java/appmap-<version>.jar
```

CLI:

1. Fetch https://raw.githubusercontent.com/getappmap/appmap-js/release-manifests/appmap-latest.json.
   The version is the end of `tag_name` (`@appland/appmap-v3.204.0` is 3.204.0).
2. Find the asset for this machine: `appmap-linux-x64`, `appmap-linux-arm64`,
   `appmap-macos-x64`, `appmap-macos-arm64`, or `appmap-win-x64.exe`.
3. Download its `url` and check the file's sha256 against the entry's `digest`.
   If they differ, delete the file and stop.
4. Install it:

```sh
mkdir -p ~/.appmap/bin ~/.appmap/lib/appmap
mv <download> ~/.appmap/lib/appmap/appmap-v<version>
chmod +x ~/.appmap/lib/appmap/appmap-v<version>
ln -sf ~/.appmap/lib/appmap/appmap-v<version> ~/.appmap/bin/appmap
~/.appmap/bin/appmap --version
```

On Windows, copy the file to `~/.appmap/bin/appmap.exe` instead of linking it.

Java agent (Java projects only):

1. Fetch https://api.github.com/repos/getappmap/appmap-java/releases/latest and
   find the asset named `appmap-<version>.jar`.
2. Download its `browser_download_url` and check the file's sha256 against the
   asset's `digest`. If they differ, delete the file and stop.
3. Install it:

```sh
mkdir -p ~/.appmap/lib/java
mv <download> ~/.appmap/lib/java/appmap-<version>.jar
ln -sf ~/.appmap/lib/java/appmap-<version>.jar ~/.appmap/lib/java/appmap.jar
```

### Maven and Gradle plugins

The build tool downloads the plugin from its usual repository once the plugin
is in `pom.xml` or `build.gradle`. Use the releases page only to look up the
current version number. If the build cannot download the plugin, stop and tell
the user. The plugin jar is on the releases page, so the user or whoever runs
their internal repository can add it there. Do not load a plugin jar into the
build by hand.

### Ruby, Python, and Node agents

These are project dependencies. They must come from RubyGems, PyPI, or npm,
through the package manager the project already uses. **appmap-record** has the
command for each language. Never install one from a git URL, a downloaded
archive, or a copy found on disk.

### If a tool cannot be installed

The sources above are the complete list. If they fail, stop and tell the user.
Do not look for another way.

A failed install almost always has a cause only the user can fix: a proxy, a
firewall, a private package registry, a missing permission. A setup built on a
workaround also gets committed into `appmap.yml`, the build files, and the
manifest, where it breaks on every other machine.

One retry is fine when the error is clearly temporary (a timeout, a dropped
connection). After that, stop.

Do not:

- install the CLI from npm, Homebrew, or a Docker image
- install an IDE extension, or launch an IDE or any other desktop app
- download any AppMap tool from a URL this section does not name
- copy a tool out of another project or a local cache
- build any AppMap tool from source
- use an older version because the current one will not download
- turn off checksum or TLS checks, or change proxy, registry, or plugin
  repository settings
- carry on with a CLI older than 3.201, or move to the next phase without the
  tool

When you stop, tell the user:

1. which tool is missing
2. the exact command you ran and the error text
3. the likely cause, if the error shows one
4. what they can do about it (allow the host, add the package or plugin to
   their internal registry, or install the AppMap IDE extension themselves,
   which downloads the CLI and the Java agent)

If the user then asks for a different method, use it.

This rule covers getting the tools. Once they are installed, fixing a recording
that produces no output is normal work; use the Troubleshooting sections in
**appmap-record**.

### Build toolchain

Confirm the project's build toolchain works with the versions the project
expects, and the database, if the build or tests need one.

## Phase 1 — Build and test as-is

Confirm the project builds and its tests can run before touching any config.
Note the exact commands; they become the record commands later.

## Phase 2 — Configure recording (commit "config")

Follow **appmap-record** for the language and build tool. In a multi-module
project, share one config and one output directory across modules (see the
multi-module note in appmap-record, `languages/java.md`). Add the output directory (`tmp/appmap/`)
and `.appmap/` to `.gitignore`.

Record ONE unit test, then verify the `.appmap.json`: correct version and
metadata, call events with parameters. Commit `appmap.yml`, any build or test
hooks, and the `.gitignore` entries.

## Phase 3 — Integration tests

Find the integration or system suites (separate module, profile, or test
config). Get one class recording green. Often no new AppMap config is needed.
Verify SQL events appear if the tests hit a database. Keep the exact working
command for each suite; they go into the manifest in the last phase.

Anything project-specific you learn on the way belongs next to the thing it is
about, as a comment: a listener that must be imported for SQL to be captured
goes in the test bootstrap that imports it; a process that must never be
recorded (an endless loop that never flushes) goes in `appmap.yml`.

## Phase 4 — Prune noise (commit "exclusions")

Follow **appmap-config**, "Cutting noise": measure the biggest recording with
`appmap stats`, exclude the generated code and the small helpers it shows, and
re-record. Confirm the tests still pass and the recordings are well under
1 MB each. Give every exclusion a one-line comment saying why. Commit the
`appmap.yml` changes.

## Phase 5 — Write the record commands into the manifest (commit "commands")

Seed `gold_traces/manifest.yaml` from the gold-traces template and fill in only
its `commands` block; delete the template's example entry and leave the bare
`entries:` key with nothing under it (the engine's minimal YAML parser does not
read `[]`). Curating entries is the **appmap-gold-traces** skill's job, and it
starts from this file.

```sh
mkdir -p gold_traces/baseline/appmaps
cp "${CLAUDE_SKILL_DIR}/../appmap-gold-traces/assets/manifest.template.yaml" gold_traces/manifest.yaml
```

Put `gold_traces/` in the directory the record command runs from: the package
root in a single-package repo, the package directory in a monorepo (one
manifest per recorded package). The engine derives every path from that
placement; see the gold-traces skill, "Layout".

In `commands`, write what Phases 1 to 3 found, the way the engine wants it:

- `framework`: the test framework name (`pytest`, `rspec`, `jest`, `maven`, ...).
- `runner`: the launcher that runs it in this repo (virtualenv path, wrapper
  script, profile, workspace flag), only if the engine's detected default is
  not right. `plan` shows what the engine would pick without it.
- `args`: flags that go after the test selectors.
- `record_env`: any environment variables the command needs.
- For a runner the engine does not know, a full `record` template with the
  `{test_file}` and `{test_name}` placeholders instead of `framework`.

Then confirm and smoke-test:

```sh
node "${CLAUDE_SKILL_DIR}/../appmap-gold-traces/assets/manage.mjs" plan --dir gold_traces
```

`plan` prints the exact record command. Run it once by hand with a real test
substituted, and confirm a recording appears under `appmap_dir`. If the repo has
a `CLAUDE.md`, add one line pointing at the manifest and the gold-traces skill,
so a session that has not loaded the skill still knows where recording is
configured. Commit the manifest and that line together.

## What this skill leaves behind

Three commits, in this order. Other workflows (for example
**appmap-setup-review**) cherry-pick them onto another revision, so keep them
separate and keep each one self-contained:

| Commit | Contents |
| --- | --- |
| "config" | `appmap.yml`, build or test hooks, `.gitignore` entries |
| "exclusions" | the `appmap.yml` exclusions, each with its reason |
| "commands" | `gold_traces/manifest.yaml` with `commands` filled and a bare `entries:` key, plus the optional `CLAUDE.md` pointer line |
