import type { ReportsConfig } from "../config.js";
import { formatCommandLog, type ShellRunner } from "../sandbox-execution.js";
import { shellQuote } from "../shell.js";
import { RunFailureError } from "./errors.js";

/**
 * Report files: what the verify commands write besides their output, such as
 * JUnit XML, LCOV coverage and screenshots. Agent Cage keeps them out of the
 * change, clears them before each verify so only that verify's files count,
 * and copies them into the run directory afterwards. The copy goes through
 * the sandbox shell, so it works the same in Docker and direct mode.
 */

export const reportKinds = ["junit", "lcov", "evidence"] as const;
export type ReportKind = (typeof reportKinds)[number];

export const reportLimits = {
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 25 * 1024 * 1024,
  files: 200,
} as const;

export type ReportLimits = { fileBytes: number; totalBytes: number; files: number };

export type ReportSkipReason =
  | "not_regular_file"
  | "too_large"
  | "over_limit"
  | "unsafe_path";

export type CollectedReport = { kind: ReportKind; path: string; bytes: number };
export type SkippedReport = { kind: ReportKind; path: string; reason: ReportSkipReason };

export type ReportCollection = {
  iteration: number;
  /** Run-directory folder holding the files at their repository paths. */
  directory: ReportDirectory;
  files: CollectedReport[];
  skipped: SkippedReport[];
};

export type ReportDirectory = `verify-${number}-reports`;

export type ReportListing = { kind: ReportKind; path: string };

/** Writes report files into the run directory and records the manifest. */
export type ReportJournal = {
  writeReportFile(name: string, data: Uint8Array): Promise<string>;
  writeJsonArtifact(name: string, value: unknown): Promise<void>;
};

// Marks one dumped file. Base64 never contains "-" or a space, so a marker
// line cannot be mistaken for file content.
const fileMarker = "--agent-cage-report";
const skipMarker = "--agent-cage-skip";

// Exit code of the prepare command when a report path matches a tracked file.
const trackedReportExitCode = 3;

export function hasReports(config: ReportsConfig): boolean {
  return reportKinds.some((kind) => config[kind].length > 0);
}

export function reportDirectory(iteration: number): ReportDirectory {
  return `verify-${iteration}-reports`;
}

function pathspecs(globs: readonly string[]): string {
  return globs.map((glob) => shellQuote(`:(glob)${glob}`)).join(" ");
}

function allGlobs(config: ReportsConfig): string[] {
  return reportKinds.flatMap((kind) => config[kind]);
}

/**
 * Fails when a report path matches a tracked file, since clearing it would
 * delete part of the repository. Otherwise adds the paths to git's exclude
 * file, so report files never enter the diff or the commit, even when the
 * repository does not ignore them.
 */
export function prepareReportsCommand(config: ReportsConfig): string {
  const globs = allGlobs(config);
  const excludeLines = globs.map((glob) => shellQuote(`/${glob}`)).join(" ");
  return [
    `tracked=$(git ls-files -- ${pathspecs(globs)})`,
    `if [ -n "$tracked" ]; then printf '%s\\n' "$tracked"; exit ${trackedReportExitCode}; fi`,
    `exclude=$(git rev-parse --git-path info/exclude)`,
    `mkdir -p "$(dirname "$exclude")"`,
    `printf '%s\\n' ${excludeLines} >> "$exclude"`,
  ].join(" && ");
}

/** Deletes the report files an earlier verify, or the agent, left behind. */
export function clearReportsCommand(config: ReportsConfig): string {
  return `git ls-files -z --others -- ${pathspecs(allGlobs(config))} | xargs -0 rm -f --`;
}

/**
 * Lists the report files by kind, NUL-separated. A kind's name follows a
 * leading "/", which git never prints at the start of a path.
 */
export function listReportsCommand(config: ReportsConfig): string {
  return reportKinds
    .filter((kind) => config[kind].length > 0)
    .map(
      (kind) =>
        `printf '/%s\\0' ${kind} && git ls-files -z --others -- ${pathspecs(config[kind])}`,
    )
    .join(" && ");
}

export function parseReportListing(stdout: string): ReportListing[] {
  const listings: ReportListing[] = [];
  let kind: ReportKind | null = null;
  for (const token of stdout.split("\0")) {
    if (token === "") continue;
    if (token.startsWith("/")) {
      const named = token.slice(1);
      kind = isReportKind(named) ? named : null;
      continue;
    }
    if (kind !== null) listings.push({ kind, path: token });
  }
  return listings;
}

function isReportKind(value: string): value is ReportKind {
  return (reportKinds as readonly string[]).includes(value);
}

/** A path that stays inside the report directory and fits on one line. */
export function isSafeReportPath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !/[\u0000-\u001f\u007f\\]/.test(path) &&
    !path.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

/**
 * Prints each regular file as a marker line with its index and size, then its
 * base64. Symlinks, special files and files over the limits get a skip line
 * instead, so nothing outside the workspace is read through a link.
 */
export function dumpReportsCommand(
  paths: readonly string[],
  limits: ReportLimits = reportLimits,
): string {
  const quoted = paths.map((path) => shellQuote(path)).join(" ");
  return [
    "total=0;",
    "i=0;",
    `for f in ${quoted}; do`,
    `if [ -L "$f" ] || [ ! -f "$f" ]; then printf '\\n${skipMarker} %s not_regular_file\\n' "$i";`,
    `else size=$(wc -c < "$f" | tr -d ' ');`,
    `if [ "$size" -gt ${limits.fileBytes} ]; then printf '\\n${skipMarker} %s too_large\\n' "$i";`,
    `elif [ $((total + size)) -gt ${limits.totalBytes} ]; then printf '\\n${skipMarker} %s over_limit\\n' "$i";`,
    `else total=$((total + size)); printf '\\n${fileMarker} %s %s\\n' "$i" "$size"; base64 < "$f"; fi;`,
    "fi;",
    "i=$((i + 1));",
    "done",
  ].join(" ");
}

export type ReportDump = {
  files: Map<number, Uint8Array>;
  skipped: Map<number, ReportSkipReason>;
};

export function parseReportDump(stdout: string, fileCount: number): ReportDump {
  const files = new Map<number, Uint8Array>();
  const skipped = new Map<number, ReportSkipReason>();
  let current: { index: number; size: number; chunks: string[] } | null = null;

  const finish = (): void => {
    if (current === null) return;
    const data = Buffer.from(current.chunks.join(""), "base64");
    if (data.length !== current.size) {
      throw new Error(
        `Report file ${current.index} was ${current.size} bytes but ${data.length} arrived.`,
      );
    }
    files.set(current.index, new Uint8Array(data));
    current = null;
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(`${fileMarker} `)) {
      finish();
      const [index, size] = line
        .slice(fileMarker.length + 1)
        .split(" ")
        .map(Number);
      current = {
        index: checkedIndex(index, fileCount),
        size: checkedSize(size),
        chunks: [],
      };
    } else if (line.startsWith(`${skipMarker} `)) {
      finish();
      const [index, reason] = line.slice(skipMarker.length + 1).split(" ");
      skipped.set(checkedIndex(Number(index), fileCount), checkedSkipReason(reason));
    } else if (current !== null) {
      current.chunks.push(line.trim());
    }
  }
  finish();
  return { files, skipped };
}

function checkedIndex(index: number | undefined, fileCount: number): number {
  if (
    index === undefined ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= fileCount
  ) {
    throw new Error(`Report dump names an unknown file: ${String(index)}`);
  }
  return index;
}

function checkedSize(size: number | undefined): number {
  if (size === undefined || !Number.isInteger(size) || size < 0) {
    throw new Error(`Report dump has an invalid size: ${String(size)}`);
  }
  return size;
}

function checkedSkipReason(reason: string | undefined): ReportSkipReason {
  switch (reason) {
    case "not_regular_file":
    case "too_large":
    case "over_limit":
      return reason;
    default:
      throw new Error(`Report dump has an unknown skip reason: ${String(reason)}`);
  }
}

/**
 * Runs during setup. A report path that matches a tracked file is a config
 * error, since clearing reports would delete it.
 */
export async function prepareReportPaths(
  shell: ShellRunner,
  config: ReportsConfig,
): Promise<string> {
  const result = await shell.run(prepareReportsCommand(config), quiet);
  if (result.exitCode === trackedReportExitCode) {
    throw new RunFailureError(
      "invalid_config",
      `reports paths match tracked files, which clearing reports would delete:\n${result.stdout.trim()}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(formatCommandLog("prepare report paths", result));
  }
  const count = allGlobs(config).length;
  return `Report paths: ${count} ${count === 1 ? "pattern" : "patterns"} kept out of the change.`;
}

export async function clearReports(
  shell: ShellRunner,
  config: ReportsConfig,
): Promise<void> {
  const result = await shell.run(clearReportsCommand(config), quiet);
  if (result.exitCode !== 0) {
    throw new Error(formatCommandLog("clear report files", result));
  }
}

/**
 * Copies this verify's report files into the run directory and writes their
 * manifest. A file that matches several kinds is kept once, as its first kind.
 */
export async function collectReports(input: {
  shell: ShellRunner;
  journal: ReportJournal;
  config: ReportsConfig;
  iteration: number;
  limits?: ReportLimits;
}): Promise<ReportCollection> {
  const limits = input.limits ?? reportLimits;
  const listed = await input.shell.run(listReportsCommand(input.config), quiet);
  if (listed.exitCode !== 0) {
    throw new Error(formatCommandLog("list report files", listed));
  }

  const skipped: SkippedReport[] = [];
  const wanted: ReportListing[] = [];
  const seen = new Set<string>();
  for (const listing of parseReportListing(listed.stdout)) {
    if (seen.has(listing.path)) continue;
    seen.add(listing.path);
    if (!isSafeReportPath(listing.path)) {
      skipped.push({ ...listing, reason: "unsafe_path" });
    } else if (wanted.length >= limits.files) {
      skipped.push({ ...listing, reason: "over_limit" });
    } else {
      wanted.push(listing);
    }
  }

  const directory = reportDirectory(input.iteration);
  const files: CollectedReport[] = [];
  if (wanted.length > 0) {
    const dumped = await input.shell.run(
      dumpReportsCommand(
        wanted.map((listing) => listing.path),
        limits,
      ),
      quiet,
    );
    if (dumped.exitCode !== 0) {
      throw new Error(formatCommandLog("copy report files", dumped));
    }
    const dump = parseReportDump(dumped.stdout, wanted.length);
    for (const [index, listing] of wanted.entries()) {
      const data = dump.files.get(index);
      if (data !== undefined) {
        await input.journal.writeReportFile(`${directory}/${listing.path}`, data);
        files.push({ ...listing, bytes: data.length });
        continue;
      }
      skipped.push({ ...listing, reason: dump.skipped.get(index) ?? "not_regular_file" });
    }
  }

  const collection: ReportCollection = {
    iteration: input.iteration,
    directory,
    files,
    skipped,
  };
  await input.journal.writeJsonArtifact(`${directory}.json`, collection);
  return collection;
}

/** One line for the verify log, such as "Reports: junit 1, evidence 3 (1 skipped)." */
export function formatReportSummary(collection: ReportCollection): string {
  const counts = reportKinds
    .map(
      (kind) =>
        [kind, collection.files.filter((file) => file.kind === kind).length] as const,
    )
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  const skipped =
    collection.skipped.length === 0 ? "" : ` (${collection.skipped.length} skipped)`;
  return counts.length === 0
    ? `Reports: none written${skipped}.`
    : `Reports: ${counts.join(", ")} in ${collection.directory}/${skipped}.`;
}

// Report commands print file lists and base64, which belong in neither the
// live output nor the phase log.
const quiet = { onData: (): void => undefined } as const;
