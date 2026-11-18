---
name: appmap-pr-movie
description: Make a one-minute summary of a pull request in three forms (a narrated video, a podcast clip, and the written script) from a browser walkthrough and an AppMap diagram of what the change did at runtime. Use when asked for a PR movie, a video or audio summary of a pull request, or "what does this change do" for someone who would rather watch or listen than read the diff. Runs by hand or in CI through getappmap/review-action/movie.
---

# Skill: AppMap PR movie

Every pull request gets a one-minute summary that someone can watch or listen to
before anyone reads the diff. Teams already ask authors for a Loom of a feature.
This one makes itself, on every push, from what the code actually did.

One script feeds three forms:

| Form | For | Made by |
| --- | --- | --- |
| Narrated video | people who watch | Showcase Studio: screenshots, the diagram, a voice reading the script |
| Podcast clip | people who listen | the same voice track, audio only |
| Written script | people who read | the same words, as text |

The story is always three parts, in this order:

1. **What the user sees.** A browser walks the path the change touches and
   screenshots each step.
2. **What the code did.** One AppMap sequence diagram of that request, base
   against head, with the new or changed calls marked.
3. **Three risks, one sentence each.** What an architect, a performance or
   DevOps engineer, and a security reviewer would each say about this change.
   Many people opening AI-written pull requests have none of those three on
   their team. The movie brings all three.
4. **The sentence.** One line saying what changed, in words a user would use.

The reviewer attaches nothing and runs nothing.

## Output contract

Write everything to one folder, `.appmap/movie/` unless told otherwise. The
publish step (`getappmap/review-action/movie`, or `assets/comment.mjs` by hand)
reads only this folder.

| File | What it is |
| --- | --- |
| `movie.json` | `{ "sentence", "title", "facts": [{"label","value"}], "risks": [{"lens": "Architecture" or "Performance" or "Security", "level": "high" or "medium" or "low" or "none", "says", "tradeoff", "evidence"}], "diagram": "automatic" or "hand-drawn", "skipped": [paths not covered] }` |
| `movie.mp4` | The narrated video, 4:3 for desktops (`video-43-draft`) |
| `movie-phone.mp4` | The same video, 9:16 for phones (`video-draft`) |
| `podcast.m4a` | The voice track, audio only |
| `script.txt` | The narration as plain text |
| `poster.png` | The diagram, used as the comment's picture and the podcast's still frame |
| `results.json` | The browser run's raw facts |

If a form cannot be made (no app to drive, no voice configured), write the
others and say which is missing and why in `movie.json` as `"missing"`. Never
fake a screen, a count, a diagram or a voice.

## Inputs

- The base and head revisions. No base given: use the merge base.
- An app that runs locally or in CI, with a test sign-in.
- Showcase Studio. With MCP: `studio_start`, `edit_showcase`, `validate`,
  `screenshot_slide`, `build_voiceover`, `export`. Without MCP (CI): a
  showcase-studio checkout, and
  `npm --prefix "$SHOWCASE_STUDIO" run dev -- --library <dir> --export <kind>:<id>`.
- The AppMap CLI and language agent (**appmap-setup**, **appmap-record**).
- An AWS profile for the voice (AWS Polly), named as `aws_profile` in the
  library's `showcase_settings.yaml`. A person picks it. Never pick one.

## When there is no user path

Docs, CI, tooling, or a refactor with no behavior change: skip steps 2 and 3,
make the podcast clip and the script only, and say so in the first line:
"This change has no screen a user would see." If AppMap shows no change in the
recorded requests, the diagram scene says "No change in recorded behavior".

## Steps

### 1. Pick the path

From the diff and the PR description, write down:

- **Who** the change affects: the role, permission or setting most likely to
  see a difference (an admin outside a group, a logged-out visitor).
- **Where**: the URLs or screens the change touches.
- **The control**: an old path that should give the same answer (the JSON view
  of the same page, the page before the change).

One person, one path. If the change touches several unrelated paths, cover the
riskiest and list the others in `movie.json` `skipped`.

### 2. Seed the case

An idempotent seed script that creates exactly the people and data the path
needs, and prints the IDs and URLs the browser needs. Test data only.

### 3. Drive the browser

A Playwright script that:

- signs in as the person from step 1 with the app's test sign-in;
- visits each screen on the path and the control;
- waits for a real element, not network idle;
- screenshots each step at 430 by 932, scale 3 (phone size, fits a portrait
  frame);
- hides developer overlays (profilers, debug bars);
- writes `results.json`: status codes, counts, expected text present or not.

Run it twice. If the runs disagree, fix the flake before going on.

### 4. Record what the code did

Record the same requests on base and head from the same checkout path (see
**appmap-analyze**, Phase 3). Then draw:

- If the AppMap trace-diagram skill is installed, use it.
- Otherwise: `appmap sequence-diagram --format json` on each recording, then
  `appmap sequence-diagram-diff <base> <head>`, and render the request on the
  path. Set `"diagram": "hand-drawn"` in `movie.json` if you laid it out
  yourself.

Keep only the request on the path. Mark what is new. Name lanes as a reader
would (Browser, TopicView, Renderer, Database). Save as `poster.png`,
1080 by 1920.

Check the diagram against `results.json`. If they disagree, find out which is
wrong before going on.

### 5. The three risks

For each lens, write one finding in plain words, the tradeoff behind it, and the
evidence. Many readers are vibe coders: name the risk by what could go wrong for
users or for the bill, then name the mechanism.

| Lens | Look for, in the recordings first and the diff second | Query |
| --- | --- | --- |
| **Architecture** | The same decision made in two places (two permission checks, two copies of a rule); a new dependency between parts that did not talk before; logic added to a layer that should not own it; work that should be a background job running inside a request | compare the base and head trees: which classes are new callers of which |
| **Performance and operations** | New SQL or HTTP calls per request, calls inside a loop (N+1), a lost cache, a missing timeout, work that grows with data size, new cost per request (paid APIs) | `appmap query hotspots`; count SQL and HTTP events per request, base against head |
| **Security** | A permission check removed, moved or duplicated; data shown to someone who should not see it, or hidden from someone who should; a secret or personal data in a log, URL or HTTP call; input reaching SQL or HTML unescaped | `appmap query find calls` on the guard functions; the recorded SQL and HTTP |

Rules:

- Each finding is one sentence, then one sentence of tradeoff: what the change
  gains, and what it costs. "The renderer checks group membership itself, which
  keeps it independent of the page, but it now disagrees with the page about
  admins."
- `level` is how bad it is for users if it ships: high, medium, low, or none.
  "none" is a valid result; say "No new risk found for <lens>" and what you
  checked.
- Evidence names the recording and the call, or says "source only".
- Never invent a risk to fill a lens. An empty lens with its check named is
  better than a guess.

### 6. Write the script

The script is what the voice reads; in Showcase Studio each scene's captions
are its spoken lines. Write it before building slides.

- About 180 words, about 75 seconds. The risks scene gets about 50 of them.
- One to three short sentences per scene: what is on screen, then what it means.
- Write for the ear. A listener with no picture must follow it: "the topic page
  shows two posts", never "as you can see here".
- Numbers only from `results.json`.
- No jargon a user would not know. When the diagram scene must name code, say
  what it does first: "a new check asks whether Alex is in the reviewers group".
- Spell it as it should sound: "pull request forty-three eight forty-three".
- The last scene's line is the sentence.

### 7. The sentence

What changed for the person using the app: the person, the screen, the
difference. "The new Markdown view hides whispers from an admin outside the
whisper group, and the topic page shows them." If nothing visible changed:
"No visible change on this path." That is a result too.

### 8. Cut it in Showcase Studio

Showcase `pr-<number>` in the movie library, screenshots and diagram under
`assets/`. Use new file names on every re-cut (`step1-v2.png`): the studio
caches assets by name.

| Scene | Theme | Content |
| --- | --- | --- |
| intro | statement | The PR title in plain words, and its number |
| one per browser step | feature, `media.frame: phone` | The screenshot |
| control | feature, `media.frame: phone` | The control screen |
| underneath | feature | The diagram |
| risks | statement | Three short lines: Architecture, Performance, Security, each with its level |
| outro | statement | The sentence |

1. Put the script into each scene's captions.
2. Set `meta.voiceover` (`voice: Matthew`, `engine: generative`). The studio
   builds the voice from the captions and times every scene to it. Never set
   `durationMs` on a voiced showcase, and never call Polly or ffmpeg yourself
   for the voice.
3. `validate`, then `screenshot_slide` every scene and look: each screenshot
   fills its frame, nothing that matters is cropped.
4. Listen once. Respell any caption the voice says wrong.

### 9. Export the three forms

1. `export` kind `video-43-draft` → `movie.mp4` (wide, for desktops), and kind
   `video-draft` → `movie-phone.mp4` (tall 9:16, for phones). Full quality only
   when asked.
2. The voice track `assets/<track>.m4a` → `podcast.m4a`.
3. `export` kind `script` → `script.txt`.
4. Copy the diagram to `poster.png`, write `movie.json`.

### 10. Publish

In CI, `getappmap/review-action/movie` uploads the files and posts one sticky
comment. By hand, run `node assets/comment.mjs .appmap/movie <video-url>
<podcast-url> <poster-url>` to print the comment body, show it to the person,
and post only on their yes. `assets/podcast.sh` turns the podcast into an MP4
with the diagram as a still frame, so GitHub plays it inline.

## Done

- One script of about 180 words, one voice.
- A video and a podcast clip of about 75 seconds, and the script, all saying the
  same thing.
- One finding, or "none" with its check named, for each of the three lenses.
- `results.json`, the diagram, the screenshots and the script agree.
- One comment on the PR with the sentence and Watch, Listen, Read.

## Never

- Show a screen you did not capture or say a number you did not measure.
- Use a production account or real user data.
- Choose the AWS account that pays for the voice.
- Approve, merge or request changes. The movie informs; the reviewer decides.
- Present a hand-drawn diagram as automatic.

## Worked example: Discourse pull request 43843

- Path: an admin outside `whispers_allowed_groups` opens one topic three ways:
  the page, the JSON, the new `.md` view.
- Facts: page 2 posts, JSON 2 posts, Markdown 1 post, the whisper's `.md` link
  404.
- Diagram: `Roleable#whisperer?` returns true for admins, so 2 posts load; the
  new `MarkdownEndpoint::TopicRenderer#can_see_whispers?` checks group
  membership, finds no row, drops the whisper.
- Architecture (medium): one permission, two rules. The renderer decides who
  sees whispers itself instead of asking the same place the page asks. That
  keeps the renderer simple to read, but the two rules already disagree about
  admins, and the next change to one will not reach the other.
- Performance (low): one extra indexed query per Markdown request
  (`group_users` lookup). Cheap, but it runs on every request an AI crawler
  makes, now that the view is on by default.
- Security (low): it fails closed. Admins see less, not more, so nothing
  private leaks. The risk is trust: staff who rely on the Markdown view miss
  whispers they are meant to see.
- Outro: "So the new Markdown view hides whispers from an admin outside the
  whisper group, and the topic page shows them. Same topic, same admin, two
  answers."
