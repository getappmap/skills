## Change digest (label-annotated, interpretation-ready)

Structural changes from `appmap compare`, each tagged with the AppMap labels
in its context (any namespace). Interpretation is left to the reader/agent.

### `pytest/test_claim_player_assigns_and_guards` — **changed**  _labels: security.authorization, security.join_code_
- added sql SELECT under `_claim_player`: `SELECT games.id AS games_id, games.name AS games_name, games.time_compression AS`  [security.authorization, security.join_code]
- added sql SELECT under `_claim_player`: `SELECT games.id AS games_id, games.name AS games_name, games.time_compression AS`  [security.authorization, security.join_code]

### `pytest/test_waiting_room_lifecycle` — **changed**  _labels: security.authorization, security.join_code_
- added sql SELECT under `_claim_player`: `SELECT games.id AS games_id, games.name AS games_name, games.time_compression AS`  [security.authorization, security.join_code]
- added sql SELECT under `_claim_player`: `SELECT games.id AS games_id, games.name AS games_name, games.time_compression AS`  [security.authorization, security.join_code]
- added sql SELECT under `_claim_player`: `SELECT games.id AS games_id, games.name AS games_name, games.time_compression AS`  [security.authorization, security.join_code]

### `pytest/test_member_sees_private_game_and_code_after_claiming` — **new**  _labels: security.authorization, security.join_code_

_SQL: 2 new / 0 removed query shape(s). API changes: 0._

---

# AppMap runtime code review

| Summary | Status |
| --- | --- |
| Failed tests | :white_check_mark: All tests passed |
| API changes | :zero: No API changes |
| Security flaws |  :white_check_mark: None detected  |
| Performance problems |  :white_check_mark: None detected  |
| Code anti-patterns |  :white_check_mark: None detected  |
| [New AppMaps](#new-appmaps) | :star: 1 new pytest test |
| Changed AppMaps |  :zero: No changes  |
| [SQL changes](#sql-changes) |    :mag:      2 new queries |






<h2 id="new-appmaps">⭐ New AppMaps</h2>


[[pytest] member sees private game and code after claiming](head/pytest/test_member_sees_private_game_and_code_after_claiming.appmap.json) from [`tests/test_join_codes.py:117`](tests/test_join_codes.py:117)


<h2 id="sql-changes">🔍 SQL changes</h2>

### New queries (2)


<details>
<summary>
  <code>SELECT games.id FROM games WHERE ...</code> 
</summary>

  ```sql
  SELECT
  games.id
FROM
  games
WHERE
  games.join_code = % (join_code_1) s:: VARCHAR
  AND games.join_code_created_at >= % (join_code_created_at_1) s:: TIMESTAMP WITH TIME ZONE
  ```



Occurs in 1 AppMap:

| Name | Source location | AppMap diagram | Diff diagram |
| --- | --- | --- | ---|
| member sees private game and code after claiming | [`tests/test_join_codes.py:117`](tests/test_join_codes.py:117) | [Full AppMap &raquo;](head/pytest/test_member_sees_private_game_and_code_after_claiming.appmap.json) | [Sequence diagram diff &raquo;](diff/pytest/test_member_sees_private_game_and_code_after_claiming.diff.sequence.json) |
</details>

<details>
<summary>
  <code>SELECT games.id, games.name, games.time_compression, games.status, ...</code> 
</summary>

  ```sql
  SELECT
  games.id,
  games.name,
  games.time_compression,
  games.status,
  games.created_by_user_id,
  games.duration,
  games.stars_per_player,
  games.start_time,
  games.end_time,
  games.event_counter,
  games.last_action_time,
  games.ended,
  games.paused,
  games.paused_at,
  games.total_paused,
  games.auto_resume_at,
  games.is_private,
  games.join_code,
  games.join_code_created_at,
  games.factory_cost,
  games.spy_probe_cost,
  games.death_probe_cost,
  games.speed_cost,
  games.battle_power_cost,
  games.range_cost,
  games.probe_shield_cost,
  games.death_shield_cost,
  games.gate_cost_per_k
FROM
  games
WHERE
  games.join_code = % (join_code_1) s:: VARCHAR
  AND games.join_code_created_at >= % (join_code_created_at_1) s:: TIMESTAMP WITH TIME ZONE
  AND games.status = % (status_1) s
  ```



Occurs in 1 AppMap:

| Name | Source location | AppMap diagram | Diff diagram |
| --- | --- | --- | ---|
| member sees private game and code after claiming | [`tests/test_join_codes.py:117`](tests/test_join_codes.py:117) | [Full AppMap &raquo;](head/pytest/test_member_sees_private_game_and_code_after_claiming.appmap.json) | [Sequence diagram diff &raquo;](diff/pytest/test_member_sees_private_game_and_code_after_claiming.diff.sequence.json) |
</details>


