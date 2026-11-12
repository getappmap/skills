---
name: appmap-analyze
description: Greenfield runtime analysis of a project, branch, or subsystem that has no gold traces - record what the code does with AppMap, write the scenario tests the suite is missing, query the recordings for bugs and design problems that are hard to prove from source alone (hot loops, ignored timeouts, stale cached state, hidden I/O, regressions in shared code), confirm each one, and write a findings-first report in the appmap-review format. Use when asked to analyze, audit, or review an existing codebase or feature branch with AppMap and no committed baseline exists. For reviewing a change against committed gold traces, use appmap-review.
---

# Skill: AppMap Greenfield Analysis

Find bugs and design problems in code that has never been recorded, and prove
each one with a recording. The output is a report in the **appmap-review**
format: findings first, each with the recorded evidence that backs it.

**appmap-review** answers "what did this change alter, compared with the
blessed baseline?". This skill answers "what is wrong with this code?" when
there is no baseline. Two things follow from that:

- **The suite usually does not run the code that matters.** New or poorly
  tested code is exactly what a greenfield analysis is asked about, and the
  existing tests rarely reach its error paths. Most findings come from
  scenario tests written during the analysis, not from recording the suite.
- **You can make a baseline when you need one.** For a branch, record the same
  tests on the merge-base and on the head, from the same checkout, and compare
  them. That is the appmap-review ad-hoc mode, run on recordings you made.

```
Phase 0  tools, config, hooks                    (appmap-setup, appmap-record)
Phase 1  record the existing suite; measure coverage of the target
Phase 2  write scenario tests: fake peers, error paths, both-revision tests
Phase 3  query the recordings                    (appmap query + assets/analyze.mjs)
Phase 4  confirm every finding without the recorder
Phase 5  compare base and head for code both revisions run   (appmap-review)
Phase 6  write the report                        (appmap-review "Report format")
```

## Phase 0 — Tools, config, hooks

Follow **appmap-setup** Phase 0 for the CLI and the language agent, and
**appmap-config** for `appmap.yml`: record the project's own code in full, and
the test directory too if the fakes you write in Phase 2 live there (their calls
are evidence too). Then enable the hooks the target needs. Some are opt-in:

| Language | Hook | How to enable while recording |
| --- | --- | --- |
| Python | outgoing HTTP (`http.client`, so `requests`/`urllib3` too) | `import appmap.http` in `conftest.py`, guarded by `os.environ.get("APPMAP") == "true"` |
| Python | SQL, bare SQLAlchemy | `import appmap.sqlalchemy` (see **appmap-record**) |

Confirm each hook with one recording before relying on its absence: zero
`http_client_request` events means "no hook" as often as "no HTTP".

## Phase 1 — Record the suite, measure coverage of the target

Record the whole suite once, with values (`APPMAP_DISPLAY_PARAMS=true` for
Python), then index it for `appmap query`:

```sh
~/.appmap/bin/appmap index --appmap-dir tmp/appmap
```

Then ask which of the target's functions ran at all. For a branch, the target
is what the diff touches:

```sh
node "${CLAUDE_SKILL_DIR}/assets/analyze.mjs" coverage --base <merge-base> [--head <rev>] [--path <src dir>]
```

It maps each diff hunk to the function around it (a text heuristic per
language; check a surprising miss by hand) and prints how often the recordings
called it. For a whole project, use `appmap query hotspots --limit 0` and look
for the modules that are missing. Every ❌ on a function that talks to the
outside world (network, device, disk, another thread) needs a scenario test in
Phase 2.

## Phase 2 — Write the scenario tests

Write normal tests the project can keep. Three kinds pay off most:

1. **A fake peer built from the project's own code.** If the code talks to a
   server, device, or broker, run an in-process fake of it: an HTTP server in a
   thread, a mock port, an in-memory broker. Build it from the project's own
   server-side or simulator classes when they exist, so the fake speaks the
   real protocol. Give it switches for the ways real peers misbehave:
   **busy** (try later), **slow** (answers after the timeout), **moved** (same
   identity, new address), **stale** (replies to an earlier request),
   **unauthorized**, and **malformed** replies.
2. **Error-path scenarios**, one per switch, each asserting what a caller
   should see. Also: values that collide with the encoding (a string that
   looks like the escape prefix), and construction from another thread
   (signal handlers, thread-locals, event loops).
3. **Both-revision tests** for code the branch changed but that also serves
   existing users (a shared base class, a common send/receive loop, a
   simulator). Write them against the API both revisions have, so the same
   file runs unchanged on base and head. They feed Phase 5.

Write each test to assert the **correct** behavior. A failing test is a
finding candidate, and its recording is the evidence. Do not weaken a test to
make it pass; list it in the report.

## Phase 3 — Query the recordings

Record the new tests (same command as Phase 1) and re-index. Then run these
passes. Each names what to look for and the command that shows it.

| Pass | Look for | Command |
| --- | --- | --- |
| Repetition without I/O | the same few calls repeated hundreds of times under one call, with no HTTP/SQL/IO under them: a spin or busy-wait loop | `appmap query hotspots` (CALLS column), then `analyze.mjs tree <file> --focus <fn>`, which prints `4309x [ … ]` |
| Values that should not be there | a default value where the caller asked for something else (timeouts, flags, modes); a secret in a plain-HTTP call | `appmap query find calls --class <C> --method <m>` (PARAMS column) |
| Identity and staleness | the same object returned for a different input (address, path, user); the next call going to the old place | `appmap query tree <appmap> --focus-url <host:port>`; compare argument and return values in `find calls` |
| Ignored results | a check that runs and whose result is then not used (a type or permission check followed by the opposite branch) | `analyze.mjs tree <file> --params` |
| Hidden I/O | network, device, or disk calls under functions that should be pure: `repr`/`toString`, property getters, logging | `appmap query tree <appmap> --filter http`; I/O whose parent is not an I/O function |
| Exceptions | exceptions escaping where the caller expects an error code; exceptions swallowed and retried | `appmap query find exceptions [--exception <class>]` |
| Threads | work on unexpected threads, results used after the call that started them returned | the `<thread N>` markers in `analyze.mjs tree` |
| Drift in the suite (branches) | which existing tests changed behavior between base and head | `analyze.mjs countdiff <base-recordings> <head-recordings>` |

`countdiff` works per function. Use it instead of the whole-suite structural
compare when the compare's text names every actor by package (`endaq#send`).
Record both sides from the **same checkout path**: `git checkout <base> -- <src
dirs>`, record, move the recordings aside, `git checkout HEAD -- <src dirs>`.
A second worktree changes test ids that embed paths and anything hashed from
paths, and every test shows as changed.

## Phase 4 — Confirm every finding without the recorder

Recording changes what runs. Before a finding goes in the report:

- **Value capture calls `repr()` / `toString()`** on every argument and
  receiver. If those do I/O or fill caches, the recording itself adds network
  calls, changes cache state, and can flip a test's outcome. Re-run the failing
  test without the recorder. A finding that disappears is about the recorder,
  or about the side effect in `repr` (which is a finding of its own).
- **Timings under recording are not timings.** Value capture and event writing
  can turn milliseconds into seconds. Confirm any latency claim with a plain run
  (`time`, a profiler).
- **Check the captured values against the source.** A recorded value is the
  agent's rendering of it, and agents have bugs. Python agents before 4.0.0,
  for example, record an optional parameter passed *positionally* as its
  default (`password=None` for a password that was passed); see
  **appmap-record**, `languages/python.md`. Check the agent version before
  trusting a recorded default.
- **Run the whole suite and each new test alone.** A test that passes only
  after other tests ran is depending on shared state, which is often the
  finding.

## Phase 5 — Compare base and head (branches only)

For each both-revision test from Phase 2, record it on base and on head (same
checkout path) and compare the pair with **appmap-review**'s ad-hoc mode:

```sh
node "${CLAUDE_SKILL_DIR}/../appmap-review/assets/review.mjs" compare \
  --base-appmap <base recording> --head-appmap <head recording> \
  --name <test> --base <base-rev> --head <head-rev> --workspace <dir per test>
```

The text diff states each regression in one line, for example "changed
`startRecording` to return boolean instead of exception!". A test that passes
on base, fails on head, and has such a line is a regression with proof. Then
read the commit that introduced it (`git log -S'<changed line>'`): a change
made for the new feature inside code the old users also run is the
side-effect pattern appmap-review's recipe calls out.

## Phase 6 — Write the report

Use **appmap-review**'s "Report format" and "Rules for the interpretation"
unchanged, with these differences:

- **Header.** `**Revisions:**` names the head and the base you recorded, or
  `**Scope:**` for a whole-project analysis. `**Method:**` says "greenfield
  runtime analysis" and names what was recorded.
- **Banner.** Say that there were no gold traces, which tests were written for
  the analysis, and that failing new tests are findings.
- **What the change does** becomes **What the code does** for a whole-project
  analysis.
- **Evidence** on each finding names the test that recorded it and the query
  that shows it, so a reader can rerun it.
- **Existing problems.** Mark findings that are already on the base
  ("existing, `develop`"). A greenfield analysis finds them as a matter of
  course, and the reader needs to know they are not the branch's.
- **About the tooling** (optional, after the details fold): recorder side
  effects, agent bugs, and hooks you had to enable. Write it once; reference it
  from findings that depend on it.

Commit the new tests and the report on a branch. The tests are the regression
tests the findings' **Fix** sections name.

## Rules

- **A finding needs a recording or a failing test, and a reason.** The source
  says what could happen; the recording shows that it does. When only the
  source supports a finding (a missing dependency, an insecure default), say
  "source only" in its Evidence line.
- **Look for absence.** The strongest evidence is often a count: one request
  and four thousand reads, no new request after a "try later", no check before
  a write. Counts come from recordings, not from reading code.
- **Group by cause.** Several symptoms with one design cause (for example a
  request/response transport forced into a stream-polling loop) are one finding
  with parts, plus the architectural fix.
- **Do not trust the recorder blindly.** Phase 4 is not optional.
