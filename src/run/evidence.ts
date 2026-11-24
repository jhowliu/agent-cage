import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerCommandOptions } from "../docker.js";
import type { ShellRunner } from "../sandbox-execution.js";
import { shellQuote } from "../shell.js";
import {
  isSafeReportPath,
  reportLimits,
  type ReportCollection,
  type ReportKind,
  type SkippedReport,
} from "./reports.js";

export type EvidenceFile = { path: string; kind: ReportKind | "log"; bytes: number };
export type EvidenceResult =
  | {
      status: "published";
      repo: string;
      branch: string;
      commit: string;
      files: EvidenceFile[];
    }
  | { status: "failed"; reason: string };

const imagePattern = /\.(png|jpe?g|gif|webp|svg)$/i;
const label = (path: string): string => path.replace(/[\\`*_[\]<>|]/g, "\\$&");
const urlPath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

export function formatEvidenceReadme(input: {
  runId: string;
  issueUrl: string;
  files: EvidenceFile[];
  skipped: SkippedReport[];
}): string {
  return [
    `# Evidence for ${label(input.runId)}`,
    "",
    input.issueUrl,
    "",
    "| Path | Kind | Size (bytes) |",
    "| --- | --- | ---: |",
    ...input.files.map(
      (file) =>
        `| [${label(file.path)}](./${urlPath(file.path)}) | ${file.kind} | ${file.bytes} |`,
    ),
    "",
    ...input.files
      .filter((file) => imagePattern.test(file.path))
      .map((file) => `![${label(file.path)}](./${urlPath(file.path)})`),
    "",
    "## Skipped files",
    "",
    ...input.skipped.map(
      (file) => `- ${label(file.path)} (${file.kind}): ${file.reason}`,
    ),
    "",
  ].join("\n");
}

export function formatEvidenceSection(evidence?: EvidenceResult): string {
  if (evidence === undefined) return "";
  if (evidence.status === "failed")
    return "\n## Evidence\nEvidence could not be published\n";
  const root = `https://github.com/${evidence.repo}`;
  let images = 0;
  return [
    "",
    "## Evidence",
    ...evidence.files.map((file) => {
      const url = `${root}/blob/${evidence.commit}/${urlPath(file.path)}?raw=true`;
      if (imagePattern.test(file.path) && images++ < 6)
        return `![${label(file.path)}](${url})`;
      return `- [${label(file.path)}](${url})`;
    }),
    `- [Evidence README](${root}/tree/${urlPath(evidence.branch)})`,
    "",
  ].join("\n");
}

/** Only host artifacts enter stdin. Git's real index and workspace are never used. */
export async function publishEvidence(input: {
  shell: ShellRunner;
  options: DockerCommandOptions;
  runId: string;
  repo: string;
  issueUrl: string;
  artifactPath: (name: string) => string;
  reports: ReportCollection | null;
  authorName: string;
  authorEmail: string;
}): Promise<EvidenceResult> {
  try {
    const files: EvidenceFile[] = [];
    const payload: { path: string; data: Buffer }[] = [];
    const skipped = [...(input.reports?.skipped ?? [])];
    let total = 0;
    const candidates = [
      {
        path: "verify.log",
        kind: "log" as const,
        source: input.artifactPath("verify.log"),
      },
      ...(input.reports?.files ?? []).map((file) => ({
        ...file,
        source: input.artifactPath(join(input.reports?.directory ?? "", file.path)),
      })),
    ];
    for (const file of candidates) {
      if (
        !isSafeReportPath(file.path) ||
        file.path.split("/").some((part) => part.toLowerCase() === ".git") ||
        file.path === "README.md" ||
        (file.kind !== "log" && file.path === "verify.log")
      ) {
        if (file.kind !== "log")
          skipped.push({ ...file, kind: file.kind, reason: "unsafe_path" });
        continue;
      }
      const data = await readFile(file.source);
      const reason =
        data.length > reportLimits.fileBytes
          ? "too_large"
          : total + data.length > reportLimits.totalBytes
            ? "over_limit"
            : null;
      if (reason !== null) {
        if (file.kind === "log") throw new Error(`verify.log: ${reason}`);
        skipped.push({ ...file, kind: file.kind, reason });
        continue;
      }
      total += data.length;
      files.push({ path: file.path, kind: file.kind, bytes: data.length });
      payload.push({ path: file.path, data });
    }
    payload.push({
      path: "README.md",
      data: Buffer.from(
        formatEvidenceReadme({
          runId: input.runId,
          issueUrl: input.issueUrl,
          files,
          skipped,
        }),
      ),
    });
    const branch = `agent-cage/evidence/${input.runId}`;
    const command = [
      "set -eu",
      "evidence_tmp=$(mktemp -d)",
      `trap 'rm -rf "$evidence_tmp"' EXIT`,
      'export GIT_INDEX_FILE="$evidence_tmp/index"',
      "git read-tree --empty",
      "while IFS= read -r evidence_path && IFS= read -r evidence_data; do",
      'printf %s "$evidence_data" | base64 -d > "$evidence_tmp/file"',
      'evidence_blob=$(git hash-object -w -- "$evidence_tmp/file")',
      'git update-index --add --cacheinfo 100644 "$evidence_blob" "$evidence_path"',
      "done",
      "evidence_tree=$(git write-tree)",
      `evidence_commit=$(git -c user.name=${shellQuote(input.authorName)} -c user.email=${shellQuote(input.authorEmail)} commit-tree "$evidence_tree" -m ${shellQuote(`Evidence for ${input.runId}`)})`,
      `git push origin "$evidence_commit":${shellQuote(`refs/heads/${branch}`)} >&2`,
      'printf "%s\\n" "$evidence_commit"',
    ].join("\n");
    const result = await input.shell.run(command, {
      ...input.options,
      input: payload
        .map((file) => `${file.path}\n${file.data.toString("base64")}\n`)
        .join(""),
      onData: () => undefined,
    });
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr || result.stdout || `Evidence command exited ${result.exitCode}`,
      );
    const commit = result.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit))
      throw new Error("Evidence command returned an invalid commit SHA");
    return { status: "published", repo: input.repo, branch, commit, files };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
