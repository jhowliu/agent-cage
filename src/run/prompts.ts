import type { AgentProvider } from "../agent/providers.js";
import type { RedGreenConfig } from "../config.js";
import type { IssueContext } from "../issue.js";
import { formatLocation, type PullRequestFeedback } from "../pull-request.js";
import type { RuntimeContext } from "../run-workflow.js";

export function buildImplementationPrompt(input: {
  context: RuntimeContext;
  iteration: number;
  feedback: string[];
  /** Test files the red step wrote for this change, when the repo uses it. */
  testsWrittenFirst?: string[] | undefined;
}): string {
  const feedback = formatFeedbackList(input.feedback);
  const tests = testRules(input.context, input.testsWrittenFirst ?? []);

  const revision = input.context.revision;

  if (revision !== null) {
    const pullRequest = revision.pullRequest;

    return `Revise the pull request below so it addresses its feedback.

Rules:
- Work only in this repository. The checked-out branch holds the pull request's earlier commits; keep that work and change what the feedback asks for.
- Do not commit, push, create pull requests, or write secrets.
- Run only commands needed to address the feedback; Agent Cage will run verification separately.
${tests}
- ${agentInstructionFilesRule(input.context.agents.implement.provider)}
- Where the feedback conflicts with the issue, follow the feedback: it is the newer decision.
- If a piece of feedback is unclear, stop and explain the blocker.

Iteration: ${input.iteration}
Repository: ${input.context.repoResolution.repo.fullName}
Pull request: ${pullRequest.url}
Branch: ${pullRequest.headBranch} (base ${pullRequest.baseBranch})

Issue:
${formatIssueContext(input.context.issue)}

Pull request feedback:
${formatPullRequestFeedback(revision.feedback)}

Feedback from earlier iterations of this run:
${feedback}
`;
  }

  return `Implement the issue below inside the current repository.

Rules:
- Work only in this repository.
- Do not commit, push, create pull requests, or write secrets.
- Run only commands needed to implement the issue; Agent Cage will run verification separately.
${tests}
- ${agentInstructionFilesRule(input.context.agents.implement.provider)}
- If the issue lacks enough detail to implement safely, stop and explain the blocker.

Iteration: ${input.iteration}
Repository: ${input.context.repoResolution.repo.fullName}
Base branch: ${input.context.baseBranch}

Issue:
${formatIssueContext(input.context.issue)}

Feedback to address:
${feedback}
`;
}

/**
 * The red step of test-driven development: the agent writes tests before the
 * code, and Agent Cage checks that each fails on the code as it stands.
 */
export function buildTestFirstPrompt(input: {
  context: RuntimeContext;
  config: RedGreenConfig;
  iteration: number;
  feedback: string[];
}): string {
  const feedback = formatFeedbackList(input.feedback);
  const revision = input.context.revision;
  const earlierCode =
    input.iteration > 1
      ? "\n- Earlier iterations already wrote code. Test what the feedback asks for that the code does not do yet."
      : "";
  const rules = `Rules:
- Work only in this repository.
- Change only tests: files matching ${formatGlobs(input.config)}. Agent Cage reverts changes to any other file.
- Agent Cage runs each test file you write or change on the code as it stands, and each must fail there. Make it fail because the behavior is missing, not because of a mistake in the test.${earlierCode}
- Test the behavior through the interface its callers use, not through the implementation. Cover the boundaries it implies: empty and zero values, each limit and one past it, invalid input.
- When nothing asked for changes testable behavior (documentation, configuration, a rename), change nothing and say why.
- Do not commit, push, create pull requests, or write secrets.
- ${agentInstructionFilesRule(input.context.agents.implement.provider)}
- If what is asked lacks the detail to test, stop and explain the blocker.`;

  if (revision !== null) {
    const pullRequest = revision.pullRequest;

    return `Write the tests for the pull request feedback below, before the code. This is the red step of test-driven development: another step writes the code afterwards, and your tests are locked while it does.

${rules}

Iteration: ${input.iteration}
Repository: ${input.context.repoResolution.repo.fullName}
Pull request: ${pullRequest.url}
Branch: ${pullRequest.headBranch} (base ${pullRequest.baseBranch})

Issue:
${formatIssueContext(input.context.issue)}

Pull request feedback:
${formatPullRequestFeedback(revision.feedback)}

Feedback from earlier iterations of this run:
${feedback}
`;
  }

  return `Write the tests for the issue below, before the code. This is the red step of test-driven development: another step writes the code afterwards, and your tests are locked while it does.

${rules}

Iteration: ${input.iteration}
Repository: ${input.context.repoResolution.repo.fullName}
Base branch: ${input.context.baseBranch}

Issue:
${formatIssueContext(input.context.issue)}

Feedback to address:
${feedback}
`;
}

function testRules(context: RuntimeContext, testsWrittenFirst: string[]): string {
  const config = context.config.guards.red_green;
  if (config === null) {
    return "- Add or update tests for the behavior you change. A bug fix gets a test that fails without the fix.";
  }

  const rules = [
    `- Files matching ${formatGlobs(config)} are tests, and they are locked: an earlier step writes tests first. Change the code, not the tests. Agent Cage restores a changed test once. A test changed again is kept, and the review checks that the change does not weaken it.`,
    testsWrittenFirst.length > 0
      ? `- Make the tests written for this change pass: ${testsWrittenFirst
          .map((file) => `\`${file}\``)
          .join(", ")}.`
      : "- No test was written for this change; the review decides whether it needs one.",
  ];

  return rules.join("\n");
}

function formatGlobs(config: RedGreenConfig): string {
  return [...config.test_files, ...config.support_files]
    .map((glob) => `\`${glob}\``)
    .join(", ");
}

function formatFeedbackList(feedback: string[]): string {
  return feedback.length === 0
    ? "No prior feedback."
    : feedback.map((item, index) => `${index + 1}. ${item}`).join("\n\n");
}

function agentInstructionFilesRule(provider: AgentProvider): string {
  switch (provider) {
    case "codex":
      return "Follow applicable native Codex AGENTS.md files discovered in this repository.";
    case "claude":
      // Claude Code's native memory is CLAUDE.md; name AGENTS.md explicitly so
      // repos that only document conventions there are still followed.
      return "Before editing, read and follow the AGENTS.md and CLAUDE.md files that apply to the paths you change.";
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

export function formatReviewIssueContext(context: RuntimeContext): string {
  const issue = `Issue:
${formatIssueContext(context.issue)}`;

  if (context.revision === null) {
    return issue;
  }

  const pullRequest = context.revision.pullRequest;

  return `${issue}
Pull request: ${pullRequest.url}
This run revises the pull request above. The diff is the whole pull request against ${pullRequest.baseBranch}, including commits from earlier runs. Besides the issue, the change must address the pull request feedback below. Where the feedback conflicts with the issue, the feedback wins: it is the newer decision.

Pull request feedback:
${formatPullRequestFeedback(context.revision.feedback)}
`;
}

export function formatPullRequestFeedback(feedback: PullRequestFeedback[]): string {
  return feedback
    .map((item, index) => `${index + 1}. ${formatFeedbackItem(item)}`)
    .join("\n\n");
}

function formatFeedbackItem(item: PullRequestFeedback): string {
  switch (item.kind) {
    case "review_thread": {
      const outdated = item.outdated ? " (outdated: the code moved since)" : "";
      const comments = item.comments
        .map((comment) => `   - ${comment.author}: ${indent(comment.body, "     ")}`)
        .join("\n");
      return `Review thread on \`${formatLocation(item)}\`${outdated}:\n${comments}`;
    }
    case "review":
      return `Review (${item.state.toLowerCase().replace(/_/g, " ")}) from ${item.comment.author}:\n   ${indent(item.comment.body, "   ")}`;
    case "comment":
      return `Comment from ${item.comment.author}:\n   ${indent(item.comment.body, "   ")}`;
    case "command_line":
      return `From the person who started this run:\n   ${indent(item.body, "   ")}`;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function indent(text: string, prefix: string): string {
  return text.trim().replace(/\r?\n/g, `\n${prefix}`);
}

function formatIssueContext(issue: IssueContext): string {
  const comments =
    issue.comments.length === 0
      ? "No human comments included."
      : issue.comments
          .map((comment) => {
            const createdAt =
              comment.createdAt === null ? "" : ` at ${comment.createdAt}`;
            return `- ${comment.author}${createdAt}: ${comment.body}`;
          })
          .join("\n");

  return `URL: ${issue.url}
Identifier: ${issue.identifier}
Title: ${issue.title}

Body:
${issue.body}

Comments:
${comments}
`;
}
