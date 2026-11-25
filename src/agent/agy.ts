import { z } from "zod";
import { shellQuote } from "../shell.js";
import type { AgentFailureCode } from "./providers.js";

export const defaultAgyAuthVolumeName = "agent-cage-agy-auth";
export const agyAuthMountTarget = "/home/agent/.agent-cage-agy-auth";
export const agyOutputSchemaPath = "/tmp/agent-cage-agy-review-output-schema.json";

const agyKeyringUnlockSecret = "agent-cage";

/**
 * Links Antigravity's CLI state and GNOME keyring storage into the mounted auth
 * volume, starts a transient D-Bus session, unlocks (or initializes) the login
 * keyring via pipe without consuming outer stdin, and executes `command`.
 */
export function commandWithAgyKeyring(command: string): string {
  const inner = [
    `eval "$(printf '%s\\n' ${shellQuote(agyKeyringUnlockSecret)} | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"`,
    "export GNOME_KEYRING_CONTROL",
    command,
  ].join(" && ");

  return [
    `mkdir -p ${agyAuthMountTarget}/keyrings ${agyAuthMountTarget}/cli /home/agent/.local/share /home/agent/.gemini`,
    `chmod 700 ${agyAuthMountTarget}/keyrings`,
    `ln -sfn ${agyAuthMountTarget}/keyrings /home/agent/.local/share/keyrings`,
    `ln -sfn ${agyAuthMountTarget}/cli /home/agent/.gemini/antigravity-cli`,
    `dbus-run-session -- sh -lc ${shellQuote(inner)}`,
  ].join(" && ");
}

/**
 * The stdin body for one `agy --input-format stream-json` turn. agy ignores
 * stdin when `--print` carries a prompt (agy 1.5 changelog: "no longer reading
 * stdin when a prompt is provided via a flag"), so the prompt travels as a
 * newline-delimited stream-json `user` message instead.
 */
export function agyStdinMessage(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

// Permissions allowed for the read-only reviewer inside Antigravity's unified
// policy engine (`Deny > Ask > Allow`). File reads inside the workspace are
// implicitly allowed by Antigravity; `write_file(*)` is explicitly denied.
export const agyReviewAllowedPermissions = [
  "command(git diff)",
  "command(git log)",
  "command(git show)",
  "command(git status)",
] as const;

export const agyReviewDeniedPermissions = [
  "write_file(*)",
  "command(git commit)",
  "command(git push)",
  "command(git checkout)",
  "command(git reset)",
  "command(git clean)",
  "command(rm)",
] as const;

export type AgyCommandInput =
  | {
      access: "workspace-write";
      model: string;
      sandbox?: boolean | undefined;
    }
  | {
      access: "read-only";
      model: string;
      outputSchema: string;
    };

/**
 * Builds CLI arguments for `agy`. The prompt arrives over stdin as a stream-json
 * message (see `agyStdinMessage`) to stay under Linux's 128 KiB single-argument
 * limit. The empty `--print=` turns on print mode, attached with `=` and placed
 * last so Go's flag parser never consumes an adjacent flag as its value.
 */
export function agyOptionArgs(input: AgyCommandInput): string[] {
  const args = [
    "--model",
    input.model,
    "--disable-slash-commands",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];

  switch (input.access) {
    case "workspace-write":
      if (input.sandbox === true) {
        args.push("--sandbox");
      }
      args.push(
        "--dangerously-skip-permissions",
        "--settings",
        JSON.stringify({
          trustedWorkspaces: ["/workspace"],
        }),
        "--print=",
      );
      return args;
    case "read-only":
      args.push(
        "--json-schema",
        input.outputSchema,
        "--settings",
        JSON.stringify({
          trustedWorkspaces: ["/workspace"],
          permissions: {
            allow: [...agyReviewAllowedPermissions],
            deny: [...agyReviewDeniedPermissions],
          },
        }),
        "--print=",
      );
      return args;
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}

export function agyExecCommand(
  input:
    | {
        access: "workspace-write";
        model: string;
        sandbox?: boolean | undefined;
      }
    | {
        access: "read-only";
        model: string;
        outputSchema: Record<string, unknown>;
      },
): string {
  switch (input.access) {
    case "workspace-write":
      return [
        "agy",
        ...agyOptionArgs({
          access: "workspace-write",
          model: input.model,
          sandbox: input.sandbox,
        }).map(shellQuote),
      ].join(" ");
    case "read-only": {
      const writeOutputSchema = `printf %s ${shellQuote(
        JSON.stringify(input.outputSchema),
      )} > ${shellQuote(agyOutputSchemaPath)}`;
      const agyCommand = [
        "agy",
        ...agyOptionArgs({
          access: "read-only",
          model: input.model,
          outputSchema: agyOutputSchemaPath,
        }).map(shellQuote),
      ].join(" ");
      return `${writeOutputSchema} && ${agyCommand}`;
    }
    default: {
      const exhaustiveInput: never = input;
      return exhaustiveInput;
    }
  }
}

const agyResultPayloadSchema = z
  .object({
    status: z.string(),
    response: z.string().optional(),
    error: z.string().nullable().optional(),
    structured_output: z.unknown().optional(),
  })
  .passthrough();

const agyResultEventSchema = z
  .object({
    event: z.literal("result"),
    result: agyResultPayloadSchema,
  })
  .passthrough();

/**
 * Extracts the final answer from Antigravity CLI `stream-json` output: the
 * serialized `structured_output` when a JSON schema was requested, otherwise
 * `response`.
 */
export function extractAgyResult(stdout: string): string {
  let resultPayload: z.infer<typeof agyResultPayloadSchema> | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parseJsonLine(line);
    const event = agyResultEventSchema.safeParse(parsed);
    if (event.success) {
      resultPayload = event.data.result;
    }
  }

  if (resultPayload === null) {
    throw new Error("Antigravity CLI did not emit a result event.");
  }

  if (resultPayload.status !== "SUCCESS") {
    const detail =
      resultPayload.error ??
      (resultPayload.response !== undefined && resultPayload.response !== ""
        ? resultPayload.response
        : resultPayload.status);
    throw new Error(`Antigravity CLI reported an error: ${detail}`);
  }

  if (
    resultPayload.structured_output !== undefined &&
    resultPayload.structured_output !== null
  ) {
    return JSON.stringify(resultPayload.structured_output);
  }

  return resultPayload.response ?? "";
}

export function agyFailureCode(output: {
  stdout: string;
  stderr: string;
}): AgentFailureCode | null {
  const details = collectErrorStrings(output);
  for (const detail of details) {
    if (
      /\b401\b|\bunauthorized\b|\bunauthenticated\b|authentication required|not authenticated|login required|please sign in|secret keyring|keyring is locked|failed to retrieve token/i.test(
        detail,
      )
    ) {
      return "agent_auth_failed";
    }
    if (
      /model[\s'":A-Za-z0-9._-]*(?:not found|not available|not supported|unavailable|invalid|unknown)|unknown model|invalid model/i.test(
        detail,
      )
    ) {
      return "agent_model_unavailable";
    }
    if (
      /rate[ _-]?limit|quota exceeded|resource_exhausted|usage limit|\b429\b/i.test(
        detail,
      )
    ) {
      return "agent_rate_limited";
    }
  }
  return null;
}

export function agyRateLimitMessage(output: { stdout: string; stderr: string }): string {
  const detail = collectErrorStrings(output).at(-1);
  return detail === undefined
    ? "Antigravity CLI reached its usage or rate limit. Rerun after the quota resets."
    : `Antigravity CLI reached its usage or rate limit (${detail}). Rerun after the quota resets.`;
}

function collectErrorStrings(output: { stdout: string; stderr: string }): string[] {
  const messages: string[] = [];

  for (const line of output.stdout.split(/\r?\n/)) {
    const event = agyResultEventSchema.safeParse(parseJsonLine(line));
    if (event.success && event.data.result.status !== "SUCCESS") {
      if (typeof event.data.result.error === "string" && event.data.result.error !== "") {
        messages.push(event.data.result.error);
      }
      if (
        typeof event.data.result.response === "string" &&
        event.data.result.response !== ""
      ) {
        messages.push(event.data.result.response);
      }
    }
  }

  for (const line of output.stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      messages.push(trimmed);
    }
  }

  return messages;
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
