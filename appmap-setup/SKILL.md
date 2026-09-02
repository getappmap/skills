---
name: appmap-setup
description: Set up AppMap recording in a repository - check the environment, get one unit test and one integration test recording, prune noisy classes from the recordings, and write a repo-local skill that captures the working build and test commands. Use when asked to set up, install, or configure AppMap recording for a project. Does not create gold traces or run a review; see appmap-setup-review for that.
---

# Skill: AppMap Recording Setup

Get a repository recording AppMap data reliably, then leave behind the facts the
next agent needs to do it again.

```
Phase 0  environment checks
Phase 1  build and run the tests as-is
Phase 2  record ONE unit test              -> commit "config"
Phase 3  record ONE integration test       -> commit "commands doc"
Phase 4  prune noise from the recordings   -> commit "exclusions"
Phase 5  write the repo-local skill
```

This skill is the high-level workflow only. The how-to lives in the companion
skills: **appmap-record** (how to record, per language and build tool) and
**appmap-config** (`appmap.yml` and label syntax). It works on whatever commit is
checked out; it does not choose branches or revisions.

Before starting, check the repo's own `.claude/skills/` for a
`<repo>-appmap-setup` skill. If one exists, the repo has been through this
workflow before and that skill holds its build, test, and database facts; follow
it. If not, create one as you work; see *Write the repo-local skill* below. Repo
facts belong in the repo, not here.

## Phase 0 — Environment checks (do these in parallel, fail fast)

1. `appmap --version` (CLI ≥ 3.201 is needed for `sanitize`), note its path.
2. Editor plugin: `ls ~/.vscode/extensions | grep -i appmap` (or JetBrains).
3. The project's build toolchain works with the versions the project expects.
4. Database, if the build or tests need one.

## Phase 1 — Build and test as-is

Confirm the project builds and its tests can run before touching any config.
Note the exact commands; they become the record commands later.

## Phase 2 — Configure recording (commit 1, "config")

Follow **appmap-record** for the language and build tool. In a multi-module
project, share one config and one output directory across modules (see the
multi-module note in appmap-record). Add the output directory (e.g.
`tmp/appmap/`) and `.appmap/` to `.gitignore`.

Record ONE unit test, then verify the `.appmap.json`: correct version and
metadata, call events with parameters. Commit.

## Phase 3 — Integration tests (commit 2, "commands doc")

Find the integration or system suites (separate module, profile, or test
config). Get one class recording green. Often no new AppMap config is needed.
Commit a short doc (`docs/development/appmap.md`) with the exact working
commands for both the unit and the integration recording; later work such as
a gold-traces manifest depends on them. Verify SQL events appear if the tests
hit a database. Commit.

## Phase 4 — Prune noise (commit 3, "exclusions")

Profile the biggest recording: count calls and JSON bytes per
(class, method). Exclude, via `appmap.yml` (syntax, what is safe to exclude,
and the YAML quoting rule for `#`: **appmap-config**, "Cutting noise"):

- generated code (schema classes, protobufs, builders)
- trivial assertion or utility helpers called hundreds of times

Re-record, confirm tests still pass, target well under 1 MB per AppMap
(a 5-10x shrink is normal). Commit.

## Phase 5 — Write the repo-local skill

Create `.claude/skills/<repo>-appmap-setup/SKILL.md` capturing what you learned
about *this* repository: build commands, database setup, test profiles, the
record commands from the integration-tests phase, and any quirks. Include it
in the "exclusions" commit, so a later cherry-pick of that commit carries it
along.

## What this skill leaves behind

Three commits, in this order. Other workflows (for example
**appmap-setup-review**) cherry-pick them onto another revision, so keep them
separate and keep each one self-contained:

| Commit | Contents |
| --- | --- |
| 1 "config" | `appmap.yml`, build or test hooks, `.gitignore` entries |
| 2 "commands doc" | `docs/development/appmap.md` with the working commands |
| 3 "exclusions" | the `appmap.yml` exclusions, plus the repo-local skill |
