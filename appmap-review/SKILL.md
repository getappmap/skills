# Skill: AppMap Behavioral Review

Review the **runtime-behavior change** between two revisions and write an
interpreted, actionable code review. It works from **gold traces** — a curated set
of AppMap recordings committed in the repository (maintained by the
**appmap-gold-traces** skill) — so it catches the regressions that still pass the
test suite: a dropped authorization guard, a new query inside a loop, a
security-sensitive function that changed but gained no check.

A normal code review reads the diff. This review reads what the code *did at
runtime* on both revisions and reports what **changed in behavior** — grounded in
the AppMaps, not just the source.

Its sharpest use is finding **unintended side effects**: behavior that changed in
code the fix or feature didn't mean to touch. A diff review can't see these — an
unintended change is either invisible in the diff (an emergent consequence of a
shared helper, a changed default, an import) or hidden in it as something innocuous.
The behavioral diff is *intent-independent*: it shows what actually ran, which you
reconcile against what the change *meant* to do — and the unexplained remainder is
the side effect. Catching that residue is this skill's reason to exist alongside a
diff review.

## When to use

- Review a branch or PR for behavioral change and security risk before merge.
- Given two revisions (or one baseline and the current HEAD), produce the review.
- Investigate how a release changed server behavior versus a prior revision.

To make recordings, see **appmap-record**; to scope/label what gets recorded, see
**appmap-label**; to maintain the gold-trace baseline, see **appmap-gold-traces**.

## Arguments

```
appmap-review <baseline-rev> [<head-rev>]
```

- **One revision** — it is the **baseline**; `head` defaults to the current `HEAD`.
- **Two revisions** — explicit `baseline` then `head`.

A revision is any git ref (SHA, branch, tag).

## How it works

The pipeline turns two revisions into one interpreted review:

1. **Resolve** `baseline` and `head`.
2. **Locate** each revision's gold traces in git history.
3. **Build an archive** of each revision's gold traces with `appmap archive`, which
   indexes them and bundles the **sequence diagrams (with labels), OpenAPI, scanner
   findings, and class map** — then unpack into a working directory as `base/` and
   `head/`.
4. **Compare** with `appmap compare`, producing the structural change report
   (new/removed/changed traces, SQL diff, OpenAPI diff, per-trace sequence-diagram
   diffs). The changed-vs-unchanged decision is made by a digest that **excludes
   volatile data** (elapsed time, object ids, parameter/return values), so timing
   jitter and unstable test data never register — a `changed` entry is real.
5. **Interpret** the compare output + the source diff into findings, following the
   **review recipe** below.
6. **Render** the scannable report.

## Locate the gold traces

Gold traces are committed AppMaps, by convention under
`gold_traces/baseline/appmaps/**/*.appmap.json`, alongside a manifest
`gold_traces/manifest.yaml`. Find them in each revision from git history
(don't assume the working tree):

```sh
# discover the gold-trace appmaps committed at a revision
git ls-tree -r --name-only <rev> | grep -E 'gold_traces/.*/appmaps/.*\.appmap\.json$'
```

Extract each revision's set into its own working directory, preserving the relative
`appmap_dir` layout the project's `appmap.yml` expects:

```sh
mkdir -p .review/base/<appmap_dir> .review/head/<appmap_dir>
for f in $(git ls-tree -r --name-only <baseline> | grep '/appmaps/.*\.appmap\.json$'); do
  git show "<baseline>:$f" > ".review/base/<appmap_dir>/$(basename "$f")"
done
# …repeat for <head>…
```

Copy the project's `appmap.yml` (from `head`) into each working dir so `archive`
indexes both sides identically.

## Build the archives and compare

```sh
appmap archive --directory .review/base --revision base --output-file base.tar
appmap archive --directory .review/head --revision head --output-file head.tar
# unpack each archive's appmaps into <out>/base and <out>/head, then:
appmap compare --directory <out> --output-dir <out>/report \
  --base-revision base --head-revision head
```

`compare` writes `change-report.json` (the structural facts) and per-trace diff
sequence diagrams under `report/diff/`. The diff sequence diagrams carry each
action's `diffMode` (added/removed/changed) and its AppMap **labels** — the primary
evidence for the recipe.

## Interpret — the review recipe

The compare output is *facts*; the **review is your interpretation of them** — what
each change means and what to do. A fixed findings table can't reason about a change
the way you can. Run all steps in one pass, then render.

Everywhere a step needs runtime evidence, read the **change report** and the
**per-trace diff sequence diagrams**, together with the **source diff**
(`git diff <baseline>..<head>`). The AppMaps are not background — they are the
evidence of *what changed*.

**1 — Feature List & intended scope.** Inspect the source diff, enumerate the
features and functional changes (application code only — not tests/config), and name
each as a complete declarative statement (e.g. "Added a gameByCode query that resolves
a private game by code"). Note which produced runtime drift in the compare — those are
higher-signal. Also capture the **intended scope** — the yardstick for Step 5: the
files/subsystems the diff touches (`git diff --name-only <baseline>..<head>`) and any
behavior-preserving claims in the commits ("refactor", "rename", "no functional
change"). A change that claims to preserve behavior but moves a trace is a finding.

**2 — Coverage Matrix.** For each feature, list the gold/manifest tests that exercise
it. ✅ covered; ❌ **uncovered** when a behavior that should be guarded has no trace —
especially a security-sensitive path with no *negative* test. For each gap, emit the
command to record the missing test.

**3 — Suggested Labels.** For functions that **changed in the compare but carry no
label**, suggest one from the taxonomy so the next review can interpret them (apply
them via **appmap-label**). Primary-language application code only. → per label:
`label` (from taxonomy), `file`, `line`, `description` (why). Taxonomy:

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
words), `description`, and the trace(s) it is based on (state if the runtime evidence
was used). Respect decisions explained in comments; don't suggest reverting to a
prior form; skip style/refactor/docs/test suggestions unless the improvement is large.

- **4a General** — focus on (1) bugs/errors, (2) security vulnerabilities, (3) performance.
- **4b SQL** — DB-related only; read the SQL diff + query nodes. Check for: N+1 /
  inefficient patterns; unsanitized input / SQL injection; dynamic SQL without
  parameterization; improper escaping; string-concatenated queries; lack of
  least-privilege; DB error-message exposure; hardcoded credentials; missing query
  timeouts; unbounded LIMIT/OFFSET; trust in user-supplied table/column names;
  `SELECT *`; missing audit on sensitive ops; no prepared statements; missing
  validation on filter/sort params; NULL/type mishandling; second-order injection;
  multiple statements per query; outdated drivers; uncontrolled metadata access
  (`information_schema`); poor batch error handling.
- **4c HTTP** — request-handling only; read changed server/client request nodes.
  Check for: missing input validation; weak/absent auth; insecure transport (HTTP not
  HTTPS); poor session management; missing content-type checks; insufficient CSRF
  protection; open redirects; trusting `Host` / `X-Forwarded-For`; unsanitized input
  in query/path; verb tampering; caching sensitive data; verbose error leakage; no
  rate limiting; permissive CORS; unsafe multipart parsing; missing security headers
  (CSP, X-Frame-Options); misuse of status codes; untrusted-body deserialization;
  malformed-header handling; insecure file uploads.

**5 — Reconcile drift against intent (the side-effect check — the headline step).**
For **every** changed trace, ask: does the change map to an enumerated feature *and*
to code the diff actually touched (cross-reference the changed functions against
`git diff --name-only`)? That splits the footprint in two:

- **Intended drift** — explained by a feature and the touched code. Confirm it matches
  the work, then it's bless-able. Assign severity from impact: a *dropped* guard and an
  *added* guard carry the same label but opposite severity; the compare can't tell them
  apart, you can.
- **Unintended side effect** — behavior that changed **outside the stated scope**: a
  trace in a subsystem the diff didn't touch, drift that maps to no feature, or a
  "refactor/no-op" commit whose traces moved anyway. **This is what a diff review
  structurally misses** — the residue of footprint minus intent. Grade each:
  - *Acceptable* (🟢 note): mechanical propagation — an additive schema column appearing
    in unrelated `SELECT`s; a shared helper the diff changed reaching its call sites
    identically. Action: **confirm the blast radius** is intended, then bless.
  - *Concerning* (🟡/🔴 flag): a changed **call shape**, a new query/loop/exception, a
    dropped guard, or an ordering change — in code the change didn't mean to alter; or a
    behavior-preserving claim contradicted. These get a finding.

  → Suggestion fields; `type: side-effect`; cite the changed trace, the out-of-scope
  function, and whether it appears in the diff.

**6 — Absence findings.** The strongest *security* findings are often about what's
**missing**: a security-labeled function that changed but gained **no** guard, while
sibling paths did. Traces show what ran; cross-check the source diff for what *should*
run but doesn't. → Suggestion fields; usually `priority: high`, `type: security`.

Steps 5–6 are the headline findings; steps 1–4 are the scaffolding around them.

## Report format

Aim for **scannable**: emoji severity markers, tables with ✅/❌ status, and
`file:line` links a reviewer can click. Use this structure (outer fence is `~~~` so
the nested code block can use normal ```` ``` ````):

~~~markdown
# AppMap Behavioral Review — <feature/release>

**Revisions:** `<head>` vs `<baseline>`
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

## Suggested Labels

Functions that changed but carry no label — label them (via appmap-label) so the
next review can interpret them:

- **`<label>`** — [file:line](path) `<fn>` — why.

---

## Behavioral Drift

Short prose: what `compare` showed — the **intended** drift (which traces changed as
the feature predicts), which subsystems are untouched, which traces are new. State
plainly that timing/value jitter is excluded by construction, so a `changed` entry is
real.

---

## Unintended Side Effects

Behavior that changed **outside the stated scope** — the residue of footprint minus
intent. This is the section a diff review can't produce.

| Changed trace | Out-of-scope change | In the diff? | Assessment |
| --- | --- | --- | --- |
| `test_x` | `Foo.bar` gained a query | no — `Foo` not in the diff | 🟡 concerning — confirm |
| `test_y` | `games` SELECT gained a column | no (schema propagation) | 🟢 acceptable — blast radius |

If empty, say so: "No behavior changed outside the change's stated scope." Concerning
rows also appear as 🟡/🔴 findings below.

---

## Suggestions

Ordered by severity, each headed with an emoji + level:

### 🔴 HIGH — <one-line title>

**File:** [path](path) **Context:** `<fn>` at line N

Prose: the trace evidence (which `test_name`, which changed node + label) AND what it
means in this codebase — reason from label + structure + source diff.

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
Cite the query shapes from the SQL diff.

## HTTP Pass

Prose on new/changed endpoints: auth gate, read vs. mutation, input handling.

---

## Summary

Tally the findings from **Suggestions** and **Unintended Side Effects** by severity —
the report's risk profile at a glance. One row per severity that has findings; the
*Action required* cell is the headline action for that level. (Suggested Labels and
Tests to Synthesize are follow-ups recorded in their own sections, so they don't
appear here.)

| Severity | Findings | Action required |
| --- | --- | --- |
| 🔴 High | … | … |
| 🟡 Medium | … | … |
| 🟢 Low | … | … |

One closing paragraph: is it merge-blocking, and the single most important action.
~~~

## Rules for the interpretation

- **Reason from labels + structure + source, never from a rule table.** A
  `security.authorization` change → reason about the auth implication; a removed SQL
  read → reason about what guard/data it provided; an `io.http` change → an
  external-call implication. The label names the domain; you supply the meaning.
- **Reconcile footprint against intent — this is the point.** The behavioral diff
  shows *everything* that changed; the source diff + commit messages say what was
  *meant* to change. The gap is the unintended side effect, which a diff review can't
  see. Always cross-reference a changed trace against `git diff --name-only`: drift in
  code the change didn't touch is the finding to chase. Distinguish mechanical
  propagation (acceptable — confirm the blast radius) from a changed call shape or new
  query/exception out of scope (concerning).
- **Severity is yours to assign** from impact, not from the label namespace. An
  *added* guard on a security path and a *dropped* guard on the same path carry the
  same label but opposite severity — the compare cannot tell them apart; you can.
- **The strongest findings are often about *absence*.** A security-labeled function
  that changed but gained **no** guard — while sibling paths did — is the
  ❌-uncovered row and usually the headline. Traces show what ran; cross-check the
  source diff for what *should* run but doesn't.
- **Coverage is path-dependent.** A trace only guards the branch it executes. A
  conditional gate (`if private: <check>`) is invisible to a trace that never drives
  that branch — so a clean compare on a happy-path trace does not clear a
  conditional guard. Flag the missing negative trace.
- **Cite evidence for every finding** (trace name + changed node + label + `file:line`),
  so the report is auditable against the compare output and the diff.
- **A clean compare is a valid report:** state that no behavioral drift was found
  (timing/value jitter excluded by construction), rather than omitting the report.
