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

1. A manifest (`appmap_golden_set.yaml`) names a curated set of tests and the
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

## Layout

The engine and templates ship with this skill; the *data* lives in the target
project and is committed there.

```
<skill>/assets/
  manage.mjs                          engine (config-driven, zero-install Node)
  manage.test.mjs                     engine tests (node --test, no deps)
  config.template.yaml                machine config template
  appmap_golden_set.template.yaml     manifest template

<project>/gold_traces/                 created at bootstrap, committed in the project
  config.yaml                         commands + paths (machine config)
  appmap_golden_set.yaml              the curated list (core + optional)
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

## Bootstrap (first time in a project)

When `gold_traces/` does not yet exist:

1. **Create the directory** and seed it from the templates:
   ```sh
   mkdir -p gold_traces/baseline/appmaps
   cp "<skill>/assets/config.template.yaml"             gold_traces/config.yaml
   cp "<skill>/assets/appmap_golden_set.template.yaml"  gold_traces/appmap_golden_set.yaml
   ```
   The engine's derived work lands in `.appmap/gold-traces` (AppMap's regenerable
   working dir). Ensure `.appmap/` is gitignored — most AppMap projects already ignore
   it; add `.appmap/` to the repo `.gitignore` if not.

2. **Fill in `config.yaml`.** Get the project's record command and paths from
   the project's `CLAUDE.md` first; if they aren't documented there, **ask the
   user** (the record invocation, the test working directory, the AppMap output
   dir, any env flag the recorder needs). Write them into `config.yaml` — after
   this, the config is the source of truth and you never re-ask. See
   **Config reference** below.

3. **Curate the manifest.** Replace the template entry with real `core` entries.
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
   and **enhance the manifest** for new/changed subsystems: add a `core` entry for a
   newly-critical path, or promote an `optional` entry into `core` when this release
   materially changed it. `update` seeds a baseline for any newly-added entry
   automatically (`update --only <test> --record`).

2. **Re-record and see what changed** — a dry run re-records and reports which traces
   drifted, writing nothing:
   ```sh
   node "<skill>/assets/manage.mjs" update --dir gold_traces --record --dry-run
   ```
   It marks each trace `bless` (behavior changed), `seed` (new entry), or counts it
   `unchanged`. The digest excludes timing/value jitter, so a `bless` is a real change.
   Add `--include-optional` for the optional set. For a full **interpreted** review of
   what changed and whether it's safe, run **appmap-review**.

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

`gold_traces/config.yaml` — machine config (commands and paths):

| Field | Meaning |
|---|---|
| `cwd` | Working dir for record/appmap commands, relative to project root (`.` = repo root). |
| `appmap_dir` | AppMap output dir, relative to `cwd`. Recordings read from `<cwd>/<appmap_dir>/<appmap_path>`. Match the project's `appmap.yml`. |
| `commands.record` | Shell template to record ONE test. Placeholders `{test_file}`, `{test_name}`, `{appmap_path}` are substituted per entry. Only needed for `--record`. |
| `commands.record_env` | Extra env vars for the record command (e.g. a recorder enable flag). |
| `commands.appmap_cli` | AppMap CLI used to export the sequence diagram that yields the bless-gating digest; may include a prefix like `npx @appland/appmap`. Default `appmap`. |
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

The engine has a single command — `update` (record + digest-gated bless). Diffing
and reviewing a change is the **appmap-review** skill's job.

```
update  [--dir DIR] [--include-optional] [--only TEST] [--record] [--dry-run]
```

- Re-blesses each baseline whose behavior changed (copies the fresh recording over
  it) and **seeds** a baseline for any manifest entry that lacks one. A trace whose
  behavioral digest matches its baseline is left **byte-identical** — no git churn.
- `--record` re-records each selected test first (needs `commands.record`).
- `--dry-run` reports what would be blessed/seeded without writing.
- `--only TEST` (repeatable) limits the run to named entries.
- `--include-optional` adds the `optional` set.
