---
name: appmap-record
description: Record AppMap data from tests, HTTP requests, a running process, or a code block, for Ruby, Python, Node, and Java. Use when asked to record, capture, or generate AppMap data, or when recording produces no output. Configuration syntax is in appmap-config.
---

# Skill: Record AppMap Data

Record runtime data from applications using AppMap agents. AppMap captures
function calls, HTTP requests, SQL queries, parameters, return values, and
exceptions into `.appmap.json` files that can be analyzed for performance,
correctness, and design.

## When to use

Use this skill when the user or an agent wants to:
- Record AppMap data from tests, ad-hoc programs, or a running application
- Troubleshoot why AppMap recording is not producing output

## General workflow

1. **Verify** the AppMap agent is installed for the project's language.
2. **Run** tests or the application with AppMap enabled.
3. **Find** recorded data in `tmp/appmap/` (default output directory).

## Configuration

This skill covers *making* recordings — running tests, serving HTTP
under the agent, wrapping a code block with a programmatic recorder.

A default `appmap.yml` is auto-created by each language agent if none
exists, so most invocations work without prior configuration. Built-in
hooks capture HTTP, SQL, exceptions, and labeled functions even with
no `packages:` declared.

To change what a recording contains (`packages:`, `exclude:`, `shallow:`,
`appmap_dir`, labels), see **appmap-config**. It has the syntax for each
language and the YAML quoting rule for method ids that contain `#`.

## Output directory

Leave the output directory at `tmp/appmap`. Every agent defaults to it,
and the gold-traces engine and the review read `appmap_dir` from
`appmap.yml` to find recordings. Changing it is for one-off situations,
such as recording into a scratch directory outside the repo. Each agent
has its own way to do it, checked against the agent source:

| Agent | How to change it | Relative to |
| --- | --- | --- |
| Ruby | `APPMAP_OUTPUT_DIR=<dir>` environment variable. The `appmap_dir` key in `appmap.yml` is ignored. | the working directory |
| Python | `appmap_dir: <dir>` in `appmap.yml`. There is no supported environment variable; `APPMAP_OUTPUT_DIR` exists for the agent's own tests and logs a warning. | the directory holding `appmap.yml` |
| Node | `appmap_dir: <dir>` in `appmap.yml`. No environment variable. | the project root: the directory holding `appmap.yml`, or `APPMAP_ROOT` if set |
| Java | `appmap_dir: <dir>` in `appmap.yml`, or `-Dappmap.output.directory=<dir>` / `APPMAP_OUTPUT_DIRECTORY=<dir>`. The property wins over the file and logs a warning when both are set. | the directory holding `appmap.yml` |

Test recorders write into a subdirectory of that directory named for the
framework (`rspec`, `minitest`, `pytest`, `jest`, ...). The Maven and Gradle
plugins have their own settings; see `languages/java.md`.

## After recording: index for queries

Recordings are written as `.appmap.json` files. To query them with
the MCP or CLI verbs, index into a queryable database first:

```sh
~/.appmap/bin/appmap index --appmap-dir tmp/appmap
```

This populates `~/.appmap/data/<sha>/query.db`.

## Language reference

Read the one file for the project's language. Each covers the agent install,
recording tests, HTTP requests, processes, and code blocks, plus
troubleshooting for that agent.

| Language | File |
| --- | --- |
| Ruby | `languages/ruby.md` |
| Python | `languages/python.md` |
| Node / JavaScript / TypeScript | `languages/node.md` |
| Java | `languages/java.md` |

A project with two languages, such as a Java backend and a JavaScript frontend,
needs two files and two `appmap.yml` files; see **appmap-config**, "Layout".
