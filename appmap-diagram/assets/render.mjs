#!/usr/bin/env node
// render.mjs — draw one AppMap recording as a readable sequence diagram on a standalone HTML page.
//
//   node render.mjs --appmap <file.appmap.json> [--notes notes.json] [--out page.html]
//   node render.mjs --sequence <file.sequence.json> [--appmap <file.appmap.json>] ...
//
// The recorded calls, SQL and exceptions come from the AppMap CLI's sequence JSON
// (`appmap sequence-diagram -f json`); exception messages come from the .appmap.json.
// Everything the recording cannot show (a client lane, a source line) comes
// from the optional notes file — see SKILL.md for its format. No npm dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NODE_LOOP = 1;
const NODE_FUNCTION = 3;
const NODE_QUERY = 6;

// Layout constants, in SVG units. One "row" is a label line above an arrow.
const MARGIN = 10;
const HEAD_W = 140;
const HEAD_H = 40;
const TOP = 64;
const MIN_GAP = 190;
const ROW = 34;
const HEADING = 26;
const NOTE_LINE = 16;
const MONO_CH = 6.9; // width of one 11.5px monospace character
const SANS_CH = 6.3;
const SQL_MAX = 44;

// --- input ------------------------------------------------------------------------------------

export function findCli() {
  const home = path.join(os.homedir(), ".appmap", "bin", process.platform === "win32" ? "appmap.exe" : "appmap");
  return fs.existsSync(home) ? home : "appmap";
}

export function sequenceFromAppmap(appmapPath, cli = findCli(), expand = []) {
  const run = (file) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appmap-diagram-"));
    const args = [
      "sequence-diagram",
      "-f",
      "json",
      "--output-dir",
      dir,
      ...expand.flatMap((e) => ["--expand", e]),
      file,
    ];
    const r = spawnSync(cli, args, { encoding: "utf8" });
    const out = fs.readdirSync(dir).find((f) => f.endsWith(".sequence.json"));
    return { r, seq: r.status === 0 && out ? JSON.parse(fs.readFileSync(path.join(dir, out), "utf8")) : null };
  };
  let { r, seq } = run(appmapPath);
  if (!seq && /compute event stack/.test(r.stderr + r.stdout)) {
    // getappmap/appmap-js#2430: returns out of stack order. Draw a re-nested copy instead.
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "appmap-diagram-")), path.basename(appmapPath));
    fs.writeFileSync(copy, JSON.stringify(renest(JSON.parse(fs.readFileSync(appmapPath, "utf8")))));
    console.error(
      'note: the CLI could not order this recording\'s returns; drawing a re-nested copy (see SKILL.md, "Async recordings")',
    );
    ({ r, seq } = run(copy));
  }
  if (!seq) throw new Error(`${cli} sequence-diagram failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  return seq;
}

/** The diff of two recordings of one test, as the CLI's diff sequence JSON. Each side's diagram is
 * made here, so `expand` applies to both. */
export function diffFromAppmaps(basePath, headPath, cli = findCli(), expand = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appmap-diagram-"));
  const files = ["base", "head"].map((side, i) => {
    const file = path.join(dir, `${side}.sequence.json`);
    fs.writeFileSync(file, JSON.stringify(sequenceFromAppmap([basePath, headPath][i], cli, expand)));
    return file;
  });
  const out = path.join(dir, "diff");
  const r = spawnSync(cli, ["sequence-diagram-diff", "-f", "json", "--output-dir", out, ...files], { encoding: "utf8" });
  const diff = path.join(out, "diff.json");
  if (r.status !== 0 || !fs.existsSync(diff)) {
    throw new Error(`${cli} sequence-diagram-diff failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  return JSON.parse(fs.readFileSync(diff, "utf8"));
}

/** Re-emit a recording's events properly nested: each call's parent is the newest call still open
 * when it starts, a return closes its own call wherever that is, and HTTP server requests are
 * dropped (their children move up). */
export function renest(appmap) {
  const calls = new Map();
  const returns = new Map();
  const open = [];
  for (const e of appmap.events || []) {
    if (e.event === "call") {
      calls.set(e.id, { e, parent: open.at(-1), children: [] });
      open.push(e.id);
    } else {
      returns.set(e.parent_id, e);
      const i = open.lastIndexOf(e.parent_id);
      if (i >= 0) open.splice(i, 1);
    }
  }
  const roots = [];
  for (const [id, n] of calls) {
    if (n.e.http_server_request) continue;
    let p = n.parent;
    while (p !== undefined && calls.get(p).e.http_server_request) p = calls.get(p).parent;
    (p === undefined ? roots : calls.get(p).children).push(id);
  }
  const events = [];
  const emit = (id) => {
    events.push(calls.get(id).e);
    calls
      .get(id)
      .children.sort((a, b) => a - b)
      .forEach(emit);
    if (returns.has(id)) events.push(returns.get(id));
  };
  roots.sort((a, b) => a - b).forEach(emit);
  return { ...appmap, events };
}

/** call event id -> [{class, message}] from the return events of the recording. */
export function exceptionsByCall(appmap) {
  const map = new Map();
  for (const e of appmap?.events || []) {
    if (e.event === "return" && e.exceptions?.length) map.set(e.parent_id, e.exceptions);
  }
  return map;
}

// --- text helpers -----------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const textW = (s, mono) => String(s).length * (mono ? MONO_CH : SANS_CH);
const shortClass = (c) => String(c).split(".").pop();

/** "-- 30 times\nINSERT INTO players (...)" -> {count: 30, sql: "INSERT INTO players (...)"} */
function splitCount(q) {
  const m = /^--\s*(\d+)\s+times\s*\n/.exec(q || "");
  return m ? { count: Number(m[1]), sql: q.slice(m[0].length) } : { count: 1, sql: q || "" };
}

/** A short, readable form of a query: the verb and table, plus the start of the rest. */
export function sqlLabel(q, max = SQL_MAX) {
  const { count, sql } = splitCount(q);
  let s = sql.replace(/\s+/g, " ").trim();
  const ins = /^INSERT INTO (\w+)/i.exec(s);
  if (ins) s = `INSERT INTO ${ins[1]} (…)`;
  const upd = /^UPDATE (\w+) SET (.+?)( WHERE .*)?$/i.exec(s);
  if (upd)
    s = `UPDATE ${upd[1]} SET ${upd[2]
      .split(",")
      .map((c) => c.split("=")[0].trim())
      .join(", ")}`;
  const sel = /^SELECT (.+?) FROM (\w+)(.*)$/i.exec(s);
  if (sel) {
    // A list of columns is "<table>.*"; a function call (count, sum, coalesce) is what the query
    // is for, so it stays, cut short.
    const short = (t) => (t.length > 20 ? t.slice(0, 19).trimEnd() + "…" : t);
    const cols = sel[1].includes("(") ? short(sel[1]) : sel[1].includes(",") ? `${sel[2]}.*` : sel[1];
    s = `SELECT ${cols} FROM ${sel[2]}${sel[3]}`;
  }
  s = s.replace(/%\((\w+)\)s(::[\w ]+)?/g, "…").replace(/\?/g, "…");
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return (count > 1 ? `${count}× ` : "") + s;
}

function sqlSummary(q) {
  const { count, sql } = splitCount(q);
  const m = /^\s*(INSERT INTO|UPDATE|DELETE FROM|SELECT[\s\S]*?FROM)\s+(\w+)/i.exec(sql);
  const verb = m ? m[1].split(/\s/)[0].toUpperCase() : sql.split(/\s/)[0];
  return `${count > 1 ? count + "× " : ""}${verb} ${m ? m[2] : ""}`.trim();
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// --- layout -----------------------------------------------------------------------------------

/** Keep only actions that changed (diffMode set) and the calls above them. An added or removed
 * call keeps its whole subtree; a changed one keeps only its changed descendants. */
export function pruneUnchanged(list) {
  const out = [];
  for (const a of list || []) {
    const children = pruneUnchanged(a.children);
    if (a.diffMode === 1 || a.diffMode === 2) out.push(a);
    else if (a.diffMode || children.length) out.push({ ...a, children });
  }
  return out;
}

const firstEvent = (a) => a.eventIds?.[0] ?? Math.min(Infinity, ...(a.children || []).map(firstEvent));

/** Move calls to the named functions to the top level, in recorded order. appmap-node writes an
 * async call's return when it settles, so a timer or request callback can be recorded inside a
 * call that had already handed control back. */
export function liftCalls(list, names) {
  const lifted = [];
  const strip = (actions, top) =>
    actions.flatMap((a) => {
      const children = strip(a.children || [], false);
      if (!top && a.nodeType === NODE_FUNCTION && names.has(a.name)) {
        lifted.push({ ...a, caller: undefined, children });
        return [];
      }
      return [{ ...a, children }];
    });
  const roots = strip(list || [], true);
  return [...roots, ...lifted].sort((a, b) => firstEvent(a) - firstEvent(b));
}

/**
 * Turn a sequence diagram (+ notes) into a list of positioned drawing ops.
 * Pass 1 walks the actions and places everything vertically, with lanes as indexes;
 * pass 2 widens the gaps between lanes until every label fits, then resolves x.
 */
/** "accept#2" -> ["accept", 2]; "accept" -> ["accept", null]. Only a trailing "#<digits>" counts,
 * so a private method named "#flush" is still a name. */
const splitAnchor = (anchor) => {
  const m = /^(.*)#(\d+)$/.exec(String(anchor));
  return m ? [m[1], Number(m[2])] : [String(anchor), null];
};

/**
 * What every view of a trace shares: the actions after --changed-only and `lift`, the number of
 * each call, and which calls the notes hide or collapse.
 *
 * Calls are numbered per name over the whole trace, in recorded order, whether or not they are
 * drawn: "callTool#3" is the third call to callTool. So hiding a call never renumbers the rest,
 * and the outline's numbers are the ones the notes use.
 */
export function prepare(seq, notes = {}) {
  if (notes.changedOnly) seq = { ...seq, rootActions: pruneUnchanged(seq.rootActions) };
  if (notes.lift?.length) seq = { ...seq, rootActions: liftCalls(seq.rootActions, new Set(notes.lift)) };
  const baseMatches = (base, a) =>
    base.startsWith("sql:")
      ? a.nodeType === NODE_QUERY && splitCount(a.query).sql.includes(base.slice(4))
      : a.nodeType === NODE_FUNCTION && a.name === base;
  const numbers = new Map(); // anchor base -> Map(action -> its number)
  const numbered = (base) => {
    if (!numbers.has(base)) {
      const found = new Map();
      const visit = (list) => {
        for (const a of list || []) {
          if (baseMatches(base, a)) found.set(a, found.size + 1);
          visit(a.children);
        }
      };
      visit(seq.rootActions);
      numbers.set(base, found);
    }
    return numbers.get(base);
  };
  const matches = (anchor, a) => {
    const [base, nth] = splitAnchor(anchor);
    return numbered(base).get(a) === (nth ?? 1);
  };
  // An entry of `hide` or `collapse` is a name (every call to it), "name#n" (that one call), or
  // "sql:<text>" (every query containing the text; "sql:<text>#n" for one).
  const named = (entries) => (a) =>
    (a.nodeType === NODE_FUNCTION || a.nodeType === NODE_QUERY) &&
    (entries || []).some((e) => {
      const [base, nth] = splitAnchor(e);
      return nth === null ? baseMatches(base, a) : matches(e, a);
    });
  return {
    seq,
    matches,
    isHidden: named(notes.hide),
    isCollapsed: named(notes.collapse),
    /** [number, how many calls share the name] for a function call. */
    numberOf: (a) => [numbered(a.name).get(a), numbered(a.name).size],
  };
}

/** The trace as indented text: one line per call, with the lane it lands on and the number to
 * use in an anchor. Hidden and collapsed calls are listed, marked, and not opened. */
export function outline(seq, { notes = {}, depth = Infinity } = {}) {
  const prep = prepare(seq, notes);
  const lane = new Map(prep.seq.actors.map((a) => [a.id, notes.laneLabels?.[a.id]?.name || a.name]));
  const mark = { 1: "+ ", 2: "- ", 3: "~ ", 4: "> " };
  const count = (list) => (list || []).reduce((n, a) => n + 1 + count(a.children), 0);
  const lines = [];
  const walk = (list, level) => {
    for (const a of list || []) {
      const pad = "  ".repeat(level);
      const diff = mark[a.diffMode] || "";
      if (a.nodeType === NODE_LOOP) {
        lines.push(`${pad}${diff}loop x${a.count}${level < depth ? "" : `  [not opened, ${count(a.children)} inside]`}`);
        if (level < depth) walk(a.children, level + 1);
        continue;
      }
      if (a.nodeType === NODE_QUERY) {
        lines.push(`${pad}${diff}sql: ${sqlLabel(a.query, 70)}${prep.isHidden(a) ? "  [hidden]" : ""}`);
        continue;
      }
      if (a.nodeType !== NODE_FUNCTION) {
        lines.push(`${pad}${diff}${a.route || a.name || `node ${a.nodeType}`}`);
        if (level < depth) walk(a.children, level + 1);
        continue;
      }
      const [n, of] = prep.numberOf(a);
      const inside = count(a.children);
      const raises = a.returnValue?.raisesException || a.stableProperties?.raises_exception;
      const state = prep.isHidden(a) ? "hidden" : prep.isCollapsed(a) ? "collapsed" : level >= depth && inside ? "not opened" : "";
      const tail = [
        a.callee && lane.has(a.callee) ? `-> ${lane.get(a.callee)}` : "",
        raises ? "raises" : "",
        state ? `[${state}${inside ? `, ${inside} inside` : ""}]` : "",
      ].filter(Boolean);
      lines.push(`${pad}${diff}${a.name}${of > 1 ? `#${n}` : ""}${tail.length ? "  " + tail.join("  ") : ""}`);
      if (!state) walk(a.children, level + 1);
    }
  };
  walk(prep.seq.rootActions, 0);
  return lines;
}

export function layout(seq, { notes = {}, exceptions = new Map() } = {}) {
  const prep = prepare(seq, notes);
  seq = prep.seq;
  const { matches, isHidden, isCollapsed } = prep;

  // Lanes: annotation lanes first (in the order given), then the recorded actors that something
  // in the picture actually calls.
  const lanes = [];
  for (const l of notes.lanes || []) lanes.push({ ...l, kind: l.kind || "client" });
  const referenced = new Set();
  const collect = (list) => {
    for (const a of list || []) {
      if (isHidden(a)) continue;
      if (a.callee) referenced.add(a.callee);
      if (a.caller) referenced.add(a.caller);
      if (!isCollapsed(a)) collect(a.children);
    }
  };
  collect(seq.rootActions);
  const named = [
    notes.rootLane,
    notes.rootQueryLane,
    ...Object.keys(notes.laneLabels || {}),
    ...Object.values(notes.callers || {}),
    ...(notes.notes || []).map((x) => x.lane),
  ];
  for (const v of named) if (v) referenced.add(v);
  const actors = [...seq.actors]
    .filter((a) => referenced.has(a.id) || referenced.has(a.name))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const a of actors) {
    const label = notes.laneLabels?.[a.id] || {};
    lanes.push({ id: a.id, name: label.name || a.name, sub: label.sub, kind: "recorded" });
  }
  const laneIdx = (id) => lanes.findIndex((l) => l.id === id || l.name === id);
  let rootLane = notes.rootLane != null ? laneIdx(notes.rootLane) : -1;
  if (rootLane < 0) {
    lanes.unshift({ id: "__caller", name: notes.rootLaneName || "test", sub: "the recorded test", kind: "caller" });
    rootLane = 0;
  }
  if (notes.laneOrder?.length) {
    const rank = (l) => {
      const i = notes.laneOrder.findIndex((x) => x === l.id || x === l.name);
      return i < 0 ? notes.laneOrder.length : i;
    };
    const root = lanes[rootLane];
    lanes.sort((a, b) => rank(a) - rank(b));
    rootLane = lanes.indexOf(root);
  }
  const L = (id) => {
    const i = laneIdx(id);
    if (i < 0) throw new Error(`notes name a lane that does not exist: ${id}`);
    return i;
  };
  const rootQueryLane = notes.rootQueryLane != null ? L(notes.rootQueryLane) : rootLane;
  const dbLane = lanes.findIndex((l) => l.id?.startsWith("database:"));

  // Anchors: "offer", "accept#2" (the second call named accept), "sql:SELECT contracts" (a query
  // whose text contains it; "#n" is the nth such query), "raise:accept" (the exception arrow of
  // that call). Notes attach before / under / after / at the end of one; steps put a heading
  // before one. `prepare` does the numbering.
  const notesAt = (where, a) => (notes.notes || []).filter((x) => x[where] && matches(x[where], a));
  const stepsAt = (a, prefix = "") =>
    (notes.steps || []).filter((x) => String(x.at).startsWith(prefix) && matches(String(x.at).slice(prefix.length), a));
  const heading = (text) => {
    ops.push({ k: "heading", y: y + 14, text });
    y += HEADING;
  };
  const visible = (a) => !isHidden(a) && (a.nodeType !== NODE_LOOP || (a.children || []).some(visible));

  const ops = [];
  const used = new Set();
  let y = TOP;
  const laneDepth = new Map();

  // `where` is the placement the note was given: before, under, after or end.
  const addNote = (note, lane, where) => {
    const mono = note.mono ?? false;
    const lines = (note.lines || wrap(note.text || "", 44)).map((l) =>
      typeof l === "string" ? { text: l, mono } : { mono, ...l },
    );
    // A heading on a `before` note is a step of its own (something that happens with no recorded
    // call). Anywhere else it belongs to the box, so it is the box's first line.
    if (note.heading && (where === "before" || note.plain)) heading(note.heading);
    else if (note.heading) lines.unshift({ text: note.heading, bold: true });
    // A box on a lane with calls still open starts to the right of their bars.
    const openHere = lane != null ? laneDepth.get(lane) || 0 : 0;
    const depthX = openHere > 0 ? openHere - 1 : null;
    if (note.plain) {
      // How many calls are open on each lane right now: an `end` note's own call is still open,
      // so centred text on that lane would cross its bars. The layout puts it beside them.
      const open = lanes.map((_, i) => laneDepth.get(i) || 0);
      ops.push({
        k: "plain",
        y: y + 14,
        lane,
        lines,
        kind: note.kind || "ok",
        align: lane == null ? "span" : "lane",
        open,
      });
      y += lines.length * NOTE_LINE + 8;
      return;
    }
    const h = lines.length * NOTE_LINE + 12;
    ops.push({ k: "note", y, h, lane, lines, kind: note.kind || "info", inside: depthX });
    used.add(note.kind || "info");
    y += h + 12;
  };

  // Queries that run before the first function call are setup: one band, not twenty arrows.
  // Calls the notes hide do not end the run: with the test's set-up call hidden, the queries
  // around it are still set-up.
  let actions = [...seq.rootActions];
  const lead = [];
  while (actions.length && (actions[0].nodeType === NODE_QUERY || isHidden(actions[0]))) {
    const first = actions.shift();
    if (first.nodeType === NODE_QUERY && !isHidden(first)) lead.push(first);
  }
  if (lead.length && notes.setup !== false) {
    const s = typeof notes.setup === "object" ? notes.setup : {};
    const lines = [{ text: s.text || `${lead.length} setup ${lead.length === 1 ? "query" : "queries"}`, mono: false }];
    const summary = s.lines || [lead.map((q) => sqlSummary(q.query)).join(" · ")];
    for (const l of summary) lines.push({ text: l, mono: true, kind: "sql" });
    const h = lines.length * NOTE_LINE + 12;
    ops.push({ k: "setup", y, h, lines });
    y += h + 20;
    used.add("sql");
  }

  const noteLane = (nt, dflt) => (nt.lane != null ? L(nt.lane) : dflt);
  const walk = (list, callerLane, top = false) => {
    for (const a of list) {
      if (!visible(a)) continue;
      const diff = { 1: "add", 2: "del", 3: "chg", 4: "mov" }[a.diffMode] || null;
      if (diff) used.add(diff);

      // Notes placed "before" an action come ahead of its step heading: the heading names the
      // action itself, so it sits directly above its arrow.
      for (const nt of notesAt("before", a)) addNote(nt, noteLane(nt, callerLane), "before");
      for (const st of stepsAt(a)) heading(st.heading);

      if (a.nodeType === NODE_LOOP) {
        const y0 = y;
        y += 20;
        const fromLane = callerLane;
        walk(a.children || [], callerLane, top);
        ops.push({ k: "loop", y1: y0, y2: y, lane: fromLane, count: a.count, open: laneDepth.get(fromLane) || 0 });
        used.add("loop");
        y += 10;
        continue;
      }

      if (a.nodeType === NODE_QUERY) {
        const to = dbLane >= 0 ? dbLane : callerLane;
        const from = callerLane;
        ops.push({
          k: "label",
          y: y + 14,
          from,
          to,
          text: sqlLabel(a.query),
          cls: "sql",
          mono: true,
          diff,
          title: splitCount(a.query).sql,
        });
        ops.push({ k: "arrow", y: y + 22, from, to, cls: "sql", diff });
        used.add("sql");
        y += ROW;
        for (const where of ["under", "after"])
          for (const nt of notesAt(where, a)) addNote(nt, noteLane(nt, nt.plain ? null : from), where);
        continue;
      }

      // A function call (or any other node: drawn the same way, named as best we can).
      const callee = a.callee ? laneIdx(a.callee) : callerLane;
      const from = callerLane;
      const name = a.nodeType === NODE_FUNCTION ? `${a.name}()` : a.route || a.name || `node ${a.nodeType}`;
      const fromCaller = (top || !a.caller) && notes.callers?.[a.name] ? L(notes.callers[a.name]) : from;
      // Dashed means "not recorded". A call moved by `callers` onto the lane the recording names
      // as its caller is still a recorded call.
      const recordedCaller = a.caller ? laneIdx(a.caller) : -1;
      const claimed = fromCaller !== from && fromCaller !== recordedCaller;
      const style = claimed || lanes[fromCaller].kind === "client" ? "client" : "call";
      used.add(style);
      const depth = laneDepth.get(callee) || 0;
      let actTop;
      if (fromCaller === callee) {
        ops.push({ k: "self", y, lane: callee, depth: Math.max(depth - 1, 0), text: name, diff });
        actTop = y + 18;
        y += 30;
      } else {
        ops.push({ k: "label", y: y + 14, from: fromCaller, to: callee, text: name, cls: style, mono: true, diff });
        ops.push({ k: "arrow", y: y + 22, from: fromCaller, to: callee, cls: style, dashed: style === "client", diff });
        actTop = y + 22;
        y += ROW;
      }
      const exc = (a.eventIds || []).map((id) => exceptions.get(id)).find(Boolean);
      const raises = a.returnValue?.raisesException || a.stableProperties?.raises_exception;
      laneDepth.set(callee, depth + 1);
      // `under`: right below the call's arrow, before anything the call does.
      for (const nt of notesAt("under", a)) addNote(nt, noteLane(nt, callee), "under");
      if (!isCollapsed(a)) walk(a.children || [], callee);
      for (const nt of notesAt("end", a)) addNote(nt, noteLane(nt, callee), "end");
      laneDepth.set(callee, depth);
      if (raises && fromCaller !== callee) {
        for (const st of stepsAt(a, "raise:")) heading(st.heading);
        const cls = exc?.[0]?.class ? shortClass(exc[0].class) : "an exception";
        ops.push({
          k: "label",
          y: y + 14,
          from: callee,
          to: fromCaller,
          text: `raises ${cls}`,
          cls: "err",
          mono: false,
          bold: true,
        });
        ops.push({ k: "arrow", y: y + 22, from: callee, to: fromCaller, cls: "err" });
        used.add("err");
        const actBottom = y + 22;
        ops.push({ k: "act", lane: callee, depth, y1: actTop, y2: actBottom, cls: "err" });
        y += ROW;
        // A sanitized recording (a gold trace) holds a placeholder such as <v141>, not the message.
        const message = exc?.[0]?.message;
        if (message && !/^<v\d+>$/.test(message) && notes.exceptionMessages !== false) {
          addNote({ kind: "error", lines: wrap(`"${message}"`, 34) }, Math.min(fromCaller, callee), "after");
        }
      } else {
        ops.push({
          k: "act",
          lane: callee,
          depth,
          y1: actTop,
          y2: Math.max(y - 6, actTop + 14),
          cls: raises ? "err" : style === "client" ? "call" : style,
        });
        y += 6;
      }
      for (const nt of notesAt("after", a)) addNote(nt, noteLane(nt, nt.plain ? null : callee), "after");
    }
  };
  walk(actions, rootLane, true);
  if (notes.footer !== false) y += 10;
  const height = y + 30;

  return resolveX({ lanes, ops, height, used, rootQueryLane, notes });
}

function resolveX({ lanes, ops, height, used, notes }) {
  const shown = (o) => (o.diff ? DIFF_PREFIX[o.diff] : "") + o.text;
  const n = lanes.length;
  const gaps = new Array(Math.max(n - 1, 0)).fill(MIN_GAP);
  const need = [];
  for (const o of ops) {
    if (o.k === "label" && o.from !== o.to) {
      const [a, b] = [Math.min(o.from, o.to), Math.max(o.from, o.to)];
      need.push({ a, b, w: textW(shown(o), o.mono) + 36 });
    }
    if (o.k === "self" && o.lane < n - 1) need.push({ a: o.lane, b: o.lane + 1, w: textW(shown(o), true) + 80 });
  }
  need.sort((p, q) => p.b - p.a - (q.b - q.a));
  for (const { a, b, w } of need) {
    const span = gaps.slice(a, b).reduce((s, g) => s + g, 0);
    if (span < w) gaps[b - 1] += Math.ceil(w - span);
  }
  const xs = [MARGIN + HEAD_W / 2];
  for (const g of gaps) xs.push(xs[xs.length - 1] + g);
  let width = xs[n - 1] + HEAD_W / 2 + MARGIN;

  const placed = [];
  const right = (x) => (width = Math.max(width, x + MARGIN));
  for (const o of ops) {
    const p = { ...o };
    if (o.k === "label") {
      const x1 = xs[o.from],
        x2 = xs[o.to];
      p.x = (x1 + x2) / 2;
      p.w = textW(shown(o), o.mono);
    } else if (o.k === "arrow") {
      const dir = Math.sign(xs[o.to] - xs[o.from]) || 1;
      p.x1 = xs[o.from] + (o.from === o.to ? 0 : dir * 0);
      p.x2 = xs[o.to] - dir * 7;
      if (o.cls !== "client" && o.cls !== "err" && dir > 0) p.x1 = xs[o.from] + 6;
      if (o.cls === "err") p.x1 = xs[o.from] - 6;
    } else if (o.k === "self") {
      p.x = xs[o.lane] + 6 + o.depth * 6;
      p.tx = p.x + 48;
      p.tw = textW(shown(o), true);
      right(p.tx + p.tw);
    } else if (o.k === "act") {
      p.x = xs[o.lane] - 6 + o.depth * 6;
    } else if (o.k === "note") {
      const w = Math.max(...o.lines.map((l) => textW(l.text, l.mono))) + 24;
      p.w = w;
      p.x = o.inside != null ? xs[o.lane] + 16 + o.inside * 6 : Math.max(MARGIN, xs[o.lane] - HEAD_W / 2);
      right(p.x + w);
    } else if (o.k === "plain") {
      p.w = Math.max(...o.lines.map((l) => textW(l.text, l.mono)));
      const cx = o.align === "span" ? (xs[1] + xs[n - 1]) / 2 : xs[o.lane];
      // Centred text lands on a lifeline when the picture has two lanes, or an even number, or
      // the note is on a lane. With calls open there, it would cross their bars, so it goes
      // beside them, left-aligned, where a box note inside the call goes.
      const near = xs.findIndex((x) => Math.abs(x - cx) < 30);
      const openHere = near >= 0 ? (o.open?.[near] ?? 0) : 0;
      if (openHere > 0) {
        p.anchor = "start";
        p.x = xs[near] + 16 + (openHere - 1) * 6;
        right(p.x + p.w);
      } else {
        p.anchor = "middle";
        p.x = cx;
        right(MARGIN + p.w);
      }
    } else if (o.k === "setup") {
      const start = n > 1 ? xs[1] - HEAD_W / 2 - 20 : MARGIN;
      const w = Math.max(...o.lines.map((l) => textW(l.text, l.mono))) + 24;
      p.x = Math.max(MARGIN, Math.min(start, width - MARGIN - w));
      p.w = Math.max(w, width - MARGIN - p.x);
      right(p.x + w);
    } else if (o.k === "loop") {
      // Clear of the bars of the calls open on this lane, so the "loop xN" label is not under one.
      p.x = xs[o.lane] + Math.max(10, (o.open || 0) * 6 + 6);
    }
    placed.push(p);
  }
  for (const p of placed) {
    if (p.k === "loop") p.w = width - MARGIN - p.x;
    if (p.k === "plain" && p.anchor === "middle") {
      p.x = Math.min(Math.max(p.x, MARGIN + p.w / 2), width - MARGIN - p.w / 2);
    }
  }
  return { lanes, xs, ops: placed, width: Math.ceil(width), height, used };
}

// --- overlap check ----------------------------------------------------------------------------

/** Every text item's box, so a layout bug shows up as a warning rather than a squint. */
export function textBoxes(model) {
  const boxes = [];
  for (const o of model.ops) {
    if (o.k === "label") boxes.push({ what: o.text, x1: o.x - o.w / 2, x2: o.x + o.w / 2, y1: o.y - 11, y2: o.y + 3 });
    if (o.k === "heading")
      boxes.push({ what: o.text, x1: MARGIN, x2: MARGIN + textW(o.text, false) * 0.95, y1: o.y - 11, y2: o.y + 3 });
    if (o.k === "self")
      boxes.push({ what: o.text, x1: o.tx, x2: o.tx + (o.tw ?? textW(o.text, true)), y1: o.y + 4, y2: o.y + 18 });
    if (o.k === "note" || o.k === "setup")
      boxes.push({ what: o.lines[0].text, x1: o.x, x2: o.x + o.w, y1: o.y, y2: o.y + o.h, box: true });
    if (o.k === "plain")
      boxes.push({
        what: o.lines[0].text,
        x1: o.anchor === "start" ? o.x : o.x - o.w / 2,
        x2: o.anchor === "start" ? o.x + o.w : o.x + o.w / 2,
        y1: o.y - 11,
        y2: o.y + (o.lines.length - 1) * NOTE_LINE + 3,
      });
  }
  return boxes;
}

/** Text that falls outside the picture, or has no position at all. */
export function outside(model) {
  return textBoxes(model)
    .filter((b) => !(b.x1 >= 0 && b.x2 <= model.width))
    .map((b) => b.what);
}

/** Headings and notes drawn across the bar of an open call: [text, ...]. */
export function barCrossings(model) {
  const bars = model.ops.filter((o) => o.k === "act").map((o) => ({ x1: o.x, x2: o.x + 12, y1: o.y1, y2: o.y2 }));
  const texts = [];
  for (const o of model.ops) {
    if (o.k === "heading")
      texts.push({ what: o.text, x1: MARGIN, x2: MARGIN + textW(o.text, false) * 0.95, y1: o.y - 11, y2: o.y + 3 });
    if (o.k === "note") texts.push({ what: o.lines[0].text, x1: o.x, x2: o.x + o.w, y1: o.y, y2: o.y + o.h });
  }
  return texts
    .filter((t) => bars.some((b) => t.x1 < b.x2 && b.x1 < t.x2 && t.y1 < b.y2 && b.y1 < t.y2))
    .map((t) => t.what);
}

export function overlaps(model) {
  const b = textBoxes(model);
  const out = [];
  for (let i = 0; i < b.length; i++)
    for (let j = i + 1; j < b.length; j++) {
      const p = b[i],
        q = b[j];
      if (p.x1 < q.x2 && q.x1 < p.x2 && p.y1 < q.y2 && q.y1 < p.y2) out.push([p.what, q.what]);
    }
  return out;
}

// --- drawing ----------------------------------------------------------------------------------

const DIFF_PREFIX = { add: "+ ", del: "− ", chg: "~ ", mov: "↷ " };

function drawSvg(model, notes) {
  const { lanes, xs, ops, width, height } = model;
  const s = [];
  s.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(notes.title || "Sequence diagram")}">`);
  s.push("<defs>");
  for (const c of ["call", "sql", "err", "client", "add", "del", "chg", "mov"])
    s.push(
      `<marker id="m-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="f-${c}"/></marker>`,
    );
  s.push("</defs>");

  // Lane headers and lifelines.
  lanes.forEach((l, i) => {
    const x = xs[i] - HEAD_W / 2;
    const cls = l.kind === "client" ? "head head-client" : "head";
    s.push(`<rect x="${x}" y="10" width="${HEAD_W}" height="${HEAD_H}" rx="7" class="${cls}"/>`);
    const sub = l.sub ?? (l.kind === "client" ? "not in the recording" : null);
    const fit = (text, ch) =>
      String(text).length * ch > HEAD_W - 12 ? ` textLength="${HEAD_W - 12}" lengthAdjust="spacingAndGlyphs"` : "";
    s.push(`<text x="${xs[i]}" y="${sub ? 28 : 35}" class="t-head"${fit(l.name, 7.2)}>${esc(l.name)}</text>`);
    if (sub)
      s.push(
        `<text x="${xs[i]}" y="43" class="t-headsub ${l.kind === "client" ? "c-client" : ""}"${fit(sub, 5.9)}>${esc(sub)}</text>`,
      );
    s.push(`<line x1="${xs[i]}" y1="${10 + HEAD_H}" x2="${xs[i]}" y2="${height - 30}" class="lifeline"/>`);
  });

  // Backgrounds first (loops, setup), then activations, then everything else on top.
  const order = { loop: 0, setup: 0, act: 1 };
  const sorted = [...ops].sort((a, b) => (order[a.k] ?? 2) - (order[b.k] ?? 2));
  for (const o of sorted) {
    const d = o.diff ? ` d-${o.diff}` : "";
    const pre = o.diff ? DIFF_PREFIX[o.diff] : "";
    switch (o.k) {
      case "heading":
        s.push(`<text x="${MARGIN}" y="${o.y}" class="t-step">${esc(o.text)}</text>`);
        break;
      case "setup": {
        s.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="6" class="setup"/>`);
        o.lines.forEach((l, i) =>
          s.push(
            `<text x="${o.x + 12}" y="${o.y + 19 + i * NOTE_LINE}" class="${l.mono ? "mono " : ""}${i === 0 ? "t-muted" : "c-sql"} t-note">${esc(l.text)}</text>`,
          ),
        );
        break;
      }
      case "label": {
        const cls = `t-label ${o.mono ? "mono " : ""}c-${o.cls}${o.bold ? " bold" : ""}${d}`;
        const title = o.title ? `<title>${esc(o.title)}</title>` : "";
        s.push(`<text x="${o.x}" y="${o.y}" text-anchor="middle" class="${cls}">${title}${esc(pre + o.text)}</text>`);
        break;
      }
      case "arrow":
        s.push(
          `<line x1="${o.x1}" y1="${o.y}" x2="${o.x2}" y2="${o.y}" class="s-${o.diff || o.cls}${o.dashed ? " dashed" : ""}${d}" marker-end="url(#m-${o.diff || o.cls})"/>`,
        );
        break;
      case "self":
        s.push(
          `<path d="M${o.x},${o.y + 8} h40 v18 h-34" fill="none" class="s-${o.diff || "call"}" marker-end="url(#m-${o.diff || "call"})"/>`,
        );
        s.push(`<text x="${o.tx}" y="${o.y + 21}" class="t-label mono${d}">${esc(pre + o.text)}</text>`);
        break;
      case "act":
        s.push(`<rect x="${o.x}" y="${o.y1}" width="12" height="${o.y2 - o.y1}" class="act act-${o.cls}"/>`);
        break;
      case "loop":
        s.push(`<rect x="${o.x}" y="${o.y1}" width="${o.w}" height="${o.y2 - o.y1}" rx="6" class="loopbox"/>`);
        s.push(`<text x="${o.x + 8}" y="${o.y1 + 14}" class="t-muted t-note bold">loop ×${esc(o.count)}</text>`);
        break;
      case "note": {
        s.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="7" class="note note-${o.kind}"/>`);
        o.lines.forEach((l, i) =>
          s.push(
            `<text x="${o.x + 12}" y="${o.y + 18 + i * NOTE_LINE}"${l.mono ? ' xml:space="preserve"' : ""} class="t-note c-${o.kind}${l.mono ? " mono" : ""}${l.bold ? " bold" : ""}">${esc(l.text)}</text>`,
          ),
        );
        break;
      }
      case "plain":
        o.lines.forEach((l, i) =>
          s.push(
            `<text x="${o.x}" y="${o.y + i * NOTE_LINE}" text-anchor="${o.anchor || "middle"}" class="t-note bold c-${o.kind}${l.mono ? " mono" : ""}">${esc(l.text)}</text>`,
          ),
        );
        break;
    }
  }
  if (notes.footer !== false) {
    const text = notes.footer || defaultFooter(model);
    s.push(`<text x="${width / 2}" y="${height - 8}" text-anchor="middle" class="t-muted t-small">${esc(text)}</text>`);
  }
  s.push("</svg>");
  return s.join("\n");
}

function defaultFooter(model) {
  const extra = model.lanes.some((l) => l.kind === "client")
    ? " Dashed lanes and boxes are drawn from the source."
    : "";
  return `Calls, SQL and exceptions are from the recording.${extra}`;
}

const LEGEND = [
  ["call", "function call (recorded)"],
  ["sql", "SQL (recorded)"],
  ["err", "exception (recorded)"],
  ["client", "not recorded (from source)"],
  ["loop", "loop"],
  ["add", "added in head"],
  ["del", "removed in head"],
  ["chg", "changed in head"],
  ["mov", "moved in head"],
];

export function renderHtml(model, notes = {}, meta = {}) {
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "page.css"), "utf8");
  const title = notes.title || meta.name || "AppMap sequence diagram";
  const sub =
    notes.subtitle ??
    [
      meta.test ? `AppMap recording of ${meta.test}` : "AppMap recording",
      meta.commit ? `at ${meta.commit.slice(0, 7)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  const legend = LEGEND.filter(([k]) => model.used.has(k))
    .map(([k, label]) => `<span class="lg lg-${k}">${esc(label)}</span>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(notes.pageTitle || "Trace Diagram")}</title>
<style>
${css}
</style>
</head>
<body>
<main style="max-width:${Math.max(model.width + 60, 720)}px">
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(sub)}</p>
  <div class="card diagram">
${drawSvg(model, notes)}
  <div class="legend">${legend}</div>
  </div>
</main>
</body>
</html>
`;
}

// --- CLI --------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--changed-only") a["changed-only"] = true;
    else if (k === "--outline") a.outline = true;
    else if (k === "--png") a.png = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    else if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const USAGE = `usage: render.mjs --appmap FILE.appmap.json [--sequence FILE.sequence.json]
                  [--base-appmap FILE.appmap.json --head-appmap FILE.appmap.json]
                  [--notes notes.json] [--out page.html] [--png [page.png]]
                  [--playwright DIR] [--expand ID[,ID]] [--cli PATH] [--changed-only]
                  [--outline [--depth N]]

Draws one AppMap recording as a sequence diagram on a standalone HTML page.
--appmap gives exception messages and runs the CLI for the sequence JSON;
--expand splits a package lane into its files (e.g. package:server);
--sequence uses an existing sequence JSON (also a diff/*.diff.sequence.json
from appmap-review, whose added/removed/changed actions are coloured;
--changed-only keeps just those and the calls above them).
--base-appmap and --head-appmap compare two recordings of one test here, so
--expand applies to the comparison too (a --sequence diff keeps the lanes it
was made with).
--outline prints the trace as indented text and draws nothing: each call, the
lane it lands on, and its number for an anchor (name#n). --depth N stops N
levels down.
--png also writes a picture of the page. It needs Playwright, from the current
project or from the one named by --playwright DIR.
Prints the output path, and a warning for every pair of labels that overlap
and every label that falls outside the picture.`;

/** Screenshot the page's main element. Playwright is resolved from the working directory. */
async function writePng(htmlPath, pngPath, from = process.cwd()) {
  const { createRequire } = await import("node:module");
  let chromium;
  try {
    ({ chromium } = createRequire(path.join(path.resolve(from), "x.js"))("playwright"));
  } catch {
    throw new Error(
      `--png needs Playwright, and ${path.resolve(from)} does not have it. Pass --playwright DIR with a project that does, or npm i -D playwright here.`,
    );
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1.5 });
    await page.goto(`file://${path.resolve(htmlPath)}`);
    await page.locator("main").screenshot({ path: pngPath });
  } finally {
    await browser.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pair = args["base-appmap"] || args["head-appmap"];
  if (pair && !(args["base-appmap"] && args["head-appmap"])) {
    console.error("error: a comparison needs both --base-appmap and --head-appmap");
    return 2;
  }
  if (args.help || (!args.appmap && !args.sequence && !pair)) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  const notes = args.notes ? JSON.parse(fs.readFileSync(args.notes, "utf8")) : {};
  const expand = [...(notes.expand || []), ...(args.expand ? args.expand.split(",") : [])];
  // Exception messages come from the head recording when two are compared.
  const appmapFile = args.appmap || args["head-appmap"];
  const appmap = appmapFile ? JSON.parse(fs.readFileSync(appmapFile, "utf8")) : null;
  const cli = args.cli || findCli();
  if (args.sequence && expand.length) {
    console.error(
      "warning: --expand does not change a --sequence file's lanes; for a comparison with one lane per file, pass --base-appmap and --head-appmap",
    );
  }
  const seq = args.sequence
    ? JSON.parse(fs.readFileSync(args.sequence, "utf8"))
    : pair
      ? diffFromAppmaps(args["base-appmap"], args["head-appmap"], cli, expand)
      : sequenceFromAppmap(args.appmap, cli, expand);
  if (args["changed-only"]) notes.changedOnly = true;
  if (args.outline) {
    const depth = args.depth === undefined ? Infinity : Number(args.depth);
    console.log(outline(seq, { notes, depth }).join("\n"));
    return 0;
  }
  const model = layout(seq, { notes, exceptions: exceptionsByCall(appmap) });
  const meta = {
    name: appmap?.metadata?.name,
    test: appmap?.metadata?.source_location?.split(":")[0] ? appmap?.metadata?.name?.replace(/ /g, "_") : null,
    commit: appmap?.metadata?.git?.commit,
  };
  if (notes.test) meta.test = notes.test;
  const base = (args.appmap || args.sequence || args["head-appmap"]).replace(/(\.diff)?(\.sequence)?(\.appmap)?\.json$/, "");
  const out = args.out || `${base}.trace.html`;
  fs.writeFileSync(out, renderHtml(model, notes, meta));
  console.log(out);
  const bad = overlaps(model);
  for (const [p, q] of bad) console.error(`warning: labels overlap: "${p}" and "${q}"`);
  for (const t of outside(model)) console.error(`warning: outside the picture: "${t}"`);
  for (const t of barCrossings(model)) console.error(`warning: drawn across a call bar: "${t}"`);
  if (notes.cards?.length) {
    console.error("warning: `cards` in the notes are no longer drawn: put that text in the review report or your reply");
  }
  if (args.png !== undefined) {
    const png = args.png || out.replace(/\.html$/, "") + ".png";
    try {
      await writePng(out, png, args.playwright);
    } catch (error) {
      // The page is written; only the picture is missing.
      console.error(`error: ${error.message}`);
      return 1;
    }
    console.log(png);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
