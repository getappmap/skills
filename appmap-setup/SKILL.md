---
name: appmap-setup
description: Set up a repository for AppMap + Gold Traces comparison - pick BASE/HEAD commits, configure test recording, prune noise, seed gold traces on BASE, replay the config onto HEAD via cherry-pick, and run an appmap-review between the two. Use when asked to set up a repo for AppMap gold-trace comparison testing.
---

# Skill: AppMap Gold-Traces Setup

Turn a repository into a two-revision comparison setup:

```
BASE (old commit)                      HEAD (new commit)
  branch: appmap-base                    branch: appmap-head
  + recording config   --cherry-pick-->  + same config (conflicts resolved)
  + noise exclusions   --cherry-pick-->  + same exclusions
  + gold traces        --cherry-pick-->  + gold traces, updated for the feature
                \                        /
                 appmap-review: BASE vs HEAD
```

This skill is the high-level workflow only. The how-to lives in the companion
skills: **appmap-record** (how to record, per language and build tool),
**appmap-label** (`appmap.yml` config syntax), **appmap-gold-traces** (baseline
lifecycle and manifest), **appmap-review** (the behavioral diff). If the
gold-traces and review skills are not installed, clone
https://github.com/getappmap/skills to a scratch directory and run their
engine/instructions from there.

Before starting, check the repo's own `.claude/skills/` for a
`<repo>-appmap-setup` skill — if one exists, the repo has been through this
workflow before and that skill holds its build/test/database facts; follow it.
If not, create one as you work: capture what you learn about *this*
repository — build commands, database setup, test profiles, quirks — there.
Repo facts belong in the repo, not here.

## Phase 0 — Environment checks (do these in parallel, fail fast)

1. `appmap --version` (CLI ≥ 3.201 needed for `sanitize`), note its path.
2. Editor plugin: `ls ~/.vscode/extensions | grep -i appmap` (or JetBrains).
3. A frontier coding agent is available (you are one — check the model isn't a mini).
4. The project's build toolchain works with the versions the project expects.
5. Database, if the build or tests need one.

## Phase 1 — Choose BASE and HEAD

Pick two recent commits separated by one substantial backend feature, diff
≤ 1,000 lines. Verify with `git diff --stat BASE..HEAD`. Reject pairs whose diff
is frontend/e2e-only — the recording agent must be able to trace the changed code.
Prefer a pair whose feature includes or touches a recordable test.

```sh
git checkout -b appmap-base <BASE_SHA>
```

## Phase 2 — Build on BASE

Confirm the project builds and its tests can run before touching any config.

## Phase 3 — Configure recording (commit 1, "unit")

Follow **appmap-record** for the language and build tool. In a multi-module
project, share one config and one output directory across modules (see the
multi-module note in appmap-record). Add the output directory (e.g.
`tmp/appmap/`) and `.appmap/` to `.gitignore`.

Record ONE unit test, then verify the `.appmap.json`: correct version/metadata,
call events with parameters. Commit.

## Phase 4 — Other test architectures (commit 2, "integration")

Find the integration/system suites (separate module, profile, or test config).
Get one class recording green. Often no new AppMap config is needed — commit a
short doc (`docs/development/appmap.md`) with the exact working commands
instead; the cherry-picks and the gold-traces manifest depend on them. Verify
SQL events appear if the tests hit a database. Commit.

## Phase 5 — Prune noise (commit 3, "exclusions")

Profile the biggest recording: count calls and JSON bytes per
(class, method). Exclude, via `appmap.yml` (syntax: **appmap-label**):

- generated code (schema classes, protobufs, builders)
- trivial assertion/util helpers called hundreds of times

Re-record, confirm tests still pass, target well under 1 MB per AppMap
(a 5-10x shrink is normal). Commit.

## Phase 6 — Gold traces on BASE (commit 4)

Follow **appmap-gold-traces** bootstrap: `gold_traces/manifest.yaml` +
`baseline/appmaps/`, `.gitattributes` marks baselines binary. Curate one lean,
deterministic integration test per subsystem relevant to the BASE..HEAD feature
(DAO/service paths with SQL beat granular unit tests). Use the engine's
`discover` for every `appmap_path`; seed with `update --record`; prove
determinism by running `update --record --dry-run` and requiring
`unchanged N (of N)`. Base the manifest's record command on the working
commands documented in Phase 4. Commit.

## Phase 7 — Replay onto HEAD

```sh
git checkout -b appmap-head <HEAD_SHA>
git cherry-pick <commit1>   # recording config
git cherry-pick <commit3>   # exclusions; expect modify/delete conflict on the
                            # doc added by commit2 - keep the incoming full file
git cherry-pick <commit2>   # doc; usually empty now -> git cherry-pick --skip
git cherry-pick <commit4>   # gold baseline (needed for the review step)
```

Verify recording still works at HEAD: re-run the unit recording and the
integration recording, including any test the feature added.

## Phase 8 — Update gold traces on HEAD (commit 5)

`update --record --dry-run` shows which baselines drifted. Bless only drift the
review explains. Add a new entry for the path the feature changed (its new test
is usually the right one), seed with `update --only <test> --record`. Commit.

## Phase 9 — appmap-review BASE vs HEAD

Follow **appmap-review** exactly: extract each branch's committed gold traces,
`appmap archive` each side, `appmap restore` both into one output dir,
`appmap compare`, then interpret change-report.json + the source diff into a
findings-first report. Key check: drift in traces the diff didn't touch is the
side-effect finding a text diff can't see. Cross-check the fix's claim against
recorded SQL (e.g. a pushed-down LIMIT shows as `fetch next ? rows only`).
