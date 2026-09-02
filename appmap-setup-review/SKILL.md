---
name: appmap-setup-review
description: Set up a two-revision AppMap comparison in a repository - pick BASE and HEAD commits one feature apart, run appmap-setup on BASE, seed gold traces there, replay the config onto HEAD via cherry-pick, update the gold traces for the feature, and run an appmap-review between the two. Use when asked to demonstrate or evaluate AppMap gold-trace comparison on an existing change. For plain recording setup, use appmap-setup instead.
---

# Skill: AppMap Two-Revision Review Setup

Turn a repository into a BASE-versus-HEAD comparison and review the difference:

```
BASE (old commit)                      HEAD (new commit)
  branch: appmap-base                    branch: appmap-head
  + recording config   --cherry-pick-->  + same config (conflicts resolved)
  + noise exclusions   --cherry-pick-->  + same exclusions
  + gold traces        --cherry-pick-->  + gold traces, updated for the feature
                \                        /
                 appmap-review: BASE vs HEAD
```

This is a demonstration and evaluation workflow. It takes a change that already
exists in history and shows what a gold-trace review would have said about it.
Day-to-day use is different: a team seeds gold traces on its main branch once
and reviews pull requests as they arrive.

This skill is the high-level workflow only. The how-to lives in the companion
skills: **appmap-setup** (get recording working), **appmap-gold-traces**
(baseline lifecycle and manifest), **appmap-review** (the behavioral diff). If
those skills are not installed, clone https://github.com/getappmap/skills to a
scratch directory and run their engine and instructions from there.

```
Phase 0  environment checks
Phase 1  choose BASE and HEAD
Phase 2  on BASE: run appmap-setup           -> its commits: config, commands doc, exclusions
Phase 3  on BASE: seed gold traces           -> commit "gold baseline"
Phase 4  replay those four commits onto HEAD
Phase 5  on HEAD: update gold traces         -> commit "gold update"
Phase 6  appmap-review BASE vs HEAD
```

## Phase 0 — Environment checks

Run the environment checks described in **appmap-setup**. In addition, confirm
a frontier coding agent is doing the work (you are one; check the model is not
a mini). The *appmap-review BASE vs HEAD* phase depends on interpretation, not
just tooling.

## Phase 1 — Choose BASE and HEAD

Pick two recent commits separated by one substantial backend feature, diff
≤ 1,000 lines. Verify with `git diff --stat BASE..HEAD`. Reject pairs whose diff
is frontend or end-to-end only; the recording must be able to reach the changed
code. Prefer a pair whose feature includes or touches a recordable test.

```sh
git checkout -b appmap-base <BASE_SHA>
```

## Phase 2 — Recording setup on BASE

Run **appmap-setup** on the checked-out BASE branch. It leaves behind three
commits, which it names "config", "commands doc", and "exclusions", plus a
repo-local skill with the working build and test commands. Note the three
commit SHAs; the replay phase cherry-picks them.

## Phase 3 — Gold traces on BASE (commit "gold baseline")

Follow the **appmap-gold-traces** bootstrap: `gold_traces/manifest.yaml` +
`baseline/appmaps/`, with `.gitattributes` marking baselines binary. Curate one
lean, deterministic integration test per subsystem relevant to the BASE..HEAD
feature (DAO and service paths with SQL beat granular unit tests). Use the
engine's `discover` for every `appmap_path`, and give each entry an `expect`
list of the code objects it must execute. Run `check --record`; it records
twice, fails on empty traces, missing `expect` coverage, or run-to-run drift,
and warns on large or repetitive traces. Then seed with `update`. Base the
manifest's record command on the commands doc appmap-setup wrote. Commit.

## Phase 4 — Replay onto HEAD

```sh
git checkout -b appmap-head <HEAD_SHA>
git cherry-pick <config>          # recording config
git cherry-pick <exclusions>      # expect a modify/delete conflict on the
                                  # commands doc - keep the incoming full file
git cherry-pick <commands doc>    # usually empty now -> git cherry-pick --skip
git cherry-pick <gold baseline>   # needed for the review step
```

Verify recording still works at HEAD: re-run the unit recording and the
integration recording, including any test the feature added.

## Phase 5 — Update gold traces on HEAD (commit "gold update")

Run `check --record`, then `update --dry-run` to see which baselines drifted.
Bless only drift the review explains. Add a new entry for the path the feature
changed (its new test is usually the right one), check it with
`check --only <test> --record`, then seed with `update --only <test>`. Commit.

## Phase 6 — appmap-review BASE vs HEAD

Follow **appmap-review** exactly, with `appmap-base` as the baseline and
`appmap-head` as the head. Its recipe covers extracting each branch's committed
gold traces, archiving and comparing them, and writing the findings-first
report.
