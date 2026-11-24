import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { execaGhRunner, execaGitRunner, type CommandRunner } from "./publish.js";
import { parseGithubRepo } from "./repo.js";

const prefix = "agent-cage/evidence/";
const retentionMs = 14 * 24 * 60 * 60 * 1000;
const pullSchema = z.object({
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
});
type EvidencePull = z.infer<typeof pullSchema>;
export type EvidenceBranch = { name: string; committedAt: string };
export type EvidenceDeletion = {
  name: string;
  reason: "linked PRs merged or closed" | "no linked PR and older than 14 days";
};

export function selectEvidenceBranches(
  branches: readonly EvidenceBranch[],
  pulls: readonly EvidencePull[],
  now: number,
): EvidenceDeletion[] {
  return branches.flatMap((branch): EvidenceDeletion[] => {
    if (!branch.name.startsWith(prefix) || branch.name.length === prefix.length)
      return [];
    const linked = pulls.filter((pull) => {
      const body = pull.body ?? "";
      return [
        branch.name,
        branch.name.split("/").map(encodeURIComponent).join("/"),
        encodeURIComponent(branch.name),
      ].some((name) =>
        body
          .split(name)
          .slice(1)
          .some((tail) => /^(?:$|[\s)\]?#"'<>`])/.test(tail)),
      );
    });
    if (linked.length > 0) {
      return linked.every((pull) => pull.state === "closed" || pull.merged_at !== null)
        ? [{ name: branch.name, reason: "linked PRs merged or closed" }]
        : [];
    }
    return Date.parse(branch.committedAt) < now - retentionMs
      ? [{ name: branch.name, reason: "no linked PR and older than 14 days" }]
      : [];
  });
}

export type CleanupEvidenceOptions = {
  repo?: string;
  yes?: boolean;
};
export type CleanupEvidenceDependencies = {
  git?: CommandRunner;
  gh?: CommandRunner;
  now?: number;
  isTTY?: boolean;
  log?: (message: string) => void;
  confirm?: () => Promise<boolean>;
};

export async function cleanupEvidenceBranches(
  options: CleanupEvidenceOptions,
  dependencies: CleanupEvidenceDependencies = {},
): Promise<void> {
  const git = dependencies.git ?? execaGitRunner;
  const gh = dependencies.gh ?? execaGhRunner;
  const log = dependencies.log ?? console.log;
  const run = async (runner: CommandRunner, args: string[]): Promise<string> => {
    const result = await runner.run(args, { cwd: process.cwd() });
    if (result.exitCode !== 0)
      throw new Error(result.stderr || `Command failed: ${args.join(" ")}`);
    return result.stdout;
  };
  const repo = parseGithubRepo(
    options.repo ?? (await run(git, ["remote", "get-url", "origin"])).trim(),
  ).fullName;
  const api = async (path: string): Promise<unknown> =>
    JSON.parse(await run(gh, ["api", "--paginate", "--slurp", path]));
  const refs = z
    .array(
      z.array(
        z.object({
          ref: z.string(),
          object: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }),
        }),
      ),
    )
    .parse(await api(`repos/${repo}/git/matching-refs/heads/${prefix}`))
    .flat();
  const evidenceRefs = refs.filter((ref) => ref.ref.startsWith(`refs/heads/${prefix}`));
  if (evidenceRefs.length === 0) {
    log("No evidence branches to delete.");
    return;
  }
  const pulls = z
    .array(z.array(pullSchema))
    .parse(await api(`repos/${repo}/pulls?state=all&per_page=100`))
    .flat();
  const branches: EvidenceBranch[] = [];
  for (const ref of evidenceRefs) {
    const commit = z
      .object({ committer: z.object({ date: z.iso.datetime() }) })
      .parse(
        JSON.parse(await run(gh, ["api", `repos/${repo}/git/commits/${ref.object.sha}`])),
      );
    branches.push({
      name: ref.ref.slice("refs/heads/".length),
      committedAt: commit.committer.date,
    });
  }
  const selected = selectEvidenceBranches(
    branches,
    pulls,
    dependencies.now ?? Date.now(),
  );
  if (selected.length === 0) {
    log("No evidence branches to delete.");
    return;
  }
  for (const branch of selected) log(`${branch.name}: ${branch.reason}`);
  if (options.yes !== true) {
    if (
      !(
        dependencies.isTTY ??
        (process.stdin.isTTY === true && process.stdout.isTTY === true)
      )
    ) {
      log(
        "No evidence branches deleted. Use --yes or an interactive terminal to confirm.",
      );
      return;
    }
    const confirm =
      dependencies.confirm ??
      (async (): Promise<boolean> => {
        const terminal = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          return /^y(es)?$/i.test(
            (await terminal.question("Delete these evidence branches? [y/N] ")).trim(),
          );
        } finally {
          terminal.close();
        }
      });
    if (!(await confirm())) return;
  }
  for (const branch of selected) {
    await run(gh, [
      "api",
      "--method",
      "DELETE",
      `repos/${repo}/git/refs/heads/${branch.name}`,
    ]);
    log(`Deleted ${branch.name}`);
  }
}
