# Experimental: gold-traces on `appmap archive` + `appmap compare`

A working prototype that reproduces the gold-traces `update`/`compare` features on
top of the stock AppMap CLI archive/compare pipeline, instead of the bespoke
sequence-diagram differ in `../assets/manage.mjs`. Built and validated against the
Nova join-codes feature.

## The pipeline

```
update   appmap archive (curated gold AppMaps)  ->  store <gold-baseline>.tar   (bless)

compare  appmap archive (fresh gold AppMaps)     ->  head.tar
         unpack base.tar -> report/base/ , head.tar -> report/head/
         appmap compare        report/{base,head}  ->  change-report.json + diff/
         appmap compare-report  --include-section sql-diff --include-section changed-appmaps
                                                    ->  report.md   (stock)
         OVERLAY: security.* label severity from the diff sequence diagrams
                                                    ->  gold-report.md + gold-findings.json
```

An AppMap archive is `appmap_archive.json` + `appmaps.tar.gz` (per-AppMap index:
`sequence.json`, `classMap.json`, `appmap-findings.json`, …) + `openapi.yml`.
`appmap compare` reads two unpacked archives staged as `report/base/` and
`report/head/` (the dir names are literal; the `--*-revision` args are labels).

## What it migrates vs. what it gets for free

Migrated from the bespoke engine (the genuine gold-traces value-add):
- **Bless/baseline lifecycle** — a stored `.tar` is the committed baseline.
- **Curated-subset** comparison — archive only the gold AppMaps.
- **Interpretation-ready change digest** (`buildDigest`) — every structural change
  from `appmap compare` tagged with the AppMap labels in its context (ANY
  namespace: `security.*`, `io.*`, `format.*`, `cache.*`, …) plus a label-agnostic
  structural classification. Labels are interpretation HINTS, not a severity gate.
  The stock report is a structural inventory ("2 new queries"); the digest is the
  artifact an LLM (the agent, in the skill model) turns into actionable findings —
  the interpretation layer `compare-report` predates.
- **CI gate** — `--fail-on-changes`.

Free from `appmap compare` (the bespoke engine reimplemented or lacked these):
new/removed/changed classification, the SQL diff, OpenAPI diff, scanner findings,
source locations, and precomputed/cached sequence diagrams.

## Validated result (Nova join codes)

Base = pre-gate gold set (`adafad7`), head = post-gate (`40a547f`, the cf164e3
join-code admission gate), curated to 4 base / 5 head AppMaps:

```
Compared. changed=2 new=1 removed=0 | 3 entr(ies) touch labeled code
```

The digest (`example-change-digest.json` / `example-gold-report.md`) shows the two
changed traces gained a `SELECT … FROM games` read **under `_claim_player`**,
tagged `security.authorization, security.join_code` — the join-code admission
gate. The stock report only says "2 new queries / 1 changed AppMap"; the digest
adds the label context an agent needs to interpret it ("the claim path now reads
the join code — confirm the public path is unaffected"). **Requires** an `appmap`
CLI that emits per-action `labels` (getappmap/appmap-js#2369) so the archived
`sequence.json` carries them. Nova only applies `security.*` labels today; the
mechanism is namespace-agnostic and would surface `io.*`/`format.*`/`cache.*`
changes identically.

## Status / open items

Prototype only — uncommitted, not wired into the skill. Before promoting:
- Drive the curated set from `gold_traces/manifest.yaml` (only archive listed tests).
- Fold the security overlay into `compare-report` itself (a label-aware section)
  rather than post-processing, so it benefits the GitHub Action too.
- Decide baseline storage: committed `.tar` vs. committed unpacked archive dir.
- SQL severity nuance: `appmap compare`'s `sqlDiff` keys on full normalized SQL,
  so a projection-only change shows as new/removed; the bespoke fingerprint
  (op+tables+filters) is quieter. Reconcile if projection-quiet matters.

Run:
```sh
node gold-archive.mjs update  --src DIR --store BASE.tar --cli "node <cli.js>"
node gold-archive.mjs compare --src DIR --base BASE.tar --work DIR --cli "node <cli.js>" --fail-on-changes
```
