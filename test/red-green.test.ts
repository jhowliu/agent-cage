import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { RedGreenConfig } from "../src/config.js";
import {
  checkGreen,
  checkRed,
  diffSince,
  findChangedTests,
  formatRedGreenItems,
  formatRedGreenSummary,
  recordRedCheck,
  restorePaths,
  snapshotWorkspace,
  testsPassingBeforeChange,
  type RedCheck,
} from "../src/run/red-green.js";
import { createHostShellRunner, type ShellRunner } from "../src/sandbox-execution.js";

const nodeTest: RedGreenConfig = {
  test_files: ["test/**/*.test.js"],
  support_files: [],
  run: "node --test {file}",
};

const mathSource = `export function divide(a, b) { return a / b; }\n`;
const mathTest = `import { test } from "node:test";
import assert from "node:assert/strict";
import { divide } from "../src/math.js";

test("divide", () => assert.equal(divide(6, 3), 2));
`;
const divideByZeroTest = `${mathTest}
test("divide by zero", () => assert.throws(() => divide(1, 0), RangeError));
`;
const divideByZeroSource = `export function divide(a, b) {
  if (b === 0) throw new RangeError("Cannot divide by zero");
  return a / b;
}
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function writeFiles(cwd: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content, "utf8");
  }
}

async function read(cwd: string, path: string): Promise<string | null> {
  return await readFile(join(cwd, path), "utf8").catch(() => null);
}

/** A repo with one commit on main, holding `files`. */
async function createRepo(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-red-green-"));
  git(cwd, "init", "--quiet", "--initial-branch=main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  await writeFiles(cwd, {
    "package.json": `{ "type": "module" }\n`,
    ".gitignore": "ignored/\n",
    ...files,
  });
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", "base");
  return cwd;
}

async function withRepo(
  files: Record<string, string>,
  body: (cwd: string, shell: ShellRunner) => Promise<void>,
): Promise<void> {
  const cwd = await createRepo(files);
  try {
    await body(cwd, createHostShellRunner(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function red(
  shell: ShellRunner,
  before: string,
  config: RedGreenConfig = nodeTest,
): Promise<RedCheck> {
  return await checkRed({ shell, config, before, redactor: (value) => value });
}

function statuses(check: RedCheck): [string, string][] {
  return check.tests.map((result) => [result.file, result.status]);
}

test("the red check passes a test written before the code, which fails on the code as it stands", async () => {
  await withRepo(
    { "src/math.js": mathSource, "test/math.test.js": mathTest },
    async (cwd, shell) => {
      const before = await snapshotWorkspace(shell);
      await writeFiles(cwd, { "test/math.test.js": divideByZeroTest });

      const check = await red(shell, before);

      assert.deepEqual(statuses(check), [["test/math.test.js", "red"]]);
      const [result] = check.tests;
      assert.match(
        result?.status === "red" ? result.reason : "",
        /Missing expected exception/,
      );
      assert.deepEqual(check.reverted, []);
    },
  );
});

test("the red check reads a multi-line error as its reason", async () => {
  await withRepo(
    { "src/math.js": mathSource, "test/math.test.js": mathTest },
    async (cwd, shell) => {
      const before = await snapshotWorkspace(shell);
      await writeFiles(cwd, {
        "test/math.test.js": `${mathTest}
test("divide rounds", () => assert.equal(divide(7, 2), 3));
`,
      });

      const [result] = (await red(shell, before)).tests;

      assert.equal(
        result?.status === "red" ? result.reason : "",
        "error: Expected values to be strictly equal: 3.5 !== 3",
      );
    },
  );
});

test("the red check flags a test that already passes before the code", async () => {
  await withRepo(
    { "src/math.js": mathSource, "test/math.test.js": mathTest },
    async (cwd, shell) => {
      const before = await snapshotWorkspace(shell);
      await writeFiles(cwd, {
        "test/math.test.js": `${mathTest}
test("divide again", () => assert.equal(divide(1, 4), 0.25));
`,
      });

      const check = await red(shell, before);

      assert.deepEqual(statuses(check), [["test/math.test.js", "passes_before_change"]]);
      assert.deepEqual(testsPassingBeforeChange(check), ["test/math.test.js"]);
    },
  );
});

test("the red check reverts code the red step wrote, and keeps support files", async () => {
  await withRepo(
    { "src/math.js": mathSource, "test/math.test.js": mathTest },
    async (cwd, shell) => {
      const before = await snapshotWorkspace(shell);
      await writeFiles(cwd, {
        "src/math.js": divideByZeroSource,
        "src/round.js": "export const round = Math.round;\n",
        "test/cases.js": "export const zero = 0;\n",
        "test/math.test.js": `${mathTest}import { zero } from "./cases.js";
test("divide by zero", () => assert.throws(() => divide(1, zero), RangeError));
`,
        "ignored/build.txt": "kept",
      });

      const check = await red(shell, before, {
        ...nodeTest,
        support_files: ["test/cases.js"],
      });

      assert.deepEqual(statuses(check), [["test/math.test.js", "red"]]);
      assert.deepEqual(check.reverted.sort(), ["src/math.js", "src/round.js"]);
      assert.equal(await read(cwd, "src/math.js"), mathSource);
      assert.equal(await read(cwd, "src/round.js"), null);
      assert.equal(await read(cwd, "test/cases.js"), "export const zero = 0;\n");
      assert.equal(await read(cwd, "ignored/build.txt"), "kept");
    },
  );
});

test("a later red step is checked against the code earlier iterations wrote", async () => {
  await withRepo(
    { "src/math.js": mathSource, "test/math.test.js": mathTest },
    async (cwd, shell) => {
      // Earlier iterations: the divide-by-zero test, then its code, uncommitted.
      await writeFiles(cwd, {
        "test/math.test.js": divideByZeroTest,
        "src/math.js": divideByZeroSource,
      });
      const before = await snapshotWorkspace(shell);
      await writeFiles(cwd, {
        "test/math.test.js": `${divideByZeroTest}
test("divide rejects strings", () => assert.throws(() => divide("1", 2), TypeError));
`,
      });

      const check = await red(shell, before);

      assert.deepEqual(statuses(check), [["test/math.test.js", "red"]]);
      assert.equal(await read(cwd, "src/math.js"), divideByZeroSource);
    },
  );
});

test("the test lock finds changed, added and deleted tests, and restores them", async () => {
  await withRepo(
    {
      "src/math.js": mathSource,
      "test/math.test.js": mathTest,
      "test/legacy.test.js": "// legacy\n",
    },
    async (cwd, shell) => {
      await writeFiles(cwd, { "test/math.test.js": divideByZeroTest });
      const lock = await snapshotWorkspace(shell);
      await rm(join(cwd, "test/legacy.test.js"));
      await writeFiles(cwd, {
        "src/math.js": divideByZeroSource,
        "test/math.test.js": mathTest,
        "test/extra.test.js": "// extra\n",
      });

      const changed = await findChangedTests(shell, nodeTest, lock);

      assert.deepEqual(
        changed.map((entry) => [entry.path, entry.status]),
        [
          ["test/extra.test.js", "A"],
          ["test/legacy.test.js", "D"],
          ["test/math.test.js", "M"],
        ],
      );
      assert.match(
        await diffSince(shell, lock, ["test/math.test.js"]),
        /^-test\("divide by zero"/m,
      );

      await restorePaths(shell, lock, changed);

      assert.equal(await read(cwd, "test/math.test.js"), divideByZeroTest);
      assert.equal(await read(cwd, "test/legacy.test.js"), "// legacy\n");
      assert.equal(await read(cwd, "test/extra.test.js"), null);
      assert.equal(await read(cwd, "src/math.js"), divideByZeroSource);
      assert.deepEqual(await findChangedTests(shell, nodeTest, lock), []);
    },
  );
});

test("the green check runs the tests written first and skips a deleted one", async () => {
  await withRepo(
    { "src/math.js": divideByZeroSource, "test/math.test.js": divideByZeroTest },
    async (cwd, shell) => {
      await writeFiles(cwd, {
        "test/strings.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { divide } from "../src/math.js";

test("divide rejects strings", () => assert.throws(() => divide("1", 2), TypeError));
`,
      });

      const results = await checkGreen({
        shell,
        config: nodeTest,
        files: ["test/math.test.js", "test/strings.test.js", "test/gone.test.js"],
        redactor: (value) => value,
      });

      assert.deepEqual(
        results.map((result) => [result.file, result.passed]),
        [
          ["test/math.test.js", true],
          ["test/strings.test.js", false],
        ],
      );
    },
  );
});

test("the PR lines and the review summary describe each test written first", () => {
  const report = recordRedCheck(
    { tests: [], changedAfterRed: [] },
    {
      tests: [
        {
          file: "test/a.test.js",
          status: "red",
          reason: "AssertionError",
          log: "$ node --test 'test/a.test.js'\nexit code: 1\nAssertionError",
        },
        { file: "test/b.test.js", status: "passes_before_change", log: "" },
      ],
      reverted: [],
    },
  );
  const withChange = {
    ...report,
    changedAfterRed: [
      { file: "test/a.test.js", diff: "-assert.equal(x, 2)\n+assert.ok(x)" },
    ],
  };

  assert.deepEqual(formatRedGreenItems(withChange), [
    "Red-green: `test/a.test.js` was written before the code, failed without it (`AssertionError`), and passes with it.",
    "Red-green: `test/b.test.js` was written before the code but already passed without it, so it may not test the change.",
    "Red-green: `test/a.test.js` was changed while the code was written, after it failed.",
  ]);
  const summary = formatRedGreenSummary(withChange);
  assert.match(
    summary,
    /`test\/a\.test\.js`: written first; failed before[\s\S]*AssertionError/,
  );
  assert.match(summary, /`test\/b\.test\.js`: written first, but already passed/);
  assert.match(summary, /changed while the code was written[\s\S]*\+assert\.ok\(x\)/);
  assert.deepEqual(formatRedGreenItems({ tests: [], changedAfterRed: [] }), [
    "Red-green: no test was written before the code.",
  ]);
});

test("a later red step replaces a file's earlier result", () => {
  const first = recordRedCheck(
    { tests: [], changedAfterRed: [] },
    {
      tests: [{ file: "test/a.test.js", status: "passes_before_change", log: "" }],
      reverted: [],
    },
  );
  const second = recordRedCheck(first, {
    tests: [{ file: "test/a.test.js", status: "red", reason: "boom", log: "boom" }],
    reverted: [],
  });

  assert.deepEqual(
    second.tests.map((result) => [result.file, result.status]),
    [["test/a.test.js", "red"]],
  );
});
