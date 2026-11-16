import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { RedGreenConfig } from "../src/config.js";
import {
  filesPassingWithoutChange,
  formatRedGreenFeedback,
  formatRedGreenItems,
  formatRedGreenSummary,
  runRedGreenCheck,
  type RedGreenResult,
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function writeFiles(cwd: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content, "utf8");
  }
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

/** Everything a run would publish or review, to compare before and after. */
function workspaceState(cwd: string): string {
  git(cwd, "add", "--intent-to-add", "--", ".");
  return [
    git(cwd, "diff", "--binary", "HEAD"),
    git(cwd, "status", "--porcelain", "--untracked-files=all"),
  ].join("\n");
}

async function check(
  cwd: string,
  config: RedGreenConfig = nodeTest,
  base = "HEAD",
  shell: ShellRunner = createHostShellRunner(cwd),
): Promise<RedGreenResult> {
  return await runRedGreenCheck({ shell, config, base, redactor: (value) => value });
}

function statuses(result: RedGreenResult): [string, string][] {
  return result.status === "checked"
    ? result.files.map((file) => [file.file, file.status])
    : [];
}

test("a test of the fixed behavior is red without the fix, and the workspace comes back exactly", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "test/math.test.js": mathTest,
  });
  try {
    await writeFiles(cwd, {
      "src/math.js": `export function divide(a, b) {
  if (b === 0) throw new RangeError("Cannot divide by zero");
  return a / b;
}
`,
      "test/math.test.js": `${mathTest}
test("divide by zero", () => assert.throws(() => divide(1, 0), RangeError));
`,
      "ignored/build.txt": "kept",
    });
    const before = workspaceState(cwd);

    const result = await check(cwd);

    assert.deepEqual(statuses(result), [["test/math.test.js", "red"]]);
    assert.equal(workspaceState(cwd), before);
    assert.equal(await readFile(join(cwd, "ignored/build.txt"), "utf8"), "kept");
    assert.match(formatRedGreenItems(result)[0] ?? "", /fails without the change/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a test that passes without the change does not test it", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "test/math.test.js": mathTest,
  });
  try {
    await writeFiles(cwd, {
      "src/math.js": `export function divide(a, b) {
  if (b === 0) throw new RangeError("Cannot divide by zero");
  return a / b;
}
`,
      "test/math.test.js": `${mathTest}
test("divide again", () => assert.equal(divide(1, 4), 0.25));
`,
    });

    const result = await check(cwd);

    assert.deepEqual(statuses(result), [["test/math.test.js", "passes_without_change"]]);
    assert.deepEqual(filesPassingWithoutChange(result), ["test/math.test.js"]);
    assert.match(formatRedGreenFeedback(["test/math.test.js"]), /do not test it/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("new code is reverted by removing it, and deleted code comes back for the run only", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "src/legacy.js": "export const legacy = true;\n",
    "test/math.test.js": mathTest,
  });
  try {
    await rm(join(cwd, "src/legacy.js"));
    await writeFiles(cwd, {
      "src/round.js": "export const round = (value) => Math.round(value);\n",
      "test/legacy.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("legacy is gone", () => assert.equal(existsSync("src/legacy.js"), false));
`,
      "test/round.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { round } from "../src/round.js";

test("round", () => assert.equal(round(1.6), 2));
`,
    });
    const before = workspaceState(cwd);

    const result = await check(cwd);

    assert.deepEqual(statuses(result), [
      ["test/legacy.test.js", "red"],
      ["test/round.test.js", "red"],
    ]);
    assert.equal(
      await readFile(join(cwd, "src/legacy.js"), "utf8").catch(() => null),
      null,
    );
    assert.equal(workspaceState(cwd), before);
    assert.equal(
      (await readFile(join(cwd, "src/round.js"), "utf8")).includes("round"),
      true,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("support files keep their changed version, so the test fails for the right reason", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "test/math.test.js": mathTest,
  });
  try {
    await writeFiles(cwd, {
      "src/math.js": `export function divide(a, b) {
  if (b === 0) throw new RangeError("Cannot divide by zero");
  return a / b;
}
`,
      "test/cases.js": "export const zero = 0;\n",
      "test/math.test.js": `${mathTest}import { zero } from "./cases.js";
test("divide by zero", () => assert.throws(() => divide(1, zero), RangeError));
`,
    });

    const reverted = await check(cwd);
    const kept = await check(cwd, { ...nodeTest, support_files: ["test/cases.js"] });

    const reason = (result: RedGreenResult): string =>
      result.status === "checked" && result.files[0]?.status === "red"
        ? result.files[0].reason
        : "";
    assert.match(reason(reverted), /cases\.js|Cannot find module/i);
    assert.doesNotMatch(reason(kept), /cases\.js|Cannot find module/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a test file that fails with the change is not checked", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "test/math.test.js": mathTest,
  });
  try {
    await writeFiles(cwd, {
      "test/math.test.js": `${mathTest}
test("broken", () => assert.equal(divide(1, 1), 2));
`,
    });

    assert.deepEqual(statuses(await check(cwd)), [
      ["test/math.test.js", "fails_on_its_own"],
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a change without test files is reported as such", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "test/math.test.js": mathTest,
  });
  try {
    await writeFiles(cwd, { "src/math.js": `${mathSource}// note\n` });

    const result = await check(cwd);

    assert.deepEqual(result, { status: "no_test_changes" });
    assert.deepEqual(formatRedGreenItems(result), ["Red-green: no test file changed."]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a revision is checked against the merge base, including its earlier commits", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "test/math.test.js": mathTest,
  });
  try {
    git(cwd, "checkout", "--quiet", "-b", "feature");
    await writeFiles(cwd, {
      "src/math.js": `export function divide(a, b) {
  if (b === 0) throw new RangeError("Cannot divide by zero");
  return a / b;
}
`,
    });
    git(cwd, "commit", "--quiet", "--all", "-m", "earlier revise");
    await writeFiles(cwd, {
      "test/math.test.js": `${mathTest}
test("divide by zero", () => assert.throws(() => divide(1, 0), RangeError));
`,
    });
    const before = workspaceState(cwd);

    const result = await check(cwd, nodeTest, "main");

    assert.deepEqual(statuses(result), [["test/math.test.js", "red"]]);
    assert.equal(workspaceState(cwd), before);
    assert.equal(git(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim(), "feature");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the workspace is restored when a test run throws", async () => {
  const cwd = await createRepo({
    "src/math.js": mathSource,
    "test/math.test.js": mathTest,
  });
  try {
    await writeFiles(cwd, {
      "src/math.js": `export function divide(a, b) { return b === 0 ? NaN : a / b; }\n`,
      "test/math.test.js": `${mathTest}
test("zero", () => assert.ok(Number.isNaN(divide(1, 0))));
`,
    });
    const before = workspaceState(cwd);
    const host = createHostShellRunner(cwd);
    let testRuns = 0;
    const shell: ShellRunner = {
      async run(command, options) {
        if (command.startsWith("node --test") && (testRuns += 1) === 2) {
          throw new Error("sandbox went away");
        }
        return await host.run(command, options);
      },
    };

    await assert.rejects(check(cwd, nodeTest, "HEAD", shell), /sandbox went away/);
    assert.equal(workspaceState(cwd), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the review summary shows the output of red tests and names the others", () => {
  const summary = formatRedGreenSummary({
    status: "checked",
    files: [
      {
        file: "test/a.test.js",
        status: "red",
        reason: "AssertionError",
        log: "$ node --test 'test/a.test.js'\nexit code: 1\nAssertionError",
      },
      { file: "test/b.test.js", status: "passes_without_change", log: "" },
    ],
  });

  assert.match(
    summary,
    /`test\/a\.test\.js`: fails without the change[\s\S]*AssertionError/,
  );
  assert.match(summary, /`test\/b\.test\.js`: passes without the change\./);
});
