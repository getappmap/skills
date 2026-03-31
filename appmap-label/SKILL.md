---
name: appmap-label
description: Propose AppMap labels for the WIP code changes.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
---

# Propose AppMap labels

## Step 1 - Inspect the WIP code diff

Use `git` commands and the `Read` tool to inspect the code changes that are in progress.

## Step 2 - Identify candidate changes for labeling

AppMap offers the capability to label code functions with defined labels that are used to identify the purpose of the code function in an unambiguous way.

Labels include:

- **`log`** Emit log data, in any form (to file, to network, etc)
- **`secret`** Returns a secret or private value, such as a security credential, or personally identifiable information
- **`security.authentication`** Determines if a user (human or non-human) is authenticated to use the application; this is an identity check
- **`security.authorization`** Determines if a user (human or non-human) is authorized to use the application; this is a permission check for an established identity
- **`deserialize`** Deserializes data in a way that is not provably safe. This label should be applied to low-level functions that perform deserialization, not to higher level functions that invoke lower-level deserialization functions.
- **`system.exec`** Invokes a system command in a way that is not provably safe. This label should be applied to code that makes a system call.
- **`job.create`** Creates a background job that will be performed independently of the main request. To be considered a background job, the spawned request should be processed in a way that is completely asynchronous; the code that creates the job will not wait for the job to complete.
- **`http.session.clear`** Clears an HTTP session.

## Step 3 - Identify field access that should be wrapped in functions

In some cases, step 2 might identify data that is encoded directly in fields. For example, environment variables that contain secret data such as database passwords might be read directly from the environment.

These fields should be wrapped in functions, because labels can only be applied to functions and not to raw data fields.

Direct field access should be completely disallowed for these data fields in the codebase. Any code that is directly accessing the identified fields should be modified to invoke the labeled functions instead.

The generated functions should NOT be written as simple 'getter' functions, as these are often ignored by tracing tools. For example, a function that provides a database password should be called 'databasePassword()', rather than 'getDatabasePassword()'.

## Step 4 - Apply labels to the identified functions

Each function that was located, or generated, and considered to be a likely candidate for labeling, should be modified to apply the AppMap label code snippet.

Labels are applied to code functions in the following way:

- **`java`**
  1. Enure that the project has a dependency on the Java library `appmap-java`.
  2. Add the following Java annotation: `@appmap-java('<labelname>')`
- **`ruby`**
  1. On the line directly before the code function, insert line that begins with the comment: `# @label <label>`, or for multiple labels: `# @labels <label1> <label2>`
- **`python`**
  1. Ensure that the project has a dependency on the Python package `appmap`.
  2. Add the import `from _appmap.labels import labels` at the top of the file (with the other imports, not inside the function).
  3. Add the decorator `@labels("<labelname>")` directly above the function definition.
- **`javascript, typescript, and the like`**
  1. On the line directly before the code function, insert line that begins with the comment: `// @label <label>`, or for multiple labels: `// @labels <label1> <label2>`

