# AppMap Skills

Agent skills for working with [AppMap](https://appmap.io) runtime recordings. Each
directory is a self-contained skill (a `SKILL.md` the agent reads, plus any assets).

| Skill | What it does |
| --- | --- |
| [`appmap-record`](appmap-record/SKILL.md) | Record runtime data from an application with the AppMap agents. |
| [`appmap-config`](appmap-config/SKILL.md) | Configure what gets recorded: `appmap.yml` (packages, exclude, shallow, output dir) and function labels, per language. |
| [`appmap-gold-traces`](appmap-gold-traces/SKILL.md) | Maintain a committed baseline of curated recordings ("gold traces") and bless it as code evolves. |
| [`appmap-review`](appmap-review/SKILL.md) | Diff a change's runtime behavior against the baseline, or between two recordings made by hand, and write an interpreted code review. |
| [`appmap-diagram`](appmap-diagram/SKILL.md) | Draw a focused, annotated sequence diagram from a recording: the code path behind a review finding, or what a change did to a trace. |
| [`appmap-archive`](appmap-archive/SKILL.md) | Package recordings as an AppMap archive without changing them, and hand two revisions' recordings to the skills that compare them. The skills do not run the revisions; the caller does. |
| [`appmap-analyze`](appmap-analyze/SKILL.md) **(beta)** | Runtime analysis, with or without an existing AppMap setup: record the code, write the missing scenario tests, query the recordings for bugs and design problems, and report them in the appmap-review format; or answer one question about runtime behavior with evidence. |
| [`appmap-pr-movie`](appmap-pr-movie/SKILL.md) **(beta)** | Make a one-minute summary of a pull request as a narrated video, a podcast clip and a script, from a browser walkthrough and an AppMap diagram of what changed. |
| [`appmap-setup`](appmap-setup/SKILL.md) | Get a repository recording AppMap data: config, one unit and one integration recording, noise exclusions, and the working record commands written into `gold_traces/manifest.yaml`. |
| [`appmap-setup-review`](appmap-setup-review/SKILL.md) | Demonstrate a gold-trace review on an existing change: set up recording and gold traces on a BASE commit, replay onto HEAD, and run `appmap-review` between them. |

Skills marked **(beta)** work, but their procedure and report format may still
change between releases.

## Which skill reviews my branch?

Four skills can look at a branch. Which one fits depends on what the
repository already has:

| The repository has | Use |
| --- | --- |
| Gold traces (`gold_traces/`) | `appmap-review`, comparing the two revisions' gold traces. |
| Recordings of the same scenarios on each branch, made by hand or in CI: one file, a directory, or an archive per side | `appmap-review`, ad-hoc mode. `appmap-archive` packages a side as one file. |
| Nothing yet, and you want a lasting baseline for future reviews | `appmap-setup-review`: sets up gold traces on the base, then reviews. |
| Nothing yet, and you want the bugs found now | `appmap-analyze`: writes scenario tests, records both revisions, and reports findings. |

`appmap-analyze` also answers one-off questions about runtime behavior ("why
is this slow", "who calls this") on any project.

## Use with Claude Code

The AppMap extension for VS Code installs the released skills into `~/.claude/skills`
and keeps them up to date. Invoke them by name.

To use a skill that is not released yet, or to change one, see
[Development](#development).

## Use in CI

The [`getappmap/review-action`](https://github.com/getappmap/review-action) GitHub
Action installs these skills and runs `appmap-gold-traces` + `appmap-review` on a pull
request.

## Development

### Use the skills from a checkout

Link every skill from this checkout into `~/.claude/skills`, in place of the released
copies:

```sh
node scripts/install.mjs --dry-run   # show what would change
node scripts/install.mjs
```

Install them together. The skills run each other's scripts by relative path, so a
mix of this checkout and a released copy can fail in ways that are hard to read. The
script adds a link for each skill, repoints a link of the same name that goes
somewhere else, and removes a link to a skill this checkout no longer has. It leaves
real files and directories alone. `--dir` names another skills directory.

To go back to the released copies:

```sh
node scripts/install.mjs --uninstall --dry-run
node scripts/install.mjs --uninstall
```

Each link that points into this checkout is pointed back at the released copy of that
skill in `~/.appmap/skills`, where the AppMap extension for VS Code keeps them. A
skill with no released copy has its link removed. Links that point anywhere else are
not touched.

Installing from a shell, without the preview or the cleanup:

```sh
mkdir -p ~/.claude/skills
for skill in */SKILL.md; do
  name=${skill%/SKILL.md}
  ln -sfn "$PWD/$name" ~/.claude/skills/"$name"
done
```

Run it from the top of the checkout. It replaces a link of the same name. It does
not remove a link to a skill that is gone, and if a real directory of that name is
already there, it puts the link inside that directory instead of replacing it.

The AppMap extension only manages links that point into its own copy
(`~/.appmap/skills`), so once a link points at this checkout the extension leaves it
alone.

### Run the tests

The helper scripts have tests that need only Node:

```sh
node --test scripts/*.test.mjs appmap-*/assets/*.test.mjs
```
