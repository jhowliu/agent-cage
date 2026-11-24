import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupEvidenceBranches,
  selectEvidenceBranches,
} from "../src/cleanup-evidence.js";
import { createCli } from "../src/commands.js";
import type { CommandRunner } from "../src/publish.js";

const now = Date.parse("2026-06-01T00:00:00Z");
const old = "2026-05-01T00:00:00Z";
const recent = "2026-05-31T00:00:00Z";
const prefix = "agent-cage/evidence/";
const pulls = [
  { body: `${prefix}merged`, state: "closed", merged_at: recent },
  { body: `${prefix}closed`, state: "closed", merged_at: null },
  {
    body: `https://github.com/o/r/tree/agent-cage/evidence/open`,
    state: "open",
    merged_at: null,
  },
] satisfies Parameters<typeof selectEvidenceBranches>[1];
const branches = ["merged", "closed", "open", "old", "recent"].map((name) => ({
  name: `${prefix}${name}`,
  committedAt: name === "recent" ? recent : old,
}));

test("selection deletes merged, closed and old unlinked evidence only", () => {
  const selected = selectEvidenceBranches(
    [
      ...branches,
      { name: "main", committedAt: old },
      {
        name: `${prefix}boundary`,
        committedAt: new Date(now - 14 * 86400000).toISOString(),
      },
    ],
    pulls,
    now,
  );
  assert.deepEqual(
    selected.map((branch) => branch.name),
    ["merged", "closed", "old"].map((name) => prefix + name),
  );
});

test("an open link protects a branch even when another linked PR is closed", () => {
  assert.deepEqual(
    selectEvidenceBranches(
      [branches[0]!],
      [
        ...pulls,
        { body: encodeURIComponent(`${prefix}merged`), state: "open", merged_at: null },
      ],
      now,
    ),
    [],
  );
});

test("branch links do not match longer branch names", () => {
  assert.deepEqual(
    selectEvidenceBranches(
      [{ name: `${prefix}open`, committedAt: recent }],
      [{ body: `${prefix}open-longer`, state: "closed", merged_at: null }],
      now,
    ),
    [],
  );
});

for (const mode of ["yes", "nonTTY", "decline", "confirm"] as const) {
  test(`cleanup command with fake runners: ${mode}`, async () => {
    const deleted: string[] = [];
    const output: string[] = [];
    let gitCalls = 0;
    let confirmed = false;
    const git: CommandRunner = {
      async run(args) {
        assert.deepEqual(args, ["remote", "get-url", "origin"]);
        gitCalls++;
        return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      },
    };
    const gh: CommandRunner = {
      async run(args) {
        const path = args.at(-1) ?? "";
        let value: unknown;
        if (args.includes("DELETE")) {
          deleted.push(path);
          value = null;
        } else if (path.includes("matching-refs")) {
          value = [
            [
              ...branches.map((branch) => ({
                ref: `refs/heads/${branch.name}`,
                object: { sha: (branch.committedAt === recent ? "b" : "a").repeat(40) },
              })),
              { ref: "refs/heads/main", object: { sha: "a".repeat(40) } },
            ],
          ];
        } else if (path.includes("pulls?")) value = [pulls];
        else if (path.includes("git/commits/"))
          value = { committer: { date: path.endsWith("b".repeat(40)) ? recent : old } };
        else throw new Error(`Unexpected GitHub call ${args.join(" ")}`);
        return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
      },
    };
    const program = createCli({
      cleanupManagedDockerResources: async () => ({
        containers: [],
        images: [],
        networks: [],
        volumes: [],
        skippedActiveRunIds: [],
      }),
      cleanupEvidenceBranches: async (options) =>
        cleanupEvidenceBranches(options, {
          git,
          gh,
          now,
          isTTY: mode !== "nonTTY",
          log: (message) => output.push(message),
          confirm: async () => {
            confirmed = true;
            return mode === "confirm";
          },
        }),
    });
    await program.parseAsync(
      ["cleanup", "--evidence", ...(mode === "yes" ? ["--yes"] : [])],
      { from: "user" },
    );
    assert.equal(gitCalls, 1);
    assert.equal(confirmed, mode === "decline" || mode === "confirm");
    assert.deepEqual(
      deleted,
      mode === "yes" || mode === "confirm"
        ? ["merged", "closed", "old"].map(
            (name) => `repos/o/r/git/refs/heads/${prefix}${name}`,
          )
        : [],
    );
    assert.ok(output.some((line) => line.includes("older than 14 days")));
  });
}

test("plain cleanup does not invoke GitHub evidence cleanup", async () => {
  const program = createCli({
    cleanupManagedDockerResources: async () => ({
      containers: [],
      images: [],
      networks: [],
      volumes: [],
      skippedActiveRunIds: [],
    }),
    cleanupEvidenceBranches: async () => {
      assert.fail("GitHub cleanup must remain opt-in");
    },
  });
  await program.parseAsync(["cleanup"], { from: "user" });
});

test("explicit repository bypasses origin lookup", async () => {
  await cleanupEvidenceBranches(
    { repo: "other/repo", yes: true },
    {
      git: {
        async run() {
          assert.fail("must not read origin");
        },
      },
      gh: {
        async run(args) {
          assert.equal(args.at(-1), `repos/other/repo/git/matching-refs/heads/${prefix}`);
          return { exitCode: 0, stdout: "[[]]", stderr: "" };
        },
      },
      log: () => undefined,
    },
  );
});
