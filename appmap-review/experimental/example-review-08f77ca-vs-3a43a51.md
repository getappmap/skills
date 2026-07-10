# AppMap Gold-Trace Review — Private Games / Join Codes

**Branch:** `08f77ca` (worktree-join-codes) vs `3a43a51` (deploy)
**Date:** 2026-06-28
**Compared:** 9 core traces + 1 new

> Base re-recorded from `3a43a51` **with SQL capture enabled** (the deploy baselines
> predate it), so base and head are apples-to-apples. The `appmap_labels` shim is
> excluded; "added function: labels" nodes are the head-only labeling decorators,
> not behavior, and are discounted.

---

## Feature List

1. **Private game creation** — `createWaitingGame` accepts `isPrivate`; private games persist `is_private` / `join_code` / `join_code_created_at`, public games leave them null.
2. **Join-code domain** — new `domain/joincode.py`: 6-char codes, normalization, a 72 h TTL.
3. **Viewer-scoped code visibility** — `join_code_for_viewer` / `member_or_creator` return the code only to creator/members; everyone else gets `null`.
4. **`gameByCode` lookup** — new query resolves a private waiting game by normalized code within the TTL.
5. **Shared `build_game_summary`** — extracted so listing and mutation returns can't drift; now called from the create and lobby paths.
6. **Security labels** — `security.authorization` / `security.join_code` applied to identity, `gameByCode`, and the claim path.

---

## Coverage Matrix

| Feature | Covered by | Status |
| --- | --- | --- |
| Private creation + viewer-scoped code | `test_create_game_mutation_enrolls_players`, `test_waiting_room_lifecycle` | ✅ |
| `gameByCode` / join-by-code, end to end | `test_member_sees_private_game_and_code_after_claiming` (new) | ✅ |
| Shared `build_game_summary` refactor (drift) | `test_create_game…`, `test_waiting_room…` (golden) | ✅ |
| Engine / auth blast radius | `test_dispatch…`, `test_production…`, `test_login…` | ✅ clean |
| **`claimPlayer` admission gate on private games** | **no test** | ❌ **uncovered** |

---

## Golden-Trace Drift

`compare` flagged **8 of 9** traces changed plus 1 new; timing/value jitter is
excluded by construction, so these are structural. The dominant change is the
`games` table gaining join-code columns — every `INSERT/SELECT games` shifts its
column set across 7 traces (additive schema, **0** removed query shapes). On top of
that, the create and lobby paths gain `join_code_for_viewer` and the shared
`build_game_summary` helpers. Engine subsystems are untouched
(`test_dispatch…`, `test_production…` show only the schema column; `test_login…` is
**byte-identical**), so the change is contained to the lobby/claim/query surface.
The new `test_member_sees…` trace exercises the join-by-code path end to end.

---

## Suggestions

### 🔴 HIGH — Private-game claim bypass (admission gap on the mutation path)

**File:** [server/nova_server/graphql/mutation.py](../server/nova_server/graphql/mutation.py) **Context:** `_claim_player` at line 931

The claim trace's `_claim_player` is labeled `security.authorization, security.join_code`,
yet its diff subtree gained **only** the `games` schema columns and `session_factory` —
the sole function nodes under it are `_claim_player` and `session_factory`, with **no
join-code/validation call**. The read paths *did* gain enforcement
(`join_code_for_viewer`, and the new `gameByCode` in `test_member_sees…`). Source
confirms the asymmetry: `query.py` filters private games by `normalize_join_code`,
while `_claim_player` contains no `is_private`/`join_code` check.

So admission is enforced on discovery/lookup but **not** on the claim mutation. A
caller who knows or enumerates a `game_id` + unclaimed `player_id` can claim a slot
in a private game without ever presenting the code — bypassing the join-by-code
model. The security label makes the omission stark: the function is *marked* as an
authorization point but performs no authorization for the private case.

**Risk:** moderate/high. `game_id`/`player_id` are sequential integers; the games
list hides private games, but the mutation is unguarded, so the gap is reachable by
anyone who can discover the ids.

**Recommended remediation:** require a valid `code` on `claimPlayer` for private
games (same normalize + 72 h-window check as `gameByCode`; exempt the creator and an
existing slot owner). Then guard the deny branch with a gold/unit test:

```python
def test_cannot_claim_private_game_without_code(session, graphql_db):
    creator = _mk_user(session, "c@t.nova"); session.commit()
    intruder = _mk_user(session, "x@t.nova"); session.commit()
    game_id = _new_private_game(creator.id)
    slot = _first_unclaimed_slot(session, game_id)
    r = _claim_player(game_id, slot.id, intruder.id, name="Intruder")
    assert not r.success
    assert "code" in r.error.lower() or "private" in r.error.lower()
```

### 🟢 INFO — `games` schema gained join-code columns (pervasive, additive)

**Context:** 7 traces, `changed sql INSERT/SELECT games`

Additive columns (`is_private`, `join_code`, `join_code_created_at`); no WHERE/JOIN
predicate changed and nothing was removed — a projection/schema delta, not an
access-pattern shift. Expected; bless the new column shapes. Worth naming so the
pervasive games-query churn isn't mistaken for behavioral drift.

### 🟢 INFO — Shared summary refactor + viewer-scoped visibility

**Context:** `test_create_game…`, `test_waiting_room…` — added `build_game_summary`, `load_game_players`, `assign_colors`, `join_code_for_viewer`

Summary construction unified into a shared `build_game_summary` (drives both listing
and mutation returns); code display scoped to creator/member. Intended structure,
consistent across both paths. Confirm prior summary fields are preserved; bless.

---

## Tests to Synthesize

| Target | Test name | Priority |
| --- | --- | --- |
| Claim private game without code → error | `test_cannot_claim_private_game_without_code` | 🔴 High |
| Claim private game after `gameByCode` lookup (proof flow) | `test_claim_private_game_after_code_lookup` | 🔴 High |

---

## SQL Pass

- New `gameByCode` lookup — `SELECT games.id … WHERE join_code = ? AND join_code_created_at >= ?` — point query on the `join_code` index, bounded by the TTL window. Clean; parameterized.
- `games` INSERT/SELECT column growth is additive (the three new columns); no predicate or table change, no injection surface.
- `0` removed query shapes — no guard/read was dropped on any path.

## HTTP Pass

- `gameByCode(code: String!)` is the only new field: read-only, behind the auth gate, input used only in an ORM `==` after `normalize_join_code` (trim + uppercase). No interpolation, no new mutation surface.

---

## Summary

| Severity | Count | Action required |
| --- | --- | --- |
| 🔴 High | 1 | Enforce join-code admission on `claimPlayer` + add the negative gold trace |
| 🟢 Info | 2 | Bless schema + summary-refactor/visibility changes; engine + auth controls clean |

The feature is well-formed and contained — schema and the summary refactor are
intended, engine subsystems and `login` are untouched. The one blocker before merge
is the `claimPlayer` admission gap: a security-labeled authorization point that
performs no authorization for private games, which the gold set can't catch until a
rejection-path trace exists.
