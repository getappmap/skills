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
**appmap-record**; to **review** a change, see **appmap-review**.

## How it works

The model is **curate → record → bless**, with the diff-and-review delegated to
**appmap-review**:

1. A manifest (`gold_traces/manifest.yaml`) names a curated set of tests and the
   recordings they produce.
2. The raw baseline AppMaps are committed under `baseline/appmaps/` — the source of
   truth: deliberately blessed, sanitized, small (KBs). Everything derived
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

The label names and how to apply them per language are in **appmap-config**.

**Record consistently.** Every gold trace must be recorded with the *same* capture
config — e.g. SQL capture on, labels applied. If the config changes, re-record the
whole set; otherwise a later review is swamped by instrumentation drift instead of
behavior.

## What makes a trace suitable

A good gold trace is the **smallest deterministic recording that exercises one
release-critical subsystem once**. Curate for *distinct* coverage: prefer one
representative trace per subsystem over many near-identical ones.

**Reuse an existing test before synthesizing one.** A repo may already have a
test that exercises a feature end-to-end — point the manifest at that. Before
adding an entry, search the suite for coverage of the command/handler you want to
guard. Synthesize a fresh test only when no existing one covers the path — and then 
it's a new, normal, test that the project will benefit from.

Rule a candidate **out** before adding it to the manifest:

- **It records little or nothing.** Some tests assert over in-memory data without driving the
  instrumented call graph. Confirm that a test actually records a useful amount of data before 
  committing it. Granular unit tests aren't a good candidate for gold traces.
- **Its size is repetition, not structure.** A loop- or large-fixture-driven test can
  balloon to MBs because the *same* helper function invocations repeat per iteration. Distinguish the
  two size modes before reacting: many big *parameter values* → the engine's `sanitize`
  step already replaces these with short tokens, so they add little committed weight
  (values aren't behavioral; see *Keeping traces lean*); many *repeated events* → pick a
  smaller fixture, or update *appmap.yml* to `exclude` the repeated function (especially if
  it's trivial in nature, and/or well-covered by a unit test).
- **It is nondeterministic.** Unseeded RNG, wall-clock branching, or run-to-run ordering
  drift makes the trace bless on every compare and trains you to ignore real changes.
  See *Determinism*. Verify a fresh candidate with `check --record` before trusting it.
  Consider making an unstable test stable by fixing the random behavior (e.g. changing
  the test setup to use a fixed seed).
- **It duplicates coverage.** Several traces walking the same path don't strengthen the
  baseline; they multiply the review and bless cost. Keep one.

**This suitability check is mandatory, not user-prompted.** After adding or changing
an entry, run:

```sh
node "<skill>/assets/manage.mjs" check --dir gold_traces --record \
  --only <test_name>
```

`check --record` records twice, verifies behavioral-digest stability, and reports
bytes, events, project code objects (for authoring `expect`), labels, SQL/HTTP
counts, and dominant repeated calls. It fails
on empty traces and unmet `expect`/`expect_labels` coverage. Large or repetitive
traces produce warnings that must be resolved or explicitly judged acceptable before blessing.
Do this automatically whenever curating a trace; do not wait for the user to ask
whether trace sizes and shapes are appropriate.

## Sanitization

- **Values are not behavior — and the engine strips them.** On bless the engine runs
  **`appmap sanitize`** (needs `@appland/appmap` ≥ 3.201.0) on the fresh recording,
  replacing every captured parameter/return/message value with a short,
  equality-preserving token (`<v1>`, `<uuid:v3>`). So the committed baseline is
  structurally incapable of carrying a secret, and it's also smaller. The engine sanitizes 
  the recordings **before** computing its bless digest and compares that against the (also sanitized) 
  committed baseline. Sanitization is performed by the gold trace helper functions and CLI commands;
  you don't need to add it explicitly.

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


## Monorepos

Keep a `gold_traces/` directory for each *appmap.yml* file in the project.

It's not your role to create or maintain *appmap.yml* files as part of gold traces maintenance.
During initial setup, if the project doesn't contain any *appmap.yml* files, then this
configuration needs to be created in collaboration with the user. How many
*appmap.yml* files a project needs (one per language, one or more per monorepo) is
covered in **appmap-config**, "Layout".

A `gold_traces/` per package (`packages/<name>/gold_traces/`)
keeps traces versioned and reviewed alongside the code they guard, and lets packages be
recorded and blessed independently (each `--dir` is its own baseline). A single repo-root
`gold_traces/` is fine too when the repo is effectively one project. This is an ownership
choice, not a technical one.

You don't configure paths: the engine runs the record/appmap commands from the **gold_traces parent directory** 
and reads recordings from wherever the **nearest-ancestor `appmap.yml`** collects them (its directory + its
`appmap_dir`). So for `packages/<name>/gold_traces`, commands run in `packages/<name>`
and recordings come from the nearest ancestor `appmap.yml`:

```sh
node "<skill>/assets/manage.mjs" update --dir packages/<name>/gold_traces --record
```

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
   inspecting the project. Lean heavily on the `appmap-record` skill to create sample
   recordings for the project. You can also check the project's README and/or LLM instruction
   files. Figure out the the test runner and how it's invoked (`package.json`
   scripts, `Makefile`, `pytest.ini`/`tox.ini`, `Gemfile`/`Rakefile`, CI workflows),
   the AppMap recorder integration for that stack, and any flags or options that the recorder
   needs. Write it into `manifest.yaml`'s `commands` block —
   after this it's the source of truth and you never re-derive it. Paths are derived,
   not configured (see **Config reference**). The record command MUST include the
   `{test_file}` and `{test_name}` tokens so it records one **specific** test rather
   than running the whole suite. The command cannot choose where the recording file
   lands — the recorder decides that, under `appmap_dir`. Don't add output-path
   flags; record, then find the file with `discover` (step 3).

3. **Curate the entries.** Replace the template entry with real `entries`,
   according to the guidance provided in the section **What makes a trace suitable**.
   Get each entry's `appmap_path` from the engine — do **not** guess it from naming
   conventions or hunt for recordings with `ls`/`find`:
   ```sh
   node "<skill>/assets/manage.mjs" discover --dir gold_traces \
     --test-file <test_file> --test-name <test_name>
   ```
   `discover` records the one test and prints the recording path(s) it produced,
   relative to `appmap_dir` — exactly the `appmap_path` value — plus a paste-ready
   entry stub. Use `feature` to group entries by subsystem. Add an `expect` list
   naming the release-critical code objects the trace must execute. For paths
   whose semantics depend on AppMap labels, add `expect_labels`; event count
   alone cannot prove coverage.

4. **Check suitability and stability.** This is required for every new entry:
   ```sh
   node "<skill>/assets/manage.mjs" check --dir gold_traces --record
   ```
   Resolve failures and investigate warnings. Reuse a better existing test before
   synthesizing a focused test; synthesize only when no existing test captures the
   required path.

5. **Seed the baseline.** Reuse the second checked recording and copy it into the
   baseline:
   ```sh
   node "<skill>/assets/manage.mjs" update --dir gold_traces
   ```
   `update` seeds `baseline/appmaps/`
   (every entry is new on the first run, so all are seeded). To seed only specific
   entries, add `--only <test_name>`, repeatable. `update` also runs the structural
   suitability gate before writing.

6. **Mark baselines binary** so Git doesn't produce noisy line diffs. Add to the
   repo-root `.gitattributes`:
   ```
   gold_traces/baseline/appmaps/**/*.appmap.json binary
   ```

7. **Commit** the new baseline as its own change:
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
   newly-critical path this release introduced or materially changed (get its
   `appmap_path` from `discover` — see **Engine commands**). Check new entries
   with `check --only <test> --record`; after review, `update --only <test>`
   seeds their baselines from the checked recordings.

2. **Check, re-record, and see what changed.** First run the mandatory suitability
   and two-recording stability check:
   ```sh
   node "<skill>/assets/manage.mjs" check --dir gold_traces --record
   ```
   Then reuse its fresh recordings in a dry run:
   ```sh
   node "<skill>/assets/manage.mjs" update --dir gold_traces --dry-run
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

Schema version 2 requires every entry to declare `expect`. Schema version 1
remains readable for existing repositories, but should be migrated by adding
coverage expectations and changing `schema_version` to `2`.

| Field | Meaning |
|---|---|
| `commands.record` | Shell template to record ONE test, run from the gold_traces parent dir. Placeholders `{test_file}`, `{test_name}` are substituted per run. Needed for `--record` and `discover`. |
| `commands.record_env` | Extra env vars for the record command (e.g. a recorder enable flag). |
| `commands.appmap_cli` | AppMap CLI the engine runs — exports the bless-gating sequence diagram **and** sanitizes each recording before it is committed (`sanitize` needs **`@appland/appmap` ≥ 3.201.0**). **Leave unset**: it auto-discovers `~/.appmap/bin/appmap` (where the IDE extensions install it), else `appmap` on `PATH`. A committed value is machine-specific config in a shared file (breaks on other machines/platforms); set it only for an unusual CLI location or a custom-compiled CLI (appmap-js itself sets `node built/cli.js`). |
| `expand` *(optional)* | Package code-object ids to render at function granularity (`--expand`). Default empty — package granularity already catches function changes. |
| `allow_values` *(optional)* | Values `appmap sanitize` keeps verbatim in blessed baselines (the engine passes them via `--allow-file`), exact whole-value match. Curate small public vocabularies only (enum state/role names); never anything that could identify a person or authenticate a request. |
| `entries` | The curated list. Each: `feature`, `test_file`, `test_name`, `appmap_path` (get it from `discover`), `summary`, an `expect` list of required AppMap code-object ids, and optional `expect_labels`. |

Paths are **derived**: commands run from the gold_traces parent directory, and
recordings are read from the nearest-ancestor `appmap.yml` (its directory + its
`appmap_dir`). Place `gold_traces/` inside the directory you want commands to run from,
within an AppMap project.

The YAML is read by a small bundled parser: block maps/lists only, no flow
collections/anchors/inline `#` comments (e.g. `entries: []` is rejected —
always write a block list). Quote any value containing a colon-then-space or
`#`, including instance-method ids such as `"Auth#login"`.

## Keeping traces lean

**A gold trace demonstrates behavior; it should be KBs, not MBs.** A trace
balloons when a high-frequency pure leaf is instrumented (e.g. a geometry helper
called thousands of times in one request → a multi-MB blob that is pure noise).
Two levers, preferred order:

1. **Exclude a well-tested, high-call pure leaf** in the project's `appmap.yml`.
   A package-local path exclusion is relative to that package's `path`:
   ```yaml
   packages:
     - path: my_pkg
       exclude:
        - geometry.distance
   ```
   Only exclude leaves whose behavior is already unit-tested and whose *callers*
   still appear in the trace. Never exclude a package whose call structure the
   gold set exists to guard. Changing `exclude` shrinks *every* affected baseline — the
   one case where re-blessing the whole set at once is correct (confirm each
   diff is only the leaf removal, then bless all). The `exclude` syntax for each
   language, and the YAML quoting rule for method ids that contain `#`, are in
   **appmap-config**, "Cutting noise".
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

The engine has three commands — `check` (shape, coverage, and stability), `update`
(record + digest-gated bless), and `discover` (find a new entry's `appmap_path`).
Diffing and reviewing a change is the
**appmap-review** skill's job.

```
update    [--dir DIR] [--only TEST] [--record] [--dry-run]
check     [--dir DIR] [--only TEST] [--record]
discover  [--dir DIR] --test-file FILE --test-name NAME
```

`check`:

- Without `--record`, checks committed baselines.
- With `--record`, records twice and fails on behavioral drift.
- Reports size and shape without relying on `jq`, `du`, or other optional shell
  tools.
- Fails on zero-event/no-call traces and missing `expect` code objects or
  `expect_labels`.
- Warns at 500 KiB, 1,500 events, or when one call repeats at least 100 times and
  accounts for at least 25% of calls.

`update`:

- Re-blesses each baseline whose behavior changed (copies the fresh recording over
  it) and **seeds** a baseline for any entry that lacks one. A trace whose behavioral
  digest matches its baseline is left **byte-identical** — no git churn.
- `--record` re-records each selected test first (needs `commands.record`).
- `--dry-run` reports what would be blessed/seeded without writing.
- `--only TEST` (repeatable) limits the run to named entries.

`discover`:

- Records the one test via `commands.record` and reports every appmap file the run
  produced — paths relative to `appmap_dir`, i.e. the entry's `appmap_path` — plus a
  paste-ready entry stub. This is **the** way to determine an `appmap_path`; never
  derive one by hand.
- Prints the same size/shape assessment for every candidate so empty or noisy
  recordings are visible before they enter the manifest.
