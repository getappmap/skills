// node --test assets/changed-code.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { changedCode, functionsByFile, parseHunks, parseNameStatus, ranIn } from "./changed-code.mjs";

function repoWith(commits) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "changed-code-")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const shas = [];
  for (const files of commits) {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(dir, name));
      else {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    shas.push(git("rev-parse", "HEAD").trim());
  }
  return { dir, shas };
}

const TRANSFERS_BASE = ["def current_customer():", "    return 1", "", "def create_transfer(a, b):", "    check_funds(a)", "    move(a, b)", ""].join("\n");
const TRANSFERS_HEAD = ["def current_customer():", "    return 1", "", "def create_transfer(a, b):", "    authorize_owner(a)", "    check_funds(a)", "    move(a, b)", ""].join("\n");

const appmap = {
  classMap: [
    {
      type: "package",
      name: "bank",
      children: [
        {
          type: "class",
          name: "transfers",
          children: [
            { type: "function", name: "current_customer", static: true, location: "bank/transfers.py:1" },
            { type: "function", name: "create_transfer", static: true, location: "bank/transfers.py:4" },
          ],
        },
      ],
    },
  ],
  events: [{ event: "call", defined_class: "bank.ledger", method_id: "post", static: true, path: "bank/ledger.py", lineno: 1 }],
};

test("functionsByFile reads the class map and the call events", () => {
  const byFile = functionsByFile(appmap);
  assert.deepEqual(
    byFile.get("bank/transfers.py").map((f) => `${f.name}:${f.line}`),
    ["transfers.current_customer:1", "transfers.create_transfer:4"],
  );
  assert.deepEqual(byFile.get("bank/ledger.py"), [{ name: "ledger.post", line: 1 }]);
});

test("functionsByFile leaves out code outside the repository", () => {
  const byFile = functionsByFile({ events: [{ event: "call", method_id: "dumps", path: "/usr/lib/python3/json/__init__.py", lineno: 183 }] }, "/work/app");
  assert.equal(byFile.size, 0);
});

test("parseNameStatus keeps both names of a rename", () => {
  assert.deepEqual(parseNameStatus("M\ta.py\nR087\told.py\tnew.py\n"), [
    { status: "M", from: "a.py", to: "a.py" },
    { status: "R", from: "old.py", to: "new.py" },
  ]);
});

test("parseHunks reads ranges on both sides, and a side with no lines", () => {
  assert.deepEqual(parseHunks("@@ -4,0 +5 @@ def create_transfer(a, b):\n+x\n@@ -10,2 +11,0 @@\n-y\n-z\n"), [
    { base: null, head: [5, 5], heading: "def create_transfer(a, b):" },
    { base: [10, 11], head: null, heading: "" },
  ]);
});

test("only the changed files the trace ran are reported, with the function above each change", () => {
  const { dir, shas } = repoWith([
    { "bank/transfers.py": TRANSFERS_BASE, "bank/ledger.py": "def post():\n    pass\n", "docs/notes.md": "one\n" },
    { "bank/transfers.py": TRANSFERS_HEAD, "docs/notes.md": "two\n", "bank/reports.py": "def report():\n    pass\n" },
  ]);
  const r = changedCode({ appmap, repo: dir, base: shas[0], head: shas[1] });
  assert.equal(r.changedFiles, 3);
  assert.deepEqual(r.files.map((f) => f.file), ["bank/transfers.py"]);
  assert.deepEqual(r.files[0].hunks.map((h) => [h.lines, h.after.name]), [[[5, 5], "transfers.create_transfer"]]);
});

test("a renamed file is followed, and a base trace is matched by its old name", () => {
  const { dir, shas } = repoWith([
    { "bank/transfers.py": TRANSFERS_BASE },
    { "bank/transfers.py": null, "bank/payments.py": TRANSFERS_HEAD },
  ]);
  const onBase = changedCode({ appmap, repo: dir, base: shas[0], head: shas[1], side: "base" });
  assert.deepEqual(onBase.files.map((f) => [f.status, f.file, f.to]), [["R", "bank/transfers.py", "bank/payments.py"]]);
  const onHead = changedCode({ appmap, repo: dir, base: shas[0], head: shas[1], side: "head" });
  assert.equal(onHead.files.length, 0, "the head trace in this test still names the old file");
});

test("with no --head the working tree is compared", () => {
  const { dir, shas } = repoWith([{ "bank/transfers.py": TRANSFERS_BASE }]);
  fs.writeFileSync(path.join(dir, "bank/transfers.py"), TRANSFERS_HEAD);
  const r = changedCode({ appmap, repo: dir, base: shas[0] });
  assert.equal(r.head, "working tree");
  assert.deepEqual(r.files.map((f) => f.file), ["bank/transfers.py"]);
});

test("a trace recorded from a subdirectory matches git's longer path", () => {
  const ran = functionsByFile(appmap);
  assert.equal(ranIn(ran, "server/bank/transfers.py").length, 2);
  assert.equal(ranIn(ran, "bank/transfers.py").length, 2);
  assert.equal(ranIn(ran, "server/other_bank/transfers.py"), null);
  assert.equal(ranIn(ran, "xbank/transfers.py"), null);
});
