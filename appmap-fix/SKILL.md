# Skill: Diagnose and Fix Bugs with AppMap

Use AppMap recordings + the AppMap MCP to investigate bugs whose root
cause isn't obvious from the stack trace alone. The workflow is
iterative: record narrowly, look at the data, deepen the scope where
the data points, repeat until the cause is identified.

This skill orchestrates three other skills:
- **appmap-record** — sets up `appmap.yml`, captures recordings.
- **appmap-label** — places labels on functions so their parameters and
  return values are persisted in the recording.
- **appmap-analyze** — drives the MCP / CLI verbs to query recordings.

This file documents *the loop* and the decisions you make at each step.
For mechanics (commands, syntax, language specifics), defer to those
skills.

## When to use

Use this skill for bugs where:
- The failure path through the code is unclear or spans many files.
- The behavior is data-dependent and hard to reproduce by reading code.
- The codebase is unfamiliar and you need to map call paths quickly.
- Earlier debugging by reading code or inspecting a stack trace has
  stalled.

Don't use it for:
- Type errors, lint failures, or syntax errors.
- Bugs whose stack trace already points at the offending line.
- Pure UI / rendering issues with no backend behavior.

## The loop at a glance

```
       ┌─────────────────────────────────────────┐
       │ 1. Establish scope (appmap.yml)         │
       │ 2. Place anchor labels                  │
       │ 3. Reproduce under recording            │
       │ 4. Investigate via MCP                  │
       │ 5. Deepen scope / add labels            │
       └────────────────┬────────────────────────┘
                        ↑
                        └── repeat 1–5 until root cause found
```

Each iteration should narrow the hypothesis. If a pass through the loop
doesn't, you're either looking in the wrong place (revise the scope) or
you've reached the data that explains the bug — read the code there.

## Step 1 — Establish scope

A bug investigation should start with the smallest `packages:` config
in `appmap.yml` that still captures the suspected region. The goal of
the first recording is orientation, not coverage.

1. Identify the file or class where you suspect the bug is, or where
   the stack trace points.
2. In `appmap.yml`, set `packages:` to that file's package only. Mark
   adjacent dependencies as `shallow: true` so you see entries into
   them without their internals.
3. Defer the syntax to **appmap-record** § Configuration / Iterative
   scoping.

If `appmap.yml` already includes a broad set of packages, consider
narrowing temporarily for the investigation — broad recordings are
slow to read and noisy to query. You can revert when you're done.

## Step 2 — Place anchor labels

Labels are the lever that surfaces *values* in the recording, not just
control flow. A labeled function is **always recorded** (even if its
package isn't instrumented) and its `parameters_json` and
`return_value` are persisted. Unlabeled functions show only call shape;
their parameters and return values are null.

Use a transient **investigation label** to anchor your debugging:

- Pick a single short tag for this investigation, e.g. `bug.4421`,
  `repro`, or `under-investigation`.
- Apply it to 2–4 functions near the suspected region: the entry
  point, an inner function whose return value you want to see, and
  any boundary you suspect (e.g. the function that hands a value to a
  framework).
- Do **not** reuse canonical labels (`log`, `secret`,
  `security.authorization`, etc.) for investigation — keep semantic
  meaning separate from debugging convenience.
- Defer label syntax (Java annotation, Ruby comment, Python decorator,
  JS/TS comment) to **appmap-label**.

Remove transient investigation labels once the bug is fixed; they
shouldn't ship.

## Step 3 — Reproduce under recording

Capture a recording that reproduces the bug.

- Prefer a **failing test case** if one exists or can be written
  quickly — recordings keyed to test names are easy to find later.
- Otherwise, a **scripted reproduction** (a small script that drives
  the failing path) works.
- Wrap the reproducer with the language agent (`npx appmap-node`, the
  Ruby/Python/Java equivalents). Defer to **appmap-record** § Record
  tests / Process recording.
- If you have one, also capture a **passing recording** of the same
  operation (a passing test, the previous behavior on a different
  branch). Side-by-side comparison narrows the hypothesis fast.

After recording:

```sh
npx @appland/appmap index --appmap-dir tmp/appmap --query-db ./query.db
```

This populates the `query.db` the MCP and CLI verbs read from.

## Step 4 — Investigate via MCP

Connect an MCP-aware client (or drive `appmap query mcp` from a
script) at the `query.db`. The recipes below use the MCP tool names;
each is documented in **appmap-analyze**.

**4a. Locate the bug recording.**

```
find_recordings exception="<class>"            (if there's a thrown error)
find_recordings status=">=500"                 (if it's a request bug)
find_recordings appmap="<test name fragment>"  (if it's from a named test)
```

Note the `appmap_id` and `appmap_name` of the failing recording (and
the passing one, if you have it).

**4b. Read the labeled anchor calls.**

```
find_calls label=<investigation-label> appmap=<id-or-name>
```

This returns each anchor call with its `parameters_json` and
`return_value`. Compare values against your mental model of the code.
Discrepancies are leads.

**4c. Pull the call tree around the failure.**

```
get_call_tree appmap=<id> focus_type=function focus_value=<fqid-of-anchor>
get_call_tree appmap=<id> focus_type=function focus_value=<fqid-of-suspect>
get_call_tree appmap=<id>                      (no focus; full tree if it's small)
```

For server-side bugs:

```
get_call_tree appmap=<id> focus_type=http_server_request focus_value=<route>
```

For SQL-related bugs:

```
get_call_tree appmap=<id> focus_type=sql_query focus_value=<sql-fragment>
```

**4d. Read the source.**

Each function call row from `find_calls`, every function node from
`get_call_tree`, and every hotspot row from `function_hotspots`
includes `path` and `lineno`. **Read the source directly at those
coordinates.** This is the single most efficient operation in the
loop — you don't need to grep for the function; you have its file and
line.

**4e. Side-by-side, if you have a passing recording.**

```
get_call_tree appmap=<failing-id>
get_call_tree appmap=<passing-id>
```

Diff the two trees mentally (or with a diff tool). Look for the first
divergence — that's almost always close to the bug.

`find_related appmap=<failing-id> status=succeeded` can help you
discover a passing baseline if you don't already have one.

**4f. Other angles, as needed.**

- `find_logs appmap=<id>` — log lines the app emitted during the run.
  Use `message=<substring>` to narrow if there are many. Logs are
  often the *first* lead when a stack trace is unhelpful: an error
  log just before the failure tells you what the app thought went
  wrong. Captured automatically for any function labeled `log`.
- `find_exceptions appmap=<id> with_logs=10` — each exception comes
  back with the last 10 log lines preceding it under `recent_logs`.
  This is usually the most efficient single-call lead when the bug
  ends in a thrown error.
- `function_hotspots route=<route>` — if "slow" is the bug.
- `sql_hotspots route=<route>` — if a query is the bug.
- `list_labels` — what labels are already present (sanity check that
  your investigation label landed; discover canonical labels you
  could leverage).

## Step 5 — Deepen scope / add labels

After step 4 you should have a hypothesis: "the bug is in X, because
function Y returned Z which is wrong." Now expand the recording's
visibility around X.

- Add X's package to `packages:` in `appmap.yml`.
- If X is in a dependency you don't want to record fully, label the
  specific functions of interest. Labeled functions are recorded with
  parameters and return values regardless of package config — this is
  often more surgical than expanding `packages:`.
- Move the investigation label inward: now anchor on functions inside
  X, not at its boundary.

Re-record (step 3) and re-investigate (step 4). Continue until a
labeled function's parameters or return value, a SQL query, or an
exception contradicts the code's apparent intent. That's the root
cause.

## Heuristics & pitfalls

- **Don't expand all packages at once.** Each iteration should add one
  package or one set of labels. Expanding broadly turns recordings
  unwieldy and queries noisy, defeating the purpose.
- **Anchor labels are cheap.** When in doubt, label one more function.
  You can remove labels in seconds.
- **Trust the data, not the code.** If a labeled function's
  `return_value` disagrees with what the code "should" return, the
  bug is at or below that function. Don't argue with the recording.
- **Keep `tmp/appmap/` clean between iterations.** Old recordings
  persist; rename or delete them before re-recording so `find_recordings`
  doesn't return stale rows. (Re-running `appmap index` is incremental
  — to force a clean rebuild, delete `query.db` and re-index.)
- **Investigation labels are temporary.** Remove them when you commit
  the fix. Canonical labels (`log`, `security.*`, etc.) stay.
- **The MCP gives you `path:lineno` for every function frame.** Use
  it. Manual greps are slower and less accurate than reading at the
  exact line the recording captured.

## Worked example (sketch)

A cron job sometimes processes the same record twice. Stack trace at
failure points at `IdempotencyKeyExpired` from a Redis check.

1. **Scope:** `appmap.yml` → `packages: [app/jobs]` only; everything
   else `shallow: true`.
2. **Labels:** add `bug.dup-job` to `runJob`, `acquireLock`,
   `releaseLock`.
3. **Record:** failing job run via test harness; also a passing run.
4. **MCP:**
   - `find_recordings exception=IdempotencyKeyExpired` → recording
     `id=87`.
   - `find_calls label=bug.dup-job appmap=87` → `acquireLock` returned
     `true` *twice* (with same arguments) before `releaseLock` ran.
   - Read `acquireLock`'s source at the row's `path:lineno`. The lock
     TTL is 0 when no caller passes one; `runJob` doesn't.
5. **Deepen:** add `app/locks` to `packages:`. Re-record and confirm
   that `Redis::set NX EX` is being called without an EX argument
   when the caller is `runJob`.
6. **Fix:** plumb a default TTL through `acquireLock`. Add a label
   `lock.acquire` (canonical) where `bug.dup-job` was. Remove the
   transient labels.

The investigation took three recording rounds — narrow scope kept each
recording small, labels surfaced the wrong return value, and
`path:lineno` removed grep from every step.

## Related skills

- **appmap-record** — recording mechanics, `appmap.yml` scoping.
- **appmap-label** — label syntax per language, canonical label list,
  field-access-via-function pattern.
- **appmap-analyze** — MCP tools, recipes, return-column reference.
- **appmap-secret-in-log** — analogous focused investigation pattern
  for a specific concern.
