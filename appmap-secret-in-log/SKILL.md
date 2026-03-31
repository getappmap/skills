---
name: appmap-secret-in-log
description: Detect secret and/or private data that is emitted by the code into log files
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

# Detect secret and/or private data that is emitted into log files

**Important:** Use `jq`, `find`, `grep`, and other standard CLI tools for
all data inspection of AppMap and findings JSON. Do not write custom
Python/Ruby/Node scripts — the project may not have those runtimes available.

## Step 1 - Label the `log` and `secret` functions

Use the `/appmap-label` skill to ensure that `log` and `secret` labels are
applied to the code.

## Step 2 - Run the code to exercise new, changed, or otherwise relevant functionality

Detecting secret and/or private data written into log files requires the
code to be executed to generate AppMap data.

If the `/appmap-record` skill is available, use it to record AppMap data.

The code can be executed using (in order of preference):

1. Existing functional and/or integration tests
2. Newly generated functional and/or integration tests
3. Standalone test program with ad-hoc invocation of the code

Check CLAUDE.md and project configuration (e.g. virtualenv, Gemfile,
package.json) for the correct interpreter and test runner. Run tests
with `APPMAP=true` (except for Java, which does not use this ENV var):

- **Python:** `APPMAP=true <python> -m pytest`
- **Ruby:** `APPMAP=true bundle exec rspec`
- **Node:** `APPMAP=true npx jest`
- **Java:** tests auto-record when the appmap-java agent is configured

Always invoke the test program from the project directory.

**Java:** Application servers may change the working directory at
launch, causing `tmp/appmap/` to appear in an unexpected location. If
data is missing, check the app server's effective working directory. Expect
this when running via lancher scripts, eg tomcat.sh.

## Step 3 - Identify generated AppMap data

AppMap data is written to `tmp/appmap/` relative to the working directory.
Do not attempt to override this output location.

Verify data was generated:

```sh
find tmp/appmap -name '*.appmap.json' | head -5
```

If no data is found, troubleshoot: check `APPMAP=true` was set, check
`appmap.yml` exists, check the agent is installed, then re-run.

## Step 4 - Index and scan the AppMap data

Locate the AppMap CLI tools. Try the local install first, then fall back
to npx:

```sh
# Prefer local installs
APPMAP_BIN="${HOME}/.appmap/bin/appmap"
SCANNER_BIN="${HOME}/.appmap/bin/scanner"

# Fall back to npx if not found
if [ ! -x "$APPMAP_BIN" ]; then APPMAP_BIN="npx @appland/appmap"; fi
if [ ! -x "$SCANNER_BIN" ]; then SCANNER_BIN="npx @appland/scanner"; fi
```

Index the AppMap data, then run the scanner:

```sh
$APPMAP_BIN index --appmap-dir tmp/appmap
$SCANNER_BIN scan --appmap-dir tmp/appmap
```

The scanner writes a single `appmap-findings.json` file in the current
directory (ensure that this file is git-ignored).

## Step 5 - Check for `secret-in-log` findings

Check the scanner output for `secret-in-log` findings:

```sh
jq '[.findings[] | select(.ruleId == "secret-in-log")]' appmap-findings.json
```

If the result is an empty array `[]`, there are no secret-in-log findings.
Report a clean result and stop.

## Step 6 - Report findings

If findings exist, extract details:

```sh
jq '.findings[] | select(.ruleId == "secret-in-log") | {
  ruleId,
  message,
  stack,
  relatedEvents
}' appmap-findings.json
```

Report each finding with:

- **Source of the secret:** which `secret`-labeled function produced the value
- **Log destination:** which `log`-labeled function received it
- **Context:** the call path showing how the secret flowed into the log
- **Remediation:** how to prevent the secret from reaching the log
