---
name: appmap-archive
description: Package AppMap recordings as an AppMap archive (one .tar per revision), the form the other skills take when they compare two revisions. Makes the archive from a list of recording files or directories without changing them, and explains the three ways to hand two sides to appmap-review, appmap-analyze and appmap-diagram - committed gold traces, two archives, or two directories of recordings. Use when asked to archive, package, or hand over AppMap recordings, or when another skill needs the base and head recordings of a change. It does not record anything and does not check out or run a revision.
---

# Skill: AppMap Archive

The skills that compare two revisions do not run them. Building and running a
revision depends on the project (dependencies, a build, services, the state of
the working tree), so the caller does that, by whatever method fits, and hands
over the recordings:

```
caller: runs base its own way ──► base recordings ──┐
caller: runs head its own way ──► head recordings ──┤
                                                    ▼
                          appmap-review compare ──► change report, diff diagrams
                                                    ▼
                    appmap-review / appmap-analyze / appmap-diagram
```

## The three ways to hand over two sides

| The caller has | Pass to `appmap-review/assets/review.mjs compare` |
| --- | --- |
| Gold traces committed on both revisions | `--base <rev> [--head <rev>]`. Both sides are read from git; nothing is run. |
| Two archives (recommended when the sides are recorded) | `--base-archive <tar> --head-archive <tar>` |
| Two directories of recordings | `--base-appmap <dir> --head-appmap <dir>` |
| One recording per side | `--base-appmap <file> --head-appmap <file>` |

An archive and a directory can be mixed. A single file compares only with a
single file. All of them end in the same `appmap compare`, so the results read
the same whichever way the sides arrived.

An archive is the better hand-off when the two sides are made in different
places (another checkout, another machine, CI): it is one file, it is named by
its revision, and it needs no checkout to read.

## Making an archive

```sh
node "${CLAUDE_SKILL_DIR}/assets/archive.mjs" --revision <name> --out <file.tar> <recording or directory>...
```

Run it inside the project, so the project's `appmap.yml` is the one used. An AppMap
CLI whose `archive` command has `--appmap-dir` works without one, so recordings can be
archived from anywhere; an older CLI needs the `appmap.yml`.

- `--revision` names the archive: the commit SHA, or a label such as `base`.
- A file is archived under its own name. A directory's recordings keep their
  paths below it.
- An existing `--out` file is not overwritten.

The helper copies the recordings to a temporary directory, each at the path it
will have in the archive, and archives the copy. The recordings and the project are
left as they were, and a list of files and directories becomes one archive.

Without the helper, when one directory already holds the recordings laid out the way
you want them, a CLI that has these options does the same in one command:

```sh
appmap archive --appmap-dir <directory> --no-in-place --revision <name> --output-file <file.tar>
```

`--no-in-place` is what leaves the directory unchanged. An older CLI has neither
option: it indexes `appmap_dir` in place and puts its tar under the directory it runs
in, which is what the helper works around.

## Rules for two sides that compare cleanly

- **The same test needs the same path on both sides.** `appmap compare` pairs a
  recording with the one at the same path in the other side. Archive each side
  from a directory laid out the same way (`<side>/pytest/test_checkout.appmap.json`).
  The helper refuses two recordings that would get one path.
- **Use the same `appmap.yml` and the same AppMap CLI version for both.** A
  different config or CLI can show differences the code did not cause.
- **Record only the tests you want compared.** An archive can hold any subset
  of a project's recordings; a recording on one side only is reported as new or
  removed.
- **Recordings hold real values.** Treat an archive like the recordings in it:
  do not commit or share one that holds secrets or personal data.

## Files

```
assets/archive.mjs        the helper
assets/archive.test.mjs   node --test assets/archive.test.mjs
```

Needs **appmap-gold-traces** installed beside it (the `appmap.yml` lookup and
the AppMap CLI lookup).
