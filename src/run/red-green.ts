import { matchesGlob } from "node:path";
import type { RedGreenConfig } from "../config.js";
import type { DockerCommandOptions } from "../docker.js";
import { formatCommandLog, type ShellRunner } from "../sandbox-execution.js";
import { shellQuote } from "../shell.js";

/**
 * How one changed test file fared. A test proves the change only when it fails
 * without it and passes with it ("red"). One that passes without the change
 * does not test it; one that fails on its own with the change could not be
 * checked.
 */
export type RedGreenFileResult =
  | { file: string; status: "red"; reason: string; log: string }
  | { file: string; status: "passes_without_change"; log: string }
  | { file: string; status: "fails_on_its_own"; log: string };

export type RedGreenResult =
  | { status: "no_test_changes" }
  | { status: "checked"; files: RedGreenFileResult[] };

type ChangedPath = { status: string; path: string };

const logTailLines = 40;
const reasonMaxLength = 160;

/**
 * Runs each changed test file with the change, then again with every other
 * change reverted to the base, and restores the workspace exactly.
 *
 * `base` is the revision the change starts from: HEAD for a new pull request,
 * or the merge base with the base branch for a revision.
 */
export async function runRedGreenCheck(input: {
  shell: ShellRunner;
  config: RedGreenConfig;
  base: string;
  redactor: (value: string) => string;
  commandOptions?: DockerCommandOptions | undefined;
}): Promise<RedGreenResult> {
  const { shell, config } = input;
  const baseCommit = await git(
    shell,
    `git rev-parse --verify ${shellQuote(`${input.base}^{commit}`)}`,
  );
  const changed = parseNameStatus(
    await git(
      shell,
      `git add --intent-to-add -- . && git diff --name-status --no-renames -z ${shellQuote(baseCommit)}`,
    ),
  );
  const isTest = (path: string): boolean => matchesAny(path, config.test_files);
  const tests = changed
    .filter((entry) => entry.status !== "D" && isTest(entry.path))
    .map((entry) => entry.path);

  if (tests.length === 0) {
    return { status: "no_test_changes" };
  }

  const results = new Map<string, RedGreenFileResult>();
  const passingWithChange: string[] = [];
  for (const file of tests) {
    const result = await runTestFile(input, file);
    if (result.exitCode === 0) {
      passingWithChange.push(file);
    } else {
      results.set(file, { file, status: "fails_on_its_own", log: result.log });
    }
  }

  if (passingWithChange.length > 0) {
    const reverted = changed.filter(
      (entry) => !isTest(entry.path) && !matchesAny(entry.path, config.support_files),
    );
    await withChangesReverted(shell, baseCommit, reverted, async () => {
      for (const file of passingWithChange) {
        const result = await runTestFile(input, file);
        results.set(
          file,
          result.exitCode === 0
            ? { file, status: "passes_without_change", log: result.log }
            : { file, status: "red", reason: result.reason, log: result.log },
        );
      }
    });
  }

  return {
    status: "checked",
    files: tests.flatMap((file) => {
      const result = results.get(file);
      return result === undefined ? [] : [result];
    }),
  };
}

/** The test files that passed without the change, so do not test it. */
export function filesPassingWithoutChange(result: RedGreenResult): string[] {
  return result.status === "checked"
    ? result.files
        .filter((file) => file.status === "passes_without_change")
        .map((file) => file.file)
    : [];
}

/** Feedback for the implementation agent when tests pass without its change. */
export function formatRedGreenFeedback(files: string[]): string {
  return `These test files pass without your change, so they do not test it: ${files
    .map((file) => `\`${file}\``)
    .join(
      ", ",
    )}. Agent Cage ran them again with your other changes reverted. Change their assertions so they fail without your change. If the issue asks for tests of behavior that already exists, leave them as they are.`;
}

/** One line per test file, for the pull request's verification list. */
export function formatRedGreenItems(result: RedGreenResult): string[] {
  if (result.status === "no_test_changes") {
    return ["Red-green: no test file changed."];
  }

  return result.files.map((file) => {
    switch (file.status) {
      case "red":
        return `Red-green: \`${file.file}\` fails without the change (\`${file.reason}\`) and passes with it.`;
      case "passes_without_change":
        return `Red-green: \`${file.file}\` also passes without the change, so it may not test it.`;
      case "fails_on_its_own":
        return `Red-green: \`${file.file}\` fails when run on its own with the change, so it was not checked.`;
      default: {
        const exhaustive: never = file;
        return exhaustive;
      }
    }
  });
}

/** The red-green results with their output, for the review prompt. */
export function formatRedGreenSummary(result: RedGreenResult): string {
  if (result.status === "no_test_changes") {
    return "No test file changed.";
  }

  return result.files
    .map((file) => {
      switch (file.status) {
        case "red":
          return `- \`${file.file}\`: fails without the change, passes with it. Output without the change:\n${indent(file.log)}`;
        case "passes_without_change":
          return `- \`${file.file}\`: passes without the change.`;
        case "fails_on_its_own":
          return `- \`${file.file}\`: fails when run on its own with the change, so it was not checked. Output:\n${indent(file.log)}`;
        default: {
          const exhaustive: never = file;
          return exhaustive;
        }
      }
    })
    .join("\n");
}

async function runTestFile(
  input: {
    shell: ShellRunner;
    config: RedGreenConfig;
    redactor: (value: string) => string;
    commandOptions?: DockerCommandOptions | undefined;
  },
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

/**
 * Snapshots the workspace as a tree, reverts `paths` to `base`, runs `body`,
 * then restores the snapshot: files the tests created are removed and files
 * they changed are rewritten. Ignored files (dependencies, build output) stay.
 */
async function withChangesReverted(
  shell: ShellRunner,
  base: string,
  paths: ChangedPath[],
  body: () => Promise<void>,
): Promise<void> {
  const snapshot = await git(shell, "git add --all && git write-tree");
  await git(shell, "git reset --quiet");

  try {
    const added = paths
      .filter((entry) => entry.status === "A")
      .map((entry) => entry.path);
    const existing = paths
      .filter((entry) => entry.status !== "A")
      .map((entry) => entry.path);
    if (added.length > 0) {
      await git(shell, `rm -f -- ${added.map(shellQuote).join(" ")}`);
    }
    if (existing.length > 0) {
      await git(
        shell,
        `git checkout ${shellQuote(base)} -- ${existing.map(shellQuote).join(" ")}`,
      );
    }
    await body();
  } finally {
    await git(
      shell,
      `git clean -fd --quiet && git read-tree -u --reset ${shellQuote(snapshot)} && git reset --quiet`,
    );
    const restored = await git(shell, "git add --all && git write-tree");
    await git(shell, "git reset --quiet");
    if (restored !== snapshot) {
      throw new Error(
        `Red-green check could not restore the workspace: expected tree ${snapshot}, found ${restored}.`,
      );
    }
  }
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
  const reason =
    lines.find((line) => /^(error:|E\s)|error\b|assert/i.test(line)) ??
    lines.find((line) => /fail|not ok|panic|expected/i.test(line)) ??
    lines.at(-1) ??
    "no output";
  const singleLine = reason.replaceAll("`", "'").replace(/\s+/g, " ");

  return singleLine.length > reasonMaxLength
    ? `${singleLine.slice(0, reasonMaxLength - 3)}...`
    : singleLine;
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
