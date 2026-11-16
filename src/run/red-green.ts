import { matchesGlob } from "node:path";
import type { RedGreenConfig } from "../config.js";
import type { DockerCommandOptions } from "../docker.js";
import { formatCommandLog, type ShellRunner } from "../sandbox-execution.js";
import { shellQuote } from "../shell.js";

/**
 * Test-driven development, enforced. In the red step the agent writes tests
 * before the code, and each test file it writes must fail on the code as it
 * stands. The tests are then locked while the agent writes the code (the green
 * step), and must pass once the code is done.
 *
 * "Tests" here are the files matching `test_files` or `support_files`; only
 * the red step may change them.
 */

/** How one test file written in the red step ran on the code as it stood. */
export type RedTestResult =
  | { file: string; status: "red"; reason: string; log: string }
  | { file: string; status: "passes_before_change"; log: string };

export type RedCheck = {
  tests: RedTestResult[];
  /** Files other than tests that the red step changed; Agent Cage reverted them. */
  reverted: string[];
};

/** A locked test the green step changed, kept after the agent was told once. */
export type TestChangedAfterRed = { file: string; diff: string };

/** Everything the red-green steps found in a run, for the review and the PR. */
export type RedGreenReport = {
  /** The latest red-step result for each test file, across red steps. */
  tests: RedTestResult[];
  changedAfterRed: TestChangedAfterRed[];
};

export type GreenTestResult = { file: string; passed: boolean; log: string };

export type ChangedPath = { status: string; path: string };

type TestRunInput = {
  shell: ShellRunner;
  config: RedGreenConfig;
  redactor: (value: string) => string;
  commandOptions?: DockerCommandOptions | undefined;
};

const logTailLines = 40;
const reasonMaxLength = 160;

/**
 * Records the workspace, including uncommitted and untracked files, as a git
 * tree. Comparing against it later shows what a step changed.
 */
export async function snapshotWorkspace(shell: ShellRunner): Promise<string> {
  const tree = await git(shell, "git add --all && git write-tree");
  await git(shell, "git reset --quiet");
  return tree;
}

/**
 * The red check: reverts what the red step changed outside the tests, then
 * runs each test file it wrote or changed. Each must fail, because the code it
 * tests is not written yet.
 */
export async function checkRed(
  input: TestRunInput & { before: string },
): Promise<RedCheck> {
  const changed = await changedSince(input.shell, input.before);
  const others = changed.filter((entry) => !isTest(input.config, entry.path));
  await restorePaths(input.shell, input.before, others);

  const tests: RedTestResult[] = [];
  for (const entry of changed) {
    if (entry.status === "D" || !matchesAny(entry.path, input.config.test_files)) {
      continue;
    }
    const result = await runTestFile(input, entry.path);
    tests.push(
      result.exitCode === 0
        ? { file: entry.path, status: "passes_before_change", log: result.log }
        : { file: entry.path, status: "red", reason: result.reason, log: result.log },
    );
  }

  return { tests, reverted: others.map((entry) => entry.path) };
}

/** The tests the green step changed since they were locked. */
export async function findChangedTests(
  shell: ShellRunner,
  config: RedGreenConfig,
  lock: string,
): Promise<ChangedPath[]> {
  return (await changedSince(shell, lock)).filter((entry) => isTest(config, entry.path));
}

/** The changes to `paths` since `lock`, as a diff for the review. */
export async function diffSince(
  shell: ShellRunner,
  lock: string,
  paths: string[],
): Promise<string> {
  return await git(
    shell,
    `git add --intent-to-add -- . && git diff --no-renames ${shellQuote(lock)} -- ${paths
      .map(shellQuote)
      .join(" ")}`,
  );
}

/** Puts `paths` back as they were in `tree`: added files go, others come back. */
export async function restorePaths(
  shell: ShellRunner,
  tree: string,
  paths: ChangedPath[],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const added = paths.filter((entry) => entry.status === "A").map((entry) => entry.path);
  const existing = paths
    .filter((entry) => entry.status !== "A")
    .map((entry) => entry.path);
  if (added.length > 0) {
    await git(shell, `rm -f -- ${added.map(shellQuote).join(" ")}`);
  }
  if (existing.length > 0) {
    await git(
      shell,
      `git checkout ${shellQuote(tree)} -- ${existing.map(shellQuote).join(" ")}`,
    );
  }
  await git(shell, "git reset --quiet");
}

/**
 * The green check: runs each test file the red steps wrote. Each must pass. A
 * file the green step deleted, and kept deleted, is the review's to judge.
 */
export async function checkGreen(
  input: TestRunInput & { files: string[] },
): Promise<GreenTestResult[]> {
  const results: GreenTestResult[] = [];
  for (const file of input.files) {
    if ((await input.shell.run(`test -e ${shellQuote(file)}`)).exitCode !== 0) {
      continue;
    }
    const result = await runTestFile(input, file);
    results.push({ file, passed: result.exitCode === 0, log: result.log });
  }

  return results;
}

/** Merges a red step's results into the run's report; a later result wins. */
export function recordRedCheck(report: RedGreenReport, check: RedCheck): RedGreenReport {
  const files = new Set(check.tests.map((test) => test.file));
  return {
    ...report,
    tests: [...report.tests.filter((test) => !files.has(test.file)), ...check.tests],
  };
}

/** The test files the red steps wrote, which the green check runs. */
export function testsWrittenFirst(report: RedGreenReport): string[] {
  return report.tests.map((test) => test.file);
}

export function testsPassingBeforeChange(check: RedCheck): string[] {
  return check.tests
    .filter((test) => test.status === "passes_before_change")
    .map((test) => test.file);
}

/** Feedback for a red step whose tests already pass. */
export function formatRedFeedback(files: string[]): string {
  return `These tests already pass on the code as it stands, so they do not test what is asked: ${codeList(
    files,
  )}. Change their assertions so they fail until the code is written. If what is asked is a test of behavior that already exists, leave them as they are.`;
}

/** Feedback for a green step that changed locked tests, which were restored. */
export function formatLockFeedback(paths: ChangedPath[]): string {
  return `You changed tests that were written before the code: ${codeList(
    paths.map((entry) => entry.path),
  )}. They are locked, and Agent Cage restored them. Change the code so they pass, not the tests. A locked test you change again is kept, and the review checks that the change does not weaken it.`;
}

/** Feedback for a green step whose tests written first still fail. */
export function formatGreenFeedback(results: GreenTestResult[]): string {
  return `These tests were written before the code and still fail. Change the code so they pass:\n${results
    .filter((result) => !result.passed)
    .map((result) => `- \`${result.file}\`:\n${indent(result.log)}`)
    .join("\n")}`;
}

/** The log of a red check. */
export function formatRedCheckLog(check: RedCheck): string {
  const lines =
    check.tests.length === 0
      ? ["No test file was written."]
      : check.tests.map((test) =>
          test.status === "red"
            ? `- \`${test.file}\`: fails (${test.reason})\n${indent(test.log)}`
            : `- \`${test.file}\`: already passes\n${indent(test.log)}`,
        );
  if (check.reverted.length > 0) {
    lines.push(
      `Reverted changes to files other than tests: ${codeList(check.reverted)}.`,
    );
  }

  return lines.join("\n");
}

/** The log of a green check. */
export function formatGreenCheckLog(results: GreenTestResult[]): string {
  return results
    .map(
      (result) =>
        `- \`${result.file}\`: ${result.passed ? "passes" : "fails"}\n${indent(result.log)}`,
    )
    .join("\n");
}

/** One line per test file, for the pull request's verification list. */
export function formatRedGreenItems(report: RedGreenReport): string[] {
  const items =
    report.tests.length === 0
      ? ["Red-green: no test was written before the code."]
      : report.tests.map((test) =>
          test.status === "red"
            ? `Red-green: \`${test.file}\` was written before the code, failed without it (\`${test.reason}\`), and passes with it.`
            : `Red-green: \`${test.file}\` was written before the code but already passed without it, so it may not test the change.`,
        );

  return [
    ...items,
    ...report.changedAfterRed.map(
      (change) =>
        `Red-green: \`${change.file}\` was changed while the code was written, after it failed.`,
    ),
  ];
}

/** The red-green results with their output, for the review prompt. */
export function formatRedGreenSummary(report: RedGreenReport): string {
  const tests =
    report.tests.length === 0
      ? ["No test was written before the code."]
      : report.tests.map((test) =>
          test.status === "red"
            ? `- \`${test.file}\`: written first; failed before the code was written, passes now. Output before the code:\n${indent(test.log)}`
            : `- \`${test.file}\`: written first, but already passed before the code was written.`,
        );

  return [
    ...tests,
    ...report.changedAfterRed.map(
      (change) =>
        `- \`${change.file}\`: changed while the code was written, after it failed. Changes since it failed:\n${indent(change.diff)}`,
    ),
  ].join("\n");
}

async function runTestFile(
  input: TestRunInput,
  file: string,
): Promise<{ exitCode: number; log: string; reason: string }> {
  const command = input.config.run.replaceAll("{file}", shellQuote(file));
  const result = await input.shell.run(command, input.commandOptions);
  const log = input.redactor(formatCommandLog(command, result));

  return {
    exitCode: result.exitCode,
    log: tail(log, logTailLines),
    reason: failureReason(log),
  };
}

async function changedSince(shell: ShellRunner, tree: string): Promise<ChangedPath[]> {
  return parseNameStatus(
    await git(
      shell,
      `git add --intent-to-add -- . && git diff --name-status --no-renames -z ${shellQuote(tree)}`,
    ),
  );
}

function isTest(config: RedGreenConfig, path: string): boolean {
  return matchesAny(path, [...config.test_files, ...config.support_files]);
}

async function git(shell: ShellRunner, command: string): Promise<string> {
  const result = await shell.run(command);
  if (result.exitCode !== 0) {
    throw new Error(formatCommandLog(command, result));
  }

  return result.stdout.trim();
}

function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: ChangedPath[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status !== undefined && path !== undefined) {
      entries.push({ status: status.charAt(0), path });
    }
  }

  return entries;
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/** The first line that names the failure, for a one-line summary. */
function failureReason(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !line.startsWith("$ ") &&
        !/^(exit code|stdout|stderr):/.test(line),
    );
  // An error message says more than the name of the failing test.
  const index = [
    lines.findIndex((line) => /^(error:|E\s)|error\b|assert/i.test(line)),
    lines.findIndex((line) => /fail|not ok|panic|expected/i.test(line)),
  ].find((found) => found !== -1);
  const reason =
    index === undefined ? (lines.at(-1) ?? "no output") : withBlockText(lines, index);
  const singleLine = reason.replaceAll("`", "'").replace(/\s+/g, " ");

  return singleLine.length > reasonMaxLength
    ? `${singleLine.slice(0, reasonMaxLength - 3)}...`
    : singleLine;
}

/**
 * A TAP field such as `error: |-` holds its text on the next lines; join the
 * first two of them onto the field name, up to the next field.
 */
function withBlockText(lines: string[], index: number): string {
  const line = lines[index] ?? "";
  if (!/:\s*[|>][-+]?$/.test(line)) {
    return line;
  }

  const text: string[] = [];
  for (const next of lines.slice(index + 1)) {
    if (/^[\w-]+:(\s|$)/.test(next) || text.length === 2) {
      break;
    }
    text.push(next);
  }

  return [line.replace(/\s*[|>][-+]?$/, ""), ...text].join(" ");
}

function codeList(files: string[]): string {
  return files.map((file) => `\`${file}\``).join(", ");
}

function tail(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return all.length <= lines ? text : ["...", ...all.slice(-lines)].join("\n");
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}
