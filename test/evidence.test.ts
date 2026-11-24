import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatEvidenceReadme,
  formatEvidenceSection,
  publishEvidence,
} from "../src/run/evidence.js";
import { createHostShellRunner } from "../src/sandbox-execution.js";

const files = [
  { path: "shots/screen.png", kind: "evidence", bytes: 4 },
  { path: "verify.log", kind: "log", bytes: 8 },
  { path: "junit.xml", kind: "junit", bytes: 10 },
] as const;

test("evidence README lists kinds, sizes and skipped reasons and embeds images", () => {
  const result = formatEvidenceReadme({
    runId: "run-1",
    issueUrl: "https://github.com/o/r/issues/1",
    files: [...files],
    skipped: [{ path: "large.zip", kind: "evidence", reason: "too_large" }],
  });
  assert.match(result, /run-1/);
  assert.match(result, /issues\/1/);
  assert.match(result, /!\[shots\/screen.png\]\(\.\/shots\/screen.png\)/);
  assert.match(result, /\[junit.xml\].*junit.*10/);
  assert.match(result, /large.zip.*too_large/);
});

test("evidence uses immutable blob URLs, limits embeds, and omits absent evidence", () => {
  assert.equal(formatEvidenceSection(), "");
  assert.match(
    formatEvidenceSection({ status: "failed", reason: "denied" }),
    /Evidence could not be published/,
  );
  const result = formatEvidenceSection({
    status: "published",
    repo: "o/r",
    branch: "agent-cage/evidence/run-1",
    commit: "abc123",
    files: [
      ...files,
      ...Array.from({ length: 7 }, (_, i) => ({
        path: `${i}.svg`,
        kind: "evidence" as const,
        bytes: 1,
      })),
    ],
  });
  assert.match(
    result,
    /!\[shots\/screen.png\]\(https:\/\/github.com\/o\/r\/blob\/abc123\/shots\/screen.png\?raw=true\)/,
  );
  assert.match(
    result,
    /\[verify.log\]\(https:\/\/github.com\/o\/r\/blob\/abc123\/verify.log\?raw=true\)/,
  );
  assert.equal(result.match(/!\[/g)?.length, 6);
  assert.match(result, /\/tree\/agent-cage\/evidence\/run-1/);
});

for (const reports of [false, true]) {
  test(`evidence pushes an isolated root commit through the host shell (reports=${reports})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cage-evidence-"));
    const cwd = join(root, "repo");
    const artifacts = join(root, "artifacts");
    const remote = join(root, "remote.git");
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" });
    try {
      await mkdir(cwd);
      await mkdir(artifacts);
      execFileSync("git", ["init", "--bare", remote]);
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      git("remote", "add", "origin", remote);
      await writeFile(join(cwd, "source"), "base");
      git("add", ".");
      git("commit", "-m", "base");
      await writeFile(join(cwd, "source"), "staged");
      git("add", ".");
      await writeFile(join(cwd, "source"), "unstaged");
      const before = git("status", "--porcelain");
      const index = await readFile(join(cwd, ".git/index"));
      const head = git("rev-parse", "HEAD");
      await writeFile(join(artifacts, "verify.log"), "verify passed\n");
      await mkdir(join(artifacts, "verify-1-reports"));
      const binary = Buffer.from([0, 255, 128, 10]);
      await writeFile(join(artifacts, "verify-1-reports/image.png"), binary);
      await writeFile(join(artifacts, "verify-1-reports/report.xml"), "[REDACTED]");
      const result = await publishEvidence({
        shell: createHostShellRunner(cwd),
        options: {},
        runId: "run-1",
        repo: "o/r",
        issueUrl: "https://github.com/o/r/issues/1",
        artifactPath: (name) => join(artifacts, name),
        authorName: "Test",
        authorEmail: "test@example.com",
        reports: reports
          ? {
              iteration: 1,
              directory: "verify-1-reports",
              files: [
                { path: "image.png", kind: "evidence", bytes: 4 },
                { path: "report.xml", kind: "junit", bytes: 10 },
              ],
              skipped: [],
            }
          : null,
      });
      assert.equal(result.status, "published");
      if (result.status !== "published") return;
      const remoteGit = (...args: string[]): Buffer =>
        execFileSync("git", ["--git-dir", remote, ...args]);
      assert.equal(
        remoteGit("rev-list", "--parents", "-n", "1", result.branch).toString().trim(),
        result.commit,
      );
      assert.deepEqual(
        remoteGit("ls-tree", "--name-only", result.commit).toString().trim().split("\n"),
        reports
          ? ["README.md", "image.png", "report.xml", "verify.log"]
          : ["README.md", "verify.log"],
      );
      if (reports) {
        assert.deepEqual(remoteGit("show", `${result.commit}:image.png`), binary);
        assert.equal(
          remoteGit("show", `${result.commit}:report.xml`).toString(),
          "[REDACTED]",
        );
      }
      assert.equal(git("status", "--porcelain"), before);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("branch", "--show-current").trim(), "main");
      assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an evidence push failure is returned with its diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "cage-evidence-fail-"));
  try {
    await writeFile(join(root, "verify.log"), "passed");
    const result = await publishEvidence({
      shell: {
        async run(_command, options) {
          assert.ok(options?.input?.includes("verify.log\n"));
          return { exitCode: 1, stdout: "", stderr: "remote denied contents write" };
        },
      },
      options: {},
      runId: "run-failure",
      repo: "o/r",
      issueUrl: "https://github.com/o/r/issues/1",
      artifactPath: (name) => join(root, name),
      reports: null,
      authorName: "Test",
      authorEmail: "test@example.com",
    });
    assert.deepEqual(result, {
      status: "failed",
      reason: "remote denied contents write",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
