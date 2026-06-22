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
  classify the diff, and bless intended changes.
- Investigate why a release's server behavior drifted from the last baseline.

This is the *behavioral-regression* layer over AppMap. To make recordings, see
**appmap-record**; to scope what gets recorded, see **appmap-label**; to query
recordings, see **appmap-analyze**.

## How it works

The model is **baseline → re-record → compare → classify → bless**:

1. A manifest (`appmap_golden_set.yaml`) names a curated set of tests and the
   recordings they produce.
2. The raw baseline AppMaps are committed under `baseline/appmaps/`.
3. At compare time the engine exports each AppMap to AppMap's JSON
   sequence-diagram form, **normalizes** away volatility (actor ordering, event
   ids, exact timings — keeping coarse elapsed-time buckets), then diffs the
   normalized call trees and the set of participating packages (actors).
4. A report classifies each change and flags security-sensitive deltas.
5. You bless intended changes by copying the fresh recordings over the baseline.

The engine stores **only** the raw baselines; sequence/normalized artifacts are
derived under `.tmp/` and regenerated each run.

## Layout

The engine and templates ship with this skill; the *data* lives in the target
project and is committed there.

```
<skill>/assets/
  manage.mjs                          engine (config-driven, zero-install Node)
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

3. **Classify the diff — separate noise from real change.** `elapsedBucket`-only
   changes are run-to-run timing noise; ignore them. Everything else is
   structural:
   ```sh
   node -e 'const r=require("./gold_traces/reports/latest-compare.json");for(const e of r.entries){if(!e.changed)continue;const s=e.diff.changes.filter(c=>!(c.type==="action_changed"&&c.field==="elapsedBucket"));console.log((s.length?"STRUCTURAL ":"timing-only ")+e.test_name+(s.length?": "+JSON.stringify(s.slice(0,4)):""))}'
   ```
   For every **structural** entry, confirm the delta maps to intended work in
   this release. **Stop and ask the user** on any newly-raised exception, a
   removed auth/guard call, or drift you can't explain (the report also raises
   `security-review` findings for auth-adjacent changes). A trace that drifts
   every run with **no** code change is nondeterministic — fix the trace (seed
   it), don't bless the noise.

4. **Bless only meaningful change** (avoid Git churn):
   - **Only timing noise:** leave the baseline alone — compare never touched it.
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

## Config reference

`gold_traces/config.yaml` — machine config (commands and paths):

| Field | Meaning |
|---|---|
| `cwd` | Working dir for record/appmap commands, relative to project root (`.` = repo root). |
| `appmap_dir` | AppMap output dir, relative to `cwd`. Recordings read from `<cwd>/<appmap_dir>/<appmap_path>`. Match the project's `appmap.yml`. |
| `commands.record` | Shell template to record ONE test. Placeholders `{test_file}`, `{test_name}`, `{appmap_path}` are substituted per entry. Only needed for `--record`. |
| `commands.record_env` | Extra env vars for the record command (e.g. a recorder enable flag). |
| `commands.appmap_cli` | AppMap CLI for sequence-diagram export; may include a prefix like `npx @appland/appmap`. Default `appmap`. |

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
