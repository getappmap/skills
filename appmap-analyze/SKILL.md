---
name: appmap-analyze
description: Runtime analysis of a project, branch, or subsystem with AppMap, whether or not it already records - record what the code does, write the scenario tests the suite is missing, query the recordings for bugs and design problems that are hard to prove from source alone (hot loops, ignored timeouts, stale cached state, hidden I/O, regressions in shared code), confirm each one, and write a findings-first report in the appmap-review format; or answer one question about runtime behavior with recorded evidence. Use when asked to analyze, audit, or investigate code with AppMap, to find bugs with it, or to review a branch that has no gold traces to compare against. To compare a change against committed gold traces or two existing recordings, use appmap-review.
---

# Skill: AppMap Runtime Analysis

Find bugs and design problems by recording what the code does, and prove each
one with a recording. The output is a report in the **appmap-review** format:
findings first, each with the recorded evidence that backs it.

**appmap-review** answers "what did this change alter, compared with a
baseline?". This skill answers "what is wrong with this code?", with or without
one. Two things follow from that:

- **The suite usually does not run the code that matters.** New or poorly
  tested code is exactly what an analysis is asked about, and the existing
  tests rarely reach its error paths. Most findings come from scenario tests
  written during the analysis, not from recording the suite.
- **You can make a baseline when you need one.** For a branch, record the same
  tests on the merge-base and on the head, from the same checkout, and compare
  them. That is the appmap-review ad-hoc mode, run on recordings you made.

## Where to start

| The project has | Start with |
| --- | --- |
| No AppMap setup | Phase 0 and every phase after it. |
| An `appmap.yml` | Phase 0's run without the recorder, then Phase 1 with the existing config. The noise check still applies. |
| Gold traces (`gold_traces/`) | As above, and add the committed recordings to Phase 2: they are a curated set of the suite's important paths. For a branch, also run **appmap-review** on them; its findings join this report. |
| A specific question ("why is checkout slow", "does `repr` hit the network", "who calls `X`") | **Question mode**, below. |

### Question mode

For one question, not an audit: run Phases 0-2 only as far as needed to record
a test that drives the code in question, write one scenario test in Phase 3 if
none does, run the Phase 4 passes that bear on the question, and apply the
Phase 5 checks to the claims you make. Answer in chat, not with a report:

1. The answer, in one to three sentences.
2. The evidence: the trimmed `tree` excerpt or counts that show it (Phase 7,
   "Evidence"), and the recording it came from.
3. The commands that reproduce it.

Offer a full analysis if the answer turns up a problem worth one.

```
Phase 0  tools; the target's tests pass without AppMap    (appmap-setup)
Phase 1  config, one recording, the noise check           (appmap-config, appmap-record)
Phase 2  record the existing suite; measure coverage of the target
Phase 3  write scenario tests: fake peers, error paths, both-revision tests
Phase 4  query the recordings                    (appmap query + assets/analyze.mjs)
Phase 5  confirm every finding without the recorder
Phase 6  compare base and head for code both revisions run   (appmap-review)
Phase 7  write the report                        (appmap-review "Report format")
```

Do not skip Phases 0 and 1 to get to the analysis sooner. Each removes one
thing that can go wrong, so later problems have one cause instead of two.

## Phase 0 — Tools, and a run without AppMap

Follow **appmap-setup** Phase 0 for the CLI and the language agent. If a tool
cannot be installed, stop as Phase 0 there says.

Then run the target's tests **without the recorder**, the way the project
runs them (**appmap-setup** Phase 1), before touching `appmap.yml` or
enabling the agent. Fix the environment until they run: interpreter and JDK
versions, dependencies, databases, services, environment variables. A test
that cannot run without AppMap will not run with it either, and debugging
the environment and the recorder at once doubles the work.

Save the result of this run (the pass/fail list from the runner's report,
for example `pytest -rA`, JUnit XML, or `--reporter json`). Two later uses:

- A test that already fails here is an **existing failure**, not a finding
  of the analysis. Note it and move on.
- Phase 2 compares this list with the recorded run. A test whose outcome
  differs between the two is affected by the recorder (Phase 5).

## Phase 1 — Config, one recording, the noise check

If the project already has an `appmap.yml`, use it and run the noise check
below anyway: a config made for gold traces can be too broad or too narrow
for this analysis. Otherwise follow **appmap-config**: record the project's
own code in full, and the test directory too if the fakes you write in
Phase 3 live there (their calls are evidence too). **Do not list frameworks
or libraries** (`org.springframework`, `django`, `lodash`): HTTP, SQL, and
exceptions are captured without them, and a whole framework buries the
project's own calls. `shallow: true` does not fix it (see **appmap-config**,
"The starting config").

Enable the hooks the target needs. Some are opt-in:

| Language | Hook | How to enable while recording |
| --- | --- | --- |
| Python | outgoing HTTP (`http.client`, so `requests`/`urllib3` too) | `import appmap.http` in `conftest.py`, guarded by `os.environ.get("APPMAP") == "true"` |
| Python | SQL, bare SQLAlchemy | `import appmap.sqlalchemy` (see **appmap-record**) |

Record **one** test that runs the target (**appmap-record**) and confirm the
recording has the target's functions with their parameters. Confirm each
hook with that recording before relying on its absence: zero
`http_client_request` events means "no hook" as often as "no HTTP".

Then run the noise check on it:

```sh
node "${CLAUDE_SKILL_DIR}/assets/analyze.mjs" noise tmp/appmap --own <own package prefixes>
```

`--own` takes the project's package prefixes, comma-separated, in the form
the recording names classes (`com.acme.shop`, `myapp`), including the test
package if it is recorded. The check prints the
share of calls per package and the functions called most often in one
recording, and fails (exit 2) when a recording is over 1 MiB (`--max-kb`) or
under half of the calls are in the project's own code (`--min-own`). Do not
go on until it passes:

- **A framework or library has most of the calls:** remove its entry from
  `appmap.yml`, or narrow it to the one package a question needs. Excluding
  its utilities one by one does not converge.
- **One of the project's own helpers has thousands of calls** (formatters,
  geometry, string utilities): exclude it (**appmap-config**, "Cutting
  noise"), unless it is part of the target. A hot loop in the target is a
  finding candidate, not noise; keep it, and use `--focus` in `tree` to read
  around it.

Rerun the check on the suite's recordings after Phase 2; a test that
exercises more code can still blow the budget.

## Phase 2 — Record the suite, measure coverage of the target

Record the whole suite once, with values (`APPMAP_DISPLAY_PARAMS=true` for
Python), then index it for `appmap query`:

```sh
~/.appmap/bin/appmap index --appmap-dir tmp/appmap
```

Compare the pass/fail list with the one from Phase 0. A test that passes
without the recorder and fails with it (or the other way round) is affected
by recording; Phase 5 explains the usual causes.

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
Phase 3.

## Phase 3 — Write the scenario tests

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
   file runs unchanged on base and head. They feed Phase 6.

Write each test to assert the **correct** behavior. A failing test is a
finding candidate, and its recording is the evidence. Do not weaken a test to
make it pass; list it in the report.

## Phase 4 — Query the recordings

Record the new tests (same command as Phase 2) and re-index. Then run these
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
Record both sides in the same checkout, as **Recording the base revision**
(Phase 6) describes.

## Phase 5 — Confirm every finding without the recorder

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

## Phase 6 — Compare base and head (branches only)

For each both-revision test from Phase 3, record it on base and on head (as
below) and compare the pair with **appmap-review**'s ad-hoc mode:

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

### Recording the base revision

Record both revisions **in the same checkout**, swapping only the source
directories. A second clone or a worktree changes test ids that embed paths and
anything hashed from paths, so every test shows as changed; some agent
environments also cannot create worktrees at all.

```sh
git status --porcelain -- <src dirs>        # must print nothing; commit or stash first
# 1. record head as usual, then move its recordings aside
mkdir -p tmp/analysis
mv tmp/appmap tmp/analysis/head
# 2. swap the source directories to base; the new tests stay as they are
git restore --source=<base> --staged --worktree -- <src dirs>
#    rebuild or reinstall if the project compiles or the lockfile is in <src dirs>
# 3. record the same tests, move them aside
mv tmp/appmap tmp/analysis/base
# 4. swap back and confirm the tree is as it was
git restore --source=HEAD --staged --worktree -- <src dirs>
git status --porcelain -- <src dirs>        # must print nothing again
```

- **Use `git restore --source`, not `git checkout <base> -- <dirs>`.** Checkout
  with a path writes the base's files but leaves files that exist only on head,
  so the "base" run still imports head's new modules. Restore removes them.
- **The clean-tree check is what makes step 4 safe.** Restore overwrites
  uncommitted changes in those directories without asking.
- **Keep the new tests outside `<src dirs>`**, or they are swapped too. If
  the project keeps tests next to the source, list the source files instead
  of directories.
- **If the dependencies differ** between the revisions (a changed lockfile or
  build file), include that file and reinstall on each side, or say in the
  report that both sides ran on head's dependencies.

## Phase 7 — Write the report

Use **appmap-review**'s "Report format" and "Rules for the interpretation"
unchanged, with these differences:

- **Header.** `**Revisions:**` names the head and the base you recorded, or
  `**Scope:**` for a whole-project analysis. `**Method:**` says "runtime
  analysis" and names what was recorded.
- **Banner.** Say what baseline there was (none, gold traces, or base-revision
  recordings made for the analysis), which tests were written for the
  analysis, and that failing new tests are findings.
- **What the change does** becomes **What the code does** for a whole-project
  analysis.
- **Evidence** on each finding names the test that recorded it, the query
  that shows it, so a reader can rerun it, and the **kind** of evidence it is:
  *count*, *recorded value*, *thread*, *absence*, *timing* (confirmed without
  the recorder), *base/head difference*, *failing test*, or *source only*.
- **Show the evidence, not just a drawing of it** (see below), and link each
  finding to the recording it came from.
- **What the recordings showed** goes after **Checks performed**, before the
  details fold (see below).
- **Existing problems.** Mark findings that are already on the base
  ("existing, `develop`"). An analysis finds them as a matter of
  course, and the reader needs to know they are not the branch's.
- **About the tooling** (optional, after the details fold): recorder side
  effects, agent bugs, and hooks you had to enable. Write it once; reference it
  from findings that depend on it.

### Evidence

appmap-review's format asks for an ASCII diagram on each finding. In an
analysis, the tools' own output is usually the better picture, because the
reader can rerun it and it cannot be drawn wrong:

- **A trimmed `tree` excerpt**, with the command above it:

  ```
  $ node analyze.mjs tree tmp/appmap/pytest/test_busy_device.appmap.json --focus send --depth 3 --params
  Transport#send(cmd=b'STATUS')  !! Timeout: no reply in 5.0s  [5.01s]   <thread 1>
    Port#write(data=b'STATUS\r')
    4309x [
      Port#read(size=1) -> b''
      Clock#now
    ]
  ```

  The `4309x` line is the finding: four thousand reads for one command, and no
  second write after the device said busy. Copy the lines exactly; mark
  anything cut with `…`. Use `--params` when a value is the point, `--hide` to
  drop calls that do not bear on it.
- **A count table** from `find calls` or `countdiff` when the finding is a
  number across tests or revisions.
- **A drawn diagram** only for what no single output shows: two threads side
  by side, a request and a late reply on a timeline, the base and head paths
  next to each other. Draw it from the recording, and mark any step that comes
  from the source rather than the recording.

Never write tool output by hand. If the command was not run, there is no
excerpt.

**Link the recordings.** `tmp/appmap` is not committed, so a link into it is
dead for every other reader. Copy each recording a finding cites next to the
report (`<report dir>/evidence/<test>.appmap.json`), commit it with the report,
and link it from the finding's Evidence line, with the event id when the
finding is about one call (`evidence/test_busy_device.appmap.json`, event
1842). The AppMap IDE extensions open these files as diagrams. Values in
recordings are real: do not commit a recording that holds secrets or personal
data; cite the excerpt instead.

### What the recordings showed

One short table, one row per finding, referencing it by number (the finding
itself stays in **Findings**):

| # | Evidence | Found by the recording, or confirmed by it |
| --- | --- | --- |
| 1 | count | found: the source reads in a loop; only the recording shows 4309 reads and no retry for one busy reply |
| 2 | recorded value | found: `timeout=None` reaches the socket, though the caller passed 2.0 |
| 3 | source only | — |

Then one sentence with the totals ("5 of 7 findings rest on recorded evidence;
3 were found by it, 2 confirmed"). Be honest about the split: a finding that a
careful read of the source would have caught is "confirmed", not "found", and
a source-only finding says so. This section is the reader's answer to "what
did running the code add?", and it is only useful if it can say "not much".

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
- **Do not trust the recorder blindly.** Phase 5 is not optional.
