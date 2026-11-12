# Python

Part of the **appmap-record** skill. Read its `SKILL.md` first for the general
workflow, the output directory rules, and indexing.

## Language agent

The `appmap` package should be installed and available. If it is not, add it
as a development dependency with the package manager the project already uses:

```sh
pip install appmap                  # plain pip or a requirements file
uv add --dev appmap                 # uv
poetry add --group dev appmap       # Poetry
pipenv install --dev appmap         # Pipenv
```

The package must come from PyPI through that package manager. Do not install
it from a git URL, a downloaded wheel or archive, or a copy found on disk. If
the install fails, stop and tell the user; see "If a tool is missing" in this
skill's `SKILL.md`.

## Programmatic recording (Python)

In-code recording of a block:

```python
from appmap import Recording

with Recording() as rec:
    # code under recording
    pass

# rec.events holds the captured events
```

## Record tests

Use the `appmap-python` wrapper to run tests. It enables recording and
ensures instrumentation is properly initialized.

```sh
appmap-python pytest              # Output: tmp/appmap/pytest/
appmap-python python -m unittest  # Output: tmp/appmap/unittest/
```

## Record HTTP requests

Automatic for Django, Flask, and FastAPI when running in development mode:
- **Django**: `DEBUG = True` in settings.py
- **Flask**: run with `--debug`
- **FastAPI/uvicorn**: run with `--reload`

## Capture SQL (SQLAlchemy)

The Python agent auto-instruments SQL for **Django and Flask** (via their
import hooks), but **not bare SQLAlchemy**: the listener ships in
`appmap/sqlalchemy.py` and is never auto-imported, so a plain SQLAlchemy
app or test silently records **no** `sql_query` events. Import it once,
early, while recording:

```python
# conftest.py (tests) or your app's startup — guarded so non-recording runs pay nothing
import os
if os.environ.get("APPMAP"):
    import appmap.sqlalchemy  # registers the SQLAlchemy SQL-capture listener
```

The listener binds to SQLAlchemy's `Engine` class, so importing it before
any engine runs a query covers every engine created afterward. Confirm it
worked: the recording's `metadata.frameworks` lists `SQLAlchemy` and
`find_queries` is non-empty.

## Capture outgoing HTTP

Outgoing HTTP requests (`http.client`, and so `requests` and `urllib3`) are
recorded only when `appmap.http` is imported. Frameworks with server-side
hooks do not import it for you. Import it the same way as the SQLAlchemy
listener:

```python
# conftest.py
import os
if os.environ.get("APPMAP") == "true":
    import appmap.http  # records http_client_request events
```

The request headers are not recorded in full; do not expect to see auth
headers in the recording.

## Record a process

```sh
appmap-python --record process python my_script.py
```

## Remote recording

Enabled automatically in development environments (Django `DEBUG=True`,
Flask `--debug`). Force with `APPMAP_RECORD_REMOTE=true`.

## Essential environment variables

| Variable | Purpose |
|---|---|
| `APPMAP=true` | Enable recording (auto-set by `appmap-python` wrapper) |
| `APPMAP_DISPLAY_PARAMS=true` | Capture params/returns for unlabeled functions (labeled functions always capture) |
| `APPMAP_CONFIG=path/to/appmap.yml` | Custom config file path |
| `APPMAP_LOG_LEVEL=DEBUG` | Verbose logging for instrumentation troubleshooting |

## Values in recordings

`APPMAP_DISPLAY_PARAMS=true` stores each argument, receiver, and return value
as its `repr()`. Two consequences:

- **`repr()` runs during recording.** If a class's `__repr__` reads a file,
  queries a device, or fills a cache, recording does that too: extra I/O in the
  recording, changed cache state, and sometimes a different test outcome or much
  longer timings. Confirm such effects with a run without the agent.
- **Agents before 4.0.0 record positional optional arguments as their
  defaults**: for `def f(self, a, b=None)`, a call `f(1, 2)` is recorded as
  `b=None`. Keyword arguments are recorded correctly. 4.0.0 records both
  correctly. With an older agent, check a recorded default against the call
  site before using it as evidence, or upgrade.

## Advanced usage

See https://appmap.io/docs/reference/appmap-python.html

## Troubleshooting

**No AppMaps generated:**
- Ensure `APPMAP=true` is set, or use the `appmap-python` wrapper which sets
  it automatically. Without it, AppMap's conditional imports are skipped and
  no recording occurs.
- Check that `APPMAP_RECORD_PYTEST=false` or `APPMAP_RECORD_UNITTEST=false`
  are not set.

**No SQL queries in the recording** (`find_queries` empty, `metadata.frameworks`
lacks `SQLAlchemy`):
- AppMap auto-wires SQL for Django/Flask but **not bare SQLAlchemy**. Import
  `appmap.sqlalchemy` once while recording — see "Capture SQL (SQLAlchemy)".

**`RuntimeError: "Recording already in progress"`:**
- This occurs when `APPMAP_RECORD_PROCESS=true` conflicts with another
  recording method (requests, remote, tests). Process recording is
  incompatible with other recording types.
- Fix: disable request recording when using process recording:
  ```sh
  appmap-python --record process --no-record requests flask --app main.app
  ```

**Remote recording security warning in non-development environments:**
- The agent warns when remote recording is enabled outside development mode.
  Development is auto-detected via Django `DEBUG=True` or Flask `--debug`.
- To force in other environments: `APPMAP_RECORD_REMOTE=true`.

**Debugging:**
- Set `APPMAP_LOG_LEVEL=DEBUG` for verbose output.
- Set `APPMAP_DISABLE_LOG_FILE=true` to prevent automatic log file creation
  (logs go to stderr instead).
- Use `appmap-python --enable-log` to explicitly create log files.

**Supported versions:** agent 4.0.0 requires Python 3.11 or later and is
tested on 3.11-3.15 (a newer Python is not rejected, only untested; agent
3.0.1 is the last for Python 3.8-3.10). Django 3.2-<5, Flask 2-3, FastAPI
~0.110.0, pytest 7 (the version the agent's own tests use), SQLAlchemy 1-2
(2.x SQL capture verified with the `appmap.sqlalchemy` import above).
