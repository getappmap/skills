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

The movie reviews the whole change first, the way a good reviewer would, and
only then shows what it found. Never open on the defect. The story is always
in this order:

1. **What the change adds.** The browser uses the new behavior as intended,
   for a user it is meant for, and screenshots each step.
2. **How it's built.** One wide diagram of the parts the change adds or
   touches, with the riskiest part marked.
3. **Three reads, one sentence each.** What an architect, a performance or
   DevOps engineer, and a security reviewer would each say, with the tradeoff.
   Many people opening AI-written pull requests have none of those three on
   their team. The movie brings all three.
4. **What it surfaced.** Any defect, shown in the browser for the user it
   hurts. Then where the data comes from (which tests ran, before and after,
   against real services), then the AppMap trace of that request, one step per
   slide, so a viewer can follow each call, then the review's verdict and the
   fix. When nothing surfaced, say what was checked.
5. **The sentence.** One line saying what changed, in words a user would use.
   No slogan or call to action after it.

The reviewer attaches nothing and runs nothing.

## Where it runs

The movie must not depend on one person's laptop. Showcase Studio is a Node
app: React slides, Chrome driven by Playwright for frames, ffmpeg to encode,
and AWS Polly for the voice. All of it runs headless.

| Where | When | How |
| --- | --- | --- |
| CI, on every push | The default. Every pull request, no laptop involved | `getappmap/review-action/movie` (GitHub Actions). A Bitbucket Pipelines step runs the same scripts. Installs Showcase Studio, runs this skill with Claude Code headless, exports, uploads, comments |
| A hosted render service | Later, so a team installs nothing but the GitHub or Bitbucket app | The CI step sends the folder from the output contract (script, screenshots, diagrams) to the service and gets back links. Same export command inside a container |
| A developer's machine | Optional preview before pushing | Showcase Studio through its MCP tools |

The skill's steps and the output contract are the same in all three. Only
the render and upload step moves.

## Output contract

Write everything to one folder, `.appmap/movie/` unless told otherwise. The
publish step (`getappmap/review-action/movie`, or `assets/comment.mjs` by hand)
reads only this folder.

| File | What it is |
| --- | --- |
| `movie.json` | `{ "sentence", "title", "facts": [{"label","value"}], "risks": [{"lens": "Architecture" or "Performance" or "Security", "level": "high" or "medium" or "low" or "none", "says", "tradeoff", "evidence"}], "diagram": "automatic" or "hand-drawn", "skipped": [paths not covered] }` |
| `movie.mp4` | The narrated video, 9:16, full screen on phones (`video-draft`) |
| `movie-wide.mp4` | Optional: the same video, 4:3 for desktops (`video-43-draft`) |
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

## Real dependencies, never mocks

The movie is only worth watching if it shows what the code really does, so
everything it records runs against real services: the app's real database,
cache, queue and any service it calls. A recording of a test where SQL and
HTTP are mocked is a call stack you could read in the source. It shows no
queries, no calls out, and no proof.

- Start what the app needs before step 2. Use the project's own
  `docker-compose.yml` or dev container when it has one. Otherwise start the
  official image of each service (`postgres`, `clickhouse/clickhouse-server`,
  `redis`, and so on) and point the app at it with test settings.
- A service you cannot run locally (a paid API, a partner system) gets a fake
  built from the project's own code that speaks the real protocol over a real
  socket (see **appmap-analyze**, Phase 2), never an in-process mock of the
  client.
- Check the recording before you use it: it must contain at least one SQL or
  HTTP event for the path. Zero means a mock, or a hook that is not on (see
  **appmap-analyze**, Phase 0). Fix that before going on.
- If a dependency cannot be started, make the movie from what you can run and
  name what is missing in `movie.json` under `"missing"`. Never present a
  mocked run as the real one.
- Some drivers are not recorded yet (for example ClickHouse from Python,
  getappmap/appmap-python#392). The browser run and HTTP view still work; say
  in `movie.json` which queries the diagram cannot show.

## When there is no user path

Docs, CI, tooling, or a refactor with no behavior change: skip steps 2 and 3,
make the podcast clip and the script only, and say so in the first line:
"This change has no screen a user would see." If AppMap shows no change in the
recorded requests, the diagram scene says "No change in recorded behavior".

## Steps

### 0. Review the branch first

The movie illustrates a review; it does not replace one. Before anything else,
run the branch review and keep its report beside the movie:

- **appmap-review** when the repository has gold traces, or when you have one
  recording of the same scenario on each side.
- **appmap-analyze** when it has neither: it writes the scenario tests the
  suite is missing, records base and head, and reports findings.

Every finding in that report becomes part of the movie: the three reads (step
5) draw from it, each defect gets its own browser steps and trace steps, and
the diagram skill (step 4) draws one picture per finding. A finding the movie
cannot show in a browser still gets a diagram slide and a line in the script.
The movie never states a finding the review did not make.

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

- Use the AppMap trace-diagram skill when it is installed. It draws the
  integrated diagram of what changed and one diagram per finding from step 0;
  use those as the movie's design and trace slides.
- Otherwise: `appmap sequence-diagram --format json` on each recording, then
  `appmap sequence-diagram-diff <base> <head>`, and render the request on the
  path. Set `"diagram": "hand-drawn"` in `movie.json` if you laid it out
  yourself.

Keep only the request on the path. Mark what is new. Name lanes as a reader
would (Browser, TopicView, Renderer, Database). Save as `poster.png`,
1080 by 2346.

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

Write for a viewer who knows nothing: a new developer on the project, or
someone who has never seen the app. Four rules, every time:

1. **Simplify.** One idea per sentence. Short words.
2. **No jargon.** Say what a thing does, in everyday words, before or instead
   of its name: "plain text" not "Markdown endpoint", "staff notes" not
   "whispers" after the first mention, "the forum's usual rule" not
   "`Roleable#whisperer?`". Code names go small on the slide, never in the
   voice.
3. **Start from the beginning.** First say what the app is and who uses it,
   then what the change adds, then how it works, then what went wrong.
4. **Assume no foreknowledge.** Introduce every person, screen and term the
   first time it appears: "Alex runs the forum as an administrator".

Then:

- Under three minutes. Each caption is one short sentence, about 80
  characters or fewer, so the subtitle fits in two lines on a phone.
- Write for the ear. A listener with no picture must follow it: "the topic page
  shows two posts", never "as you can see here".
- Numbers only from `results.json`.
- Say the dates: when the pull request merged, and, for any defect, whether it
  is still in the code as of the day the movie was made.
- Spell it for the voice in the voice input only ("pull request forty-three
  eight forty-three", "App Map"); the on-screen caption keeps the normal
  spelling.
- The last scene's line is the sentence, unless the "how this was made"
  ending follows it.

#### The standard script

Every movie follows this script, scene by scene. Fill the brackets from the
review and `results.json`; keep the shape. Each line is one caption. Leave out
a scene only when its row says so.

| # | Scene | Theme | Picture | Lines (one caption each) |
| --- | --- | --- | --- | --- |
| 1 | intro | statement | Title: "[Project] pull request [number]". Support: "Merged [date] · [Still live / Fixed] as of [today]" | "[Project] is [what the app is, in one plain sentence]." · "[Who uses it and the one term the viewer needs, introduced]." · "This change adds [the new behavior, in a user's words]." · "It was merged on [date]." |
| 2 | one per intended-use step | footage | The screenshot, full screen | "Here is [the screen], [what is new on it]." · "[How a person gets there]." |
| 3 | the right user, working | footage | The screenshot for a user the change is meant for | "Here is [the screen] for [person]." · "[Person] is [their role]. [They see X]. That's correct." |
| 4 | other ways in (skip if none) | statement | Title: what else the change opens up | One or two lines on any other route to the same behavior |
| 5 | how it's built | footage | The portrait design diagram | "Here is how it's built. [Step one] and [the decision it makes]." · "[The usual parts that run]. Then new code [does the new thing]." · "[The riskiest part] does one thing differently. [What it does]." |
| 6 | three quick reviews | statement | Title: "Three quick reviews". Support: "Design · Speed · Security" | "Design: [one sentence, with its tradeoff]." · "Speed: [one sentence, with its cost]." · "Security: [one sentence: what leaks or does not, and the real risk]." |
| 7 | one per defect step (skip if none) | footage | The screenshot for the user it hurts | "And [it goes wrong]. [Person] is [role], but [the condition]." · "[What the old screen shows them]." then "In the new [view], [person] sees [the difference]." |
| 8 | where the data comes from | footage | The data slide | "Here is where the data comes from." · "AppMap recorded [the project's own tests], plus [N] new test cases written for this review." · "They ran before and after the change, against a real database and cache. Nothing was faked." |
| 9 | one per trace step | footage | One trace slide per step | Step 1: "AppMap recorded what the code did, step by step." · "First, [the usual rule] asks: [question]? [Answer]." · "[What that loads]." Next steps: "Next, [the new code] asks its own question: [question]?" · "[The answer]. So [the result]." Last step: "[Old view shows X]. [New view shows Y]." · "Same person, two rules, two answers." |
| 10 | the review's verdict (skip if nothing surfaced) | statement | Title: "What the review says" | "AppMap's review rates this [level]. [What it does or does not expose]." · "[Whether it looks deliberate, and the evidence]." · "The fix is simple: [the fix, in plain words]." |
| 11 | outro | statement | Title: "In one sentence". Support: "[Still live / Fixed] in [project] as of [today]" | "This change adds [what works]." · "And [the one defect, in a user's words]." · "As of [today], this bug is still live in [project]." (or "fixed in [commit]") |
| 12 | how this was made (optional) | footage | Two slides with the eight steps | "Here is how this movie was made, automatically, for every pull request." then one line per step |

When nothing surfaced, scenes 7, 9 and 10 become one statement scene: "AppMap
checked [paths]. Nothing changed for [users]." and scene 8 still says where the
data came from. Scene 8 is never left out: a viewer trusts the trace only once
they know it came from real runs.

### 7. The sentence

What changed for the person using the app: the person, the screen, the
difference. "The new Markdown view hides whispers from an admin outside the
whisper group, and the topic page shows them." If nothing visible changed:
"No visible change on this path." That is a result too.

### 8. Cut it in Showcase Studio

Showcase `pr-<number>` in the movie library, screenshots and diagram under
`assets/`. Use new file names on every re-cut (`step1-v2.png`): the studio
caches assets by name.

Make the phone version first. Reviewers watch on phones, and they need to see
each screen and each interaction clearly, so every picture fills the whole
screen:

| Scene | Theme | Content |
| --- | --- | --- |
| intro | statement | What the app is, what the change adds, the pull request number, the merge date |
| one per intended-use step | footage | The screenshot, full screen |
| how it's built | footage | One portrait (1080 by 2346) diagram of the change, plain words first |
| three reads | statement | Design, Speed, Security, one line each |
| one per defect step | footage | The screenshot for the user it hurts, full screen |
| where the data comes from | footage | One portrait slide: the project's tests, the new test cases, run before and after, real database and cache |
| one per trace step | footage | One portrait slide per step of the AppMap trace |
| the review's verdict | statement | The level, whether it looks deliberate, the fix |
| outro | statement | The sentence, and whether the defect is still live, with the date |

The scenes and their lines are the standard script in step 6.

Layout rules for maximum readability, learned the hard way:

- Every picture is `theme: footage` with
  `media: {frame: full, align: top, motion: still, tiktok: {fit: fill, focus: top}}`,
  so it fills the phone screen edge to edge. Never a phone frame inside the
  phone, never a column of text beside a picture.
- Every picture uses `fit: cover`. Draw slides (the design, the data slide,
  the trace steps, the "how this was made" steps) at the movie's own shape,
  1080 by 2346 (the same shape as the studio's 1320 by 2868 canvas), so cover
  crops nothing and contain is never needed. A 1080 by 1920 slide gets its
  sides cut with cover and a black band under it with contain.
- Take browser screenshots at phone size (430 by 932, scale 3) and keep the
  part that matters in the top 80%: the subtitle sits at the bottom.
- Plain-text or code screens: set the font to at least 27 pixels before the
  screenshot (430 wide at scale 3), so every line reads on a phone without
  zooming. Default 13 or 14 pixel text is unreadable in the movie.
- One idea per slide. A slide holds at most four cards; each card has a bold
  plain-words line (46 pixels) and one short explanation (38 pixels).
- Color carries one meaning across the whole movie: green is what works as
  intended, amber is the new or risky part, red is what goes wrong, blue is
  neutral new parts. Never color alone: every card also says it in words.
- Draw every diagram and trace step at 1080 by 2346, in plain words at 38
  pixels or more, with the code names small (28 pixels) underneath for
  developers. Keep everything in the top 75%: the subtitles sit in the
  bottom quarter and must never cover a card.
- Split a trace into steps of two or three boxes each, one slide per step,
  about ten seconds each. A whole trace on one slide flashes past.
- A wide (4:3) cut for desktops is optional and comes second. If you make one,
  draw its diagrams again at 1600 by 900 for `console` slides.

Then:

1. Put the script into each scene's captions.
2. Voice it. Set `meta.voiceover` (for example `voice: Ruth`,
   `engine: generative`) and the studio builds the voice from the captions and
   times every scene to it. Never set `durationMs` on a voiced showcase. If the
   studio has no voiceover support, make one clip per caption with a voice
   whose license allows commercial use, join them with fixed silences, set
   `meta.soundtrack: {src, sync: true}`, and pin each caption's and scene's
   `durationMs` to its clip. Say which voice and license in `meta.notes`.
3. Check the voice with speech-to-text (the studio's `transcribe`, or any
   whisper) against the script. Respell for the voice only what it says wrong.
4. `validate`, then `screenshot_slide` every scene and look: each picture
   fits its frame, nothing that matters is cropped.

### 9. Export the three forms

1. `export` kind `video-draft` → `movie.mp4` (tall 9:16, full screen on
   phones). Optionally `video-43-draft` → `movie-wide.mp4` for desktops. Full
   quality only when asked.
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

- One plain-language script a newcomer can follow, one voice.
- A full-screen phone video and a podcast clip under three minutes, and the script, all saying the
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
- Order in the movie: Markdown lists and topics working for Maya, who is in
  the whisper group; how the change is built; the three reads; then the
  defect for Alex, an admin outside the group; then the trace in three steps.
- Outro: "So this pull request adds Markdown views that work, and one rule
  that hides whispers from admins outside the whisper group."
