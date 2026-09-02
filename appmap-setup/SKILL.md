---
name: appmap-setup
description: Set up AppMap recording in a repository - confirm the AppMap tools are installed where the other skills expect them, get one unit test and one integration test recording, prune noisy classes from the recordings, and write a short docs/appmap.md imported from CLAUDE.md with the working record commands. Use when asked to set up, install, or configure AppMap recording for a project. Does not create gold traces or run a review; see appmap-setup-review for that.
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
Phase 5  write docs/appmap.md, import it from CLAUDE.md, smoke-test
                                           -> commit "docs"
```

This skill is the high-level workflow only. The how-to lives in the companion
skills: **appmap-record** (how to record, per language and build tool) and
**appmap-config** (`appmap.yml` and label syntax). It works on whatever commit is
checked out; it does not choose branches or revisions.

Before starting, look for `docs/appmap.md` or an AppMap section reachable from
`CLAUDE.md`. If one exists, the repo has been set up before: follow its commands
and skip to whichever phase is still missing.

## Phase 0 — Tools and environment (do these in parallel, fail fast)

The AppMap tools must be at the location the other skills and the gold-traces
engine look in first:

```sh
~/.appmap/bin/appmap --version        # must be 3.201 or newer (needed for sanitize)
ls ~/.appmap/lib/java/appmap.jar      # Java projects only: the agent jar
```

If either is missing, install the AppMap extension for VS Code or JetBrains
and open the project once. The extension downloads both and keeps them
up to date. Do not install the CLI from npm as a substitute; nothing keeps
that copy current. Ruby, Python, and Node agents are project dependencies,
added the way **appmap-record** describes.

Then confirm the project's build toolchain works with the versions the project
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
command for each suite; they go into the doc in the last phase.

## Phase 4 — Prune noise (commit "exclusions")

Follow **appmap-config**, "Cutting noise": measure the biggest recording with
`appmap stats`, exclude the generated code and the small helpers it shows, and
re-record. Confirm the tests still pass and the recordings are well under
1 MB each. Commit the `appmap.yml` changes.

## Phase 5 — Write the doc and import it from CLAUDE.md (commit "docs")

Write `docs/appmap.md`. It is loaded into every session through CLAUDE.md, so
keep it under one screen. It holds:

- Where the tools live (`~/.appmap/bin/appmap`, and the agent jar for Java).
- One record command per test suite, unit and integration, written the way
  the gold-traces manifest wants it: the framework name (`pytest`, `rspec`,
  `jest`, `maven`, ...) and the launcher that runs it in this repo (the
  virtualenv path, wrapper script, profile, or workspace flag), so the pair can
  later be pasted into the manifest's `commands.framework` and
  `commands.runner` unchanged. For a runner the gold-traces engine does not
  know, give a full command with the `{test_file}` and `{test_name}`
  placeholders instead, for `commands.record`. List any environment variables
  the command needs next to it.
- Where recordings land (`tmp/appmap/<framework>/`).
- What `appmap.yml` excludes and why, in one line per exclusion.
- A pointer to `gold_traces/manifest.yaml`, once it exists.

Add this line to `CLAUDE.md`, creating the file with only that line if the
repo has none:

```
@docs/appmap.md
```

Smoke-test the doc: run each record command it lists once, with a real test
substituted for the placeholders, and confirm a recording appears. Commit the
doc and the `CLAUDE.md` change together.

## What this skill leaves behind

Three commits, in this order. Other workflows (for example
**appmap-setup-review**) cherry-pick them onto another revision, so keep them
separate and keep each one self-contained:

| Commit | Contents |
| --- | --- |
| "config" | `appmap.yml`, build or test hooks, `.gitignore` entries |
| "exclusions" | the `appmap.yml` exclusions |
| "docs" | `docs/appmap.md` and the `@docs/appmap.md` line in `CLAUDE.md` |
