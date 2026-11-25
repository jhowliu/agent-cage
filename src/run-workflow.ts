import { readCoverageItem } from "./run/coverage.js";
import { execaGhRunner, type CommandRunner } from "./publish.js";
import { publishEvidence } from "./run/evidence.js";
import { resolve } from "node:path";
import { agentShellCommand, type AgentAssignments } from "./agent/providers.js";
import {
  createComposeProject,
  hasComposeServices,
  type ComposeProject,
} from "./compose.js";
import type {
  AgentCageConfig,
  ExecutionMode,
  RedGreenConfig,
  ReportsConfig,
} from "./config.js";
import type { CommandCredentialIntent, RunCredentials } from "./credentials.js";
import {
  buildRuntimeImage,
  createDockerSandbox,
  unauthenticatedRemoteUrl,
  type DockerCommandOptions,
  type DockerSandbox,
  type DockerSandboxOptions,
  type RuntimeImageBuildResult,
} from "./docker.js";
import type { IssueContext } from "./issue.js";
import { scanDiffForGuardViolations } from "./guards.js";
import { NoDiffError, publishRevision, publishSuccessfulRun } from "./publish.js";
import type { PromptContext } from "./prompt-context.js";
import type { RevisionContext } from "./pull-request.js";
import type { AuthenticatedRepo, RepoResolution } from "./repo.js";
import { runIndependentReview, ReviewModifiedDiffError } from "./review.js";
import { RunFailureError } from "./run/errors.js";
import type { RunEventSink } from "./run/events.js";
import {
  readRunDiff,
  runPublishGate,
  runReviewGate,
  runSecretGuardGate,
  type VerificationResult,
} from "./run/gates.js";
import { RunJournal } from "./run/journal.js";
import {
  clearReports,
  collectReports,
  formatReportSummary,
  hasReports,
  prepareReportPaths,
  type ReportCollection,
} from "./run/reports.js";
import { formatJunitFailures, formatJunitItems, readJunitReports } from "./run/junit.js";
import {
  buildImplementationPrompt,
  buildTestFirstPrompt,
  formatPassedCommandForReview,
} from "./run/prompts.js";
import {
  checkGreen,
  checkRed,
  diffSince,
  findChangedTests,
  formatGreenCheckLog,
  formatGreenFeedback,
  formatLockFeedback,
  formatRedCheckLog,
  formatRedFeedback,
  formatRedGreenItems,
  recordRedCheck,
  restorePaths,
  snapshotWorkspace,
  testsPassingBeforeChange,
  testsWrittenFirst,
  type RedCheck,
  type RedGreenReport,
} from "./run/red-green.js";
import {
  createDockerShellRunner,
  createHostShellRunner,
  createHostWorkspace,
  createLineStreamSink,
  formatCommandLog,
  requiredAgentShell,
  requiredShell,
  type HostWorkspace,
  type ShellRunner,
  type ShellTimeouts,
  type StreamSink,
} from "./sandbox-execution.js";
import { shellQuote } from "./shell.js";
import type { FailureCode, PhaseName, RunStore } from "./state.js";

export type { ShellRunner } from "./sandbox-execution.js";

export type RunAgentCageResult = {
  runId: string;
  status: "succeeded" | "failed";
  failureCode: FailureCode | null;
  prUrl: string | null;
};

export type RunProgressEvent =
  | {
      type: "run_started";
      runId: string;
      issueKey: string;
      issueTitle: string;
      repo: string;
      branch: string;
      artifactDir: string;
    }
  | {
      type: "phase_started" | "phase_passed" | "phase_failed";
      runId: string;
      phase: PhaseName;
      logPath: string;
    }
  | {
      type: "iteration_started";
      runId: string;
      iteration: number;
      maxIterations: number;
    }
  | {
      type: "run_finished";
      runId: string;
      status: "succeeded" | "failed";
      failureCode: FailureCode | null;
      prUrl: string | null;
    };

export type RuntimeContext = {
  cwd: string;
  config: AgentCageConfig;
  configWarnings: string[];
  credentials: RunCredentials;
  issue: IssueContext;
  repoResolution: RepoResolution;
  authenticatedRepo: AuthenticatedRepo;
  baseBranch: string;
  agents: AgentAssignments;
  draft: boolean;
  runId: string;
  branchName: string;
  runtimeImage: RuntimeImageBuildResult & { source: "configured" | "built" };
  promptContext: PromptContext;
  executionMode: ExecutionMode;
  verbose: boolean;
  // Set when the run revises an open pull request instead of opening one.
  revision: RevisionContext | null;
};

export type RunWorkflowInput = {
  context: RuntimeContext;
  store: RunStore;
  createDockerSandbox?: (options: DockerSandboxOptions) => DockerSandbox;
  buildRuntimeImage?: typeof buildRuntimeImage;
  createShellRunner?: (
    sandbox: DockerSandbox,
    env: Record<string, string>,
    sink?: StreamSink,
    timeouts?: ShellTimeouts,
  ) => ShellRunner;
  createHostWorkspace?: typeof createHostWorkspace;
  createHostShellRunner?: typeof createHostShellRunner;
  createComposeProject?: typeof createComposeProject;
  runIndependentReview?: typeof runIndependentReview;
  publishSuccessfulRun?: typeof publishSuccessfulRun;
  publishRevision?: typeof publishRevision;
  failureGh?: CommandRunner;
  onProgress?: (event: RunProgressEvent) => void;
  onEvent?: RunEventSink;
};

export async function runWorkflow(input: RunWorkflowInput): Promise<RunAgentCageResult> {
  const context = input.context;
  const createSandbox = input.createDockerSandbox ?? createDockerSandbox;
  const buildImage = input.buildRuntimeImage ?? buildRuntimeImage;
  const makeShellRunner = input.createShellRunner ?? createDockerShellRunner;
  const makeHostWorkspace = input.createHostWorkspace ?? createHostWorkspace;
  const makeHostShellRunner = input.createHostShellRunner ?? createHostShellRunner;
  const makeComposeProject = input.createComposeProject ?? createComposeProject;
  const review = input.runIndependentReview ?? runIndependentReview;
  const publish = input.publishSuccessfulRun ?? publishSuccessfulRun;
  const revise = input.publishRevision ?? publishRevision;
  const onProgress = input.onProgress ?? (() => undefined);
  const journal = new RunJournal(input.store, context, onProgress, input.onEvent);
  const redactor = context.credentials.redactor();
  // In verbose mode, stream redacted command output to stdout so progress is
  // visible live (locally and, crucially, in CI logs where files are not).
  const streamSink = context.verbose
    ? createLineStreamSink((line) => process.stdout.write(line), redactor)
    : undefined;
  const shellTimeouts: ShellTimeouts = {
    commandMs: context.config.timeouts.command_minutes * 60_000,
    idleMs: context.config.timeouts.idle_minutes * 60_000,
    deadlineAt: Date.now() + context.config.timeouts.total_minutes * 60_000,
  };
  const reportsState: { last: ReportCollection | null } = { last: null };
  const failureShell: { current: ShellRunner | null } = { current: null };
  const registerFailureShell = (runner: ShellRunner): void => {
    failureShell.current = runner;
  };
  let sandbox: DockerSandbox | null = null;
  let shell: ShellRunner | null = null;
  let compose: ComposeProject | null = null;
  let hostWorkspace: HostWorkspace | null = null;

  try {
    await journal.startRun();
    await journal.startStage("prepare");
    await journal.writeJsonArtifact("issue.json", context.issue);
    await journal.writePromptContextArtifact();
    if (context.revision !== null) {
      await journal.writeJsonArtifact("revision.json", context.revision);
    }
    await journal.writeJsonArtifact("resolved-config.json", {
      config: context.config,
      warnings: context.configWarnings,
      repoSource: context.repoResolution.source,
      executionMode: context.executionMode,
      runtimeImage: context.runtimeImage,
    });

    await journal.runPhase("preflight", async () => {
      return [
        `Issue: ${context.issue.identifier} ${context.issue.title}`,
        `Repo: ${context.repoResolution.repo.fullName}`,
        `Base: ${context.baseBranch}`,
        `Branch: ${context.branchName}`,
        ...(context.revision === null
          ? []
          : [
              `Pull request: ${context.revision.pullRequest.url}`,
              `Feedback items: ${context.revision.feedback.length}`,
            ]),
      ].join("\n");
    });

    if (context.executionMode === "direct") {
      shell = await provisionDirectWorkspace({
        context,
        journal,
        redactor,
        sink: streamSink,
        createHostWorkspace: makeHostWorkspace,
        createHostShellRunner: makeHostShellRunner,
        shellTimeouts,
        registerFailureShell,
        registerWorkspace: (workspace) => {
          hostWorkspace = workspace;
        },
      });
    } else {
      const provisioned = await provisionDockerSandbox({
        context,
        journal,
        redactor,
        sink: streamSink,
        createSandbox,
        buildImage,
        makeShellRunner,
        makeComposeProject,
        shellTimeouts,
        registerFailureShell,
        registerCompose: (project) => {
          compose = project;
        },
        registerSandbox: (created) => {
          sandbox = created;
        },
      });
      shell = provisioned;
    }

    const shellRunner = shell;

    const reportsConfig = context.config.reports;
    if (context.config.setup.length > 0 || hasReports(reportsConfig)) {
      await journal.setRunStatus("setup");
      try {
        await journal.runPhase("setup", async () => {
          const logs: string[] = [];
          if (hasReports(reportsConfig)) {
            logs.push(await prepareReportPaths(shellRunner, reportsConfig));
          }
          for (const command of context.config.setup) {
            logs.push(
              await requiredShell(
                shellRunner,
                command,
                redactor,
                runtimeCommandCredentials("setup", context),
              ),
            );
          }
          return logs.join("\n");
        });
      } catch (error) {
        if (error instanceof RunFailureError) throw error;
        throw new RunFailureError("setup_failed", formatError(error));
      }
    }

    await journal.finishStage();

    const runResult = await runImplementationLoop({
      context,
      journal,
      shell: shellRunner,
      redactor,
      review,
      publish,
      revise,
      onReports: (reports) => {
        reportsState.last = reports;
      },
    });

    return runResult;
  } catch (error) {
    const failureCode = failureCodeFromError(error);
    if (shell !== null) {
      try {
        const failedDiff = await readRunDiff(shell, context);
        const violations = scanDiffForGuardViolations(failedDiff, {
          injectedSecrets: context.credentials.injectedSecrets(),
        });
        if (failedDiff.trim() !== "" && violations.length === 0) {
          await journal.writeArtifact("final.patch", redactor(failedDiff));
        }
      } catch {
        // Failure reporting must not hide the original run failure.
      }
    }
    await journal.recordFailure(failureCode, error);
    // Reporting is best effort and must preserve the original result.
    try {
      const evidence =
        failureShell.current !== null &&
        reportsState.last !== null &&
        reportsState.last.files.length > 0
          ? await publishEvidence({
              shell: failureShell.current,
              options: context.credentials.command("publish"),
              runId: context.runId,
              repo: context.repoResolution.repo.fullName,
              issueUrl: context.issue.url,
              artifactPath: (name) => journal.artifactPath(name),
              reports: reportsState.last,
              authorName: context.config.git.author_name,
              authorEmail: context.config.git.author_email,
            })
          : null;
      if (evidence?.status === "failed")
        console.error(redactor(`Failure evidence: ${evidence.reason}`));
      if (context.issue.source === "github") {
        const junit = await readJunitReports(
          (name) => journal.artifactPath(name),
          reportsState.last,
        );
        const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
        const body = redactor(
          [
            `Agent Cage failed (\`${failureCode}\`): ${formatError(error).split(/\r?\n/)[0] ?? "Run failed"}`,
            formatJunitFailures(junit),
            evidence?.status === "published"
              ? `[Evidence branch](https://github.com/${evidence.repo}/tree/${evidence.branch})`
              : null,
            GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
              ? `[Actions run](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID})`
              : null,
          ]
            .filter((line) => line !== null)
            .join("\n\n"),
        );
        const result = await (input.failureGh ?? execaGhRunner).run(
          [
            context.revision === null ? "issue" : "pr",
            "comment",
            context.revision?.pullRequest.url ?? context.issue.url,
            "--body",
            body,
          ],
          { cwd: context.cwd, env: context.credentials.command("publish").env },
        );
        if (result.exitCode !== 0)
          throw new Error(result.stderr || result.stdout || "Comment API failed");
      }
    } catch (reportError) {
      console.error(
        redactor(`Failed to report run failure: ${formatError(reportError)}`),
      );
    }

    const runResult: RunAgentCageResult = {
      runId: context.runId,
      status: "failed",
      failureCode,
      prUrl: null,
    };

    return runResult;
  } finally {
    await cleanupRuntime(compose, sandbox, hostWorkspace);
  }
}

async function provisionDockerSandbox(input: {
  context: RuntimeContext;
  journal: RunJournal;
  redactor: (value: string) => string;
  sink: StreamSink | undefined;
  createSandbox: (options: DockerSandboxOptions) => DockerSandbox;
  buildImage: typeof buildRuntimeImage;
  makeShellRunner: (
    sandbox: DockerSandbox,
    env: Record<string, string>,
    sink?: StreamSink,
    timeouts?: ShellTimeouts,
  ) => ShellRunner;
  makeComposeProject: typeof createComposeProject;
  registerCompose: (project: ComposeProject) => void;
  registerSandbox: (sandbox: DockerSandbox) => void;
  shellTimeouts: ShellTimeouts;
  registerFailureShell: (shell: ShellRunner) => void;
}): Promise<ShellRunner> {
  const { context, journal, redactor } = input;
  const runtimeDockerfile = context.config.runtime.dockerfile;

  if (runtimeDockerfile !== null) {
    try {
      context.runtimeImage = await journal.runPhase("runtime_image", async () => {
        const result = await input.buildImage({
          runId: context.runId,
          dockerfilePath: resolve(context.cwd, runtimeDockerfile),
          contextPath: resolve(context.cwd, ".agent-cage"),
        });

        return {
          log: [
            `Built runtime image: ${result.image}`,
            `Dockerfile: ${result.dockerfilePath}`,
            `Build context: ${result.contextPath}`,
          ].join("\n"),
          value: { ...result, source: "built" as const },
        };
      });
    } catch (error) {
      throw new RunFailureError("runtime_image_failed", formatError(error));
    }
  }

  await journal.writeJsonArtifact("runtime-image.json", context.runtimeImage);

  let compose: ComposeProject | null = null;

  if (hasComposeServices(context.config.services)) {
    const composeFile = context.config.services.compose;

    if (composeFile === null) {
      throw new RunFailureError("invalid_config", "Compose file is not configured.");
    }

    compose = input.makeComposeProject({
      runId: context.runId,
      composeFile: resolve(context.cwd, composeFile),
      projectDirectory: context.cwd,
      readyCommands: context.config.services.ready,
    });
    input.registerCompose(compose);
    try {
      await journal.runPhase("setup", async () => {
        await compose?.up();
        await compose?.waitUntilReady();
        return "Compose services are ready.";
      });
    } catch (error) {
      throw new RunFailureError("setup_failed", formatError(error));
    }
  }

  const cloneCredentials = runtimeCommandCredentials("clone", context);
  const sandboxOptions: DockerSandboxOptions = {
    runId: context.runId,
    cloneUrl: context.authenticatedRepo.cloneUrl,
    image: context.runtimeImage.image,
    env: cloneCredentials.env ?? {},
  };

  if (compose !== null) {
    sandboxOptions.serviceNetworkName = compose.networkName;
  }

  const sandbox = input.createSandbox(sandboxOptions);
  input.registerSandbox(sandbox);
  // Failure evidence is published after the journal has closed its final stage.
  const rawShell = input.makeShellRunner(sandbox, {}, input.sink, input.shellTimeouts);
  input.registerFailureShell(rawShell);
  const shell = journal.instrumentShell(rawShell);

  await journal.setRunStatus("cloning");
  await journal.runPhase("cloning", async () => {
    await sandbox.create();
    return await asCloneFailure(async () => {
      await sandbox.cloneRepository();
      return await requiredShell(
        shell,
        checkoutCommand(context),
        redactor,
        cloneCredentials,
      );
    });
  });

  return shell;
}

async function provisionDirectWorkspace(input: {
  context: RuntimeContext;
  journal: RunJournal;
  redactor: (value: string) => string;
  sink: StreamSink | undefined;
  createHostWorkspace: typeof createHostWorkspace;
  createHostShellRunner: typeof createHostShellRunner;
  registerWorkspace: (workspace: HostWorkspace) => void;
  shellTimeouts: ShellTimeouts;
  registerFailureShell: (shell: ShellRunner) => void;
}): Promise<ShellRunner> {
  const { context, journal, redactor } = input;

  await journal.writeJsonArtifact("runtime-image.json", context.runtimeImage);

  const cloneCredentials = runtimeCommandCredentials("clone", context);
  const workspace = await input.createHostWorkspace(context.runId);
  input.registerWorkspace(workspace);
  const rawShell = input.createHostShellRunner(
    workspace.workspacePath,
    {},
    input.sink,
    input.shellTimeouts,
  );
  input.registerFailureShell(rawShell);
  const shell = journal.instrumentShell(rawShell);

  await journal.setRunStatus("cloning");
  await journal.runPhase("cloning", async () =>
    asCloneFailure(async () => {
      const remoteUrl = unauthenticatedRemoteUrl(context.authenticatedRepo.cloneUrl);
      await requiredShell(
        shell,
        `git clone ${shellQuote(remoteUrl)} . && git remote set-url origin ${shellQuote(
          remoteUrl,
        )}`,
        redactor,
        cloneCredentials,
      );
      return await requiredShell(
        shell,
        checkoutCommand(context),
        redactor,
        cloneCredentials,
      );
    }),
  );

  return shell;
}

/**
 * Checks out the branch the run works on: the base branch for a new pull
 * request, or the pull request's branch for a revision. A revision fetches the
 * base too, since its diff starts at the merge base with it.
 */
function checkoutCommand(context: RuntimeContext): string {
  const base = shellQuote(context.baseBranch);

  if (context.revision === null) {
    return `git fetch origin ${base} && git checkout ${base} && git pull --ff-only origin ${base}`;
  }

  const headBranch = context.revision.pullRequest.headBranch;
  const head = shellQuote(headBranch);
  return `git fetch origin ${base} ${head} && git checkout -B ${head} ${shellQuote(
    `origin/${headBranch}`,
  )}`;
}

/**
 * Reports clone and base-branch checkout failures (missing repo access, an
 * empty repository, an unknown base branch) as clone_failed. Failures that
 * already carry a code, such as docker_unavailable or timeout, pass through.
 */
async function asCloneFailure<T>(clone: () => Promise<T>): Promise<T> {
  try {
    return await clone();
  } catch (error) {
    if (error instanceof RunFailureError) throw error;
    throw new RunFailureError("clone_failed", formatError(error));
  }
}

function runtimeCommandCredentials(
  intent: CommandCredentialIntent,
  context: RuntimeContext,
): DockerCommandOptions {
  return context.credentials.command(intent);
}

async function runImplementationLoop(input: {
  context: RuntimeContext;
  journal: RunJournal;
  shell: ShellRunner;
  redactor: (input: string) => string;
  review: typeof runIndependentReview;
  publish: typeof publishSuccessfulRun;
  revise: typeof publishRevision;
  onReports: (reports: ReportCollection | null) => void;
}): Promise<RunAgentCageResult> {
  const feedback: string[] = [];
  let reviewCycle = 0;
  let guardAttempt = 0;
  let lastFailure: FailureCode = "verify_failed";
  const redGreenConfig = input.context.config.guards.red_green;
  const tdd: TddState | null =
    redGreenConfig === null
      ? null
      : {
          config: redGreenConfig,
          report: { tests: [], changedAfterRed: [] },
          lock: null,
          lockFeedbackGiven: false,
          writeTestsNext: true,
        };

  for (
    let iteration = 1;
    iteration <= input.context.config.agent.max_iterations;
    iteration += 1
  ) {
    await input.journal.setRunStatus("implementing");
    await input.journal.startStage("implement");
    await input.journal.iterationStarted(
      iteration,
      input.context.config.agent.max_iterations,
    );
    if (tdd !== null && tdd.writeTestsNext) {
      await runRedStep({ ...input, tdd, iteration, feedback });
      tdd.writeTestsNext = false;
    }
    await input.journal.runPhase("implement", async () => {
      const prompt = buildImplementationPrompt({
        context: input.context,
        iteration,
        feedback,
        testsWrittenFirst: tdd === null ? undefined : testsWrittenFirst(tdd.report),
      });
      await input.journal.writeArtifact(
        `implementation-prompt-${iteration}.md`,
        input.redactor(prompt),
      );

      return await requiredAgentShell(
        input.shell,
        {
          role: "implement",
          agent: input.context.agents.implement,
          agentCommand: agentShellCommand(input.context.agents.implement, {
            access: "workspace-write",
            prompt,
            executionMode: input.context.executionMode,
          }),
        },
        input.redactor,
        runtimeCommandCredentials("implement", input.context),
      );
    });
    if (tdd !== null) {
      await runTestLock({ ...input, tdd, feedback });
    }
    await input.journal.finishStage();

    await input.journal.setRunStatus("verifying");
    await input.journal.startStage("verify");
    const verification = await runVerificationCommands({
      journal: input.journal,
      shell: input.shell,
      commands: input.context.config.verify,
      reports: input.context.config.reports,
      iteration,
      onReports: input.onReports,
      redactor: input.redactor,
      commandOptions: runtimeCommandCredentials("verify", input.context),
    });

    if (!verification.passed) {
      lastFailure = "verify_failed";
      feedback.push(verification.feedback);
      if (iteration === input.context.config.agent.max_iterations) {
        throw maxIterationsError(lastFailure);
      }
      await input.journal.failStage("verify_failed");
      continue;
    }

    const greenFeedback =
      tdd === null ? null : await runGreenCheck({ ...input, tdd, iteration });
    if (greenFeedback !== null) {
      lastFailure = "verify_failed";
      feedback.push(greenFeedback);
      if (iteration === input.context.config.agent.max_iterations) {
        throw maxIterationsError(lastFailure);
      }
      await input.journal.failStage("verify_failed");
      continue;
    }

    const diff = await readRunDiff(input.shell, input.context);
    if (verification.reports?.files.some((file) => file.kind === "lcov")) {
      const workspace = await input.shell.run("pwd", { onData: (): void => undefined });
      const coverage = await readCoverageItem(
        (name) => input.journal.artifactPath(name),
        verification.reports,
        diff,
        input.context.executionMode === "docker" ? "/workspace" : workspace.stdout.trim(),
      );
      if (coverage !== null) {
        const item = input.redactor(coverage);
        verification.items.push(item);
        verification.reviewSummary += `\n\n${item}`;
      }
    }

    let secretGuard: ReturnType<typeof runSecretGuardGate>;
    try {
      secretGuard = runSecretGuardGate({
        context: input.context,
        diff,
        guardAttempt,
      });
    } catch (error) {
      if (
        error instanceof RunFailureError &&
        error.failureCode === "secret_guard_failed"
      ) {
        await input.journal.recordSecretGuard({ status: "failed", retryable: false });
      }
      throw error;
    }

    if (secretGuard.action === "retry") {
      await input.journal.recordSecretGuard({ status: "failed", retryable: true });
      guardAttempt = secretGuard.guardAttempt;
      lastFailure = secretGuard.lastFailure;
      feedback.push(secretGuard.feedback);
      if (iteration === input.context.config.agent.max_iterations) {
        throw maxIterationsError(lastFailure);
      }
      await input.journal.failStage("secret_guard_failed");
      continue;
    }

    await input.journal.recordSecretGuard({ status: "passed", retryable: false });
    // Preserve the reviewed change while it is still uncommitted. Only expose it
    // after the secret gate has accepted it, including during a live review.
    await input.journal.writeArtifact(`changes-${iteration}.patch`, input.redactor(diff));
    await input.journal.finishStage();
    const checked = {
      ...verification,
      items: [
        ...verification.items,
        ...(tdd === null ? [] : formatRedGreenItems(tdd.report)),
      ],
    };

    await input.journal.startStage("review");
    const reviewAction = await runReviewGate({
      context: input.context,
      journal: input.journal,
      shell: input.shell,
      redactor: input.redactor,
      review: input.review,
      diff,
      verification: checked,
      redGreen: tdd?.report ?? null,
      iteration,
      reviewCycle,
    });

    if (reviewAction.action === "fix") {
      reviewCycle = reviewAction.nextCycle;
      // What the review asks for gets its own failing tests before the code.
      if (tdd !== null) {
        tdd.writeTestsNext = true;
      }
      lastFailure = "review_blocking";
      feedback.push(
        `Independent review found blocking issues:\n${reviewAction.feedback}`,
      );
      if (iteration === input.context.config.agent.max_iterations) {
        throw maxIterationsError(lastFailure);
      }
      await input.journal.failStage("review_blocking");
      continue;
    }

    if (reviewAction.action === "fail") {
      throw new RunFailureError("review_blocking", reviewAction.feedback);
    }

    await input.journal.finishStage();

    await input.journal.startStage("publish");
    const publishResult = await runPublishGate({
      context: input.context,
      journal: input.journal,
      shell: input.shell,
      redactor: input.redactor,
      publish: input.publish,
      revise: input.revise,
      verification: checked,
      description: reviewAction.prDescription,
    });
    await input.journal.recordSuccess(publishResult);

    return {
      runId: input.context.runId,
      status: "succeeded",
      failureCode: null,
      prUrl: publishResult.prUrl,
    };
  }

  throw maxIterationsError(lastFailure);
}

/**
 * Test-driven development state for one run, when the repo configures
 * `guards.red_green`. The red step runs in the first iteration and after each
 * blocking review; `lock` is the workspace the green step must not change the
 * tests of.
 */
type TddState = {
  config: RedGreenConfig;
  report: RedGreenReport;
  lock: string | null;
  lockFeedbackGiven: boolean;
  writeTestsNext: boolean;
};

type TddStepInput = {
  context: RuntimeContext;
  journal: RunJournal;
  shell: ShellRunner;
  redactor: (input: string) => string;
  tdd: TddState;
};

/**
 * The red step: the agent writes tests before the code, and each test file it
 * writes must fail on the code as it stands. Tests that already pass go back
 * to the agent once; if they still pass, the review decides, since a test of
 * behavior that already exists can be what was asked for.
 */
async function runRedStep(
  input: TddStepInput & { iteration: number; feedback: string[] },
): Promise<void> {
  const { tdd } = input;
  const before = await snapshotWorkspace(input.shell);
  const redFeedback: string[] = [];
  let check: RedCheck = { tests: [], reverted: [] };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await input.journal.runPhase("write_tests", async () => {
      const prompt = buildTestFirstPrompt({
        context: input.context,
        config: tdd.config,
        iteration: input.iteration,
        feedback: [...input.feedback, ...redFeedback],
      });
      await input.journal.writeArtifact(
        `test-prompt-${input.iteration}-${attempt}.md`,
        input.redactor(prompt),
      );

      return await requiredAgentShell(
        input.shell,
        {
          role: "implement",
          agent: input.context.agents.implement,
          agentCommand: agentShellCommand(input.context.agents.implement, {
            access: "workspace-write",
            prompt,
            executionMode: input.context.executionMode,
          }),
        },
        input.redactor,
        runtimeCommandCredentials("implement", input.context),
      );
    });
    check = await input.journal.runPhase("red_check", async () => {
      const value = await checkRed({
        shell: input.shell,
        config: tdd.config,
        before,
        redactor: input.redactor,
        commandOptions: runtimeCommandCredentials("verify", input.context),
      });
      return { log: formatRedCheckLog(value), value };
    });
    await input.journal.writeJsonArtifact(
      `red-check-${input.iteration}-${attempt}.json`,
      check,
    );

    const passing = testsPassingBeforeChange(check);
    if (passing.length === 0 || attempt === 2) {
      break;
    }
    redFeedback.push(formatRedFeedback(passing));
  }

  tdd.report = recordRedCheck(tdd.report, check);
  tdd.lock = await snapshotWorkspace(input.shell);
}

/**
 * Keeps the tests locked while the code is written. A changed test is
 * restored once, with feedback; changed again, it is kept and shown to the
 * review with its diff.
 */
async function runTestLock(input: TddStepInput & { feedback: string[] }): Promise<void> {
  const { tdd } = input;
  const lock = tdd.lock;
  if (lock === null) {
    return;
  }

  await input.journal.runPhase("test_lock", async () => {
    const changed = await findChangedTests(input.shell, tdd.config, lock);
    const files = changed.map((entry) => `\`${entry.path}\``).join(", ");
    if (changed.length === 0) {
      return "Locked tests are unchanged.";
    }

    if (!tdd.lockFeedbackGiven) {
      await restorePaths(input.shell, lock, changed);
      tdd.lockFeedbackGiven = true;
      input.feedback.push(formatLockFeedback(changed));
      return `Restored locked tests: ${files}.`;
    }

    // One git command at a time: concurrent ones contend for the index lock.
    const kept: { file: string; diff: string }[] = [];
    for (const entry of changed) {
      kept.push({
        file: entry.path,
        diff: input.redactor(await diffSince(input.shell, lock, [entry.path])),
      });
    }
    const keptFiles = new Set(kept.map((change) => change.file));
    tdd.report = {
      ...tdd.report,
      changedAfterRed: [
        ...tdd.report.changedAfterRed.filter((change) => !keptFiles.has(change.file)),
        ...kept,
      ],
    };
    return `Kept changes to locked tests for the review: ${files}.`;
  });
}

/**
 * The green check: every test file written first must pass now. Returns
 * feedback for the agent when one fails, or null.
 */
async function runGreenCheck(
  input: TddStepInput & { iteration: number },
): Promise<string | null> {
  const files = testsWrittenFirst(input.tdd.report);
  if (files.length === 0) {
    return null;
  }

  const phase = await input.journal.startPhase("green_check");
  let results: Awaited<ReturnType<typeof checkGreen>>;
  try {
    results = await checkGreen({
      shell: input.shell,
      config: input.tdd.config,
      files,
      redactor: input.redactor,
      commandOptions: runtimeCommandCredentials("verify", input.context),
    });
  } catch (error) {
    await phase.fail(formatError(error));
    throw error;
  }
  await input.journal.writeJsonArtifact(`green-check-${input.iteration}.json`, results);

  const log = formatGreenCheckLog(results);
  if (results.every((result) => result.passed)) {
    await phase.pass(log);
    return null;
  }

  await phase.fail(log);
  return formatGreenFeedback(results);
}

function maxIterationsError(failureCode: FailureCode): RunFailureError {
  return new RunFailureError(failureCode, "Exceeded max_iterations without success.");
}

async function runVerificationCommands(input: {
  journal: RunJournal;
  shell: ShellRunner;
  commands: string[];
  reports: ReportsConfig;
  onReports: (reports: ReportCollection | null) => void;
  iteration: number;
  redactor: (input: string) => string;
  commandOptions?: DockerCommandOptions | undefined;
}): Promise<VerificationResult> {
  input.onReports(null);
  const items: string[] = [];
  const phase = await input.journal.startPhase("verify");
  const logs: string[] = [];
  const reviewLines: string[] = [];
  const reports = hasReports(input.reports) ? input.reports : null;
  const recordCommands = async (status: "passed" | "failed"): Promise<void> => {
    await input.journal.recordVerificationCommands({
      status,
      commandCount: input.commands.length,
      passedCount: items.length,
      logRef: phase.logPath,
    });
  };
  // Collected after the commands ran, whether they passed or failed: a
  // failing test report is what explains the failure.
  const collect = async (): Promise<ReportCollection | null> => {
    if (reports === null) return null;
    const collection = await collectReports({
      shell: input.shell,
      journal: input.journal,
      config: reports,
      iteration: input.iteration,
    });
    input.onReports(collection);
    logs.push(formatReportSummary(collection));
    return collection;
  };

  try {
    if (reports !== null) await clearReports(input.shell, reports);
  } catch (error) {
    await phase.fail(formatError(error));
    throw error;
  }

  for (const command of input.commands) {
    let result: Awaited<ReturnType<ShellRunner["run"]>>;
    try {
      result = await input.shell.run(command, input.commandOptions);
    } catch (error) {
      await phase.fail(formatError(error));
      await recordCommands("failed");
      throw error;
    }

    const log = formatCommandLog(command, result);
    logs.push(log);
    if (result.exitCode === 124) {
      const redactedLog = input.redactor(logs.join("\n"));
      await phase.fail(redactedLog);
      await recordCommands("failed");
      throw new RunFailureError("timeout", redactedLog);
    }

    if (result.exitCode !== 0) {
      // The agent gets the command output only: it cannot read the run directory.
      const commandLog = input.redactor(logs.join("\n"));
      let collection: ReportCollection | null;
      try {
        collection = await collect();
      } catch (error) {
        await phase.fail(formatError(error));
        await recordCommands("failed");
        throw error;
      }
      await phase.fail(input.redactor(logs.join("\n")));
      await recordCommands("failed");
      const junit = await readJunitReports(
        (name) => input.journal.artifactPath(name),
        collection,
      );
      const failedTests = formatJunitFailures(junit);
      return {
        passed: false,
        feedback: `Verification failed for command: ${input.redactor(command)}\n${
          failedTests === null ? "" : `${input.redactor(failedTests)}\n\n`
        }${commandLog}`,
        reports: collection,
      };
    }

    items.push(`\`${command}\` passed`);
    reviewLines.push(formatPassedCommandForReview(command, result));
  }

  let collection: ReportCollection | null;
  try {
    collection = await collect();
  } catch (error) {
    await phase.fail(formatError(error));
    await recordCommands("failed");
    throw error;
  }
  const summary = input.redactor(logs.join("\n"));
  await phase.pass(summary);
  await recordCommands("passed");

  const junit = await readJunitReports(
    (name) => input.journal.artifactPath(name),
    collection,
  );
  items.push(...formatJunitItems(junit).map((item) => input.redactor(item)));

  return {
    passed: true,
    reviewSummary: input.redactor(reviewLines.join("\n\n")),
    items,
    reports: collection,
  };
}

function failureCodeFromError(error: unknown): FailureCode {
  if (error instanceof RunFailureError) {
    return error.failureCode;
  }

  if (error instanceof NoDiffError) {
    return "no_diff";
  }

  if (error instanceof ReviewModifiedDiffError) {
    return "review_blocking";
  }

  return "internal_error";
}

async function cleanupRuntime(
  compose: ComposeProject | null,
  sandbox: DockerSandbox | null,
  hostWorkspace: HostWorkspace | null,
): Promise<void> {
  const errors: string[] = [];

  if (compose !== null) {
    try {
      await compose.down();
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  if (sandbox !== null) {
    try {
      await sandbox.cleanup();
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  if (hostWorkspace !== null) {
    try {
      await hostWorkspace.cleanup();
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  if (errors.length > 0) {
    console.error(`Cleanup failed:\n${errors.join("\n")}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
