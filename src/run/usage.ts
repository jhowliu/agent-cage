import type { AgentProvider } from "../agent/providers.js";
import { canonicalStages, type CanonicalStage, type RunEvent } from "./events.js";

/** What one agent command used, as the agent printed it. */
export type AgentUsage =
  | {
      provider: "claude";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
    }
  | {
      // Codex prints only a total: no split and no cost.
      provider: "codex";
      totalTokens: number;
    }
  | {
      provider: "agy";
      inputTokens: number;
      outputTokens: number;
      thinkingTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
    };

export type StageUsageEntry = {
  stage: CanonicalStage;
  usage: AgentUsage;
};

export type StageDuration = {
  stage: CanonicalStage;
  attempts: number;
  /** Milliseconds from stage.started to stage.finished or stage.failed. */
  durationMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseClaudeUsage(output: string): AgentUsage | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{") || !line.includes('"result"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "result") continue;
    const usage = isRecord(parsed.usage) ? parsed.usage : {};
    return {
      provider: "claude",
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
      costUsd: count(parsed.total_cost_usd),
    };
  }
  return null;
}

function parseCodexUsage(output: string): AgentUsage | null {
  const match = /tokens used\s*\r?\n\s*([\d,]+)/i.exec(output);
  if (match?.[1] === undefined) return null;
  const total = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(total) ? { provider: "codex", totalTokens: total } : null;
}

function parseAgyUsage(output: string): AgentUsage | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{") || !line.includes('"result"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.event !== "result" || !isRecord(parsed.result)) {
      continue;
    }
    const usage = isRecord(parsed.result.usage) ? parsed.result.usage : null;
    if (usage === null) continue;
    const inputTokens = count(usage.input_tokens);
    const outputTokens = count(usage.output_tokens);
    const thinkingTokens = count(usage.thinking_tokens);
    const cacheReadTokens = count(usage.cache_read_tokens);
    const reportedTotal = count(usage.total_tokens);
    const totalTokens =
      reportedTotal > 0
        ? reportedTotal
        : inputTokens + outputTokens + thinkingTokens + cacheReadTokens;
    return {
      provider: "agy",
      inputTokens,
      outputTokens,
      thinkingTokens,
      cacheReadTokens,
      totalTokens,
    };
  }
  return null;
}

/** The usage of one agent command, or null when its output has none. */
export function parseAgentUsage(
  provider: AgentProvider,
  output: string,
): AgentUsage | null {
  switch (provider) {
    case "claude":
      return parseClaudeUsage(output);
    case "codex":
      return parseCodexUsage(output);
    case "agy":
      return parseAgyUsage(output);
    default: {
      const exhaustiveProvider: never = provider;
      return exhaustiveProvider;
    }
  }
}

/** Attempts and total time per canonical stage that started. */
export function stageDurations(events: readonly RunEvent[]): StageDuration[] {
  const totals = new Map<CanonicalStage, StageDuration>();
  const started = new Map<string, number>();

  for (const event of events) {
    if (
      event.type !== "stage.started" &&
      event.type !== "stage.finished" &&
      event.type !== "stage.failed"
    ) {
      continue;
    }
    const key = `${event.stage}:${event.stageAttempt}`;
    const at = Date.parse(event.occurredAt);
    if (event.type === "stage.started") {
      started.set(key, at);
      const total = totals.get(event.stage) ?? {
        stage: event.stage,
        attempts: 0,
        durationMs: 0,
      };
      total.attempts += 1;
      totals.set(event.stage, total);
      continue;
    }
    const start = started.get(key);
    const total = totals.get(event.stage);
    if (start !== undefined && total !== undefined) {
      total.durationMs += Math.max(0, at - start);
      started.delete(key);
    }
  }

  return canonicalStages.flatMap((stage) => {
    const total = totals.get(stage);
    return total === undefined ? [] : [total];
  });
}

const emptyCell = "—";

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m${rest}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Rounded to k or M: 950, 41k, 2.1M. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function totalTokens(usage: AgentUsage): number {
  switch (usage.provider) {
    case "codex":
      return usage.totalTokens;
    case "claude":
      return (
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadTokens +
        usage.cacheWriteTokens
      );
    case "agy":
      return usage.totalTokens;
    default: {
      const exhaustiveUsage: never = usage;
      return exhaustiveUsage;
    }
  }
}

function formatInt(value: number): string {
  return String(Math.round(value));
}

function stageTokens(usages: readonly AgentUsage[]): string {
  const claude = { input: 0, output: 0, read: 0, write: 0, count: 0 };
  const agy = { input: 0, output: 0, thinking: 0, read: 0, count: 0 };
  let codex: number | null = null;
  for (const usage of usages) {
    switch (usage.provider) {
      case "claude":
        claude.input += usage.inputTokens;
        claude.output += usage.outputTokens;
        claude.read += usage.cacheReadTokens;
        claude.write += usage.cacheWriteTokens;
        claude.count += 1;
        break;
      case "codex":
        codex = (codex ?? 0) + usage.totalTokens;
        break;
      case "agy":
        agy.input += usage.inputTokens;
        agy.output += usage.outputTokens;
        agy.thinking += usage.thinkingTokens;
        agy.read += usage.cacheReadTokens;
        agy.count += 1;
        break;
      default: {
        const exhaustiveUsage: never = usage;
        return exhaustiveUsage;
      }
    }
  }
  const cells: string[] = [];
  if (claude.count > 0) {
    cells.push(
      `${formatInt(claude.input)} in / ${formatInt(claude.output)} out / ${formatInt(claude.read)} cache read / ${formatInt(claude.write)} cache write`,
    );
  }
  if (agy.count > 0) {
    cells.push(
      `${formatInt(agy.input)} in / ${formatInt(agy.output)} out / ${formatInt(agy.thinking)} thinking / ${formatInt(agy.read)} cache read`,
    );
  }
  if (codex !== null) cells.push(`${formatInt(codex)} total`);
  return cells.length === 0 ? emptyCell : cells.join("; ");
}

function claudeCost(usages: readonly AgentUsage[]): number | null {
  let cost: number | null = null;
  for (const usage of usages) {
    if (usage.provider === "claude") cost = (cost ?? 0) + usage.costUsd;
  }
  return cost;
}

function usagesFor(
  entries: readonly StageUsageEntry[],
  stage: CanonicalStage,
): AgentUsage[] {
  return entries.filter((entry) => entry.stage === stage).map((entry) => entry.usage);
}

/** The `## Usage` section of summary.md, or "" when no stage ran. */
export function formatUsageTable(
  durations: readonly StageDuration[],
  entries: readonly StageUsageEntry[],
): string {
  if (durations.length === 0) return "";
  const rows = durations.map((duration) => {
    const usages = usagesFor(entries, duration.stage);
    const cost = claudeCost(usages);
    const time =
      duration.durationMs > 0 ? formatDuration(duration.durationMs) : emptyCell;
    const costCell = cost === null ? emptyCell : `$${cost.toFixed(2)} (API list price)`;
    return `| ${duration.stage} | ${duration.attempts} | ${time} | ${stageTokens(usages)} | ${costCell} |`;
  });
  return [
    "## Usage",
    "",
    "| Stage | Attempts | Time | Tokens | Cost |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

const prUsageStages: readonly CanonicalStage[] = ["implement", "verify", "review"];

/**
 * The value of the PR body's `- Usage:` bullet, for the stages that finished
 * before publish. Null when none of them ran.
 */
export function formatPrUsage(
  durations: readonly StageDuration[],
  entries: readonly StageUsageEntry[],
): string | null {
  const parts = durations
    .filter((duration) => prUsageStages.includes(duration.stage))
    .map((duration) => {
      const usages = usagesFor(entries, duration.stage);
      const pieces = [
        duration.stage + (duration.attempts > 1 ? ` ${duration.attempts}×` : ""),
        formatDuration(duration.durationMs),
      ];
      if (usages.length > 0) {
        const tokens = usages.reduce((sum, usage) => sum + totalTokens(usage), 0);
        pieces.push(`${formatTokenCount(tokens)} tokens`);
      }
      const cost = claudeCost(usages);
      if (cost !== null) pieces.push(`$${cost.toFixed(2)}`);
      return pieces.join(" ");
    });
  return parts.length === 0 ? null : parts.join(" · ");
}
