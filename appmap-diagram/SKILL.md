---
name: appmap-diagram
description: Draw a focused, annotated sequence diagram from an AppMap recording (a trace) - only the calls that matter to one finding or one change, with notes that explain them. Takes what to emphasise (a review finding from any tool, a comparison of two traces, or a sentence from the user), the trace, and the git revision or revisions it was recorded at, and reads the changed code itself with narrow git commands. Use when asked to draw, show or diagram the trace behind a review finding, what changed in a gold trace, or a comparison of two recordings. It does not record anything and does not run a revision - for a comparison, the caller records both revisions and hands them to appmap-review (see appmap-archive).
---

# Skill: AppMap Diagram

Draw one diagram that explains one thing: the code path behind a finding, or what a
change did to a trace (an AppMap recording of one test or request).

```
what to emphasise ─┐
the trace ─────────┼─► choose the calls that matter ─► annotate them ─► one diagram
the revision(s) ───┘     (the rest is left out)        (from the code)   (HTML, and PNG)
```

AppMap's IDE plugin and CLI already draw a whole trace and a whole comparison. This
skill is for the focused picture: a few calls, in order, with notes a reader can
follow without opening the code. If nobody can say what the diagram should
emphasise, the plain tools are the better choice; say so.

## Inputs

| Input | Needed | Where it comes from |
| --- | --- | --- |
| What to emphasise | Yes | A review finding, a comparison of two traces, or a sentence from the user |
| The trace | Yes | Named by the finding or the user; else found from the files involved |
| The revision or revisions | One, or two for a change | The commit the trace was recorded at, plus the base when there is one |

**What to emphasise.** Any of these:

- **A review finding, from any tool.** What you need from it: a description of what is
  wrong, and the files or functions involved. An **appmap-review** finding gives both,
  plus the trace (its **File** and **Evidence** lines) and a sketch of the path. A code
  review comment, a security scan result or a pull request thread gives the first two;
  find the trace yourself (below).
- **A comparison of two traces.** The comparison is the emphasis: the steps that were
  added, removed, changed or moved. It comes from **appmap-review** (a changed gold
  trace, or two archives or directories of recordings the caller made).
- **A sentence from the user** naming what to show.

**The trace.** This skill does not record. Use the trace the finding or the user names.
If none is named, find one that runs the files involved with **appmap-gold-traces**
("Finding the test for a code path"). If no trace exists, stop and say which skill
makes one: **appmap-record** for one test. For a comparison, the caller records each
revision and hands both over (**appmap-archive**). Don't pick "the closest test" and draw that: a confident diagram of the
wrong code path is worse than none.

**The revisions.** A trace records the commit it was made at (`metadata.git.commit`);
check it is there before relying on it. A gold trace does not have it (it is removed
when the trace is blessed): use the commit that last changed the trace file,
`git log -1 --format=%h -- <trace file>`. Ask when neither gives one. For a change, you also
need the base revision. You are given revisions, never a diff: the whole diff may be
huge, and you only need the part this trace runs.

## Steps

1. **Draw it plain first**, to see what the trace holds. No notes yet:

   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/render.mjs" --appmap <file.appmap.json> --out <page.html>
   ```

   With `--appmap` alone it runs the CLI for the sequence JSON (`~/.appmap/bin/appmap`,
   else `appmap` on PATH; `--cli` overrides). By default the CLI puts each package on
   one lane; `--expand package:server` (or `expand` in the notes) splits a package
   into one lane per file. Use the package name as it appears in the recording's
   lanes (`package:content`, not `package:src/content`); the CLI ignores a name that
   matches nothing. For a comparison, see "Drawing a comparison".

   A trace with hundreds of calls is unreadable as a first picture. Print it as text
   instead, and choose from that:

   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/render.mjs" --appmap <file.appmap.json> --outline [--depth 2]
   ```

   Each line is one call, the lane it lands on, and its number when the name is
   called more than once (`callTool#3`). With `--notes` it marks what the notes
   already hide or collapse.

2. **Find the changed code this trace runs**, when there are two revisions:

   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/changed-code.mjs" --appmap <file.appmap.json> --base <rev> [--head <rev>]
   ```

   It asks git for the names of the changed files, keeps the ones this trace ran, and
   prints for each the functions the trace ran there and the changed line ranges. The
   size of the whole diff does not matter. Leave `--head` out to compare with the
   working tree; add `--side base` for a trace recorded on the base revision. When it
   says the trace runs no changed code, a difference in behaviour comes from outside
   the code this trace runs, and that is worth a note.

3. **Read the code that matters, and only that.** One function at a time:

   ```sh
   git show <rev>:<path>               # the file at one revision
   git diff <base> <head> -- <path>    # one file's changes
   ```

   Read the functions on the path to what the finding names, and the changed
   functions from step 2. Never read the whole diff.

4. **Choose what the diagram shows.**

   | Emphasis | Keep | Leave out |
   | --- | --- | --- |
   | A finding | The calls on the path to the code it names, and the queries under them | Helpers, and calls beside that path (`hide`, or `collapse` at the call) |
   | A comparison | The changed steps and the calls above them (`--changed-only`) | Everything unchanged |
   | A sentence | What it names | The rest |

   What is left out does not matter to this picture; don't list it.

5. **Write a notes file** (format below) and draw again with `--notes`. The notes are
   yours: the user never writes them. Put in steps that tell the story, and a note
   wherever the reader needs something the trace cannot show. That may be one line of
   code, several, a check that never ran, or nothing at all. Don't force a single cause
   onto a problem that has more than one. Quote code you read in step 3, with its file
   and line.

6. **Fix every warning.** The renderer prints `warning: labels overlap: "x" and "y"`
   for any two labels whose boxes meet, `warning: outside the picture: "x"` for
   text that would be cut off, and `warning: drawn across a call bar: "x"` for a step
   heading or a note that runs over the bar of a call still open (shorten the
   heading; give the note a `lane` further right). Its text-width estimate is slightly wider than a
   browser's, so no warning means none on screen. Usual fixes: hide a helper
   (`hide`), stop at a call (`collapse`), or move a note to its own step.

7. **Look at it.** Add `--png` to write a picture of the page beside it and view
   that. It uses Playwright from the project you run it in; when that project has
   none (a Python or Java project, say), add `--playwright <a project that has it>`.
   Then show the user.

Never edit the generated HTML by hand: change the notes and render again, so the next
render keeps the fix.

## Notes file

JSON. Every field is optional.

| Field | What it does |
| --- | --- |
| `title`, `subtitle`, `pageTitle` | Heading, the line under it, the browser tab title (2-4 words) |
| `lanes` | Lanes the recording can't see, drawn first and dashed: `[{"id": "app", "name": "Player B's app", "sub": "…"}]` |
| `laneLabels` | Rename or caption a recorded lane: `{"package:nova_server": {"sub": "contracts.py"}}` |
| `rootLane` | Lane the top-level calls come from. Unset adds a `test` lane |
| `rootQueryLane` | Lane top-level queries come from (default `rootLane`) |
| `callers` | Per-function caller lane for top-level calls: `{"accept": "app"}`. Applies even though the CLI names a caller for them |
| `laneOrder` | Lane ids or names, left to right: `["test", "app"]`. Lanes not listed follow, in their usual order |
| `lift` | Function names drawn as top-level calls wherever the recording nested them (see "Async recordings") |
| `expand` | Package lanes to split into files, as `--expand`: `["package:server"]` |
| `hide` | Calls left out, with everything under them: a function name (every call to it) or `name#n` (that one call). `sql:<text>` leaves out every query containing the text |
| `collapse` | Calls drawn, but not what they call: a name, or `name#n` |
| `setup` | Band for the queries before the first call that is drawn: `{"text": "…", "lines": ["…"]}`, or `false` to draw them as arrows. Hide the test's own set-up call and the queries around it join the band |
| `steps` | Numbered headings: `[{"at": "<anchor>", "heading": "1 · …"}]` |
| `notes` | Boxes: `{"before" \| "under" \| "end" \| "after": "<anchor>", "lane": "…", "kind": "client \| error \| info \| ok", "lines": […], "mono": true, "plain": true, "heading": "…"}` |
| `changedOnly` | Same as `--changed-only` |
| `exceptionMessages` | `false` hides the message box under an exception arrow. A gold trace's message is a placeholder (`<v141>`), and is never drawn |
| `footer` | Replaces the footer line, or `false` |

**Anchors** name a point in the recording:

| Anchor | Means |
| --- | --- |
| `accept` | the first call to a function named `accept` |
| `game_now#2` | the second call to `game_now` in the trace (`--outline` prints the numbers) |
| `sql:SELECT contracts` | the first query whose text contains that; `#n` works here too |
| `raise:accept` | the exception arrow leaving `accept` (steps only) |

Calls are numbered over the whole trace, in recorded order, whether or not they are
drawn. Hiding a call does not renumber the others.

Where a note goes, for a call that makes calls of its own:

```
            ◄── before   (ahead of the step heading)
1 · heading
──► call()
            ◄── under    (below the arrow, before anything the call does)
    ──► child()
            ◄── end      (after its children, before it returns or raises)
◄── raises
            ◄── after    (once the call is over)
```

For a call with no children, `under`, `end` and `after` land in the same place. `end`
is where a note about what the call decided goes.

A `heading` on a `before` note is a step of its own, for something that happens with
no recorded call. On any other note it is the box's bold first line: use it for the
file and line the note quotes. A line in `lines` is a string, or `{"text", "mono",
"bold"}`. A box note with no `lane` sits on the lane that was called (for `before`,
the caller's), to the right of the bars of any calls still open there; a `plain` note
placed `after` with no `lane` is centred across the picture. Plain text that would land on a lane with
calls still open (an `end` note, say) is drawn beside the bars instead of across them.

`assets/fixtures/paused-accept.notes.json` is a complete example: a client lane, four
steps, and a source-line box inside the call that raises.

## Async recordings

appmap-node writes an async call's return when its promise settles. So a helper the
test awaits can look as if it encloses everything that ran after it, and a timer or
request callback lands inside whichever call was still open:

```
recorded                         what ran
startStudio()                    startStudio()
  handle()          ◄── page     handle()            ◄── page's request
  isSelfWriteEcho() ◄── timer    isSelfWriteEcho()   ◄── file watcher's timer
  emit()                         emit()
```

Two things handle it:

- When the CLI can't order the returns at all ("failed trying to compute event
  stack", getappmap/appmap-js#2430), `--appmap` draws a re-nested copy and prints a
  note saying so. Nothing to do.
- To put the callbacks back at the top level, list them in `lift`, then give them
  their real caller with `callers` and a dashed lane in `lanes`. Lifted calls keep
  their recorded order.

## Drawing a comparison

The comparison already exists when this skill starts: `diff/**/*.diff.sequence.json`
from **appmap-review**, whether the two sides were gold traces, archives or
directories of recordings.

```sh
node "${CLAUDE_SKILL_DIR}/assets/render.mjs" --changed-only --sequence <diff.json> --out <page.html>
```

`--changed-only` keeps the changed steps and the calls above them; a whole comparison
is usually thousands of pixels tall. Added steps are green, removed are red and struck
through, changed are amber, moved are teal.

That diff has one lane per package unless the compare was run with `--expand`, and
the renderer cannot split it afterwards. When the code is in one package, every
changed call is then a self-call on one lane. For one lane per file, run the compare
again with `--expand package:<name>` (**appmap-review**; it needs an AppMap CLI whose
`compare` has that option), or give the renderer the two recordings and let it make
the diff, which works with any CLI:

```sh
node "${CLAUDE_SKILL_DIR}/assets/render.mjs" --changed-only --expand package:server \
  --base-appmap <workspace>/out/report/base/<trace>.appmap.json \
  --head-appmap <workspace>/out/report/head/<trace>.appmap.json --out <page.html>
```

The compare leaves each side's recordings in `out/report/base` and `out/report/head`.

- **One diagram**, when a few calls were added or removed: the comparison, as above.
  Use step 2 on each side's recording to find the code change behind each changed
  step, and say it in a note.
- **Two diagrams**, when the path itself changed: draw each side's `.appmap.json`
  with the same notes skeleton (lanes, `lift`, `callers`, `hide`), so the only
  differences are the recording's. Put the recorded values that tell them apart in
  notes.
- **One side only** (a test that exists on one revision): one diagram; say in the
  `subtitle` why there is nothing to compare.

## In a CodeTour

A tour step shows a picture, not a page: render with `--png` and add
`![What it shows](./.tours/diagrams/<name>.png)` to the step's description. The
path is from the workspace root. A link to the HTML opens its source in the editor,
so don't link it. Keep the recordings and notes beside the pictures (for example
`.tours/appmap/`), so the pictures can be drawn again.

## Writing the page

The page is one annotated diagram and nothing else. Longer explanation (the rule the
code should follow, why the tests passed, what a different path would have done)
belongs in the **appmap-review** report or your
reply, not under the diagram.

- Same plain-language rules as **appmap-review**: say what happens to a person, then
  name the code. Step headings read as a story ("B taps Accept"), not as function names.
- Mark what is not recorded. A lane or box drawn from the source is a claim the
  recording does not back; the dashed style says so, and the note itself should name
  the file and line it came from.
- One diagram per finding. When two traces need comparing, draw each and put them
  side by side in the reply.

## Files

```
assets/render.mjs        the renderer (CLI + exported layout/overlap functions)
assets/page.css          the page style; light and dark themes from CSS variables
assets/render.test.mjs   node --test assets/render.test.mjs
assets/changed-code.mjs  which code that a trace ran changed between two revisions (git only)
assets/changed-code.test.mjs  node --test assets/changed-code.test.mjs
assets/fixtures/         one recorded test, reduced to what the renderer reads, and its notes
```
