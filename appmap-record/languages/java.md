# Java

Part of the **appmap-record** skill. Read its `SKILL.md` first for the general
workflow, the output directory rules, and indexing.

## Language agent

The `appmap.jar` Java agent JAR is available from Maven Central or is auto-downloaded by
IDE plugins to `$HOME/.appmap/lib/java/appmap.jar`.

Run with the `-javaagent` JVM flag:

```sh
java -javaagent:$HOME/.appmap/lib/java/appmap.jar -jar myapp.jar
```

## Programmatic recording (Java)

In-code recording of a `Runnable`:

```java
import com.appland.appmap.record.Recorder;

Recorder.getInstance().record("scenario_name", () -> {
    // code under recording
});
```

## Record tests with Maven

Add to `pom.xml`:

```xml
<plugin>
    <groupId>com.appland</groupId>
    <artifactId>appmap-maven-plugin</artifactId>
    <version>LATEST</version>
    <executions>
        <execution>
            <phase>process-test-classes</phase>
            <goals>
                <goal>prepare-agent</goal>
            </goals>
        </execution>
    </executions>
</plugin>
```

Then run:

```sh
mvn test
# Output: tmp/appmap/

# Without modifying pom.xml:
mvn com.appland:appmap-maven-plugin:prepare-agent test
```

**Surefire note**: `forkCount` must not be `0`, and if `argLine` is set it
must include `@{argLine}`.

**Multi-module projects**: by default each module writes its own `tmp/appmap/`
and reads its own `appmap.yml`. To share one config and one output directory
across all modules, point the plugin at the repo root:

```xml
<configuration>
    <configFile>${maven.multiModuleProjectDirectory}/appmap.yml</configFile>
    <outputDirectory>${maven.multiModuleProjectDirectory}/tmp/appmap</outputDirectory>
</configuration>
```

## Record tests with Gradle

Add to `build.gradle`:

```groovy
plugins {
    id "com.appland.appmap" version "<latest-version>"
}
```

Then run:

```sh
gradle appmap test
# Output: $buildDir/appmap/
```

## Record HTTP requests

Automatic for Spring Boot, Spring Web Framework, and Spark Framework.

## Process recording

```sh
java -javaagent:$HOME/.appmap/lib/java/appmap.jar \
     -Dappmap.recording.auto=true \
     -jar myapp.jar
```

## Remote recording

Requires a servlet container (Tomcat, Jetty, etc.). Start the app with the
`-javaagent` flag and use IDE or curl to start/stop recording.

## Essential system properties

| Property | Purpose | Default |
|---|---|---|
| `appmap.config.file` | Config file path | `appmap.yml` |
| `appmap.output.directory` | Output directory | `./tmp/appmap` |
| `appmap.recording.auto` | Auto-record on boot | `false` |
| `appmap.debug` | Enable debug logging | disabled |

## Advanced usage

- Java agent: https://appmap.io/docs/reference/appmap-java.html
- Maven plugin: https://appmap.io/docs/reference/appmap-maven-plugin.html
- Gradle plugin: https://appmap.io/docs/reference/appmap-gradle-plugin.html

## Troubleshooting

**`NoClassDefFoundError: com/appland/appmap/runtime/HookFunctions`:**
- Occurs in application servers with modular class loading (WildFly, Tomcat,
  WebSphere, WebLogic, GlassFish). The agent's classes become inaccessible
  due to class loader isolation.
- Fix: expose `com.appland.appmap.runtime` through the server's class loading
  configuration. Example for WildFly:
  ```
  -Djboss.modules.system.pkgs=org.jboss.byteman,com.appland.appmap.runtime
  ```

**`-javaagent` must come before `-jar`:**
- When using `java -jar`, the `-javaagent` argument must appear **before**
  `-jar` or the agent will not load.

**No `tmp/appmap` directory created (Maven):**
- Verify the `prepare-agent` goal is executing during the build.
- Confirm the Surefire plugin has `forkCount > 0` (not `0`).
- If `argLine` is set in Surefire config, it must include `@{argLine}`:
  ```xml
  <argLine>@{argLine} --illegal-access=permit</argLine>
  ```

**No `$buildDir/appmap` directory created (Gradle):**
- Verify the `appmap` task is explicitly called: `gradle appmap test`.
- Verify the JVM fork propagates the `javaagent` argument.

**Empty or minimal `.appmap.json` files:**
- The agent is running but no classes matching the `appmap.yml` packages
  config are being executed. Adjust the `packages` entries to match the code
  paths exercised by your tests.

**"The forked VM terminated without properly saying goodbye" (Maven/Gradle):**
- Usually caused by an invalid `appmap.yml` configuration.
- Check the agent log at `tmp/appmap/agent.log` (Maven) or
  `$buildDir/appmap/agent.log` (Gradle).
- For Maven, also check Surefire dumpstream files at
  `target/surefire-reports/*.dumpstream`.

**Tests fail only with agent attached:**
- File a report at https://github.com/getappmap/appmap-java/issues with:
  full `appmap.yml`, exact run command, complete output, and any dumpstream
  files.

**Debugging:**
- Set `-Dappmap.debug` to enable debug logging.
- Maven/Gradle plugins support `debug` parameter with comma-separated flags:
  `info`, `hooks`, `http`, `locals`.
- Debug logs default to `tmp/appmap/agent.log` (configurable via `debugFile`).
- Validate Gradle config with: `gradle appmap-validate-config`.
