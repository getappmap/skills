# Skill: Analyze AppMap Recordings

Query indexed AppMap recordings to investigate performance, correctness,
and behavior. AppMap exposes its analysis surface through a SQLite-backed
query engine and an MCP (Model Context Protocol) server, both shipped in
the `appmap` CLI.

## When to use

Use this skill when the user wants to:
- Find slow endpoints, slow functions, or slow SQL
- Diff performance between two branches
- Identify which recording exercised a given route or threw an exception
- Drill into the call tree of a specific recording
- Find recordings similar to a known-good or known-bad reference

This is the *read* side of AppMap. To produce recordings, see the
**appmap-record** skill.

## Prerequisites

1. Recordings exist on disk (typically under `tmp/appmap/`).
2. They have been indexed into a queryable database:
   ```sh
   npx @appland/appmap index --appmap-dir tmp/appmap
   ```
   This populates `~/.appmap/data/<sha>/query.db`. Pass `--query-db
   <path>` to write somewhere explicit (recommended for ad-hoc analysis).

## Two ways to query

### A. CLI verbs

Direct invocations for one-shot questions:

```sh
appmap query endpoints                     # per-route p50/p95/error rate
appmap query find requests --duration ">500ms"
appmap query find queries --table users
appmap query hotspots --type function --route "POST /orders"
appmap query tree <appmap-name> --focus-fn "app/Orders#create"
appmap query related <appmap-name>
appmap query compare <branch-a> <branch-b>
```

Use `--query-db <path>` to point at a non-default database.

### B. MCP server (recommended for LLM-driven analysis)

```sh
appmap query mcp --query-db <path>
```

Speaks JSON-RPC 2.0 over stdio (newline-delimited). Standard MCP
handshake, then `tools/call` with a tool name and arguments. The 11
exposed tools mirror the CLI verbs:

| Tool | Returns |
|---|---|
| `list_endpoints` | per-route p50/p95/error rate |
| `function_hotspots` | functions ranked by total/self elapsed |
| `sql_hotspots` | distinct SQL statements ranked by total elapsed |
| `find_recordings` | recording-level rows matching filters |
| `find_requests` | individual HTTP requests |
| `find_queries` | individual SQL queries |
| `find_calls` | function calls (filterable by class, method, label) |
| `find_logs` | log lines from functions labeled `log` (filter by message substring or logger class) |
| `find_exceptions` | exception rows |
| `get_call_tree` | one recording's tree, optionally focused |
| `find_related` | recordings similar to a reference |
| `compare_branches` | per-route latency delta between two branches |

Resources:
- `appmap://endpoints` — same data as `list_endpoints`, useful as a
  stable summary surface.
- `appmap://recording/{ref}/logs` — all log lines for one recording
  (templated; `{ref}` is the recording's `appmap_id` or its
  `appmap_name`/basename, same forms `find_recordings` returns). Use
  `resources/templates/list` to discover; substitute `{ref}` and read
  with `resources/read`.

## Analysis recipes

The MCP exposes individual tools; productive investigation chains them.
Common recipes:

### "Where is time going?"

```
list_endpoints sort=p95
  → pick the slow route
function_hotspots route="POST /orders"
  → pick the top function
find_requests route="POST /orders" duration=">p95"
  → pick a representative recording
get_call_tree appmap=<name> focus_type=function focus_value=<fqid>
              ancestors=2 descendants=2
```

### "What's slow about my SQL?"

```
sql_hotspots
  → pick a costly statement
find_queries duration=">100ms"
  → identify the recordings that ran it
get_call_tree appmap=<name> focus_type=sql_query focus_value=<sql substring>
```

### "What broke?"

```
find_exceptions with_logs=10
  → each exception comes back with the last 10 log lines preceding it
    under recent_logs (chronological); usually the fastest read on
    "what did the app think went wrong?"
get_call_tree appmap=<name>
  → see surrounding call context if recent_logs isn't enough
```

### "What did the app log?"

```
find_logs appmap=<name>                            # all log lines in one recording
find_logs message="connection refused"             # by substring (across recordings)
find_logs logger=AuditLogger appmap=<name>         # by logging class
```

`find_logs` returns rows captured from any function labeled `log`. The
substring search is broad on purpose — it matches anywhere in the call's
captured parameters or return value, including parameter names. Tighten
visually as you read the rows.

The actual log message lives inside `parameters_json` (a `[{name, class,
value}, …]` blob) — read the value of the parameter named `message` /
`msg`, or the first string-typed parameter. Some recorders (or
hand-instrumented loggers) instead return a structured object like
`{level, message, ...}` from the log function; in that case parse
`return_value` as JSON and use its `message` field. Both forms are
searchable by `--message`.

### "Did this branch regress?"

```
compare_branches branch_a=main branch_b=feature/foo
  → routes are sorted by biggest change first
find_recordings branch=feature/foo route="<regressed route>"
function_hotspots route=<regressed route> branch=feature/foo
```

### "What recordings are like this one?"

```
find_related appmap=<known-good or known-bad>
```

Score weights routes (×5), tables (×3), and shared classes (×2).

## fqid format

Many tools (`function_hotspots`, `find_calls`, `get_call_tree.focus_value`)
operate on fully qualified function ids. The format:

| Kind | Example |
|---|---|
| Instance method | `app/Logger#error` |
| Static method | `app/Util.parse` |
| Module-level (no class) | `src/cmds/query/db/openQueryDb.openQueryDb` |
| Nested classes | `app/Outer::Inner#method` |

## Output columns (what tools return)

Each tool returns an array of rows. Notable columns:

- **`find_recordings`**: `appmap_id`, `appmap_name`, `route`,
  `status_code`, `elapsed_ms`, `sql_count`, `branch`, `timestamp`.
  Pass either `appmap_id` (numeric) or `appmap_name` to `get_call_tree`
  / `find_related`.
- **`function_hotspots`**: `fqid`, `calls`, `total_ms`, `self_ms`.
- **`sql_hotspots`**: `sql_text`, `count`, `avg_ms`, `total_ms`.
- **`find_requests`**: `appmap_name`, `method`, `path`, `status_code`,
  `elapsed_ms`.
- **`find_queries`**: `appmap_name`, `sql_text`, `elapsed_ms`,
  `caller_class`, `caller_method`.
- **`find_exceptions`**: `appmap_id`, `appmap_name`, `event_id`,
  `exception_class`, `message`, `path`, `lineno`. Pass `with_logs=N`
  to attach `recent_logs` — an array of up to N log entries (same
  shape as `find_logs` rows) that preceded the exception in event
  order. Returned chronologically (oldest first).
- **`find_logs`**: `appmap_name`, `event_id`, `parent_event_id`,
  `logger`, `method_id`, `path`, `lineno`, `parameters_json`,
  `return_value`. The displayable log message is *not* a separate
  column — derive it from `parameters_json` (or structured
  `return_value`) as described in the recipe above.
- **`get_call_tree`**: ordered nodes with `depth`, `kind`
  (`function`/`http_server`/`http_client`/`sql`/`exception`/`log`),
  `fqid`/`sql_text`/etc., `elapsed_ms`, `event_id`. Log calls (any
  function labeled `log`) appear inline at their event position with
  kind=`log` rather than being mixed in with regular function calls.
  The CLI verb additionally accepts `--filter logs` to flatten the
  tree to just log lines.

## Driving the MCP from a script

Minimal stdio loop in Node:

```js
import { spawn } from 'child_process';
const mcp = spawn('appmap', ['query', 'mcp', '--query-db', dbPath],
  { stdio: ['pipe', 'pipe', 'pipe'] });

let id = 0;
function call(method, params) {
  return new Promise((resolve) => {
    mcp.stdout.once('data', (b) => resolve(JSON.parse(b.toString().trim()).result));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  });
}

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const hotspots = await call('tools/call',
  { name: 'function_hotspots', arguments: { limit: 10 } });
console.log(JSON.parse(hotspots.content[0].text));
```

Tool results arrive as `{ content: [{ type: 'text', text: '<JSON>' }] }`
— parse `content[0].text` to get the row array.

## Troubleshooting

**Empty results from every tool:**
- Confirm the database is populated: `sqlite3 <path> "SELECT
  COUNT(*) FROM appmaps"`. If zero, run `appmap index` again with
  `--appmap-dir` pointing at the directory containing `.appmap.json`
  files.
- The default DB lives under `~/.appmap/data/<sha>/` keyed by appmap
  directory. If you indexed under one cwd and queried from another, the
  shas won't match — pass `--query-db` to both sides.

**`get_call_tree` says "appmap not found":**
- Use the `appmap_name` returned by `find_recordings`, not the file path.
- Names with spaces and em-dashes work fine; pass them through unchanged.

**`function_hotspots` is empty but recordings exist:**
- The recording may not have instrumented your packages. Check the
  `appmap.yml` `packages:` config and re-record. See **appmap-record**.

**Stale data after re-recording:**
- `appmap index` is incremental. To force a clean rebuild, delete the
  query.db and re-run index.

## Related skills

- **appmap-record** — how to capture the recordings analyzed here.
- **appmap-label** — how labelling functions affects what shows up under
  `find_calls --label`.
