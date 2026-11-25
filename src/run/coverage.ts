import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ReportCollection } from "./reports.js";

/** Intersects new-file diff lines with executable LCOV lines, merging repeated records. */
export function changedLineCoverage(
  diff: string,
  reports: readonly string[],
  workspace: string,
): string {
  const changed = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  for (const text of diff.split(/\r?\n/)) {
    if (text.startsWith("diff --git ")) {
      file = null;
      line = 0;
    } else if (text.startsWith("+++ ") && line === 0) {
      const name = text.slice(4);
      // Git quotes unusual filenames using JSON-compatible C escapes.
      let decoded = name;
      if (name.startsWith('"')) {
        try {
          const value: unknown = JSON.parse(name);
          if (typeof value === "string") decoded = value;
        } catch {
          continue;
        }
      }
      file = decoded.startsWith("b/") ? decoded.slice(2) : null;
    } else if (text.startsWith("@@ ")) {
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
    } else if (file !== null && line > 0) {
      if (text.startsWith("+")) {
        const lines = changed.get(file) ?? new Set<number>();
        lines.add(line++);
        changed.set(file, lines);
      } else if (text.startsWith(" ")) line++;
    }
  }
  const executable = new Map<string, Map<number, boolean>>();
  for (const report of reports) {
    let source: string | null = null;
    for (const text of report.split(/\r?\n/)) {
      if (text.startsWith("SF:")) {
        const path = text.slice(3);
        const mapped = isAbsolute(path)
          ? relative(resolve(workspace), resolve(path))
          : path;
        source =
          mapped === ".." || mapped.startsWith("../") || isAbsolute(mapped)
            ? null
            : mapped;
      } else if (text === "end_of_record") source = null;
      else if (source !== null) {
        const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(text);
        if (match === null) continue;
        const number = Number(match[1]);
        if (!changed.get(source)?.has(number)) continue;
        const lines = executable.get(source) ?? new Map<number, boolean>();
        lines.set(number, lines.get(number) === true || Number(match[2]) > 0);
        executable.set(source, lines);
      }
    }
  }
  let total = 0;
  let covered = 0;
  const locations: string[] = [];
  for (const [path, lines] of [...executable].sort(([a], [b]) => a.localeCompare(b))) {
    const missing: number[] = [];
    for (const [number, hit] of lines) {
      total++;
      if (hit) covered++;
      else missing.push(number);
    }
    missing.sort((a, b) => a - b);
    for (let i = 0; i < missing.length; i++) {
      const start = missing[i];
      let end = start;
      while (end !== undefined && missing[i + 1] === end + 1) end = missing[++i];
      locations.push(`${path}:${start}${end === start ? "" : `-${end}`}`);
    }
  }
  if (total === 0) return "Changed-line coverage: no changed lines are executable";
  return `Changed-line coverage: ${covered} of ${total} lines (${Math.round((covered / total) * 100)}%).${locations.length === 0 ? "" : ` Not covered: ${locations.slice(0, 10).join(", ")}${locations.length > 10 ? ", …" : ""}`}`;
}

/** Coverage is informational, including when a collected file cannot be read. */
export async function readCoverageItem(
  artifactPath: (name: string) => string,
  collection: ReportCollection | null,
  diff: string,
  workspace: string,
): Promise<string | null> {
  const files = collection?.files.filter((file) => file.kind === "lcov") ?? [];
  if (files.length === 0 || collection === null) return null;
  const texts: string[] = [];
  for (const file of files) {
    try {
      texts.push(
        await readFile(artifactPath(`${collection.directory}/${file.path}`), "utf8"),
      );
    } catch {
      return "Changed-line coverage: could not read LCOV reports";
    }
  }
  return changedLineCoverage(diff, texts, workspace);
}
