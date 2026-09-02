# Node.js

Part of the **appmap-record** skill. Read its `SKILL.md` first for the general
workflow, the output directory rules, and indexing.

## Language agent

The `appmap-node` package should be prefixed to the run command. It works
on current Node LTS releases (Node 18+); newer versions including Node 22
are fine in practice — if you hit an issue, ensure you're on
`appmap-node@latest`.

> **Do not use `appmap-agent-js`.** It is deprecated and superseded by
> `appmap-node`. Always invoke recording through `npx appmap-node`.

## Usage

Wrap your existing launch command:

```sh
npx appmap-node <your command>
```

## Programmatic recording (Node)

In-code recording of a block (sync or async):

```javascript
import { record } from 'appmap-node';

const appmap = record(() => {
  // synchronous code under recording
});

// async:
const appmap = await record(async () => {
  // async code under recording
});
```

The import is from the `appmap-node` package (the same package that
provides the `npx appmap-node` CLI), not `appmap`.

## Record tests

```sh
npx appmap-node mocha specs/test.js
npx appmap-node npx jest
npx appmap-node npx vitest
# Output: tmp/appmap/<mocha|jest|vitest>/
```

**Important**: If you modify `NODE_OPTIONS`, run `appmap-node` _after_ the
modification:

```sh
# Correct:
cross-env NODE_OPTIONS='--max-old-space-size=2048' appmap-node jest

# Wrong (appmap-node before NODE_OPTIONS change):
appmap-node cross-env NODE_OPTIONS='--max-old-space-size=2048' jest
```

## Record HTTP requests

Automatic when HTTP requests are served. Output: `tmp/appmap/requests/`.

## Process recording

Default behavior when no tests or HTTP requests are detected.

```sh
npx appmap-node node my_script.js
# Force process recording alongside other recordings:
APPMAP_RECORDER_PROCESS_ALWAYS=true npx appmap-node npm start
```

## Remote recording

Automatic -- use the AppMap remote recording API or IDE plugin to
start/stop recordings while the app is running.

## Advanced usage

See https://appmap.io/docs/reference/appmap-node.html

## Troubleshooting

**Babel SyntaxError when wrapping a TypeScript test runner in a monorepo:**
- Symptom: `npx appmap-node@latest npx jest …` fails to parse a `.ts`
  test file with a babel `Unexpected token` error, even though the
  bare `npx jest …` runs fine.
- Cause: appmap-node's hook bundles its own babel config and may not
  pick up a `ts-jest` (or other TS) preset configured in a sub-package's
  `jest.config.js` when invoked from a parent directory.
- Fix: run `npx appmap-node` from the package directory whose
  `jest.config.js` defines the TypeScript transform.

**No AppMaps generated or unexpected behavior:**
- Ensure you are running the latest version: `npx appmap-node@latest`.
- If you modify `NODE_OPTIONS` in your launch command, `appmap-node` **must
  come after** the modification. Getting this order wrong is a common cause
  of silent failures. See the "Record tests" section above for examples.

**Process recording not created when other recorders are active:**
- By default, process recording is suppressed when test or request recording
  is active. To force it: `APPMAP_RECORDER_PROCESS_ALWAYS=true`.

**For other issues:** File a report at https://github.com/getappmap/appmap-node.
