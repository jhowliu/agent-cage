import assert from "node:assert/strict";
import test from "node:test";
import { parseRunEventLine } from "../src/run/events.js";
import {
  formatPrUsage,
  formatTokenCount,
  parseAgentUsage,
  stageDurations,
} from "../src/run/usage.js";

const claudeOutput = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "result",
    is_error: false,
    total_cost_usd: 0.4321,
    usage: {
      input_tokens: 12,
      output_tokens: 345,
      cache_read_input_tokens: 6789,
      cache_creation_input_tokens: 100,
    },
  }),
].join("\n");

test("parseAgentUsage reads the four Claude token counts and the cost", () => {
  assert.deepEqual(parseAgentUsage("claude", claudeOutput), {
    provider: "claude",
    inputTokens: 12,
    outputTokens: 345,
    cacheReadTokens: 6789,
    cacheWriteTokens: 100,
    costUsd: 0.4321,
  });
});

test("parseAgentUsage gives zeros for an errored Claude result with no usage", () => {
  const output = JSON.stringify({ type: "result", is_error: true, usage: {} });
  assert.deepEqual(parseAgentUsage("claude", output), {
    provider: "claude",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  });
});

test("parseAgentUsage reads the Codex total", () => {
  assert.deepEqual(parseAgentUsage("codex", "done\ntokens used\n38,878\n"), {
    provider: "codex",
    totalTokens: 38878,
  });
});

test("parseAgentUsage gives null without usage", () => {
  assert.equal(parseAgentUsage("claude", "plain text"), null);
  assert.equal(parseAgentUsage("codex", claudeOutput), null);
});

function event(
  sequence: number,
  type: string,
  stage: string,
  attempt: number,
  at: string,
) {
  return parseRunEventLine(
    JSON.stringify({
      protocolVersion: 1,
      eventId: `e${sequence}`,
      runId: "r",
      sequence,
      occurredAt: at,
      type,
      stage,
      stageAttempt: attempt,
      payload: type === "stage.failed" ? { failureCode: "verify_failed" } : {},
    }),
  );
}

test("stageDurations sums attempts and counts a failed stage", () => {
  const durations = stageDurations([
    event(1, "stage.started", "implement", 1, "2026-01-01T00:00:00Z"),
    event(2, "stage.finished", "implement", 1, "2026-01-01T00:01:00Z"),
    event(3, "stage.started", "verify", 1, "2026-01-01T00:01:00Z"),
    event(4, "stage.failed", "verify", 1, "2026-01-01T00:01:30Z"),
    event(5, "stage.started", "implement", 2, "2026-01-01T00:02:00Z"),
    event(6, "stage.finished", "implement", 2, "2026-01-01T00:04:12Z"),
  ]);

  assert.deepEqual(durations, [
    { stage: "implement", attempts: 2, durationMs: 192_000 },
    { stage: "verify", attempts: 1, durationMs: 30_000 },
  ]);
  assert.equal(
    formatPrUsage(durations, [
      {
        stage: "implement",
        usage: { provider: "codex", totalTokens: 2_100_000 },
      },
    ]),
    "implement 2× 3m12s 2.1M tokens · verify 30s",
  );
});

test("formatTokenCount rounds to k or M", () => {
  assert.equal(formatTokenCount(950), "950");
  assert.equal(formatTokenCount(41_200), "41k");
  assert.equal(formatTokenCount(2_140_000), "2.1M");
});
