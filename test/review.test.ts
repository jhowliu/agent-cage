import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  blockingReviewFeedback,
  buildReviewPrompt,
  execaReviewAgentRunner,
  parseReviewReport,
  reviewReportJsonSchema,
  reviewNextAction,
  runIndependentReview,
  type ReviewAgentRunner,
} from "../src/review.js";
import { formatPassedCommandForReview } from "../src/run/prompts.js";

function recordingReviewRunner(output: string): ReviewAgentRunner & {
  calls: Array<Parameters<ReviewAgentRunner["run"]>[0]>;
} {
  const calls: Array<Parameters<ReviewAgentRunner["run"]>[0]> = [];

  return {
    calls,
    async run(input): Promise<string> {
      calls.push(input);
      return output;
    },
  };
}

const passReportJson = JSON.stringify({
  decision: "pass",
  summary: "No blocking issues.",
  findings: [],
  prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.\n",
});

const blockingReportJson = JSON.stringify({
  decision: "blocking",
  summary: "Needs a fix.",
  findings: [
    {
      severity: "blocking",
      message: "Verification command is not wired.",
      path: "src/run.ts",
      line: 42,
    },
  ],
  prDescription: null,
});

test("buildReviewPrompt includes read-only instructions and required context", () => {
  const prompt = buildReviewPrompt({
    issueContext: "Issue: add review",
    diff: "diff --git a/src/app.ts b/src/app.ts",
    verificationSummary: "npm test passed",
    reviewPolicyStatus:
      "Target review policy: present at /workspace/.agent-cage/review-policy.md.",
    resultMetadata: {
      runId: "run-1",
      verify: ["npm test"],
    },
  });

  assert.match(prompt, /read-only reviewer/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /Issue: add review/);
  assert.match(prompt, /Verification results:\nEvery verify command passed\./);
  assert.match(prompt, /npm test passed/);
  assert.match(prompt, /Target review policy: present/);
  assert.match(prompt, /"runId": "run-1"/);
  assert.match(prompt, /diff --git/);
});

test("a passed command shows the reviewer only the last lines of each output stream", () => {
  const tap = Array.from({ length: 40 }, (_, index) => `ok ${index + 1} - case`);
  const summary = formatPassedCommandForReview(
    "npm test",
    {
      stdout: `${[...tap, "# pass 40", "# fail 0"].join("\n")}\n\n`,
      stderr: "npm notice\n",
    },
    3,
  );

  assert.equal(
    summary,
    [
      "`npm test` passed.",
      "Last 3 of 42 lines of stdout:",
      "    ok 40 - case",
      "    # pass 40",
      "    # fail 0",
      "stderr:",
      "    npm notice",
    ].join("\n"),
  );
  assert.equal(
    formatPassedCommandForReview("npm run lint", { stdout: "", stderr: "  \n" }),
    "`npm run lint` passed.",
  );
});

test("buildReviewPrompt explains the red-green results only when the run wrote tests first", () => {
  const input = {
    issueContext: "Issue: fix divide",
    diff: "diff --git a/src/math.js b/src/math.js",
    verificationSummary: "npm test passed",
    resultMetadata: { runId: "run-1" },
  };
  const withCheck = buildReviewPrompt({
    ...input,
    redGreenSummary:
      "- `test/math.test.js`: written first, but already passed before the code was written.",
  });

  assert.match(
    withCheck,
    /Red-green \(test-driven development\): the agent wrote tests before the code/,
  );
  assert.match(
    withCheck,
    /does not test the change\. Treat it as blocking unless what was asked/,
  );
  assert.match(withCheck, /only because what it imports did not exist yet/);
  assert.match(withCheck, /changed after it failed may have been weakened/);
  assert.match(withCheck, /`test\/math\.test\.js`: written first, but already passed/);
  assert.doesNotMatch(buildReviewPrompt(input), /Red-green/);
});

test("buildReviewPrompt asks a passing review for a PR description that follows the repo's rules", () => {
  const prompt = buildReviewPrompt({
    issueContext: "Issue: add review",
    diff: "diff --git a/src/app.ts b/src/app.ts",
    verificationSummary: "npm test passed",
    resultMetadata: { runId: "run-1" },
  });

  assert.match(prompt, /"prDescription": "Markdown pull request description" or null/);
  assert.match(
    prompt,
    /pull request description rules in the AGENTS\.md and CLAUDE\.md files/,
  );
  assert.match(
    prompt,
    /Agent Cage appends the verification results, this review's status, the run ID and the issue link/,
  );
  assert.match(prompt, /When the decision is "blocking", set "prDescription" to null/);
});

test("parseReviewReport accepts strict structured JSON from the review agent", () => {
  assert.deepEqual(parseReviewReport(`\n\`\`\`json\n${blockingReportJson}\n\`\`\`\n`), {
    decision: "blocking",
    summary: "Needs a fix.",
    findings: [
      {
        severity: "blocking",
        message: "Verification command is not wired.",
        path: "src/run.ts",
        line: 42,
      },
    ],
    prDescription: null,
  });
});

test("parseReviewReport ignores non-json fenced blocks before JSON", () => {
  assert.deepEqual(
    parseReviewReport(`\n\`\`\`bash\n-code\n\`\`\`\n\n${passReportJson}\n`),
    {
      decision: "pass",
      summary: "No blocking issues.",
      findings: [],
      prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.",
    },
  );
});

test("parseReviewReport normalizes nullable structured output fields", () => {
  assert.deepEqual(
    parseReviewReport(
      JSON.stringify({
        decision: "blocking",
        summary: "Needs a fix.",
        findings: [
          {
            severity: "blocking",
            message: "Missing required behavior.",
            path: null,
            line: null,
          },
        ],
      }),
    ),
    {
      decision: "blocking",
      summary: "Needs a fix.",
      findings: [
        {
          severity: "blocking",
          message: "Missing required behavior.",
        },
      ],
      prDescription: null,
    },
  );
});

test("parseReviewReport keeps a PR description only from a passing review", () => {
  const pass = { decision: "pass", summary: "ok", findings: [] };
  const blocking = JSON.parse(blockingReportJson) as Record<string, unknown>;

  assert.equal(parseReviewReport(JSON.stringify(pass)).prDescription, null, "left out");
  assert.equal(
    parseReviewReport(JSON.stringify({ ...pass, prDescription: "  \n" })).prDescription,
    null,
    "blank",
  );
  assert.equal(
    parseReviewReport(JSON.stringify({ ...blocking, prDescription: "Adds review." }))
      .prDescription,
    null,
    "a blocking review's diff changes before publish",
  );
});

test("review report JSON schema requires every finding property", () => {
  assert.deepEqual(reviewReportJsonSchema.properties.findings.items.required, [
    "severity",
    "message",
    "path",
    "line",
  ]);
});

test("parseReviewReport rejects passing reports with blocking findings", () => {
  assert.throws(
    () =>
      parseReviewReport(
        JSON.stringify({
          decision: "pass",
          summary: "looks good",
          findings: [{ severity: "blocking", message: "bug" }],
        }),
      ),
    /Passing review reports cannot contain blocking findings/,
  );
});

test("reviewNextAction allows passing review to continue", () => {
  assert.deepEqual(
    reviewNextAction({
      report: parseReviewReport(passReportJson),
      cycle: 0,
      maxReviewCycles: 2,
    }),
    {
      action: "continue",
      prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.",
    },
  );
});

test("reviewNextAction feeds blocking findings back until max review cycles", () => {
  assert.deepEqual(
    reviewNextAction({
      report: parseReviewReport(blockingReportJson),
      cycle: 0,
      maxReviewCycles: 2,
    }),
    {
      action: "fix",
      nextCycle: 1,
      feedback: "1. Verification command is not wired. (src/run.ts:42)",
    },
  );

  assert.deepEqual(
    reviewNextAction({
      report: parseReviewReport(blockingReportJson),
      cycle: 2,
      maxReviewCycles: 2,
    }),
    {
      action: "fail",
      failureCode: "review_blocking",
      feedback: "1. Verification command is not wired. (src/run.ts:42)",
    },
  );
});

test("blockingReviewFeedback formats blocking findings for the implementer", () => {
  assert.equal(
    blockingReviewFeedback(parseReviewReport(blockingReportJson)),
    "1. Verification command is not wired. (src/run.ts:42)",
  );
});

test("runIndependentReview runs a fresh review runner and returns parsed action", async () => {
  const runner = recordingReviewRunner(passReportJson);
  const diff = "diff --git a/src/app.ts b/src/app.ts";
  const result = await runIndependentReview({
    cwd: "/repo",
    agent: { provider: "codex", model: "gpt-5.4" },
    cycle: 0,
    maxReviewCycles: 2,
    issueContext: "Issue context",
    diff,
    verificationSummary: "npm test passed",
    resultMetadata: { runId: "run-1" },
    readCurrentDiff: async () => diff,
    runner,
    env: { OPENAI_API_KEY: "secret" },
  });

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.cwd, "/repo");
  assert.deepEqual(runner.calls[0]?.agent, { provider: "codex", model: "gpt-5.4" });
  assert.equal(runner.calls[0]?.outputSchema.type, "object");
  assert.deepEqual(runner.calls[0]?.outputSchema.required, [
    "decision",
    "summary",
    "findings",
    "prDescription",
  ]);
  assert.deepEqual(runner.calls[0]?.env, { OPENAI_API_KEY: "secret" });
  assert.equal(result.report.decision, "pass");
  assert.deepEqual(result.nextAction, {
    action: "continue",
    prDescription: "Adds review.\n\n## How to use\n\nRun `npm test`.",
  });
});

test("runIndependentReview fails if the read-only review changes the diff", async () => {
  const runner = recordingReviewRunner(passReportJson);

  await assert.rejects(
    () =>
      runIndependentReview({
        cwd: "/repo",
        agent: { provider: "codex", model: "gpt-5.4" },
        cycle: 0,
        maxReviewCycles: 2,
        issueContext: "Issue context",
        diff: "before",
        verificationSummary: "npm test passed",
        resultMetadata: { runId: "run-1" },
        readCurrentDiff: async () => "after",
        runner,
      }),
    { name: "ReviewModifiedDiffError" },
  );
});

test("host review runners pass effort to each CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cage-review-effort-"));
  try {
    for (const provider of ["codex", "claude", "agy"] as const) {
      const log = join(dir, `${provider}.log`);
      const script = join(dir, provider);
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\ncat > /dev/null\necho '{"type":"result","is_error":false,"result":"ok"}'\necho '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'\n`,
        { mode: 0o755 },
      );
    }
    const env = { PATH: `${dir}:${process.env.PATH ?? ""}` };
    const run = async (
      provider: "codex" | "claude" | "agy",
      effort: "xhigh" | undefined,
    ): Promise<string[]> => {
      await execaReviewAgentRunner.run({
        cwd: dir,
        agent:
          effort === undefined
            ? { provider, model: "m" }
            : { provider, model: "m", effort },
        prompt: "p",
        outputSchema: {},
        env,
      });
      return (await readFile(join(dir, `${provider}.log`), "utf8")).split("\n");
    };

    const codexArgs = await run("codex", "xhigh");
    const at = codexArgs.indexOf("-c");
    assert.equal(codexArgs[at + 1], 'model_reasoning_effort="xhigh"');
    assert.ok(!(await run("codex", undefined)).includes("-c"));

    for (const provider of ["claude", "agy"] as const) {
      const args = await run(provider, "xhigh");
      assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
      assert.ok(!(await run(provider, undefined)).includes("--effort"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
