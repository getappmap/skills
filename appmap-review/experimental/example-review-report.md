# AppMap Gold-Trace Review — Private-Game Join-Code Admission Gate

**Baseline:** `adafad7` (pre-gate gold set) → **Head:** `40a547f` (`cf164e3` applied)
**Date:** 2026-06-28   **Compared:** 5 core traces

> Illustrative output for the appmap-gold-traces skill, interpreted from
> `latest-compare.json` for this release. The engine produced the facts (the
> per-trace digest below); the findings are the skill's interpretation of them.

## Summary

| | Count |
|---|---|
| Changed traces | 2 (`test_claim_player_assigns_and_guards`, `test_waiting_room_lifecycle`) |
| New / Removed traces | 1 / 0 (`test_member_sees_private_game_and_code_after_claiming`) |
| Label domains touched | `security.authorization`, `security.join_code` |
| Blocking findings | 0 (1 confirm-required, 1 coverage gap) |

This release **adds** an admission gate to the claim path: `_claim_player`
(labeled `security.authorization, security.join_code`) now loads the game and, for
private games, validates the join code and its 72h window before assigning a slot.
The two new global query shapes are the join-code lookups; **no query or guard was
removed** (0 removed shapes), so this strengthens access control rather than
weakening it. It closes the admission bypass flagged HIGH in the 2026-06-26 review.

## Findings

### MEDIUM — Confirm the new claim-path admission gate is `is_private`-conditional

**Evidence** — `test_claim_player_assigns_and_guards` and
`test_waiting_room_lifecycle` each gained `added sql SELECT … FROM games` actions
**under `_claim_player`** (`[security.authorization, security.join_code]`). The SQL
diff adds two shapes filtered on `games.join_code` + `games.join_code_created_at`
(72h window). `0` removed query shapes. (`latest-compare.json` → entries[*].changes.)

**Interpretation** — The claim mutation now reads the game to branch on
`is_private` and, when private, checks a currently-valid join code — the same
normalize + TTL logic as `gameByCode`. This is the intended fix for the prior
review's HIGH "admission bypass on the claim mutation path."

**Impact** — If the gate were *not* conditioned on `is_private`, public claims
would suddenly require a code (a functional regression). The traces show an
unconditional `games` load (fine) but the join-code filter only on the private
path — consistent with a correct `is_private` branch.

**Recommendation** — Confirm against `mutation.py` `_claim_player`: (a) public
games still claim without a code; (b) creator and existing-owner are exempt;
(c) the 72h boundary is inclusive as intended. Then bless the two changed traces.

**Residual risk** — None on the backend gate once confirmed; see the coverage gap
below for the regression lock-in.

### MEDIUM — No gold trace drives the gate's *negative* (rejection) branch

**Evidence** — The changed traces exercise the *success* path (private member with
a valid code, public claim). The digest shows only `added` actions; there is no
trace in the gold set where the gate *rejects* a claim, so its rejection behavior
is unguarded going forward. (Coverage is path-dependent: a trace only guards the
branch it executes.)

**Interpretation** — `cf164e3` added unit tests (no-code / wrong-code / expired /
creator-exempt), but none is in the curated gold set, so a future regression that
silently drops the rejection would not surface here.

**Recommendation** — Add a `core` manifest entry that records the rejection (e.g.
`test_cannot_claim_private_game_without_code`) and bless its baseline, so the
*denied* path is a guarded gold trace, not just the *allowed* one.

**Residual risk** — Until added, the gate's deny branch is covered only by unit
tests, not by behavioral drift detection.

### LOW — New end-to-end join-by-code trace to bless

**Evidence** — `test_member_sees_private_game_and_code_after_claiming` is **new**
(`[security.authorization, security.join_code]`); it is where the
`SELECT … WHERE games.join_code = …` validation actually fires end to end.

**Interpretation** — Expected new coverage for the feature; it exercises
`gameByCode` resolution + private claim.

**Recommendation** — Add to the manifest `core` and bless as a new baseline.

**Residual risk** — None.

## Per-trace digest (engine facts)

| Trace | Status | Labels | Structural change |
|---|---|---|---|
| `test_claim_player_assigns_and_guards` | changed | security.authorization, security.join_code | +2 `SELECT … FROM games` under `_claim_player` |
| `test_waiting_room_lifecycle` | changed | security.authorization, security.join_code | +3 `SELECT … FROM games` under `_claim_player` |
| `test_member_sees_private_game_and_code_after_claiming` | new | security.authorization, security.join_code | (new trace) |
| `test_login_verifies_provider_token_and_mints_session` | unchanged | — | digest identical |
| `test_create_game_mutation_enrolls_players` | unchanged | — | digest identical |

SQL: 2 new query shapes (join-code lookups), 0 removed. API changes: 0. Exceptions:
none new. Timing/value jitter: excluded by construction (digest unaffected).

## Severity Summary

| Severity | Count | Action required |
|---|---|---|
| High | 0 | — |
| Medium | 2 | Confirm gate is `is_private`-conditional; add a rejection-path gold trace |
| Low | 1 | Bless the new join-by-code trace |

## Final Assessment

**Not merge-blocking.** This release adds — does not weaken — the private-game
admission gate, closing the prior HIGH bypass; no guard or read was removed and the
two unrelated control traces are byte-identical. Before blessing, confirm the gate
is conditioned on `is_private` (so public claims are unaffected), and add a
rejection-path trace to the gold set so the deny branch is guarded going forward.
