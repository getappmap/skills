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

Extract each revision's set into its own working directory, reproducing the layout
the project's `appmap.yml` expects: the recordings live under `appmap_dir`, and each
one's path *below* `appmaps/` in the baseline is its path *below* `appmap_dir`.
Preserve that sub-path — don't flatten to the basename, or two traces that share a
basename in different directories collide.

## Build the archives and compare

This exact sequence is verified against `@appland/appmap` ≥ 3.200.0. Run it from the
project root (which has `appmap.yml`). `$appmap_dir` is the `appmap_dir:` value from
`appmap.yml` (e.g. `tmp/appmap`); `$BASE`/`$HEAD` are the two revisions.

The project root may sit below the git repo root (e.g. `server/` in a monorepo).
That's fine: `git ls-tree` returns paths relative to the current directory, and the
`./` in `$ref:./$f` makes `git show` resolve them the same way.

The workspace lives under the system temp dir, NOT inside the repo — work files in
the repo tree can end up accidentally committed. The path is fixed (no random
suffix) so later commands and inspection can find it; each run starts by clearing it.

```sh
appmap_dir=$(sed -n 's/^appmap_dir: *//p' appmap.yml)   # e.g. tmp/appmap
review_root="${TMPDIR:-/tmp}/appmap-review"
rm -rf "$review_root"

# 1 — Extract each revision's committed gold traces into a per-revision working dir,
#     under $appmap_dir, preserving each trace's sub-path (no basename flattening),
#     and copy in appmap.yml so `archive` indexes both sides identically.
for rev in base head; do
  ref=$([ "$rev" = base ] && echo "$BASE" || echo "$HEAD")
  mkdir -p "$review_root/$rev/$appmap_dir"
  cp appmap.yml "$review_root/$rev/appmap.yml"
  for f in $(git ls-tree -r --name-only "$ref" | grep -E 'gold_traces/.*/appmaps/.*\.appmap\.json$'); do
    rel="${f##*/appmaps/}"                                # path under $appmap_dir
    mkdir -p "$review_root/$rev/$appmap_dir/$(dirname "$rel")"
    git show "$ref:./$f" > "$review_root/$rev/$appmap_dir/$rel"
  done
done

# 2 — Archive each side. archive's DEFAULT output is .appmap/archive/full/<rev>.tar;
#     do NOT pass an absolute --output-file (the internal tar mangles it). Just cd in
#     and pass --revision. archive runs the scanner and OpenAPI automatically.
( cd "$review_root/base" && appmap archive --revision base )
( cd "$review_root/head" && appmap archive --revision head )

# 3 — Restore each archive into <output-dir>/base and <output-dir>/head. `compare`
#     REQUIRES the two revisions' data to already sit there before it runs, and it
#     loads appmap.yml from its working dir — so put one there too.
#     Use `appmap restore`, NOT a manual `tar xf`: the archive nests the AppMaps and
#     their index files inside an inner appmaps.tar.gz, and restore unpacks both
#     layers. A single tar extraction leaves the inner tarball packed, and compare
#     then sees ZERO appmaps on both sides and silently reports only the API diff.
#     Don't pre-create the base/ and head/ dirs — restore refuses to write into a
#     directory that already exists.
mkdir -p "$review_root/out/report"
cp appmap.yml "$review_root/out/appmap.yml"
( cd "$review_root/base" && appmap restore --revision base --output-dir ../out/report/base )
( cd "$review_root/head" && appmap restore --revision head --output-dir ../out/report/head )

# 4 — Compare. base/ and head/ live UNDER --output-dir (here `report`); compare writes
#     change-report.json and diff/ alongside them. Do NOT pass --clobber-output-dir —
#     it would delete the base/ and head/ you just restored.
( cd "$review_root/out" && appmap compare --base-revision base --head-revision head --output-dir report )
# results: $review_root/out/report/change-report.json  and  $review_root/out/report/diff/
```

`compare` writes `change-report.json` (the structural facts) and per-trace diff
sequence diagrams under `report/diff/`. The diff sequence diagrams carry each
action's `diffMode` (added/removed/changed) and its AppMap **labels** — the primary
evidence for the recipe.

Note: captured values in gold traces are **sanitized** — each is a stable,
equality-preserving token (`<v1>`, `<uuid:v3>`), not real data. Reason from labels,
call structure, and SQL *shape*, never from a value's contents; equal tokens still
signal equal values (data flow), and both revisions are sanitized identically so a
token never registers as a change.

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

The report is **findings-first**: the reader lands on the verdict and the actionable
findings; the evidence that backs them is one click away. The recipe above is
unchanged — this section is how its output is *rendered*. Four principles govern it:

- **Plain language.** The report is read by people who haven't read the diff and
  don't know this skill's internals. No invented shorthand ("static residue",
  "footprint minus intent", "parser reach") and no recipe jargon — say what happened
  in ordinary words ("behavior changed in code this PR didn't touch"). Every finding
  and ledger note must make sense on its own, without reading the recipe, the other
  sections, or the code. Prefer a short concrete sentence over a compressed technical
  phrase; expand product terms on first use ("the digest — the fingerprint used to
  decide whether behavior changed").

- **Single home.** Every fact is stated exactly once. A finding lives in **Findings**
  and nowhere else — ledger and coverage rows *reference* it by number (`→ #2`). A
  cross-cutting caveat (first-ever baseline, partial trace set) is stated once in the
  banner and never restated. Test recommendations live inside the finding they fix or
  the coverage gap that motivates them — there is no separate tests section. A
  concerning Step-5 side effect **is** a finding (`type: side-effect`); an acceptable
  one is a line in the drift narrative.
- **Tiered rendering.** 🔴/🟡 findings get the full block (file, evidence, risk, fix).
  🟢 findings get one bullet each. A purely intended change that was considered and
  cleared is not a finding at all — it is the ✅ *Intended changes verified* row in
  the ledger.
- **Clean is a row, not a section.** A pass that found nothing (compare, side-effects,
  absence, SQL, HTTP) earns exactly one ledger row with a one-line note. Prose exists
  only where there are findings to explain.

Prose budgets: Feature List entries are strictly one line; **Risk** and **Fix** are
≤ 2 sentences each; code blocks only where the reader should copy-paste. Step 1's
intended-scope notes are working input to Step 5 — don't render them.

Keep the scannable idiom: emoji severity markers, ✅/❌ tables, clickable `file:line`
links. Structure (outer fence is `~~~` so nested code blocks can use normal
```` ``` ````; GitHub renders `<details>` folded in PR comments and job summaries, so
the detail stays accessible without being paid for on every read):

~~~markdown
# AppMap Behavioral Review — <feature/release>

**Revisions:** `<head>` vs `<baseline>` · **Date:** <YYYY-MM-DD> ·
**Commits:** `<sha>` <short subject> · … (group out-of-scope commits in one parenthetical)

> ⚠️ <Cross-cutting caveat, only if any — stated once here, referenced elsewhere.>

## Summary

| Severity | Findings | Action required |
| --- | --- | --- |
| 🔴 High | … | … |
| 🟡 Medium | … | … |
| 🟢 Low | … | … |

One or two sentences: merge-blocking or not, and the single most important action.

## Findings

Numbered across all severities, ordered by severity.

### 1 · 🔴 HIGH — <one-line title>

**File:** [path:line](path) · **Context:** `<fn>` · **Evidence:** <trace name +
changed node + label — or "source diff only" when no trace covers it>

One short paragraph: what the evidence shows and what it means in this codebase —
reason from label + structure + source diff.

**Risk:** who/what is exposed and how reachable it is (≤ 2 sentences).
**Fix:** the concrete change, then the regression test to add (≤ 2 sentences +
copy-paste block if warranted):

```python
def test_cannot_<bypass>(...):
    ...
```

### 🟢 Low

- **4** · <title> — [file:line](path) — one-sentence action.

## Checks performed

The audit trail: every pass the review ran, one row each.

| Check | Result | Note |
| --- | --- | --- |
| Behavioral compare | ✅ clean · ⚠️ changes → #n · — not run | <one line, e.g. "timing noise is filtered out, so every reported change is real"> |
| Changes outside the PR's scope (Step 5) | ✅ none · ⚠️ → #n | <one line> |
| Missing guards (Step 6) | ✅ · 🔴 → #n | <one line> |
| Test/recording coverage (Step 2) | ✅ · ❌ n gaps (detail ↓) | <one line> |
| SQL (Step 4b) | ✅ clean · ⚠️ → #n | <one line> |
| HTTP (Step 4c) | ✅ clean · ⚠️ → #n | <one line> |
| Intended changes verified | ✅ | <one line — the cleared features, with their evidence> |

<details>
<summary><b>Review detail</b> — features, coverage, labels, drift</summary>

### Feature List

Numbered, one line each: **bold lead-in** naming the feature, then what it does.

### Coverage Matrix

| Feature | Covered by | Status |
| --- | --- | --- |
| <feature> | `test_name` | ✅ |
| **<security-relevant feature>** | **no test** | ❌ **uncovered** → #n |
| <client-only/untraced> | — | — |

(✅ a gold/unit trace exercises it; ❌ a behavior that *should* be guarded isn't —
especially a security path with no negative test; — out of trace scope.) One code
block with the record command(s) that close the ❌ gaps.

### Suggested Labels

- **`<label>`** — [file:line](path) `<fn>` — why.

### Behavioral Drift

Short prose: the **intended** drift (which traces changed as the feature predicts),
which subsystems held still, which traces are new — plus any acceptable Step-5
side effects (mechanical propagation, confirmed blast radius).

</details>
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
- **A clean compare is a valid report:** render it as ✅ rows in the checks ledger
  (noting that timing/value jitter is excluded by construction), rather than omitting
  the report — the ledger is what proves the checks ran.
