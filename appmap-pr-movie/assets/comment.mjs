#!/usr/bin/env node
// Build the PR comment for a PR movie from the skill's output folder.
//
//   node comment.mjs <movie-dir> <video-url> <podcast-url> <poster-url>
//
// Prints Markdown to stdout. Any URL may be "" when that form was not made;
// its link is then left out and the reason from movie.json "missing" shown.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- appmap-pr-movie -->";

export function buildComment({ movie, script, videoUrl, podcastUrl, posterUrl }) {
  const lines = [MARKER, ""];
  lines.push(`### 🎬 ${movie.title || "What this pull request does"}`, "");
  if (movie.sentence) lines.push(`**${movie.sentence}**`, "");
  if (posterUrl) {
    const img = `<img src="${posterUrl}" alt="What the code did" width="320">`;
    lines.push(videoUrl ? `<a href="${videoUrl}">${img}</a>` : img, "");
  }
  const links = [];
  if (videoUrl) links.push(`▶️ [Watch](${videoUrl})`);
  if (podcastUrl) links.push(`🎧 [Listen](${podcastUrl})`);
  if (script) links.push("📄 Read (below)");
  if (links.length) lines.push(links.join(" · "), "");

  const facts = Array.isArray(movie.facts) ? movie.facts : [];
  if (facts.length) {
    lines.push(`| ${facts.map((f) => cell(f.label)).join(" | ")} |`);
    lines.push(`| ${facts.map(() => "---").join(" | ")} |`);
    lines.push(`| ${facts.map((f) => cell(f.value)).join(" | ")} |`, "");
  }
  const risks = Array.isArray(movie.risks) ? movie.risks : [];
  if (risks.length) {
    lines.push("| Lens | Level | What it means | Tradeoff |", "| --- | --- | --- | --- |");
    for (const r of risks) {
      lines.push(`| ${cell(r.lens)} | ${cell(LEVEL[r.level] || r.level)} | ${cell(r.says)} | ${cell(r.tradeoff)} |`);
    }
    lines.push("");
  }
  if (script) {
    lines.push("<details><summary>Read the script</summary>", "", script.trim(), "", "</details>", "");
  }
  const notes = [];
  if (movie.diagram === "hand-drawn") notes.push("The diagram was laid out by hand from the AppMap recordings.");
  for (const [form, why] of Object.entries(movie.missing || {})) notes.push(`No ${form}: ${why}`);
  if (Array.isArray(movie.skipped) && movie.skipped.length) notes.push(`Not covered: ${movie.skipped.join("; ")}.`);
  if (notes.length) lines.push(...notes.map((n) => `<sub>${n}</sub>`), "");
  lines.push("<sub>Made by the appmap-pr-movie skill from a browser run and AppMap recordings of this change.</sub>");
  return lines.join("\n") + "\n";
}

const LEVEL = { high: "🔴 high", medium: "🟠 medium", low: "🟡 low", none: "🟢 none" };

function cell(v) {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, videoUrl = "", podcastUrl = "", posterUrl = ""] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: comment.mjs <movie-dir> <video-url> <podcast-url> <poster-url>");
    process.exit(2);
  }
  const movie = JSON.parse(readFileSync(path.join(dir, "movie.json"), "utf8"));
  const scriptPath = path.join(dir, "script.txt");
  const script = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";
  process.stdout.write(buildComment({ movie, script, videoUrl, podcastUrl, posterUrl }));
}
