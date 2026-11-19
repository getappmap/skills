// node --test — no dependencies. Uses the paused-accept fixture (a recorded pytest run).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  layout,
  outline,
  overlaps,
  outside,
  barCrossings,
  renest,
  renderHtml,
  exceptionsByCall,
  sqlLabel,
} from "./render.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const seq = () => load("paused-accept.sequence.json");
const exceptions = exceptionsByCall(load("paused-accept.appmap.json"));
const notes = load("paused-accept.notes.json");
const texts = (m) =>
  m.ops.filter((o) => o.text || o.lines).map((o) => o.text ?? o.lines.map((l) => l.text).join(" / "));

test("sqlLabel keeps the verb and table and drops the noise", () => {
  assert.equal(sqlLabel("INSERT INTO contracts (a, b) VALUES (%(a)s::INTEGER, %(b)s)"), "INSERT INTO contracts (…)");
  assert.equal(
    sqlLabel("UPDATE games SET paused=%(p)s, paused_at=%(t)s WHERE games.id = %(i)s"),
    "UPDATE games SET paused, paused_at",
  );
  assert.match(sqlLabel("-- 30 times\nSELECT a.x, a.y FROM a WHERE a.id = %(i)s"), /^30× SELECT a\.\* FROM a WHERE/);
});

test("without notes: a caller lane, the recorded actors, the exception and its message", () => {
  const m = layout(seq(), { exceptions });
  assert.deepEqual(
    m.lanes.map((l) => l.name),
    ["test", "nova_server", "models", "Database"],
  );
  const t = texts(m);
  assert.ok(t.includes("accept()"));
  assert.ok(t.includes("raises ContractError"));
  assert.ok(
    t.some((s) => s.includes("The game is paused")),
    "exception message comes from the .appmap.json",
  );
  assert.deepEqual(overlaps(m), []);
});

test("with notes: annotation lane, hidden calls, steps in order, anchors by ordinal", () => {
  const m = layout(seq(), { notes, exceptions });
  assert.equal(m.lanes[0].name, "Player B's app");
  const t = texts(m);
  for (const hidden of ["_wall_now()", "_player_in_game()"]) assert.ok(!t.includes(hidden));
  assert.ok(!m.ops.some((o) => o.k === "loop"), "a loop whose calls are all hidden is not drawn");
  const at = (s) => t.findIndex((x) => x.startsWith(s));
  assert.ok(at("1 ·") < at("2 ·") && at("2 ·") < at("3 ·") && at("3 ·") < at("4 ·") && at("4 ·") < at("5 ·"));
  assert.ok(at("3 ·") < at("accept()") && at("4 ·") < at("raises ContractError"));
  // "game_now#2" is the call inside accept, not the one inside offer.
  const frozen = m.ops.find((o) => o.k === "plain" && o.lines[0].text.startsWith("clock frozen"));
  const acceptY = m.ops.find((o) => o.k === "label" && o.text === "accept()").y;
  assert.ok(frozen.y > acceptY);
  assert.deepEqual(overlaps(m), []);
});

test("a note naming a lane that does not exist fails with the lane name", () => {
  assert.throws(() => layout(seq(), { notes: { notes: [{ before: "accept", lane: "nope", text: "x" }] } }), /nope/);
});

test("diff diagrams colour added and removed actions", () => {
  const s = {
    actors: [
      { id: "package:app", name: "app", order: 1 },
      { id: "database:Database", name: "Database", order: 2 },
    ],
    rootActions: [
      {
        nodeType: 3,
        callee: "package:app",
        name: "save",
        diffMode: 3,
        children: [
          { nodeType: 6, callee: "database:Database", query: "SELECT 1 FROM t", diffMode: 1, children: [] },
          { nodeType: 6, callee: "database:Database", query: "SELECT 2 FROM u", diffMode: 2, children: [] },
        ],
      },
    ],
  };
  const m = layout(s);
  for (const k of ["add", "del", "chg"]) assert.ok(m.used.has(k));
  const html = renderHtml(m, {});
  assert.match(html, /d-add/);
  assert.match(html, /added in head/);
});

test("the page is self-contained and themed for dark mode", () => {
  const html = renderHtml(layout(seq(), { notes, exceptions }), notes);
  assert.ok(!/(src|href)="https?:/.test(html), "no external resources");
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /<title>Paused Accept Trace<\/title>/);
});

test("changed-only keeps changed actions, their ancestors, and only the lanes they use", () => {
  const s = {
    actors: [
      { id: "package:a", name: "a", order: 1 },
      { id: "package:b", name: "b", order: 2 },
      { id: "package:c", name: "c", order: 3 },
      { id: "database:Database", name: "Database", order: 4 },
    ],
    rootActions: [
      { nodeType: 3, callee: "package:c", name: "untouched", children: [] },
      {
        nodeType: 3,
        callee: "package:a",
        name: "outer",
        children: [
          { nodeType: 3, caller: "package:a", callee: "package:b", name: "same", children: [] },
          {
            nodeType: 6,
            caller: "package:a",
            callee: "database:Database",
            query: "SELECT 1 FROM t",
            diffMode: 1,
            children: [],
          },
        ],
      },
    ],
  };
  const m = layout(s, { notes: { changedOnly: true } });
  const t = texts(m);
  assert.ok(t.includes("outer()"), "the ancestor of a change stays");
  assert.ok(!t.includes("same()") && !t.includes("untouched()"), "unchanged calls go");
  assert.deepEqual(
    m.lanes.map((l) => l.name),
    ["test", "a", "Database"],
    "lanes nothing uses go",
  );
});

// An async test as appmap-node records it: two calls to emit, the CLI's caller on every root.
const watcher = () => ({
  actors: [
    { id: "class:test", name: "test", order: 1 },
    { id: "class:server", name: "server", order: 2 },
  ],
  rootActions: [
    {
      nodeType: 3,
      caller: "class:test",
      callee: "class:test",
      name: "start",
      eventIds: [1],
      children: [
        { nodeType: 3, caller: "class:test", callee: "class:server", name: "emit", eventIds: [9], children: [] },
      ],
    },
    { nodeType: 3, caller: "class:test", callee: "class:server", name: "handle", eventIds: [5], children: [] },
    { nodeType: 3, caller: "class:test", callee: "class:server", name: "emit", eventIds: [12], children: [] },
  ],
});
const timerLane = { lanes: [{ id: "timer", name: "watcher timer" }], rootLane: "class:test" };

test("a bare anchor is the first call; #2 the second", () => {
  const m = layout(watcher(), {
    notes: {
      steps: [
        { at: "emit", heading: "first" },
        { at: "emit#2", heading: "second" },
      ],
    },
  });
  assert.deepEqual(
    m.ops.filter((o) => o.k === "heading").map((o) => o.text),
    ["first", "second"],
  );
});

test("a box note with no lane sits on the lane that was called", () => {
  const m = layout(watcher(), { notes: { notes: [{ after: "handle", lines: ["x"] }] } });
  const note = m.ops.find((o) => o.k === "note");
  assert.equal(
    note.lane,
    m.lanes.findIndex((l) => l.id === "class:server"),
  );
  assert.ok(Number.isFinite(note.x));
  assert.deepEqual(outside(m), []);
});

test("callers applies to top-level calls even when the CLI set a caller", () => {
  const m = layout(watcher(), { notes: { ...timerLane, callers: { handle: "timer" } } });
  const arrow = m.ops.find((o) => o.k === "label" && o.text === "handle()");
  assert.equal(
    arrow.from,
    m.lanes.findIndex((l) => l.id === "timer"),
  );
});

test("lift moves a nested call to the top level, in recorded order", () => {
  const m = layout(watcher(), { notes: { lift: ["emit"] } });
  const labels = m.ops.filter((o) => o.k === "label" || o.k === "self").map((o) => o.text);
  assert.deepEqual(labels, ["start()", "handle()", "emit()", "emit()"]);
});

test("laneOrder puts lanes in the order given; the rest follow", () => {
  const m = layout(watcher(), { notes: { ...timerLane, laneOrder: ["test", "timer"] } });
  assert.deepEqual(
    m.lanes.map((l) => l.name),
    ["test", "watcher timer", "server"],
  );
});

test("a plain note on the first lane stays inside the picture", () => {
  const m = layout(watcher(), {
    notes: {
      notes: [
        {
          after: "start",
          plain: true,
          lane: "class:test",
          lines: ["a long line of text that is wider than a lane head"],
        },
      ],
    },
  });
  assert.deepEqual(outside(m), []);
});

test("an added call to its own lane is drawn as an arrow, not a filled shape", () => {
  const s = watcher();
  s.rootActions[0].children[0] = {
    nodeType: 3,
    caller: "class:test",
    callee: "class:test",
    name: "helper",
    diffMode: 1,
    children: [],
  };
  const html = renderHtml(layout(s), {});
  assert.match(html, /<path [^>]*fill="none" class="s-add"/);
  s.rootActions[0].children[0].name = 'aRatherLongHelperNameOnTheLastLane';
  s.rootActions[0].children[0].callee = 'class:server';
  s.rootActions[0].children[0].caller = 'class:server';
  s.rootActions[0].children = [{ ...s.rootActions[2], children: [s.rootActions[0].children[0]] }];
  assert.deepEqual(outside(layout(s)), [], 'the "+ " prefix is counted in the width');
});

test("renest closes each call at its own return and drops HTTP server requests", () => {
  const ev = (id, method_id, extra = {}) => ({ id, event: "call", method_id, ...extra });
  const ret = (id, parent_id) => ({ id, event: "return", parent_id });
  const out = renest({
    events: [
      ev(1, "start"),
      ev(2, null, { http_server_request: { path_info: "/" } }),
      ev(3, "handle"),
      ret(4, 3),
      ret(5, 1),
      ev(6, "emit"),
      ret(7, 6),
      ret(8, 2),
    ],
  });
  assert.deepEqual(
    out.events.map((e) => (e.event === "call" ? e.method_id : `/${e.parent_id}`)),
    ["start", "handle", "/3", "emit", "/6", "/1"],
  );
});

test("a plain note at the end of a call is drawn beside the call's bars, not across them", () => {
  const m = layout(seq(), {
    notes: { notes: [{ end: "accept", plain: true, lines: ["refused before any write"] }] },
  });
  const p = m.ops.find((o) => o.k === "plain");
  assert.equal(p.anchor, "start");
  // Every bar open on that lane at the note's height ends left of the text.
  const bars = m.ops.filter((o) => o.k === "act" && o.lane === p.lane && o.y1 <= p.y && p.y <= o.y2);
  assert.ok(bars.length > 0, "the note sits inside an open call");
  for (const b of bars) assert.ok(p.x > b.x + 12, `text at ${p.x} clears the bar at ${b.x}`);
  assert.deepEqual(overlaps(m), []);
  assert.deepEqual(outside(m), []);
  // A plain note after the call, with the call closed, is still centred.
  const after = layout(seq(), {
    notes: { notes: [{ after: "accept", plain: true, lines: ["status still PENDING"] }] },
  });
  assert.equal(after.ops.find((o) => o.k === "plain").anchor, "middle");
});

// --- one call by number, the outline, note placement -------------------------------------------

const labelsOf = (m) => m.ops.filter((o) => o.k === "label" || o.k === "self").map((o) => o.text);

test("hide takes name#n for one call; the others keep their numbers", () => {
  // watcher() has emit under start (#1) and emit at the top level (#2).
  const m = layout(watcher(), {
    notes: { hide: ["emit#1"], steps: [{ at: "emit#2", heading: "the second emit" }] },
  });
  assert.deepEqual(labelsOf(m), ["start()", "handle()", "emit()"]);
  assert.deepEqual(
    m.ops.filter((o) => o.k === "heading").map((o) => o.text),
    ["the second emit"],
  );
});

test("collapse takes name#n too", () => {
  const all = layout(watcher(), { notes: { collapse: ["start"] } });
  const one = layout(watcher(), { notes: { collapse: ["start#1"] } });
  assert.deepEqual(labelsOf(one), labelsOf(all));
  assert.ok(labelsOf(one).length < labelsOf(layout(watcher())).length);
});

test("outline lists each call with its lane and number, and marks what the notes hide", () => {
  const lines = outline(watcher(), { notes: { hide: ["handle"] } });
  assert.ok(lines.includes("start  -> test"));
  assert.ok(lines.some((l) => /^  emit#1  -> server/.test(l)), lines.join("\n"));
  assert.ok(lines.includes("handle  -> server  [hidden]"));
  assert.ok(lines.includes("emit#2  -> server"));
  const shallow = outline(watcher(), { depth: 0 });
  assert.ok(shallow.some((l) => /^start  -> test  \[not opened, \d+ inside\]$/.test(l)), shallow.join("\n"));
});

test("a heading on an end or after note is the first line of its box; on a before note, a step", () => {
  const inBox = layout(watcher(), { notes: { notes: [{ end: "start", heading: "server.mjs:10", lines: ["x"] }] } });
  assert.deepEqual(inBox.ops.find((o) => o.k === "note").lines.map((l) => l.text), ["server.mjs:10", "x"]);
  assert.ok(!inBox.ops.some((o) => o.k === "heading"));
  const step = layout(watcher(), { notes: { notes: [{ before: "start", heading: "1 · first", lines: ["x"] }] } });
  assert.deepEqual(step.ops.filter((o) => o.k === "heading").map((o) => o.text), ["1 · first"]);
  assert.deepEqual(step.ops.find((o) => o.k === "note").lines.map((l) => l.text), ["x"]);
});

test("an under note sits below the call's arrow and above what the call does", () => {
  const m = layout(watcher(), {
    notes: { notes: [{ under: "start", lines: ["under"] }, { after: "start", lines: ["after"] }] },
  });
  const y = (text) => m.ops.find((o) => o.k === "note" && o.lines[0].text === text).y;
  const firstChild = Math.min(...m.ops.filter((o) => o.k === "label" && o.text === "emit()").map((o) => o.y));
  assert.ok(y("under") < firstChild && firstChild < y("after"));
});

test("a note on a lane with calls open starts to the right of their bars, and a crossing is reported", () => {
  const m = layout(watcher(), { notes: { notes: [{ under: "start", lines: ["inside start"] }] } });
  const note = m.ops.find((o) => o.k === "note");
  const bar = m.ops.find((o) => o.k === "act" && o.lane === note.lane);
  assert.ok(note.x >= bar.x + 12);
  assert.deepEqual(barCrossings(m), []);
  // A long heading runs from the left edge across the server lane's open bar.
  const long = "a step heading long enough to reach across the first lanes of this picture and beyond";
  const crossed = layout(watcher(), { notes: { steps: [{ at: "emit", heading: long }] } });
  assert.deepEqual(barCrossings(crossed), [long]);
});

test("a sanitized exception message is not drawn", () => {
  const withMessage = (message) => {
    const s = seq();
    const map = new Map([...exceptions].map(([id, list]) => [id, list.map((e) => ({ ...e, message }))]));
    return texts(layout(s, { exceptions: map }));
  };
  assert.ok(withMessage("real words").some((t) => t.includes("real words")));
  assert.ok(!withMessage("<v141>").some((t) => t.includes("<v141>")));
});

test("hidden calls before the first drawn call do not break the setup band; hide takes sql: too", () => {
  const withSetupCall = () => {
    const s = watcher();
    const q = (query, id) => ({ nodeType: 6, callee: "class:server", query, eventIds: [id], children: [] });
    s.rootActions = [
      { nodeType: 3, caller: "class:test", callee: "class:test", name: "make_game", eventIds: [90], children: [] },
      q("INSERT INTO players (name) VALUES (%s)", 91),
      ...s.rootActions,
      q("SELECT games.id FROM games WHERE games.id = %s", 92),
    ];
    return s;
  };
  const shown = layout(withSetupCall());
  assert.ok(!shown.ops.some((o) => o.k === "setup"), "a call comes first, so its query is drawn as an arrow");
  const hidden = layout(withSetupCall(), { notes: { hide: ["make_game", "sql:FROM games"], setup: { text: "one player" } } });
  const band = hidden.ops.find((o) => o.k === "setup");
  assert.equal(band.lines[0].text, "one player");
  const t = texts(hidden);
  assert.ok(!t.some((x) => x.includes("make_game")));
  assert.ok(!t.some((x) => x.includes("FROM games")), "the trailing query is hidden");
});

test("sqlLabel keeps a function in the select list; an indented code line keeps its indent", () => {
  const label = sqlLabel("SELECT coalesce(sum(contracts.amount), %(c)s::INTEGER) AS c1 FROM contracts JOIN events ON 1");
  assert.match(label, /^SELECT coalesce\(sum\(.*… FROM contracts/, label);
  const m = layout(watcher(), { notes: { notes: [{ end: "start", lines: [{ text: "    return False", mono: true }] }] } });
  assert.match(renderHtml(m, {}), /xml:space="preserve"[^>]*>    return False</);
});
