# Skill: Maintain AppMap Gold Traces

Maintain a curated set of AppMap recordings — **gold traces** — committed in the
repository as a behavioral baseline. A gold trace is a behavioral *snapshot*: the
test stays green, but the recording captures the shape of the path it exercised, so
a later revision can be diffed against it to catch *unintended* behavior change.

This skill owns the **data lifecycle**: curating which tests are gold, recording
them, keeping them lean and deterministic, and **blessing** new baselines as the
code legitimately evolves. To actually *diff and review* one revision against
another, see **appmap-review** — that skill reads these gold traces from git
history, compares them, and writes the interpreted review.

## When to use

- **Bootstrap** a gold-traces baseline in a project that doesn't have one.
- **Maintain** the baseline during a release: enhance the manifest for new
  features and subsystems, re-record, review (e.g. with the **appmap-review** skill), and bless it.
- Keep traces lean and deterministic so the comparison stays trustworthy.

This is the *baseline-maintenance* layer over AppMap. To make recordings, see
**appmap-record**; to scope/label what gets recorded, see **appmap-label**; to **review** a change, see **appmap-review**.

## How it works

The model is **curate → record → bless**, with the diff-and-review delegated to
**appmap-review**:

1. A manifest (`gold_traces/manifest.yaml`) names a curated set of tests and the
   recordings they produce.
2. The raw baseline AppMaps are committed under `baseline/appmaps/` — the source of
   truth: deliberately blessed, diffable per-trace, small (KBs). Everything derived
   (sequence diagrams, archives, the review) is produced on demand and not committed.
3. To decide what to bless on a release, re-record the gold tests and **review the
   change with appmap-review** (whether a change is intended, a regression, or a side
   effect is its job). The engine's `update --dry-run` reports *which* traces changed;
   bless the ones the review confirms (the engine copies the fresh recordings over the
   changed baselines and leaves the rest byte-identical).

Three properties keep the baseline trustworthy — they are this skill's real job:

**Curate for coverage.** A gold trace only guards a code path it actually executes.
A conditional gate (`if game.is_private: <check>`) is invisible to a trace that never
drives that branch. Curate the manifest so some entry exercises each guarded branch —
especially the *negative* branch of a security gate; a single happy-path trace is not
enough.

**Label what should be interpreted.** appmap-review reasons about a change from:

1. Code object names
2. AppMap **labels** on the functions involved (`security.*`, `io.*`, …).

**Record consistently.** Every gold trace must be recorded with the *same* capture
config — e.g. SQL capture on, labels applied. If the config changes, re-record the
whole set; otherwise a later review is swamped by instrumentation drift instead of
behavior.

## What makes a trace suitable

A good gold trace is the **smallest deterministic recording that exercises one
release-critical subsystem once**. Curate for *distinct* coverage: prefer one
representative trace per subsystem over many near-identical ones.

**Reuse an existing test before synthesizing one.** A repo usually already has a
test that drives the subsystem end-to-end — point the manifest at that. Before
adding an entry, search the suite for coverage of the command/handler you want to
guard; a manifest of existing tests stays in sync with the code as those tests
evolve, whereas synthesized invocations rot on their own. This is especially true
for a CLI: record the command's **handler test**, not the built binary driven as a
process. A process recording of the whole binary drags in boot-time work — arg
parsing, config loading, env probing for optional integrations — which is noise at
best and *nondeterministic across machines* at worst (e.g. filesystem probes for an
IDE that exists on your box but not on CI). The handler test enters at the command
logic and captures just that. Synthesize a fresh test only when no existing one
covers the path — and then it's a normal test the suite should keep anyway.

Rule a candidate **out** before adding it to the manifest:

- **It records nothing.** Some tests assert over in-memory data without driving the
  instrumented call graph (e.g. a validator fed a literal object, a pure-function unit
  test). If `update --record` produces no AppMap at the entry's `appmap_path`, the test
  is not a gold-trace candidate — its behavior isn't being captured. Confirm an entry
  actually records before committing it.
- **Its size is repetition, not structure.** A loop- or large-fixture-driven test can
  balloon to MBs because the *same* helper frames repeat per iteration. The exported
  sequence diagram (what the digest is computed from) collapses those repeats, so the
  extra megabytes add **zero** digest signal — they're pure git weight. Distinguish the
  two size modes before reacting: many big *parameter values* → the engine's `sanitize`
  step already replaces these with short tokens, so they add little committed weight
  (values aren't behavioral; see *Keeping traces lean*); many *repeated events* → pick a
  smaller fixture, or keep just one dedicated loop trace (and no more).
- **It is nondeterministic.** Unseeded RNG, wall-clock branching, or run-to-run ordering
  drift makes the trace bless on every compare and trains you to ignore real changes.
  See *Determinism*. Verify a fresh candidate is stable (`update --record --dry-run`
  twice → `unchanged`) before trusting it.
- **It duplicates coverage.** Several traces walking the same path don't strengthen the
  baseline; they multiply the review and bless cost. Keep one. In particular, don't map
  unit tests one-to-one onto gold traces: when a subsystem needs coverage of several
  branches (including the failure branch of a security check), write **one** test whose
  fixture drives all of them and record that — branch coverage belongs inside the
  fixture, not spread across manifest entries.

Two practical notes from real baselines:

- **Values are not behavior — and the engine strips them.** On bless the engine runs
  **`appmap sanitize`** (needs `@appland/appmap` ≥ 3.201.0) on the fresh recording,
  replacing every captured parameter/return/message value with a short,
  equality-preserving token (`<v1>`, `<uuid:v3>`). So the committed baseline is
  structurally incapable of carrying a secret, and much smaller. Sanitize is
  deterministic and idempotent, but it *can* rewrite digest-relevant text (e.g. SQL
  literals) — so the engine sanitizes the fresh recording **before** computing its bless
  digest and compares that against the (also sanitized) committed baseline: an honest,
  sanitized-vs-sanitized gate that never reports false drift. This is automatic; projects
  don't wire sanitizing into their record command.
- **Sharing a recording basename is legal but worth knowing.** AppMaps are identified by
  their full path under `appmap_dir`, so two entries in different directories whose files
  share a basename (distinct `describe` blocks both ending in `is_recorded`) are perfectly
  distinct recordings. The catch is downstream: the CLI's `sequence-diagram` export names
  its output after the AppMap's *basename only*, so two such entries would otherwise write
  the same `<basename>.sequence.json`. The engine isolates each entry's export in its own
  subdirectory keyed by the full `appmap_path` to prevent that aliasing — but distinct
  names still keep the manifest and derived exports easier to read.

## Layout

The engine and templates ship with this skill; the *data* lives in the target
project and is committed there.

```
<skill>/assets/
  manage.mjs                          engine (config-driven, zero-install Node)
  manage.test.mjs                     engine tests (node --test, no deps)
  manifest.template.yaml              manifest template (commands + entries)

<project>/gold_traces/                 created at bootstrap, committed in the project
  manifest.yaml                       the manifest: record commands + the curated entries
  baseline/appmaps/**.appmap.json     committed baselines
<project>/.appmap/gold-traces/         derived sequence exports (regenerated, gitignored)
```

The engine has no npm dependencies — it runs straight from Node (uses a bundled
minimal YAML reader). Invoke it from the **project root**:

```sh
node "<skill>/assets/manage.mjs" <command> --dir gold_traces [options]
```

(`<skill>` is this skill's directory — substitute its absolute path. `--dir`
defaults to `gold_traces`.)

**Monorepos.** Two separable decisions — don't conflate them:

*Where the baseline lives.* A `gold_traces/` per package (`packages/<name>/gold_traces/`)
keeps traces versioned and reviewed alongside the code they guard, and lets packages be
recorded and blessed independently (each `--dir` is its own baseline). A single repo-root
`gold_traces/` is fine too when the repo is effectively one project. This is an ownership
choice, not a technical one.

*How recording is configured.* The recording is defined by the AppMap project —
`appmap.yml` + its `appmap_dir` — which is usually **one config at the repo root** even
when baselines are split per package. You don't configure paths: the engine runs the
record/appmap commands from the **gold_traces parent directory** and reads recordings
from wherever the **nearest-ancestor `appmap.yml`** collects them (its directory + its
`appmap_dir`). So for `packages/<name>/gold_traces`, commands run in `packages/<name>`
and recordings come from the root `appmap.yml`'s `appmap_dir` — both derived:

```sh
node "<skill>/assets/manage.mjs" update --dir packages/<name>/gold_traces --record
```

Make sure the package is listed in that root `appmap.yml` so its code is instrumented.
Note the consequence: a shared multi-package `appmap.yml` **co-instruments sibling
packages that appear in the call path** — so a trace can legitimately capture a callee in
another package (richer cross-package behavior), but the baseline then couples to that
package, and appmap-node names code objects relative to the *common ancestor* of all
instrumented packages, so a trace's package root shifts (`src` → `<pkg>`/`<sibling>`)
depending on which siblings it touches. If you want a trace isolated to one package's
code, give that package its own scoped `appmap.yml` (`path: <pkg>/src`) instead — at the
cost of not seeing across the boundary. Either is valid; just record the whole set with
**one** of them (see *Record consistently*).

## Bootstrap (first time in a project)

When `gold_traces/` does not yet exist:

1. **Create the directory** and seed it from the template:
   ```sh
   mkdir -p gold_traces/baseline/appmaps
   cp "<skill>/assets/manifest.template.yaml"  gold_traces/manifest.yaml
   ```
   The engine's derived work lands in `.appmap/gold-traces` (AppMap's regenerable
   working dir). Ensure `.appmap/` is gitignored — most AppMap projects already ignore
   it; add `.appmap/` to the repo `.gitignore` if not.

2. **Fill in the `commands`.** Determine the project's record command yourself by
   inspecting the project. Check its `CLAUDE.md` first; if it isn't documented there,
   figure it out from the project — the test runner and how it's invoked (`package.json`
   scripts, `Makefile`, `pytest.ini`/`tox.ini`, `Gemfile`/`Rakefile`, CI workflows),
   the AppMap recorder integration for that stack, and any env flag the recorder needs
   (e.g. `APPMAP=true`). Write it into `manifest.yaml`'s `commands` block —
   after this it's the source of truth and you never re-derive it. Paths are derived,
   not configured (see **Config reference**).

3. **Curate the entries.** Replace the template entry with real `entries`.
   Prefer real integration paths over validation-only branches, distinct
   subsystems over duplicates, and **deterministic** traces (seed any RNG). Use
   `feature` to group entries by subsystem. Make sure the security-relevant
   functions those traces exercise are **labeled** (see **appmap-label**) so
   appmap-review can interpret changes there.

4. **Seed the baseline.** Record each entry and copy the recording into the
   baseline:
   ```sh
   node "<skill>/assets/manage.mjs" update --dir gold_traces --record
   ```
   `update --record` re-records every manifest entry and seeds `baseline/appmaps/`
   (every entry is new on the first run, so all are seeded). To seed only specific
   entries, add `--only <test_name>`, repeatable.

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

## Maintain (each release)

Refresh the baseline as part of the release so it tracks what shipped. **Skip only
if the release touched no traceable application code.**

1. **Know the drift surface and enhance the manifest.** The baseline was last blessed
   at the last commit touching it:
   ```sh
   git log -1 --format=%h -- gold_traces/baseline/appmaps/
   ```
   Review traceable change since then (`git log <that-commit>..HEAD --oneline -- <app source>`)
   and **enhance the entries** for new/changed subsystems: add an entry for a
   newly-critical path this release introduced or materially changed. `update` seeds a
   baseline for any newly-added entry automatically (`update --only <test> --record`).

2. **Re-record and see what changed** — a dry run re-records and reports which traces
   drifted, writing nothing:
   ```sh
   node "<skill>/assets/manage.mjs" update --dir gold_traces --record --dry-run
   ```
   It marks each trace `bless` (behavior changed), `seed` (new entry), or counts it
   `unchanged`. The digest excludes timing/value jitter, so a `bless` is a real change.
   For a full **interpreted** review of what changed and whether it's safe, run
   **appmap-review**.

3. **Review, then bless what's intended.** Deciding whether a changed trace is
   intended — or a regression, or an unintended side effect — is **appmap-review**'s
   job, not this skill's. The only call
   that belongs here is **trace hygiene**: a trace that drifts with **no** code change
   is nondeterministic — fix the trace (seed it), don't bless the noise. Then bless the
   traces the review confirmed: drop `--dry-run` (and don't re-pass `--record` — reuse
   step 2's recordings); `update` re-blesses every changed trace and leaves the rest
   byte-identical, or scope it with `--only`:
   ```sh
   node "<skill>/assets/manage.mjs" update --dir gold_traces [--only <reviewed_test>]
   ```

4. **Commit**, staging only what genuinely changed (manifest edits, newly-blessed
   baselines):
   ```sh
   git add gold_traces <touched source files>
   git commit -m "chore(gold-traces): refresh baseline for <version>"
   ```

## Config reference

`gold_traces/manifest.yaml` — one file: recording `commands` + the curated
`entries`. Paths are **not** configured — they are derived.

| Field | Meaning |
|---|---|
| `commands.record` | Shell template to record ONE test, run from the gold_traces parent dir. Placeholders `{test_file}`, `{test_name}`, `{appmap_path}` are substituted per entry. Only needed for `--record`. |
| `commands.record_env` | Extra env vars for the record command (e.g. a recorder enable flag). |
| `commands.appmap_cli` | AppMap CLI the engine runs — exports the bless-gating sequence diagram **and** sanitizes each recording before it is committed (`sanitize` needs **`@appland/appmap` ≥ 3.201.0**). **Leave unset**: it auto-discovers `~/.appmap/bin/appmap` (where the IDE extensions install it), else `appmap` on `PATH`. A committed value is machine-specific config in a shared file (breaks on other machines/platforms); set it only for an unusual CLI location or a custom-compiled CLI (appmap-js itself sets `node built/cli.js`). |
| `expand` *(optional)* | Package code-object ids to render at function granularity (`--expand`). Default empty — package granularity already catches function changes. |
| `allow_values` *(optional)* | Values `appmap sanitize` keeps verbatim in blessed baselines (the engine passes them via `--allow-file`), exact whole-value match. Curate small public vocabularies only (enum state/role names); never anything that could identify a person or authenticate a request. |
| `entries` | The curated list. Each: `feature`, `test_file`, `test_name`, `appmap_path`, `summary`. |

Paths are **derived**: commands run from the gold_traces parent directory, and
recordings are read from the nearest-ancestor `appmap.yml` (its directory + its
`appmap_dir`). Place `gold_traces/` inside the directory you want commands to run from,
within an AppMap project.

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
   one case where re-blessing the whole set at once is correct (confirm each
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

The engine has a single command — `update` (record + digest-gated bless). Diffing
and reviewing a change is the **appmap-review** skill's job.

```
update  [--dir DIR] [--only TEST] [--record] [--dry-run]
```

- Re-blesses each baseline whose behavior changed (copies the fresh recording over
  it) and **seeds** a baseline for any entry that lacks one. A trace whose behavioral
  digest matches its baseline is left **byte-identical** — no git churn.
- `--record` re-records each selected test first (needs `commands.record`).
- `--dry-run` reports what would be blessed/seeded without writing.
- `--only TEST` (repeatable) limits the run to named entries.
