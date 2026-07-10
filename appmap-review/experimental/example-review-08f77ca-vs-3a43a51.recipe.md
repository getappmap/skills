# AppMap Behavioral Review — Private Games / Join Codes

**Revisions:** `08f77ca` (worktree-join-codes) vs `3a43a51` (deploy)
**Date:** 2026-06-30
**Commits reviewed:**

- `ef360a4` feat: private games with join codes (+ follow-ups through `08f77ca`)

> Produced by the appmap-review recipe over the compare of each revision's gold
> traces. Base re-recorded from `3a43a51` with SQL capture enabled (parity); the
> `appmap_labels` shim is excluded and its "added labels" nodes discounted.
> **Intended scope** (`git diff --name-only`): `auth/*`, `db/models.py`,
> `domain/joincode.py`, `engine/newgame_builder.py`, `graphql/{identity,mutation,query}.py`.

---

## Feature List

1. **Private game creation** — `createWaitingGame` accepts `isPrivate`; private games persist `is_private` / `join_code` / `join_code_created_at`.
2. **Join-code domain** — new `domain/joincode.py`: 6-char codes, `normalize_join_code`, 72 h TTL; `_allocate_join_code` retries collisions (in `engine/newgame_builder.py`).
3. **Viewer-scoped code visibility** — `join_code_for_viewer` / `member_or_creator` return the code only to creator/members.
4. **`gameByCode` lookup** — resolves a private waiting game by normalized code within the TTL.
5. **Shared `build_game_summary`** — extracted from `_list_games`; drives both listing and mutation returns.
6. **Security labels** — `security.authorization` / `security.join_code` on identity, `gameByCode`, the claim path.

---

## Coverage Matrix

| Feature | Covered by | Status |
| --- | --- | --- |
| Code generation / normalization | `test_generate_join_code_shape`, `test_normalize_join_code` | ✅ |
| Private creation + hidden listing | `test_private_game_gets_code_and_is_hidden_from_public_list` | ✅ |
| `gameByCode` unknown / case / expiry / started | `test_game_by_code_*` (4 tests) | ✅ |
| Member visibility after claim | `test_member_sees_private_game_and_code_after_claiming` (new) | ✅ |
| Shared `build_game_summary` (drift) | `test_create_game_mutation_enrolls_players`, `test_waiting_room_lifecycle` | ✅ |
| Engine / auth blast radius | `test_dispatch…`, `test_production…`, `test_login…` | ✅ checked (see Side Effects) |
| **`claimPlayer` admission gate on private games** | **no test** | ❌ **uncovered** |

---

## Suggested Labels

Functions that changed but carry no label — label them (via appmap-label) so the next
review can interpret them:

- **`security.authorization`** — [query.py:92](../server/nova_server/graphql/query.py) `join_code_for_viewer` — gates *who* may see a private game's code.
- **`dao.materialize`** — [query.py:146](../server/nova_server/graphql/query.py) `load_game_players` — loads player DAOs; makes per-game load fan-out (N+1) legible.

---

## Behavioral Drift (intended)

The in-scope changes match the feature: the create and lobby paths gain
`join_code_for_viewer` and the shared `build_game_summary` / `load_game_players` /
`assign_colors` helpers (`test_create_game`, `test_waiting_room`); `gameByCode` runs end
to end in the new `test_member_sees…`. The `games` table gains `is_private` /
`join_code` / `join_code_created_at`, so `games` INSERT/SELECT shapes shift across many
traces (additive — `0` removed predicates). Timing/value jitter is excluded by
construction, so every `changed` entry is real.

---

## Unintended Side Effects

Behavior that changed **outside the stated scope** — reconciling the footprint against
the touched files. The result here is reassuring: the blast radius is entirely
*mechanical*, with no out-of-scope call-shape, predicate, or guard change.

| Changed trace | Out-of-scope change | In the diff? | Assessment |
| --- | --- | --- | --- |
| `test_dispatch_arrival_and_battle_captures_star` | `games` INSERT gained the 3 new columns | no — engine tick code untouched | 🟢 acceptable — schema propagation via fixture game creation |
| `test_production_cycle_grows_ships_and_cash` | same `games` INSERT column delta | no | 🟢 acceptable — schema propagation |
| `test_snapshot_query_enforces_fog_of_war`, `test_subscription_pushes_snapshot_on_publish` | `games` SELECT gained the new columns | partially — `query.py` touched, but only the column set moved | 🟢 acceptable — schema propagation into read paths |
| `test_gate_rejects_invalid_token` | gained `appmap_labels.labels` calls | no (labeling config) | 🟢 acceptable — instrumentation, not behavior |

**Confirm the blast radius, then bless.** `engine/newgame_builder.py` *is* in the diff
(join-code allocation), but the engine traces show **only** the additive `games` column
in their fixture's game-creation INSERT — the tick/battle/production logic is byte-stable
and no new allocation path runs in these (non-private) games. No engine behavior
regressed; the schema simply rippled through every `games` query. If any of these had
shown a *new query*, a *changed call order*, or a new exception, it would be a 🟡/🔴
finding — none did.

---

## Suggestions

### 🔴 HIGH — Private-game claim bypass (admission absent on the mutation path)

**File:** [mutation.py](../server/nova_server/graphql/mutation.py) **Context:** `_claim_player` at line 931

*(Absence.)* `_claim_player` is labeled `security.authorization, security.join_code`, yet
its diff subtree gained **only** the `games` schema columns and `session_factory` — no
join-code/validation call. The read paths *did* gain enforcement (`join_code_for_viewer`;
`gameByCode`). Source confirms: `query.py` filters private games by `normalize_join_code`,
while `_claim_player` has no `is_private`/`join_code` check.

So admission is enforced on lookup but **not** on the claim mutation — a caller who knows
or enumerates a `game_id` + unclaimed `player_id` can claim a slot in a private game
without the code.

**Risk:** moderate/high — sequential ids; the list hides private games but the mutation
is unguarded.

**Recommended remediation:** require a valid `code` on `claimPlayer` for private games
(same normalize + 72 h-window check as `gameByCode`; exempt creator + existing owner),
then guard the deny branch:

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

### 🟢 INFO — Confirm the `build_game_summary` refactor preserves the summary

*(Intended drift, in scope.)* `build_game_summary` now drives both listing and mutation
returns; the create/lobby traces show the new call structure. Spot-check that the shared
summary returns the same fields it did inline before — a refactor's payoff is identical
output from one path.

---

## Tests to Synthesize

| Target | Test name | Priority |
| --- | --- | --- |
| Claim private game without code → error | `test_cannot_claim_private_game_without_code` | 🔴 High |
| Claim private game after `gameByCode` lookup (proof flow) | `test_claim_private_game_after_code_lookup` | 🔴 High |

---

## SQL Pass

- **New query:** `SELECT games.id … WHERE join_code = ? AND join_code_created_at >= ?` (gameByCode / `_allocate_join_code`) — parameterized, point lookup on the `join_code` index, TTL-bounded. No injection, no `SELECT *`.
- **Schema shapes** (3 removed ↔ 5 added on `games`) are the two sides of the additive column change — not a behavioral access shift, not a dropped guard.
- **N+1 watch:** `load_game_players` runs per game inside `_list_games`'s loop — pre-existing fan-out, **not introduced here** (the traces show its shape unchanged). Labeling it (above) makes it visible to future reviews.

## HTTP Pass

- `gameByCode(code: String!)` is the only new field: read-only, behind the auth gate, input used solely in an ORM `==` after `normalize_join_code`. No new mutation surface, no header trust, no redirect. Note: with `AUTH_DISABLED=1` (dev/test) the field is open — confirm production keeps the gate on.

---

## Summary

| Severity | Count | Action required |
| --- | --- | --- |
| 🔴 High | 1 | Enforce join-code admission on `claimPlayer` + add the negative gold trace |
| 🟢 Info | 2 | Confirm the summary refactor; bless the additive schema drift |

**Merge-blocking:** the `claimPlayer` admission gap — a security-labeled authorization
point that performs no authorization for private games. Everything else is contained:
the feature's behavioral footprint is the intended lobby/query drift plus a **purely
mechanical** schema/labeling blast radius — no engine or auth subsystem changed behavior,
and `login` is byte-identical.
