import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAgentCageConfig, type ReportsConfig } from "../src/config.js";
import { RunFailureError } from "../src/run/errors.js";
import {
  clearReports,
  collectReports,
  formatReportSummary,
  isSafeReportPath,
  parseReportDump,
  parseReportListing,
  prepareReportPaths,
  type ReportJournal,
} from "../src/run/reports.js";
import { createHostShellRunner } from "../src/sandbox-execution.js";

function reports(partial: Partial<ReportsConfig>): ReportsConfig {
  return { junit: [], lcov: [], evidence: [], ...partial };
}

async function createRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-cage-reports-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content, "utf8");
  }
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  return dir;
}

async function writeFiles(
  dir: string,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

function memoryJournal(): ReportJournal & {
  files: Map<string, Uint8Array>;
  json: Map<string, unknown>;
} {
  const files = new Map<string, Uint8Array>();
  const json = new Map<string, unknown>();
  return {
    files,
    json,
    async writeReportFile(name, data) {
      files.set(name, data);
      return name;
    },
    async writeJsonArtifact(name, value) {
      json.set(name, value);
    },
  };
}

test("reports config defaults to no report files and rejects paths outside the repository", () => {
  const base = { verify: ["npm test"] };
  assert.deepEqual(parseAgentCageConfig(base).config.reports, {
    junit: [],
    lcov: [],
    evidence: [],
  });
  assert.deepEqual(
    parseAgentCageConfig({ ...base, reports: { junit: ["reports/*.xml"] } }).config
      .reports,
    { junit: ["reports/*.xml"], lcov: [], evidence: [] },
  );
  for (const glob of ["../outside.xml", "/abs/junit.xml", " junit.xml", "a\nb", "a\\b"]) {
    assert.throws(
      () => parseAgentCageConfig({ ...base, reports: { evidence: [glob] } }),
      /relative to the repository root/,
      glob,
    );
  }
  assert.deepEqual(parseAgentCageConfig({ ...base, reports: {} }).warnings, []);
});

test("report listings keep each file under the kind printed before it", () => {
  assert.deepEqual(
    parseReportListing(
      "/junit\0reports/junit.xml\0/evidence\0shots/a.png\0shots/b b.png\0",
    ),
    [
      { kind: "junit", path: "reports/junit.xml" },
      { kind: "evidence", path: "shots/a.png" },
      { kind: "evidence", path: "shots/b b.png" },
    ],
  );
  assert.equal(isSafeReportPath("shots/a.png"), true);
  for (const path of ["", "/etc/passwd", "../x", "a/../b", "a/./b", "a\nb", "a\\b"]) {
    assert.equal(isSafeReportPath(path), false, JSON.stringify(path));
  }
});

test("a report dump must name known files and deliver every byte it announced", () => {
  const dump = parseReportDump(
    "\n--agent-cage-report 0 5\naGVs\nbG8=\n\n--agent-cage-skip 1 too_large\n",
    2,
  );
  assert.equal(Buffer.from(dump.files.get(0) ?? []).toString(), "hello");
  assert.equal(dump.skipped.get(1), "too_large");
  assert.throws(
    () => parseReportDump("--agent-cage-report 0 9\naGVsbG8=\n", 1),
    /9 bytes/,
  );
  assert.throws(
    () => parseReportDump("--agent-cage-report 3 1\nYQ==\n", 1),
    /unknown file/,
  );
  assert.throws(() => parseReportDump("--agent-cage-skip 0 why\n", 1), /skip reason/);
});

test("prepared report paths stay out of git status, and tracked matches are a config error", async () => {
  const dir = await createRepo({
    "src/app.js": "export {};\n",
    "fixtures/shot.png": "png",
  });
  const shell = createHostShellRunner(dir);
  try {
    await assert.rejects(
      prepareReportPaths(shell, reports({ evidence: ["fixtures/*.png"] })),
      (error: unknown) =>
        error instanceof RunFailureError &&
        error.failureCode === "invalid_config" &&
        error.message.includes("fixtures/shot.png"),
    );

    const log = await prepareReportPaths(
      shell,
      reports({ junit: ["junit.xml"], evidence: ["shots/**/*.png"] }),
    );
    assert.equal(log, "Report paths: 2 patterns kept out of the change.");
    await writeFiles(dir, {
      "junit.xml": "<testsuites/>",
      "shots/deep/a.png": "png",
      "notes.txt": "kept",
      "src/junit.xml": "not a report: the pattern is anchored at the root",
    });
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
    assert.deepEqual(status.trim().split("\n").sort(), [
      "?? notes.txt",
      "?? src/junit.xml",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearing reports deletes only untracked files that match the report paths", async () => {
  const dir = await createRepo({ "src/app.js": "export {};\n" });
  const shell = createHostShellRunner(dir);
  const config = reports({ junit: ["reports/*.xml"], evidence: ["shots/*.png"] });
  try {
    await writeFiles(dir, {
      "reports/junit.xml": "stale",
      "shots/planted.png": "fake",
      "shots/keep.txt": "kept",
    });
    await clearReports(shell, config);
    await assert.rejects(readFile(join(dir, "reports/junit.xml")));
    await assert.rejects(readFile(join(dir, "shots/planted.png")));
    assert.equal(await readFile(join(dir, "shots/keep.txt"), "utf8"), "kept");
    assert.equal(await readFile(join(dir, "src/app.js"), "utf8"), "export {};\n");

    // Nothing to clear is not an error.
    await clearReports(shell, config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collecting reports copies regular files byte for byte and skips links and oversized files", async () => {
  const dir = await createRepo({ "src/app.js": "export {};\n" });
  const outside = await mkdtemp(join(tmpdir(), "agent-cage-outside-"));
  const shell = createHostShellRunner(dir);
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
  ]);
  try {
    await writeFile(join(outside, "secret.txt"), "host secret");
    await writeFiles(dir, {
      "reports/junit.xml": '<testsuite tests="2" failures="0"/>',
      "coverage/lcov.info": "SF:src/app.js\nDA:1,1\nend_of_record\n",
      "shots/a.png": png,
      "shots/huge.png": new Uint8Array(64),
      "shots/empty.png": new Uint8Array(0),
    });
    await symlink(join(outside, "secret.txt"), join(dir, "shots/link.png"));
    const journal = memoryJournal();

    const collection = await collectReports({
      shell,
      journal,
      config: reports({
        junit: ["reports/*.xml"],
        lcov: ["coverage/lcov.info"],
        evidence: ["shots/*.png", "reports/*.xml"],
      }),
      iteration: 2,
      limits: { fileBytes: 40, totalBytes: 1024, files: 10 },
    });

    assert.equal(collection.directory, "verify-2-reports");
    assert.deepEqual(
      collection.files.map((file) => `${file.kind} ${file.path} ${file.bytes}`),
      [
        "junit reports/junit.xml 35",
        "lcov coverage/lcov.info 35",
        "evidence shots/a.png 10",
        "evidence shots/empty.png 0",
      ],
    );
    assert.deepEqual(
      collection.skipped.map((file) => `${file.path} ${file.reason}`).sort(),
      ["shots/huge.png too_large", "shots/link.png not_regular_file"],
    );
    assert.deepEqual(journal.files.get("verify-2-reports/shots/a.png"), png);
    assert.equal(
      Buffer.from(
        journal.files.get("verify-2-reports/reports/junit.xml") ?? [],
      ).toString(),
      '<testsuite tests="2" failures="0"/>',
    );
    assert.ok(
      ![...journal.files.values()].some((data) =>
        Buffer.from(data).includes("host secret"),
      ),
    );
    assert.deepEqual(journal.json.get("verify-2-reports.json"), collection);
    assert.equal(
      formatReportSummary(collection),
      "Reports: junit 1, lcov 1, evidence 2 in verify-2-reports/ (2 skipped).",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("collecting reports stops at the file and total limits", async () => {
  const dir = await createRepo({ "src/app.js": "export {};\n" });
  const shell = createHostShellRunner(dir);
  try {
    await writeFiles(dir, {
      "shots/1.png": "1234",
      "shots/2.png": "5678",
      "shots/3.png": "9",
      "shots/4.png": "0",
    });
    const collection = await collectReports({
      shell,
      journal: memoryJournal(),
      config: reports({ evidence: ["shots/*.png"] }),
      iteration: 1,
      limits: { fileBytes: 10, totalBytes: 6, files: 3 },
    });
    assert.deepEqual(
      collection.files.map((file) => file.path),
      ["shots/1.png", "shots/3.png"],
    );
    assert.deepEqual(
      collection.skipped.map((file) => `${file.path} ${file.reason}`),
      ["shots/4.png over_limit", "shots/2.png over_limit"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collecting reports with no matching files writes an empty manifest", async () => {
  const dir = await createRepo({ "src/app.js": "export {};\n" });
  try {
    const journal = memoryJournal();
    const collection = await collectReports({
      shell: createHostShellRunner(dir),
      journal,
      config: reports({ junit: ["reports/*.xml"] }),
      iteration: 1,
    });
    assert.deepEqual(collection.files, []);
    assert.deepEqual(collection.skipped, []);
    assert.equal(journal.files.size, 0);
    assert.equal(formatReportSummary(collection), "Reports: none written.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
