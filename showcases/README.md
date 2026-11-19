# Showcases

This folder is managed by Showcase Studio. Each showcase is a folder:

    <id>/showcase.yaml   the script: scenes, narration, timing
    <id>/theme.yaml      optional styling (colors, fonts, atmosphere)
    <id>/assets/         screenshots and marks (asset keys = file names without extension)
    <id>/graphics/       optional TSX diagrams (default-export React components, CSS-only animation)

showcase_settings.yaml at this top level (next to the showcase folders)
marks this folder as a library and holds its settings — currently just one:

    show_in_recent: false   keep this folder out of File > Open Recent

The studio live-reloads whenever files here change.

When this folder is inside a git repository, the studio keeps a history:
a few seconds after a showcase stops changing, it commits that showcase's
folder (and nothing else) with a message saying what changed. Find those
commits with `git log --grep Showcase-Studio`. Revert one with
`git revert <sha>`, or start a new cut with `git switch -c <name>` —
switching branches reloads the app. If this folder isn't in a git
repository yet, the studio starts one the first time it has a change to
save, so there is a history from your first edit. To turn commits off
(or back on) — which also stops it starting one — use the "Commit
changes to git" switch under the gear button at the top right of a
showcase's screens.
