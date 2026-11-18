#!/usr/bin/env node
// changed-code.mjs — which code that a trace ran changed between two revisions?
//
//   node changed-code.mjs --appmap <file.appmap.json> --base <rev> [--head <rev>]
//                         [--side head|base] [--repo DIR] [--json]
//
// The trace sets the scope, so the size of the whole diff never matters: git is asked
// only for the names of the changed files, and then for the changes to the files this
// trace ran. Prints, per such file, the functions the trace ran in it and the changed
// line ranges, each with the nearest function the trace ran above it. Use it to choose
// what a diagram emphasises, then read the code itself with `git show <rev>:<file>`.
//
// --head   the newer revision; left out, the working tree is compared with --base.
// --side   which revision the trace was recorded on (default head). A trace recorded on
//          base is matched against the old file names and the old line numbers.
// --repo   the repository (default: the one the current directory is in).
//
// No npm dependencies. Needs git.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node changed-code.mjs --appmap <file.appmap.json> --base <rev> [--head <rev>]
                             [--side head|base] [--repo DIR] [--json]`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--json") a.json = true;
    else if (k.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** A path as the repository names it, or null for code outside it (a library, the runtime). */
function repoPath(repo, p) {
  if (!p) return null;
  const rel = path.isAbsolute(p) ? path.relative(repo, p) : path.normalize(p);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/");
}

/** The functions a trace ran, by file: Map<file, [{name, line}]>, lines ascending. */
export function functionsByFile(appmap, repo = "") {
  const seen = new Map();
  const add = (file, name, line) => {
    const f = repoPath(repo, file);
    if (!f || !name) return;
    if (!seen.has(f)) seen.set(f, new Map());
    // One function per line: the class map and the call events can spell its owner differently.
    const key = line != null ? `:${line}` : name;
    if (!seen.get(f).has(key)) seen.get(f).set(key, { name, line: line ?? null });
  };
  // The class map lists every function the recording saw, with "path:line".
  const walk = (nodes, owner) => {
    for (const n of nodes || []) {
      if (n.type === "function" && n.location) {
        const m = /^(.*?):(\d+)$/.exec(n.location);
        add(m ? m[1] : n.location, owner ? `${owner}${n.static ? "." : "#"}${n.name}` : n.name, m ? Number(m[2]) : null);
      }
      walk(n.children, n.type === "class" ? n.name : owner);
    }
  };
  walk(appmap.classMap, "");
  // Call events carry the same facts; some reduced recordings keep only these.
  for (const e of appmap.events || []) {
    if (e.event !== "call" || !e.path) continue;
    const owner = (e.defined_class || "").split(/[.:]+/).pop();
    add(e.path, owner ? `${owner}${e.static ? "." : "#"}${e.method_id}` : e.method_id, e.lineno);
  }
  const out = new Map();
  for (const [f, fns] of seen) {
    out.set(f, [...fns.values()].sort((p, q) => (p.line ?? 0) - (q.line ?? 0)));
  }
  return out;
}

/** The functions the trace ran in the file git calls `gitPath`. A recorder run from a
 *  subdirectory (server/) names files from there (app/models.py), so a trace path also
 *  matches when it is the end of the git path. */
export function ranIn(ran, gitPath) {
  if (ran.has(gitPath)) return ran.get(gitPath);
  for (const [tracePath, fns] of ran) if (gitPath.endsWith(`/${tracePath}`)) return fns;
  return null;
}

/** `git diff --name-status -M` as [{status, from, to}] (from === to unless renamed). */
export function parseNameStatus(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split("\t");
    rows.push({ status: status[0], from: a, to: b || a });
  }
  return rows;
}

/** The hunk headers of a `git diff -U0`: [{base: [start, end], head: [start, end], heading}]. */
export function parseHunks(text) {
  const hunks = [];
  for (const line of text.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (!m) continue;
    const range = (start, count) => {
      const n = count === undefined ? 1 : Number(count);
      return n === 0 ? null : [Number(start), Number(start) + n - 1];
    };
    hunks.push({ base: range(m[1], m[2]), head: range(m[3], m[4]), heading: m[5].trim() });
  }
  return hunks;
}

/** The last function the trace ran that starts at or above `line`, or null. */
function functionAbove(fns, line) {
  let found = null;
  for (const f of fns) if (f.line != null && f.line <= line) found = f;
  return found;
}

export function changedCode({ appmap, repo, base, head, side = "head" }) {
  const revs = head ? [base, head] : [base];
  const ran = functionsByFile(appmap, repo);
  const changed = parseNameStatus(git(repo, ["diff", "--name-status", "-M", ...revs]));
  const files = [];
  for (const row of changed) {
    const mine = side === "base" ? row.from : row.to;
    // A file added on head was never run by a base trace, and one deleted on head never by a head trace.
    if ((side === "base" && row.status === "A") || (side === "head" && row.status === "D")) continue;
    const fns = ranIn(ran, mine);
    if (!fns) continue;
    const paths = row.from === row.to ? [row.to] : [row.from, row.to];
    const hunks = parseHunks(git(repo, ["diff", "-U0", "-M", ...revs, "--", ...paths])).map((h) => {
      const lines = h[side] || h[side === "head" ? "base" : "head"];
      return { lines: h[side], otherSide: h[side] ? null : lines, heading: h.heading, after: functionAbove(fns, lines[0]) };
    });
    files.push({ status: row.status, file: mine, from: row.from, to: row.to, functions: fns, hunks });
  }
  return { base, head: head || "working tree", side, ranFiles: ran.size, changedFiles: changed.length, files };
}

function report(r) {
  const out = [];
  out.push(`${r.files.length} of the ${r.changedFiles} files changed between ${r.base} and ${r.head} are run by this trace.`);
  if (!r.files.length) {
    out.push("This trace runs no code that changed. If its behaviour differs, the cause is outside the code it runs.");
    return out.join("\n");
  }
  const at = (f) => (f.line == null ? f.name : `${f.name} :${f.line}`);
  for (const f of r.files) {
    out.push("");
    out.push(`${f.status} ${f.file}${f.from !== f.to ? `  (renamed from ${f.from})` : ""}`);
    out.push(`  the trace ran: ${f.functions.map(at).join(", ")}`);
    for (const h of f.hunks) {
      const where = h.lines
        ? h.lines[1] !== h.lines[0]
          ? `lines ${h.lines[0]}-${h.lines[1]}`
          : `line ${h.lines[0]}`
        : `removed here (${r.side === "head" ? "base" : "head"} lines ${h.otherSide[0]}-${h.otherSide[1]})`;
      const after = h.after ? `  after ${at(h.after)}` : "  above every function the trace ran";
      out.push(`  changed: ${where}${after}${h.heading ? `  [${h.heading}]` : ""}`);
    }
    const rev = r.side === "base" ? r.base : r.head === "working tree" ? null : r.head;
    out.push(`  read it: ${rev ? `git show ${rev}:${f.file}` : f.file}`);
  }
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.appmap || !args.base) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  if (args.side && args.side !== "head" && args.side !== "base") {
    console.error("--side must be head or base");
    return 2;
  }
  const repo = git(args.repo || process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const appmap = JSON.parse(fs.readFileSync(args.appmap, "utf8"));
  const result = changedCode({ appmap, repo, base: args.base, head: args.head, side: args.side || "head" });
  if (result.ranFiles === 0) {
    console.error("warning: this recording names no source files, so nothing can be matched");
  }
  console.log(args.json ? JSON.stringify(result, null, 2) : report(result));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main();
}
