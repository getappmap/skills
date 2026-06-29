# Skill: Maintain AppMap Gold Traces

Guard server/application **behavior** across releases with a curated set of
AppMap recordings kept as a committed baseline. On each release you re-record
the same tests and diff the new traces against the baseline to catch
*unintended* changes in call structure, exceptions, return shapes, participating
packages, and security-sensitive behavior — the kind of regression that still
passes the test suite.

A gold trace is a behavioral *snapshot*, not an assertion: the test stays green,
but the trace shows that the path it exercised changed shape. The skill turns
those snapshots into a release gate.

## When to use

Use this skill when the user or an agent wants to:
- **Bootstrap** a gold-traces baseline in a project that doesn't have one.
- **Operate** an existing baseline during a release: re-record, compare,
  interpret the diff into a review, and bless intended changes.
- Investigate why a release's server behavior drifted from the last baseline.

This is the *behavioral-regression* layer over AppMap. To make recordings, see
**appmap-record**; to scope what gets recorded, see **appmap-label**; to query
recordings, see **appmap-analyze**.

## How it works

The model is **baseline → re-record → compare → interpret → bless**:

1. A manifest (`appmap_golden_set.yaml`) names a curated set of tests and the
   recordings they produce.
2. The raw baseline AppMaps are committed under `baseline/appmaps/`.
3. At compare time the engine exports each AppMap to AppMap's JSON
   sequence-diagram form and compares in **two tiers**:
   - **High-level pass.** A single digest over the diagram's root subtree
     digests. Equal digests = no behavioral change, full stop. The digest is
     built from AppMap's `stableProperties` — normalized SQL (literals and
     bind-params abstracted), code-object identity, exceptions — and **excludes**
     volatile data: elapsed time, object ids, parameter/return *values*, and
     random strings. So timing jitter and unstable test data never register.
   - **Drill-down pass.** When the digests differ, it runs the AppMap CLI's
     `sequence-diagram-diff` — an **edit-distance alignment**, robust to inserted
     or removed frames (no positional cascade) — to get the changed actions plus
     a compact text diff for the report.
4. The engine emits a **label-annotated change digest** (`reports/latest-compare.json`):
   every changed/added/removed action, tagged with the AppMap **labels** in its
   context (any namespace — `security.*`, `io.*`, `format.*`, `cache.*`, …, read
   straight from the diagram) and a structural classification (SQL added/removed/
   changed via fingerprint, call added/removed, exception/return change, actor
   delta). It also emits a coarse first-pass `findings` list — treat that as a
   **hint**, not the verdict. The digest is *facts*; labels are interpretation
   hints, not a hard-coded severity gate.
5. **You (the skill) interpret the digest into a review report** — the actionable
   layer the raw structural diff lacks. For each change you read its label context
   + structural shape + the source diff, and write what it *means* and what to
   verify (see **Interpret and report** below). This replaces a fixed findings
   table: a `security.*` change is an auth implication, an `io.http` change an
   external-call implication, a removed query a possibly-dropped guard — you reason
   from the labels and structure, not from an enumerated rule set.
6. You bless intended changes by copying the fresh recordings over the baseline.

The engine stores **only** the raw baselines; sequence/diff artifacts are derived
under `.tmp/` and regenerated each run.

**Labels are interpretation hints.** A change under *any* labeled function is
interpretable — the label names the domain (auth, i/o, serialization, cache) so
you can reason about the implication. So the functions you want interpreted must
be **labeled** (see **appmap-label**). A label on a function also covers a change
in its body — a new child query under a labeled `_claim_player` is surfaced even
though the function node itself is unchanged.

**Coverage is path-dependent.** A gold trace only guards a code path it actually
executes. A conditional security gate (`if game.is_private: <check>`) is invisible
to a trace that never drives that branch — a public-game claim trace cannot catch
a regression in the private-game gate. Curate the manifest so some entry exercises
each guarded branch; a single happy-path trace is not enough for a conditional
guard.

## Layout

The engine and templates ship with this skill; the *data* lives in the target
project and is committed there.

```
<skill>/assets/
  manage.mjs                          engine (config-driven, zero-install Node)
  manage.test.mjs                     engine tests (node --test, no deps)
  config.template.yaml                machine config template
  appmap_golden_set.template.yaml     manifest template
  gitignore.template                  ignores derived artifacts

<project>/gold_traces/                 created at bootstrap, committed in the project
  config.yaml                         commands + paths (machine config)
  appmap_golden_set.yaml              the curated list (core + optional)
  baseline/appmaps/**.appmap.json     committed baselines
  reports/latest-compare.{json,md}    committed canonical report
  .tmp/                               derived, gitignored
```

The engine has no npm dependencies — it runs straight from Node (uses a bundled
minimal YAML reader). Invoke it from the **project root**:

```sh
node "<skill>/assets/manage.mjs" <command> --dir gold_traces [options]
```

(`<skill>` is this skill's directory — substitute its absolute path. `--dir`
defaults to `gold_traces`.)

## Bootstrap (first time in a project)

When `gold_traces/` does not yet exist:

1. **Create the directory** and seed it from the templates:
   ```sh
   mkdir -p gold_traces/baseline/appmaps gold_traces/reports
   cp "<skill>/assets/config.template.yaml"             gold_traces/config.yaml
   cp "<skill>/assets/appmap_golden_set.template.yaml"  gold_traces/appmap_golden_set.yaml
   cp "<skill>/assets/gitignore.template"               gold_traces/.gitignore
   ```

2. **Fill in `config.yaml`.** Get the project's record command and paths from
   the project's `CLAUDE.md` first; if they aren't documented there, **ask the
   user** (the record invocation, the test working directory, the AppMap output
   dir, any env flag the recorder needs). Write them into `config.yaml` — after
   this, the config is the source of truth and you never re-ask. See
   **Config reference** below.

3. **Curate the manifest.** Replace the template entry with real `core` entries.
   Prefer real integration paths over validation-only branches, distinct
   subsystems over duplicates, and **deterministic** traces (seed any RNG).
   Mark `feature: auth` on auth/identity entries so changes there are always
   flagged for security review.

4. **Seed the baseline.** Record each entry and copy the recording into the
   baseline (the compare errors without a baseline to diff against):
   ```sh
   node "<skill>/assets/manage.mjs" update --dir gold_traces --record
   ```
   `update --record` re-records every manifest entry and copies the results into
   `baseline/appmaps/`. (To seed only specific entries, add `--only <test_name>`,
   repeatable.)

5. **Mark baselines binary** so Git doesn't produce noisy line diffs. Add to the
   repo-root `.gitattributes`:
   ```
   gold_traces/baseline/appmaps/**/*.appmap.json binary
   ```

6. **Commit** the new baseline as its own change:
   ```sh
   git add gold_traces .gitattributes
   git commit -m "chore(gold-traces): establish baseline"
   ```

## Operate (each release)

Refresh the baseline as part of the release so it tracks what shipped. **Skip
only if the release touched no traceable application code.**

1. **Know the drift surface.** The baseline was last blessed at the last commit
   touching it:
   ```sh
   git log -1 --format=%h -- gold_traces/baseline/appmaps/
   ```
   Review traceable change since then (`git log <that-commit>..HEAD --oneline -- <app source>`)
   and **enhance the manifest** for new/changed subsystems: add a `core` entry
   for a newly-critical path, or promote an `optional` entry into `core` when
   this release materially changed it. Seed a baseline for any newly-added entry
   (`update --only <test> --record`) or compare will error on it.

2. **Re-record and compare:**
   ```sh
   node "<skill>/assets/manage.mjs" compare --dir gold_traces --record
   ```
   This re-records every `core` entry and diffs against the baseline into
   `gold_traces/reports/latest-compare.{json,md}`. Compare **never** writes the
   baseline. Add `--include-optional` to also compare the optional set.

3. **Interpret the digest — write the review report.** Volatile data is not in the
   digest, so an entry with `changed: true` has a **structural or SQL** delta —
   never timing or unstable-value jitter. Read `reports/latest-compare.json` (each
   changed entry carries `changes` with label context + a `text_diff`) **together
   with the source diff for this release** (`git log <last-bless>..HEAD`), and
   **interpret** each change into the report described in **Interpret and report**
   below. This is your job, not the engine's: for each change reason from its label
   + structure + the code to *what it means and what to verify* — a `security.*`
   change is an auth implication, a removed query a possibly-dropped guard, a new
   `io.http` call an external dependency. **Stop and ask the user** on anything you
   read as a regression (a dropped guard/predicate, a newly-raised or now-swallowed
   exception, a security-labeled behavior change you can't tie to intended work) or
   any drift you can't explain. A trace that drifts every run with **no** code
   change is nondeterministic — fix the trace (seed it), don't bless the noise.

4. **Bless only meaningful change** (avoid Git churn):
   - **Nothing changed:** leave the baseline alone — compare never touched it.
     (Timing and unstable-value jitter never mark an entry changed, so there is
     no timing-noise case to discard.)
   - **Real, intended structural drift:** bless just the traces that changed,
     reusing the recordings from step 2 (do **not** pass `--record` again — that
     re-records and re-introduces noise):
     ```sh
     node "<skill>/assets/manage.mjs" update --dir gold_traces --only <changed_test> [--only <another>]
     ```
     Blessing per-entry keeps untouched baselines byte-identical. The one case
     where re-blessing the whole set at once is correct is an `exclude` change
     that legitimately shrinks every baseline (see **Keeping traces lean**).

5. **Commit separately**, staging only what genuinely changed (manifest edits,
   newly-blessed baselines, the report):
   ```sh
   git add gold_traces <touched source files>
   git commit -m "chore(gold-traces): refresh baseline for <version>"
   ```
   If only the report churned (no manifest or baseline change), committing it is
   optional.

To gate CI or a release script, add `--fail-on-changes` to the compare — it
exits non-zero when any trace changed.

## Interpret and report

The engine produces *facts* (`reports/latest-compare.json`): a label-annotated,
de-noised inventory of what changed. The **review report is your interpretation of
those facts** — what each change means and what to do. The engine does not and
should not write it; a fixed findings table can't reason about a change the way
you can. Produce the review in two moves: run the **steps** below to gather
findings from the digest + source diff, then **render** them in the format that
follows.

### Steps

This is the Review2 review pipeline re-grounded on the behavioral diff: everywhere a
step would use "AppMaps as context," read the **change-digest**
(`reports/latest-compare.json`) and the per-trace diff sequence diagrams — they are
the primary evidence of *what changed*. Run all steps in one pass.

**1 — Feature List.** Inspect the source diff (`git log <last-bless>..HEAD`),
enumerate the features and functional changes (application code only — not
tests/config), and name each as a complete declarative statement (e.g. "Added a
gameByCode query that resolves a private game by code"). Note which produced runtime
drift in the digest — those are higher-signal. → per item: `feature`.

**2 — Coverage Matrix.** For each feature, list the gold/manifest tests that exercise
it. ✅ covered; ❌ **uncovered** when a behavior that should be guarded has no trace —
especially a security-labeled path with no *negative* test. For each gap, emit the
command to record the missing test. → per feature: `feature`, `tests[]` (`file`,
`testName`, `startLine?`).

**3 — Suggested Labels.** For functions that **changed in the digest but carry no
label**, suggest one from the taxonomy so the next compare can interpret them (this
feeds **appmap-label**). Primary-language application code only — not tests/config.
→ per label: `label` (from taxonomy), `file`, `line`, `description` (why). Taxonomy:

- `access.public` — request allows public access (no auth/authz); controller methods, not ordinary functions.
- `audit` — writes a permanent audit record of application activity.
- `command.perform` — invocation of a command-line command or script.
- `crypto.encrypt` / `crypto.decrypt` / `crypto.digest` / `crypto.set_auth_data` — encryption / decryption / cryptographic hash / sets authenticated data.
- `dao.materialize` — loads data-access objects from the DB into memory (framework/library code, not every load).
- `deserialize.safe` / `deserialize.unsafe` / `deserialize.sanitize` — deserialization that is safe / not guaranteed safe / makes data safe-or-fails.
- `http.session.clear` — clears the HTTP session (any prior session id becomes invalid).
- `job.create` / `job.perform` / `job.cancel` — schedules / runs / cancels a background job.
- `log` — writes to the application log (framework/library code).
- `rpc.circuit_breaker` — circuit-breaker function, expected under an RPC client request.
- `secret` — returns a secret (password, key, auth token); PII does *not* count.
- `security.authentication` — verifies a user's identity.
- `security.authorization` — tests whether a user is authorized to perform an action.
- `security.logout` — logs a user out.
- `string.equals` — compares two strings for equality.
- `system.exec` / `system.exec.safe` / `system.exec.sanitize` — runs an OS command / known-safe / makes input safe-or-fails.
- Plus project-specific labels already in use (e.g. `security.join_code`).

**4 — Suggestions (three domain passes).** Each suggestion: `file`, `line`, `type`
(bug | security | performance), `priority` (low | medium | high), `label` (a few
words), `description`, and the trace(s) it's based on (state if the diffed behavior
was used). Respect decisions explained in comments; don't suggest reverting to a
prior form; skip style/refactor/docs/test suggestions unless the improvement is large.

- **4a General** — focus on (1) bugs/errors, (2) security vulnerabilities, (3) performance.
- **4b SQL** — DB-related only; read the digest's `sqlDiff` + query nodes. Check for:
  N+1 / inefficient patterns; unsanitized input / SQL injection; dynamic SQL without
  parameterization; improper escaping; string-concatenated queries; lack of
  least-privilege; DB error-message exposure; hardcoded credentials; missing query
  timeouts; unbounded LIMIT/OFFSET; trust in user-supplied table/column names;
  `SELECT *`; missing audit on sensitive ops; no prepared statements; missing
  validation on filter/sort params; NULL/type mishandling; second-order injection;
  multiple statements per query; outdated drivers; uncontrolled metadata access
  (`information_schema`); poor batch error handling.
- **4c HTTP** — request-handling only; read changed ServerRPC/ClientRPC nodes. Check
  for: missing input validation; weak/absent auth; insecure transport (HTTP not
  HTTPS); poor session management; missing content-type checks; insufficient CSRF
  protection; open redirects; trusting `Host` / `X-Forwarded-For`; unsanitized input
  in query/path; verb tampering; caching sensitive data; verbose error leakage; no
  rate limiting; permissive CORS; unsafe multipart parsing; missing security headers
  (CSP, X-Frame-Options); misuse of status codes; untrusted-body deserialization;
  malformed-header handling; insecure file uploads.

**5 — Drift findings** *(gold-traces only — Review2 has no equivalent).* Report
behavior that changed vs. baseline: added/removed/changed actions. Assign severity
from impact — a *dropped* guard and an *added* guard carry the same label but
opposite severity; the digest can't tell them apart, you can. → Suggestion fields;
`type: drift`.

**6 — Absence findings** *(gold-traces only).* The strongest findings are often about
what's **missing**: a security-labeled function that changed but gained **no** guard,
while sibling paths did. Traces show what ran; cross-check the diff for what *should*
run but doesn't. → Suggestion fields; usually `priority: high`, `type: security`.

Steps 5–6 are the headline 🔴 findings; steps 1–4 are the scaffolding around them.

### Report format

Aim for **scannable**: emoji severity markers, tables with ✅/❌ status, and
`file:line` links a reviewer can click. Use this structure (outer fence is `~~~`
so the nested code block can use normal ```` ``` ````):

~~~markdown
# AppMap Gold-Trace Review — <feature/release>

**Branch:** `<head>` vs `<baseline>`
**Date:** <YYYY-MM-DD>
**Commits reviewed:**

- `<sha>` <subject>

---

## Feature List

Numbered, one line each, **bold lead-in** naming the feature, then what it does.
(Read from the source diff — this orients the reader before the findings.)

---

## Coverage Matrix

| Feature | Covered by | Status |
| --- | --- | --- |
| <feature> | `test_name` | ✅ |
| **<security-relevant feature>** | **no test** | ❌ **uncovered** |
| <client-only/untraced> | — | — |

(✅ a gold/unit trace exercises it; ❌ a behavior that *should* be guarded isn't —
especially a security path with no negative test; — out of trace scope.)

---

## Golden-Trace Drift

Short prose: what `compare` showed — structural changes vs. nothing, which
subsystems are untouched, which traces are new. State plainly that timing/value
jitter is excluded by construction, so a `changed` entry is real.

---

## Suggestions

Ordered by severity, each headed with an emoji + level:

### 🔴 HIGH — <one-line title>

**File:** [path](path) **Context:** `<fn>` at line N

Prose: the trace evidence (which `test_name`, which changed node + label) AND what
it means in this codebase — reason from label + structure + source diff.

**Risk:** who/what is exposed and how reachable it is.

**Recommended remediation:** the concrete fix (offer options if design-dependent),
then the regression test to add — as a real code block, e.g.:

```python
def test_cannot_<bypass>(...):
    ...
    assert not result.success
```

### 🟡 MEDIUM — <title>
### 🟢 LOW — <title>

(A purely intended change still gets a 🟢/INFO entry so the reader sees it was
considered, not missed.)

---

## Tests to Synthesize

| Target | Test name | Priority |
| --- | --- | --- |

---

## SQL Pass

Prose on new/changed queries: index use, predicate shape, N+1, injection surface.
Cite the query shapes from the digest's `sqlDiff`.

## HTTP Pass

Prose on new/changed endpoints: auth gate, read vs. mutation, input handling.

---

## Summary

| Severity | Count | Action required |
| --- | --- | --- |
| 🔴 High | … | … |
| 🟡 Medium | … | … |
| 🟢 Low | … | … |

One closing paragraph: is it merge-blocking, and the single most important action.
~~~

Rules for the interpretation:
- **Reason from labels + structure + source, never from a rule table.** A
  `security.authorization` change → reason about the auth implication; a removed
  SQL read → reason about what guard/data it provided; an `io.http` change → an
  external-call implication. The label names the domain; you supply the meaning.
- **Severity is yours to assign** from impact, not from the label namespace. An
  *added* guard on a security path and a *dropped* guard on the same path carry the
  same label but opposite severity — the engine cannot tell them apart; you can.
- **The strongest findings are often about *absence*.** A security-labeled function
  that changed but gained **no** guard — while sibling read paths did — is the
  ❌-uncovered row and usually the headline. Traces show what ran; cross-check the
  source diff for what *should* run but doesn't.
- **Cite evidence for every finding** (trace name + changed node + label + `file:line`),
  so the report is auditable against `latest-compare.json` and the diff.
- **Cross-reference prior reviews and the source diff.** If a change resolves a
  known issue or implements a planned feature, say so; if it can't be tied to
  intended work, that's a finding to escalate.
- **A clean compare is a valid report:** state that no behavioral drift was found
  (timing/value jitter excluded by construction), rather than omitting the report.

## Config reference

`gold_traces/config.yaml` — machine config (commands and paths):

| Field | Meaning |
|---|---|
| `cwd` | Working dir for record/appmap commands, relative to project root (`.` = repo root). |
| `appmap_dir` | AppMap output dir, relative to `cwd`. Recordings read from `<cwd>/<appmap_dir>/<appmap_path>`. Match the project's `appmap.yml`. |
| `commands.record` | Shell template to record ONE test. Placeholders `{test_file}`, `{test_name}`, `{appmap_path}` are substituted per entry. Only needed for `--record`. |
| `commands.record_env` | Extra env vars for the record command (e.g. a recorder enable flag). |
| `commands.appmap_cli` | AppMap CLI for sequence-diagram export **and diff**; may include a prefix like `npx @appland/appmap`. Default `appmap`. Must emit per-action `labels` in `sequence-diagram --format json` (used for security severity). |
| `expand` *(optional)* | Package code-object ids to render at function granularity (`--expand`). Default empty — package granularity already catches function changes; use only to break a security-critical package into per-function swimlanes. |

`gold_traces/appmap_golden_set.yaml` — the curated list. `core` (canonical
baseline) and `optional` (promote into `core` when a release changes that
subsystem). Each entry: `feature`, `test_file`, `test_name`, `appmap_path`, and
a `summary` (core) or `trigger` (optional).

The YAML is read by a small bundled parser: block maps/lists only, no flow
collections/anchors/inline `#` comments. Quote any value containing a
colon-then-space.

## Keeping traces lean

**A gold trace demonstrates behavior; it should be KBs, not MBs.** A trace
balloons when a high-frequency pure leaf is instrumented (e.g. a geometry helper
called thousands of times in one request → a multi-MB blob that is pure noise).
Two levers, preferred order:

1. **Exclude a well-tested, high-call pure leaf** in the project's `appmap.yml`.
   AppMap reads `exclude` **per-package, relative to the package `path`** — a
   top-level `exclude:` is silently ignored. Correct form:
   ```yaml
   packages:
     - path: my_pkg
       exclude:
         - geometry.distance   # relative to path; pure math, called ~16k times
   ```
   Only exclude leaves whose behavior is already unit-tested and whose *callers*
   still appear in the trace. Never exclude a package whose call structure the
   gold set exists to guard. See **appmap-label** for `exclude`/`packages` syntax
   across languages. Changing `exclude` shrinks *every* affected baseline — the
   one case where re-blessing the whole core set at once is correct (confirm each
   diff is only the leaf removal, then bless all).
2. **Prefer a minimal fixture** for a new entry — build the minimal object graph
   the behavior needs (tens of events) instead of a heavyweight end-to-end setup.

## Determinism

The comparison only works if traces are reproducible. A nondeterministic trace
(unseeded RNG, wall-clock branching, ordering that varies run to run) drifts on
every compare and trains you to ignore real changes. Seed RNG in the test
(e.g. pass an explicit `seed=` rather than calling an unseeded resolver), pin any
time-dependent input, and stabilize collection ordering. If a fresh entry drifts
with no code change, fix the test before blessing it.

## Engine commands

```
update   [--dir DIR] [--include-optional] [--only TEST] [--record]
compare  [--dir DIR] [--include-optional] [--only TEST] [--record] [--fail-on-changes] [--output-json FILE] [--output-markdown FILE]
```

- `update` copies current AppMaps into the baseline (bless). With `--record` it
  re-records first.
- `compare` diffs current AppMaps against the baseline and writes the report.
  Never writes the baseline.
- `--only TEST` (repeatable) limits the run to named entries.
- `--include-optional` adds the `optional` set.
- `--fail-on-changes` makes compare exit non-zero on any change (CI gate).
