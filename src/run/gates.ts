import { publishEvidence } from "./evidence.js";
import {
  assertNoGuardViolations,
  guardAttemptDecision,
  GuardViolationError,
  scanDiffForGuardViolations,
} from "../guards.js";
import {
  NoDiffError,
  publishRevision,
  publishSuccessfulRun,
  type PublishSuccessfulRunResult,
} from "../publish.js";
import { formatReviewPolicyForPrompt } from "../prompt-context.js";
import type { RuntimeContext } from "../run-workflow.js";
import {
  buildReviewPrompt,
  runIndependentReview,
  type ReviewNextAction,
  type ReviewReport,
} from "../review.js";
import {
  createGhCommandRunner,
  createGitCommandRunner,
  createReviewAgentRunner,
  readCurrentDiff,
  type ShellRunner,
} from "../sandbox-execution.js";
import type { FailureCode, PhaseName, ReviewDecision, RunStatus } from "../state.js";
import { RunFailureError } from "./errors.js";
import { formatReviewIssueContext } from "./prompts.js";
import { formatRedGreenSummary, type RedGreenReport } from "./red-green.js";
import type { ReportCollection } from "./reports.js";

/**
 * `reviewSummary` is what the review agent sees of a passed verify: each
 * command with the last lines of its output, not the full log in verify.log.
 * `reports` is null when the config declares no report files.
 */
export type VerificationResult =
  | {
      passed: true;
      reviewSummary: string;
      items: string[];
      reports: ReportCollection | null;
    }
  | { passed: false; feedback: string; reports: ReportCollection | null };

type RunGatePhaseBody = () => Promise<string | undefined>;

export type RunGateJournal = {
  artifactPath?: (name: string) => string;
  setRunStatus: (status: RunStatus) => Promise<void>;
  runPhase: <TValue = undefined>(
    name: PhaseName,
    body: RunGatePhaseBody | (() => Promise<{ log: string; value: TValue }>),
  ) => Promise<TValue>;
  addReviewCycle: (input: {
    cycle: number;
    decision: ReviewDecision;
    report: ReviewReport;
  }) => Promise<void>;
  writeArtifact: (name: string, content: string) => Promise<string>;
  writeJsonArtifact: (name: string, value: unknown) => Promise<void>;
};

export type SecretGuardGateResult =
  | { action: "pass" }
  | {
      action: "retry";
      feedback: string;
      guardAttempt: number;
      lastFailure: FailureCode;
    };

export function runSecretGuardGate(input: {
  context: RuntimeContext;
  diff: string;
  guardAttempt: number;
}): SecretGuardGateResult {
  const violations = scanDiffForGuardViolations(input.diff, {
    injectedSecrets: input.context.credentials.injectedSecrets(),
  });

  try {
    assertNoGuardViolations(violations);
    return { action: "pass" };
  } catch (error) {
    if (!(error instanceof GuardViolationError)) {
      throw error;
    }

    const decision = guardAttemptDecision({
      attempt: input.guardAttempt,
      maxAttempts: input.context.config.guards.max_secret_fix_attempts,
    });

    if (decision.action === "fail") {
      throw new RunFailureError("secret_guard_failed", error.message);
    }

    return {
      action: "retry",
      feedback: `Secret guard violations must be fixed:\n${error.message}`,
      guardAttempt: decision.nextAttempt,
      lastFailure: "secret_guard_failed",
    };
  }
}

export async function runReviewGate(input: {
  context: RuntimeContext;
  journal: RunGateJournal;
  shell: ShellRunner;
  redactor: (input: string) => string;
  review: typeof runIndependentReview;
  diff: string;
  verification: Extract<VerificationResult, { passed: true }>;
  redGreen: RedGreenReport | null;
  iteration: number;
  reviewCycle: number;
}): Promise<ReviewNextAction> {
  await input.journal.setRunStatus("reviewing");
  const reviewResult = await input.journal.runPhase("review", async () => {
    const reviewIssueContext = formatReviewIssueContext(input.context);
    const reviewPolicyStatus = formatReviewPolicyForPrompt(input.context.promptContext);
    const resultMetadata = {
      runId: input.context.runId,
      iteration: input.iteration,
      repo: input.context.repoResolution.repo.fullName,
    };
    const redGreenSummary =
      input.redGreen === null ? undefined : formatRedGreenSummary(input.redGreen);
    const reviewPrompt = buildReviewPrompt({
      issueContext: reviewIssueContext,
      verificationSummary: input.verification.reviewSummary,
      redGreenSummary,
      reviewPolicyStatus,
      resultMetadata,
      diff: input.diff,
    });
    await input.journal.writeArtifact(
      `review-prompt-${input.reviewCycle}.md`,
      input.redactor(reviewPrompt),
    );
    const reviewCredentials = input.context.credentials.command("review");
    const result = await input.review({
      cwd: input.context.cwd,
      agent: input.context.agents.review,
      cycle: input.reviewCycle,
      maxReviewCycles: input.context.config.agent.max_review_cycles,
      issueContext: reviewIssueContext,
      diff: input.diff,
      verificationSummary: input.verification.reviewSummary,
      redGreenSummary,
      reviewPolicyStatus,
      resultMetadata,
      readCurrentDiff: async () => await readRunDiff(input.shell, input.context),
      runner: createReviewAgentRunner(
        input.shell,
        reviewCredentials,
        input.context.executionMode,
      ),
      ...(reviewCredentials.env === undefined ? {} : { env: reviewCredentials.env }),
    });

    await input.journal.addReviewCycle({
      cycle: input.reviewCycle,
      decision: result.report.decision,
      report: result.report,
    });

    return {
      log: input.redactor(JSON.stringify(result.report, null, 2)),
      value: result,
    };
  });

  return reviewResult.nextAction;
}

export async function runPublishGate(input: {
  context: RuntimeContext;
  journal: RunGateJournal;
  shell: ShellRunner;
  redactor: (input: string) => string;
  publish: typeof publishSuccessfulRun;
  revise: typeof publishRevision;
  verification: Extract<VerificationResult, { passed: true }>;
  description: string | null;
}): Promise<PublishSuccessfulRunResult> {
  await input.journal.setRunStatus("creating_pr");
  // Publishing commits the workspace; reading HEAD's diff afterwards loses the
  // very changes that the results view and final artifact need to show.
  await input.journal.writeArtifact(
    "final.patch",
    input.redactor(await readRunDiff(input.shell, input.context)),
  );
  const publishResult = await input.journal.runPhase("pr", async () => {
    let result;
    const publishCredentials = input.context.credentials.command("publish");

    const artifactPath = input.journal.artifactPath?.bind(input.journal);
    const evidence =
      artifactPath === undefined
        ? undefined
        : await publishEvidence({
            shell: input.shell,
            options: publishCredentials,
            runId: input.context.runId,
            repo: input.context.repoResolution.repo.fullName,
            issueUrl: input.context.issue.url,
            artifactPath,
            reports: input.verification.reports,
            authorName: input.context.config.git.author_name,
            authorEmail: input.context.config.git.author_email,
          });
    const shared = {
      cwd: input.context.cwd,
      issue: input.context.issue,
      authorName: input.context.config.git.author_name,
      authorEmail: input.context.config.git.author_email,
      env: publishCredentials.env,
      metadata: {
        runId: input.context.runId,
        description: input.description,
        verification: input.verification.items,
        reviewStatus: "Independent review passed.",
        risks: [],
        ...(evidence === undefined ? {} : { evidence }),
      },
      git: createGitCommandRunner(input.shell, publishCredentials),
      gh: createGhCommandRunner(input.shell, publishCredentials),
    };
    const revision = input.context.revision;

    try {
      result =
        revision === null
          ? await input.publish({
              ...shared,
              repo: input.context.repoResolution.repo,
              baseBranch: input.context.baseBranch,
              branchName: input.context.branchName,
              draft: input.context.draft,
            })
          : await input.revise({ ...shared, revision });
    } catch (error) {
      if (error instanceof NoDiffError) {
        throw error;
      }

      throw new RunFailureError("pr_failed", input.redactor(formatError(error)));
    }

    return {
      log: input.redactor(JSON.stringify({ ...result, evidence }, null, 2)),
      value: result,
    };
  });

  await input.journal.writeJsonArtifact("pr.json", publishResult);

  return publishResult;
}

/**
 * Reads the change the run produced. A revision reviews the whole pull
 * request, so its diff starts at the merge base with the base branch.
 */
export async function readRunDiff(
  shell: ShellRunner,
  context: RuntimeContext,
): Promise<string> {
  return context.revision === null
    ? await readCurrentDiff(shell)
    : await readCurrentDiff(shell, `origin/${context.baseBranch}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
