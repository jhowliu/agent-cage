import type { ExecutionMode } from "../config.js";
import { shellQuote } from "../shell.js";
import type { FailureCode } from "../state.js";
import {
  agyExecCommand,
  agyFailureCode,
  agyRateLimitMessage,
  agyStdinMessage,
  extractAgyResult,
} from "./agy.js";
import {
  claudeExecCommand,
  claudeFailureCode,
  claudeRateLimitMessage,
  extractClaudeResult,
} from "./claude.js";
import { codexExecCommand, codexFailureCode } from "./codex.js";

export const agentProviders = ["codex", "claude", "agy"] as const;
export type AgentProvider = (typeof agentProviders)[number];

export const agentRoles = ["implement", "review"] as const;
export type AgentRole = (typeof agentRoles)[number];

export const agentEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof agentEfforts)[number];

export type AgentAssignment = {
  provider: AgentProvider;
  model: string;
  effort?: AgentEffort;
};

export type AgentAssignments = Record<AgentRole, AgentAssignment>;

/** Recognized agent failures with specific recovery guidance. */
export type AgentFailureCode = Extract<
  FailureCode,
  "agent_auth_failed" | "agent_model_unavailable" | "agent_rate_limited"
>;

export const defaultAgentModels = {
  codex: "gpt-5.4-mini",
  claude: "claude-opus-5-5",
  agy: "gemini-4-neon-high",
} as const satisfies Record<AgentProvider, string>;

/** Credential env names each provider may receive; nothing else reaches it. */
export const agentCredentialEnvNames = {
  codex: ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  agy: [],
} as const satisfies Record<AgentProvider, readonly string[]>;

export type AgentCommandInput =
  | {
      access: "workspace-write";
      prompt: string;
      executionMode: ExecutionMode;
    }
  | {
      access: "read-only";
      prompt: string;
      executionMode: ExecutionMode;
      outputSchema: Record<string, unknown>;
    };

/**
 * An agent's shell command and the prompt to write to its stdin. The prompt is
 * never an argument: the command runs as `sh -lc <command>`, and Linux fails
 * any single argument over 128 KiB, which a review prompt with a large diff
 * reaches. Run it with `{ input: stdin }`.
 */
export type AgentCommand = { command: string; stdin: string };

const codexOutputSchemaPath = "/tmp/agent-cage-review-output-schema.json";

export function agentShellCommand(
  agent: AgentAssignment,
  input: AgentCommandInput,
): AgentCommand {
  return {
    command: agentCommandLine(agent, input),
    stdin: agent.provider === "agy" ? agyStdinMessage(input.prompt) : input.prompt,
  };
}

function agentCommandLine(agent: AgentAssignment, input: AgentCommandInput): string {
  switch (agent.provider) {
    case "codex":
      return codexShellCommand(agent.model, agent.effort, input);
    case "claude":
      return claudeExecCommand(
        input.access === "read-only"
          ? {
              access: "read-only",
              model: agent.model,
              effort: agent.effort,
              outputSchema: input.outputSchema,
            }
          : { access: "workspace-write", model: agent.model, effort: agent.effort },
      );
    case "agy":
      return agyExecCommand(
        input.access === "read-only"
          ? {
              access: "read-only",
              model: agent.model,
              effort: agent.effort,
              outputSchema: input.outputSchema,
            }
          : {
              access: "workspace-write",
              model: agent.model,
              effort: agent.effort,
              sandbox: input.executionMode === "direct",
            },
      );
    default: {
      const exhaustiveProvider: never = agent.provider;
      return exhaustiveProvider;
    }
  }
}

/** Reduces raw agent stdout to the agent's final answer. */
export function extractAgentResult(provider: AgentProvider, stdout: string): string {
  switch (provider) {
    case "codex":
      return stdout;
    case "claude":
      return extractClaudeResult(stdout);
    case "agy":
      return extractAgyResult(stdout);
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

/**
 * Recognizes credential, model, and usage-limit errors in an agent's output. Returns null
 * for every other failure, which callers report as a generic role failure.
 */
export function agentFailureCode(
  provider: AgentProvider,
  output: { stdout: string; stderr: string },
): AgentFailureCode | null {
  switch (provider) {
    case "codex":
      return codexFailureCode(`${output.stdout}\n${output.stderr}`);
    case "claude":
      return claudeFailureCode(output.stdout);
    case "agy":
      return agyFailureCode(output);
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

export function agentRateLimitMessage(
  provider: AgentProvider,
  output: { stdout: string; stderr: string },
): string {
  switch (provider) {
    case "claude":
      return claudeRateLimitMessage(output.stdout);
    case "agy":
      return agyRateLimitMessage(output);
    case "codex":
      return "Codex reached its usage limit. Rerun after the quota resets.";
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

export function agentProvidersInUse(
  agents: Record<AgentRole, AgentProvider>,
): ReadonlySet<AgentProvider> {
  return new Set(agentRoles.map((role) => agents[role]));
}

function codexShellCommand(
  model: string,
  effort: AgentEffort | undefined,
  input: AgentCommandInput,
): string {
  const bypassSandbox = input.executionMode === "direct";

  switch (input.access) {
    case "workspace-write":
      return codexExecCommand({
        model,
        effort,
        sandbox: "workspace-write",
        bypassSandbox,
      });
    case "read-only": {
      const writeOutputSchema = `printf %s ${shellQuote(
        JSON.stringify(input.outputSchema),
      )} > ${shellQuote(codexOutputSchemaPath)}`;
      return `${writeOutputSchema} && ${codexExecCommand({
        model,
        effort,
        sandbox: "read-only",
        outputSchemaPath: codexOutputSchemaPath,
        bypassSandbox,
      })}`;
    }
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}
