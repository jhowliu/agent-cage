import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeExecCommand,
  claudeFailureCode,
  claudeRateLimitInfo,
  extractClaudeResult,
} from "../src/agent/claude.js";
import { codexConfigModel, codexFailureCode } from "../src/agent/codex.js";
import {
  agentFailureCode,
  agentProviders,
  agentShellCommand,
  extractAgentResult,
} from "../src/agent/providers.js";

const schema = { type: "object", required: ["decision"] };

function resultLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", is_error: false, ...fields });
}

test("Claude implementation runs headless with permissions bypassed and streaming output", () => {
  const command = claudeExecCommand({
    access: "workspace-write",
    model: "claude-opus-5-5",
  });

  assert.ok(command.startsWith("DISABLE_AUTOUPDATER=1 claude -p '--model' "));
  assert.match(command, /'--model' 'claude-opus-5-5'/);
  assert.match(command, /'--output-format' 'stream-json' '--verbose'/);
  assert.match(command, /'--dangerously-skip-permissions'/);
  assert.doesNotMatch(command, /--allowedTools/);
});

test("Claude review is limited to read-only tools and a JSON schema", () => {
  const command = claudeExecCommand({
    access: "read-only",
    model: "claude-opus-5-5",
    outputSchema: schema,
  });

  assert.ok(command.startsWith("DISABLE_AUTOUPDATER=1 claude -p '--model' "));
  assert.match(
    command,
    /'--json-schema' '\{"type":"object","required":\["decision"\]\}'/,
  );
  assert.match(command, /'--disallowedTools' 'Edit,Write,NotebookEdit'/);
  assert.match(command, /'--allowedTools' 'Read,Grep,Glob,Bash\(git diff:\*\)/);
  assert.doesNotMatch(command, /dangerously/);
});

test("Codex commands keep the sandbox flag in Docker mode and bypass it in direct mode", () => {
  const codex = { provider: "codex", model: "gpt-5.4-mini" } as const;
  const { command: docker } = agentShellCommand(codex, {
    access: "workspace-write",
    prompt: "Implement it",
    executionMode: "docker",
  });
  const { command: direct } = agentShellCommand(codex, {
    access: "workspace-write",
    prompt: "Implement it",
    executionMode: "direct",
  });

  assert.match(docker, /^codex exec --model 'gpt-5\.4-mini' --sandbox 'workspace-write'/);
  assert.match(direct, /--dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(direct, /--sandbox/);
});

test("Codex review writes the output schema before running read-only", () => {
  const { command } = agentShellCommand(
    { provider: "codex", model: "gpt-5.4-mini" },
    {
      access: "read-only",
      prompt: "Review it",
      executionMode: "docker",
      outputSchema: schema,
    },
  );

  assert.match(
    command,
    /^printf %s '\{.*\}' > '\/tmp\/agent-cage-review-output-schema\.json' && /,
  );
  assert.match(command, /--sandbox 'read-only'/);
  assert.match(command, /--output-schema '\/tmp\/agent-cage-review-output-schema\.json'/);
});

test("agent commands take the prompt on stdin, never as an argument", () => {
  // A review prompt with a large diff passed the 128 KiB limit Linux puts on
  // one argument, so `sh -lc <command>` failed with "argument list too long".
  const prompt = `Review it ${"x".repeat(200 * 1024)} 'quoted'`;
  for (const provider of agentProviders) {
    for (const access of ["workspace-write", "read-only"] as const) {
      const input =
        access === "read-only"
          ? { access, prompt, executionMode: "docker" as const, outputSchema: schema }
          : { access, prompt, executionMode: "docker" as const };
      const agentCommand = agentShellCommand({ provider, model: "m" }, input);

      assert.equal(agentCommand.stdin, prompt);
      assert.ok(agentCommand.command.length < 2048, `${provider} ${access}`);
      assert.doesNotMatch(agentCommand.command, /Review it/);
    }
  }
  assert.match(
    agentShellCommand(
      { provider: "codex", model: "m" },
      { access: "workspace-write", prompt, executionMode: "docker" },
    ).command,
    / -$/,
  );
});

test("extractClaudeResult prefers structured output over result text", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    "warning: not json",
    resultLine({ result: "ignored", structured_output: { decision: "pass" } }),
  ].join("\n");

  assert.equal(extractClaudeResult(stdout), '{"decision":"pass"}');
});

test("extractClaudeResult falls back to result text", () => {
  assert.equal(extractClaudeResult(`${resultLine({ result: "done" })}\n`), "done");
});

test("extractClaudeResult rejects error results and missing result events", () => {
  assert.throws(
    () => extractClaudeResult(resultLine({ is_error: true, result: "rate limited" })),
    /Claude Code reported an error: rate limited/,
  );
  assert.throws(
    () => extractClaudeResult(JSON.stringify({ type: "assistant" })),
    /did not emit a result event/,
  );
});

test("extractAgentResult passes Codex output through unchanged", () => {
  assert.equal(extractAgentResult("codex", '{"decision":"pass"}'), '{"decision":"pass"}');
  assert.equal(
    extractAgentResult("claude", resultLine({ structured_output: { decision: "pass" } })),
    '{"decision":"pass"}',
  );
});

test("claudeFailureCode recognizes rejected credentials and unknown models", () => {
  const auth = [
    '{"type":"system","subtype":"api_retry","error":"authentication_failed"}',
    '{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}',
  ].join("\n");
  const model = [
    '{"type":"assistant","error":"model_not_found","message":{"content":[]}}',
    '{"type":"result","is_error":true,"api_error_status":404,"result":"There\'s an issue with the selected model (claude-nope-9)."}',
  ].join("\n");
  const other =
    '{"type":"result","is_error":true,"api_error_status":null,"result":"Overloaded"}';

  assert.equal(claudeFailureCode(auth), "agent_auth_failed");
  assert.equal(claudeFailureCode(model), "agent_model_unavailable");
  assert.equal(claudeFailureCode(other), null);
  assert.equal(claudeFailureCode("not json"), null);
});

test("codexFailureCode reads only the final ERROR lines", () => {
  const model = `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}`;
  const auth =
    "ERROR: unexpected status 401 Unauthorized: Incorrect API key provided: sk-…, url: https://api.openai.com/v1/responses, auth error: 401, auth error code: invalid_api_key";
  // A background model-list refresh can log a 401 without failing the turn.
  const backgroundNoise =
    "2026-11-10T08:34:40.852684Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized";

  assert.equal(codexFailureCode(model), "agent_model_unavailable");
  assert.equal(codexFailureCode(`${backgroundNoise}\n${auth}`), "agent_auth_failed");
  assert.equal(codexFailureCode(backgroundNoise), null);
  assert.equal(codexFailureCode("ERROR: stream disconnected before completion"), null);
});

test("agentFailureCode reads Claude stdout and Codex stderr", () => {
  assert.equal(
    agentFailureCode("claude", {
      stdout: '{"type":"result","is_error":true,"api_error_status":401}',
      stderr: "",
    }),
    "agent_auth_failed",
  );
  assert.equal(
    agentFailureCode("codex", {
      stdout: "",
      stderr: 'ERROR: {"error":{"code":"model_not_found"}}',
    }),
    "agent_model_unavailable",
  );
});

test("codexConfigModel reads the top-level model only", () => {
  assert.equal(
    codexConfigModel('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\n'),
    "gpt-6.1-sol",
  );
  assert.equal(codexConfigModel('[profiles.fast]\nmodel = "other"\n'), null);
  assert.equal(codexConfigModel('approval_policy = "never"\n'), null);
});

const rateLimitEvent =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795505400,"rateLimitType":"five_hour","overageStatus":"rejected"}}';

test("Claude rejected usage limits retain reset details and defer to credential and model errors", () => {
  assert.equal(claudeFailureCode(rateLimitEvent), "agent_rate_limited");
  assert.deepEqual(claudeRateLimitInfo(rateLimitEvent), {
    rateLimitType: "five_hour",
    resetsAt: "2026-11-24T07:30:00.000Z",
  });
  for (const [error, code] of [
    ["authentication_failed", "agent_auth_failed"],
    ["model_not_found", "agent_model_unavailable"],
  ]) {
    assert.equal(
      claudeFailureCode(`${rateLimitEvent}\n${JSON.stringify({ error })}`),
      code,
    );
  }
  assert.equal(claudeFailureCode(rateLimitEvent.replaceAll("rejected", "allowed")), null);
  assert.equal(claudeRateLimitInfo("not json"), null);
  assert.equal(
    claudeRateLimitInfo(rateLimitEvent.replace("1795505400", '"invalid"')),
    null,
  );
  assert.equal(claudeRateLimitInfo(rateLimitEvent.replace("1795505400", "1e100")), null);
});
