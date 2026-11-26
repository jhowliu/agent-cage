import { z } from "zod";
import { shellQuote } from "../shell.js";
import type { AgentEffort, AgentFailureCode } from "./providers.js";

// Tools the read-only reviewer may use. In print mode Claude Code denies any
// tool outside this list instead of prompting.
export const claudeReviewAllowedTools = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
] as const;

const claudeEditTools = ["Edit", "Write", "NotebookEdit"] as const;

export type ClaudeCommandInput =
  | { access: "workspace-write"; model: string; effort?: AgentEffort | undefined }
  | {
      access: "read-only";
      model: string;
      effort?: AgentEffort | undefined;
      outputSchema: Record<string, unknown>;
    };

/**
 * Options after `-p`. The prompt comes on stdin, so the variadic
 * `--allowedTools`/`--disallowedTools` have no positional prompt to swallow.
 */
export function claudeOptionArgs(input: ClaudeCommandInput): string[] {
  // stream-json keeps output flowing during long turns, so the idle timeout
  // only fires when Claude Code is actually stuck. It requires --verbose.
  const args = ["--model", input.model, "--output-format", "stream-json", "--verbose"];
  if (input.effort !== undefined) {
    args.push("--effort", input.effort);
  }

  switch (input.access) {
    case "workspace-write":
      // Claude Code has no OS-level sandbox; the Docker sandbox (or the
      // externally isolated direct-mode runner) is the isolation boundary.
      args.push("--dangerously-skip-permissions");
      return args;
    case "read-only":
      args.push(
        "--json-schema",
        JSON.stringify(input.outputSchema),
        "--disallowedTools",
        claudeEditTools.join(","),
        "--allowedTools",
        claudeReviewAllowedTools.join(","),
      );
      return args;
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}

/** `claude -p` with no prompt argument reads the prompt from stdin; see AgentCommand. */
export function claudeExecCommand(input: ClaudeCommandInput): string {
  return [
    "DISABLE_AUTOUPDATER=1 claude -p",
    ...claudeOptionArgs(input).map(shellQuote),
  ].join(" ");
}

const claudeResultEventSchema = z
  .object({
    type: z.literal("result"),
    is_error: z.boolean(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
  })
  .passthrough();

/**
 * Returns the final answer from Claude Code `stream-json` output: the
 * structured output when a JSON schema was requested, otherwise the result
 * text.
 */
export function extractClaudeResult(stdout: string): string {
  let resultEvent: z.infer<typeof claudeResultEventSchema> | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const event = claudeResultEventSchema.safeParse(parseJsonLine(line));
    if (event.success) {
      resultEvent = event.data;
    }
  }

  if (resultEvent === null) {
    throw new Error("Claude Code did not emit a result event.");
  }

  if (resultEvent.is_error) {
    throw new Error(`Claude Code reported an error: ${resultEvent.result ?? "unknown"}`);
  }

  if (
    resultEvent.structured_output !== undefined &&
    resultEvent.structured_output !== null
  ) {
    return JSON.stringify(resultEvent.structured_output);
  }

  return resultEvent.result ?? "";
}

// Claude Code tags API failures on stream-json events: `error` on the
// assistant/retry events, `api_error_status` on the final result event.
const claudeErrorEventSchema = z
  .object({
    error: z.string().nullable().optional(),
    api_error_status: z.number().nullable().optional(),
  })
  .passthrough();

export function claudeFailureCode(stdout: string): AgentFailureCode | null {
  for (const line of stdout.split(/\r?\n/)) {
    const event = claudeErrorEventSchema.safeParse(parseJsonLine(line));
    if (!event.success) continue;
    const { error, api_error_status: status } = event.data;
    if (error === "authentication_failed" || status === 401 || status === 403) {
      return "agent_auth_failed";
    }
    if (error === "model_not_found" || status === 404) {
      return "agent_model_unavailable";
    }
  }
  return rejectedRateLimitEvents(stdout).length > 0 ? "agent_rate_limited" : null;
}

const claudeRateLimitEventSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({
    status: z.literal("rejected"),
    rateLimitType: z.unknown().optional(),
    resetsAt: z.unknown().optional(),
  }),
});

function rejectedRateLimitEvents(
  stdout: string,
): z.infer<typeof claudeRateLimitEventSchema>[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const event = claudeRateLimitEventSchema.safeParse(parseJsonLine(line));
    return event.success ? [event.data] : [];
  });
}

/** Reads a rejected usage limit and formats its epoch-seconds reset as UTC. */
export function claudeRateLimitInfo(
  stdout: string,
): { rateLimitType: string; resetsAt: string } | null {
  const schema = z.object({
    rateLimitType: z.string().min(1),
    resetsAt: z.number().finite(),
  });
  for (const event of rejectedRateLimitEvents(stdout)) {
    const info = schema.safeParse(event.rate_limit_info);
    if (!info.success) continue;
    const reset = new Date(info.data.resetsAt * 1000);
    if (!Number.isFinite(reset.getTime())) continue;
    return { rateLimitType: info.data.rateLimitType, resetsAt: reset.toISOString() };
  }
  return null;
}

export function claudeRateLimitMessage(stdout: string): string {
  const info = claudeRateLimitInfo(stdout);
  const limit = info === null ? "usage limit" : `${info.rateLimitType} usage limit`;
  const reset =
    info === null ? "the reset time is unavailable" : `it resets at ${info.resetsAt}`;
  return `Claude Code reached its ${limit}; ${reset}. Rerun after that, or use ANTHROPIC_API_KEY for API billing.`;
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Output can carry non-JSON lines (warnings, partial writes); those are
    // not events, and a missing result event is reported by the caller.
    return null;
  }
}
