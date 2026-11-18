import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComment, MARKER } from "./comment.mjs";

const movie = {
  title: "Markdown views of topics",
  sentence: "The new Markdown view hides whispers from an admin outside the whisper group.",
  facts: [
    { label: "Page", value: "2 posts" },
    { label: "Markdown", value: "1 post" },
  ],
  diagram: "hand-drawn",
};

test("starts with the sticky marker and leads with the sentence", () => {
  const out = buildComment({ movie, script: "Line one.", videoUrl: "v", podcastUrl: "p", posterUrl: "i" });
  assert.ok(out.startsWith(MARKER));
  assert.match(out, /\*\*The new Markdown view hides whispers/);
  assert.match(out, /\[Watch\]\(v\)/);
  assert.match(out, /\[Listen\]\(p\)/);
  assert.match(out, /<details><summary>Read the script/);
  assert.match(out, /\| Page \| Markdown \|/);
  assert.match(out, /laid out by hand/);
});

test("leaves out forms that were not made and says why", () => {
  const out = buildComment({
    movie: { ...movie, diagram: "automatic", missing: { video: "no screen a user would see" } },
    script: "",
    videoUrl: "",
    podcastUrl: "p",
    posterUrl: "",
  });
  assert.doesNotMatch(out, /Watch/);
  assert.match(out, /No video: no screen a user would see/);
  assert.doesNotMatch(out, /laid out by hand/);
});

test("lists the three risks with their level and tradeoff", () => {
  const out = buildComment({
    movie: {
      risks: [
        { lens: "Architecture", level: "medium", says: "One permission, two rules.", tradeoff: "Simpler renderer, rules drift." },
        { lens: "Security", level: "none", says: "No new risk found.", tradeoff: "" },
      ],
    },
    script: "",
  });
  assert.match(out, /\| Architecture \| 🟠 medium \| One permission, two rules\. \| Simpler renderer, rules drift\. \|/);
  assert.match(out, /\| Security \| 🟢 none \|/);
});

test("escapes pipes in facts so the table holds", () => {
  const out = buildComment({ movie: { facts: [{ label: "a|b", value: "c" }] }, script: "" });
  assert.match(out, /a\\\|b/);
});
