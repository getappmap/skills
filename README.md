# AppMap Skills

Agent skills for working with [AppMap](https://appmap.io) runtime recordings. Each
directory is a self-contained skill (a `SKILL.md` the agent reads, plus any assets).

| Skill | What it does |
| --- | --- |
| [`appmap-record`](appmap-record/SKILL.md) | Record runtime data from an application with the AppMap agents. |
| [`appmap-label`](appmap-label/SKILL.md) | Configure what gets recorded — per-function labels and `appmap.yml` scoping. |
| [`appmap-gold-traces`](appmap-gold-traces/SKILL.md) | Maintain a committed baseline of curated recordings ("gold traces") and bless it as code evolves. |
| [`appmap-review`](appmap-review/SKILL.md) | Diff a change's runtime behavior against the baseline and write an interpreted code review. |

## Use with Claude Code

Symlink (or copy) the skills you want into `~/.claude/skills`, then invoke them by name:

```sh
ln -s "$PWD/appmap-review" ~/.claude/skills/appmap-review
```

## Use in CI

The [`getappmap/review-action`](https://github.com/getappmap/review-action) GitHub
Action installs these skills and runs `appmap-gold-traces` + `appmap-review` on a pull
request.
