import { readFile } from "node:fs/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { ReportCollection } from "./reports.js";

/**
 * JUnit XML from the report files a verify collected. Counts come from the
 * <testcase> elements, since some tools omit or miscount suite attributes.
 */

export type JunitFailure = { classname: string; name: string; message: string };

export type JunitSummary = {
  passed: number;
  failed: number;
  skipped: number;
  failures: JunitFailure[];
};

export type JunitFileResult =
  | { path: string; ok: true; summary: JunitSummary }
  | { path: string; ok: false };

export const maxFeedbackFailures = 20;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
});

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attribute(node: Record<string, unknown>, name: string): string {
  const value = node[`@_${name}`];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (isRecord(value) && typeof value["#text"] === "string") return value["#text"];
  return "";
}

function failureMessage(node: unknown): string {
  const first = asArray(node)[0];
  const message = isRecord(first) ? attribute(first, "message") : "";
  const text = message !== "" ? message : textOf(first);
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function collectSuite(suite: unknown, summary: JunitSummary): void {
  if (!isRecord(suite)) return;
  for (const testcase of asArray(suite["testcase"])) {
    // An empty element such as <skipped/> parses to "", so test for presence.
    const node = isRecord(testcase) ? testcase : {};
    if ("failure" in node || "error" in node) {
      summary.failed += 1;
      summary.failures.push({
        classname: attribute(node, "classname"),
        name: attribute(node, "name"),
        message: failureMessage("failure" in node ? node["failure"] : node["error"]),
      });
    } else if ("skipped" in node) {
      summary.skipped += 1;
    } else {
      summary.passed += 1;
    }
  }
  for (const nested of asArray(suite["testsuite"])) collectSuite(nested, summary);
}

/** Returns null when the text is not JUnit XML. */
export function parseJunit(xml: string): JunitSummary | null {
  if (XMLValidator.validate(xml) !== true) return null;
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    return null;
  }
  if (!isRecord(document)) return null;
  const root = document["testsuites"] ?? document["testsuite"];
  if (root === undefined) return null;

  const summary: JunitSummary = { passed: 0, failed: 0, skipped: 0, failures: [] };
  if (document["testsuites"] !== undefined) {
    // The root has the same shape as a suite: testsuite children, nested.
    collectSuite(root, summary);
  } else {
    for (const suite of asArray(root)) collectSuite(suite, summary);
  }
  return summary;
}

/** Reads the redacted copies in the run directory, never the sandbox files. */
export async function readJunitReports(
  artifactPath: (name: string) => string,
  collection: ReportCollection | null,
): Promise<JunitFileResult[]> {
  if (collection === null) return [];
  const results: JunitFileResult[] = [];
  for (const file of collection.files.filter((entry) => entry.kind === "junit")) {
    try {
      const text = await readFile(
        artifactPath(`${collection.directory}/${file.path}`),
        "utf8",
      );
      const summary = parseJunit(text);
      results.push(
        summary === null
          ? { path: file.path, ok: false }
          : { path: file.path, ok: true, summary },
      );
    } catch {
      results.push({ path: file.path, ok: false });
    }
  }
  return results;
}

/** The Verification items: none without JUnit files, else a count and an unreadable-file line. */
export function formatJunitItems(results: readonly JunitFileResult[]): string[] {
  if (results.length === 0) return [];
  const unreadable = results.filter((result) => !result.ok).map((result) => result.path);
  const readable = results.flatMap((result) => (result.ok ? [result] : []));
  const parts: string[] = [];
  if (readable.length > 0) {
    const total = { passed: 0, failed: 0, skipped: 0 };
    for (const result of readable) {
      total.passed += result.summary.passed;
      total.failed += result.summary.failed;
      total.skipped += result.summary.skipped;
    }
    const names = readable.map((result) => result.path).join(", ");
    parts.push(
      `Tests: ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped (JUnit: ${names})`,
    );
  }
  if (unreadable.length > 0) {
    parts.push(`Tests: could not read ${unreadable.join(", ")}`);
  }
  return parts;
}

/** The failed tests for retry feedback, or null when there are none. */
export function formatJunitFailures(results: readonly JunitFileResult[]): string | null {
  const failures = results.flatMap((result) =>
    result.ok ? result.summary.failures : [],
  );
  if (failures.length === 0) return null;
  const lines = failures.slice(0, maxFeedbackFailures).map((failure) => {
    const label =
      failure.classname === "" ? failure.name : `${failure.classname} > ${failure.name}`;
    return `- ${label}: ${failure.message}`;
  });
  const more =
    failures.length > maxFeedbackFailures
      ? [`- ... and ${failures.length - maxFeedbackFailures} more`]
      : [];
  return `Failed tests (${failures.length}):\n${[...lines, ...more].join("\n")}`;
}
