# AppMap Behavioral Review — sequence-diagram labels + `appmap trim`

**Revisions:** `6defff5e` vs `main` (`78d4f20b`) · **Date:** 2026-07-02 ·
**Commits:** `0d99566f` labels on diagram actions · `87824eb4` `appmap trim` + shared truncation lib · `b305a8a3`/`8d9ee218` gold-trace baseline · (5 CI-workflow-only commits, not reviewed)

> ⚠️ **First run — there was nothing to compare against.** The `main` branch has no
> committed gold traces yet; this branch introduces them. The 17 recordings on this
> branch become the baseline that future reviews will compare against. The findings
> below come from reading the code changes and the new recordings — not from a
> before/after comparison.

## Summary

| Severity | Findings | Action required |
| --- | --- | --- |
| 🔴 High | 0 | — |
| 🟡 Medium | 2 | Add test coverage for the text-truncation code and the new `trim` command |
| 🟢 Low | 2 | Clarify what `--max-length` covers; check the new `security.path-resolution` label actually works |

**Not merge-blocking.** The most important follow-up is test coverage: the
text-truncation library (which now shapes what AI agents see from MCP queries), the
new file-rewriting `trim` command, and the new labels feature could each break later
without any test or recording noticing. Record the truncation test, add a `trim`
test, and re-record the baseline.

## Findings

### 1 · 🟡 MEDIUM — Text-truncation rewrite also changes MCP query output, and nothing tests it

**File:** [truncateStructValue.ts:51](packages/cli/src/lib/truncateStructValue.ts#L51) ·
**Context:** `parseStruct` / `splitTopLevelFields` · **Evidence:** code change in
`87824eb4`; this code runs in none of the 17 recordings

Moving the truncation code out of `treeRender.ts` was not a pure copy-paste: the new
version recognizes three value formats the old one didn't (a space before `{`,
multi-line Ruby values, whitespace-only values). So the output of the MCP
`tree`/`find` commands — the text an AI agent reads — changes for those formats,
even though this PR is nominally about the new `trim` command. No test or recording
exercises this code.

**Risk:** The change itself looks safe — the new patterns only add cases. But this
output now has no safety net: if it breaks later, nothing will catch it.
**Fix:** Record the existing truncation unit test as a gold trace, then approve it
into the baseline:

```sh
cd packages/cli && npx appmap-node npx jest tests/unit/cmds/query/lib/treeRender.spec.ts
```

### 2 · 🟡 MEDIUM — `appmap trim` rewrites files in place, with no test and no undo

**File:** [trim.ts:97](packages/cli/src/cmds/trim/trim.ts#L97) · **Context:**
`handler` / `trimAppMap` · **Evidence:** code change; no recording runs `trim`

The new command overwrites AppMap files as it processes them. If one file in a batch
is corrupt, the command crashes partway through — after some files are already
overwritten and before others are touched. There is no dry-run option, and no test
covers any of this.

**Risk:** Someone pointing `trim` at a directory with one bad file ends up with a
half-modified set of recordings and no way back.
**Fix:** Read and validate every file before writing any of them. Add `trim.spec.ts`
covering: values get shorter, call structure stays identical, and a corrupt file is
skipped rather than fatal.

### 🟢 Low

- **3** · `trim --max-length` doesn't cover everything its name implies — [trim.ts:85](packages/cli/src/cmds/trim/trim.ts#L85) — the flag only caps plain strings; values inside structured objects keep their fixed limits (48/12 chars). Document that, or make the flag apply everywhere.
- **4** · The new `security.path-resolution` label may not actually work — [recordingId.ts:37](packages/cli/src/cmds/query/lib/recordingId.ts#L37) — it was added as a `// @label` code comment, but the recording that runs this function shows no labels at all. Check that the Node recorder picks up comment labels in TypeScript; if not, declare the label in `appmap.yml` instead.

## Checks performed

| Check | Result | Note |
| --- | --- | --- |
| Behavioral compare | — not run | first run; nothing to compare against (see note at top) |
| Changes outside the PR's scope | ⚠️ one → #1 | the truncation rewrite also changes MCP query output, which this PR wasn't about |
| Missing guards | ✅ | no security-related function changed without its check |
| Test/recording coverage | ❌ 3 gaps → #1, #2 | the labels feature, `trim`, and the truncation library have no coverage (detail ↓) |
| SQL | ✅ clean | no queries were added or changed |
| HTTP | ✅ clean | no request handling changed; the new labels are display metadata only |
| Intended changes verified | ✅ | the labels feature works as designed and runs in the recordings (`buildDiagram` ×49, `labelsOf` ×10); by design, re-labeling alone is never flagged as a behavior change, so this feature needs unit tests rather than recordings — counted as a gap above |

<details>
<summary><b>Review detail</b> — features, coverage, labels, drift</summary>

### Feature List

1. **Sequence-diagram actions carry AppMap labels** — `buildDiagram` attaches each function's labels to its diagram node ([buildDiagram.ts:27](packages/sequence-diagram/src/buildDiagram.ts#L27)).
2. **Labels don't count as behavior changes** — `Node.labels` is excluded from the fingerprint used to detect change, so re-labeling a function never trips a review ([types.ts:47](packages/sequence-diagram/src/types.ts#L47)).
3. **New `appmap trim` command** — shortens the recorded parameter/return values inside AppMap files; call structure and SQL are untouched ([trim.ts:1](packages/cli/src/cmds/trim/trim.ts#L1)).
4. **Shared text-truncation library** — moved out of the MCP tree renderer so `trim` can use it too; the move also extended what it can parse (see #1) ([truncateStructValue.ts:1](packages/cli/src/lib/truncateStructValue.ts#L1)).
5. **`security.path-resolution` label on `resolveAppmapPath`** — a comment annotation only; the function's code is unchanged ([recordingId.ts:37](packages/cli/src/cmds/query/lib/recordingId.ts#L37)).

### Coverage Matrix

| Feature | Covered by | Status |
| --- | --- | --- |
| `buildDiagram`/`labelsOf` run at all | `Sequence_diagram/labels/are_reported…` (×49 / ×10) | ✅ |
| **labels actually appearing on a diagram** | the recording contains no labeled functions, so the labels-present path never runs | ❌ **uncovered** |
| `appmap trim` | no recording | ❌ **uncovered** → #2 |
| text-truncation library | runs in none of the 17 recordings | ❌ **uncovered** → #1 |
| `resolveAppmapPath` | `MCP_handler/get_call_tree…` (×2) | ✅ |
| SQL rendering (not changed by this PR) | `query-find`, `query-tree`, `SQL_query` | — baseline |
| HTTP rendering (not changed by this PR) | `OpenAPI`, `query-endpoints`, `HTTP_server_request` | — baseline |

To close the gaps (record from the package dir so the ts-jest preset applies — see repo CLAUDE.md):

```sh
cd packages/cli && npx appmap-node npx jest tests/unit/cmds/query/lib/treeRender.spec.ts
cd packages/cli && npx appmap-node npx jest tests/unit/cmds/trim   # after adding trim.spec.ts (#2)
# labels on a diagram: record a fixture that has labeled functions, or assert it in a unit test
```

### Suggested Labels

- **`command.perform`** — [trim.ts:80](packages/cli/src/cmds/trim/trim.ts#L80) `handler` — the `appmap trim` command entry point.
- **`deserialize.safe`** — [trim.ts:95](packages/cli/src/cmds/trim/trim.ts#L95) `JSON.parse(before)` — `trim` parses whatever JSON is on disk; the label marks that trust boundary. (Whether comment labels work at all is #4.)

### Behavioral Drift

No comparison ran (see note at top). The recordings do confirm the changed code
paths run without errors: `buildDiagram`, `labelsOf`, and `resolveAppmapPath` all
execute; `trim` and the truncation library run in no recording. The SQL and HTTP
areas have baseline recordings and weren't touched by this PR, so future reviews
will flag any change there.

</details>
