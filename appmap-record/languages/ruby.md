# Ruby

Part of the **appmap-record** skill. Read its `SKILL.md` first for the general
workflow, the output directory rules, and indexing.

## Language agent

The `appmap` gem should be present in the `test` and `development` bundles.

## Programmatic recording (Ruby)

In-code recording of a block — useful when wrapping a whole test is
too coarse:

```ruby
require 'appmap'

appmap = AppMap.record do
  # code under recording
end
File.write('tmp/appmap/scratch.appmap.json', JSON.generate(appmap))
```

## Record tests

```sh
# RSpec (automatic when appmap gem is loaded)
bundle exec rspec
# Output: tmp/appmap/rspec/

# Minitest
bundle exec rake test
# Output: tmp/appmap/minitest/

# Cucumber (requires setup in support/env.rb and support/hooks.rb)
bundle exec cucumber
# Output: tmp/appmap/cucumber/
```

## Record HTTP requests

Automatic via Rack middleware. Enabled by default when `RAILS_ENV=development`.

```sh
rails server
```

## Remote recording

Enabled by default in development. Control with `APPMAP_RECORD_REMOTE=true|false`.

## Advanced usage

See https://appmap.io/docs/reference/appmap-ruby.html

## Troubleshooting

**No AppMaps generated from tests:**
- The `appmap` gem must be the **first gem** listed in the `Gemfile`, or it
  will not properly instrument other dependencies.
- For RSpec, ensure `appmap/rspec` is required in `spec_helper.rb` **before**
  the Rails environment loads.
- For Minitest, ensure `appmap/minitest` is required in `test_helper.rb`
  **before** the Rails environment loads.
- Verify recording is not disabled: check that `APPMAP=false` and
  `APPMAP_RECORD_RSPEC=false` / `APPMAP_RECORD_MINITEST=false` are not set.

**No AppMaps from HTTP requests:**
- Request recording is only auto-enabled when `RAILS_ENV=development`. In
  other environments, set `APPMAP_RECORD_REQUESTS=true` explicitly.
- Run `rake middleware` to confirm AppMap middleware is in the Rack stack.

**Essential environment variables:**

| Variable | Purpose |
|---|---|
| `APPMAP=false` | Disable all recording |
| `APPMAP_RECORD_REQUESTS=true` | Force HTTP request recording outside development |
| `APPMAP_LOG_HOOK=true` | Detailed instrumentation hook logging (writes to `appmap_hook.log`) |

**Disabling recording for specific tests:**
Use the `appmap: false` RSpec tag:
```ruby
describe 'Module', appmap: false do
  # AppMap recording disabled for this group
end
```
