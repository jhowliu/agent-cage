import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  agyAuthMountTarget,
  agyExecCommand,
  agyFailureCode,
  agyOptionArgs,
  defaultAgyAuthVolumeName,
  extractAgyResult,
} from "../src/agent/agy.js";
import {
  agentFailureCode,
  agentRateLimitMessage,
  agentShellCommand,
  defaultAgentModels,
} from "../src/agent/providers.js";
import {
  agyAuthVolumeLabel,
  agyOAuthTokenPath,
  checkAgyAuthStatus,
  loginAgyAuth,
  logoutAgyAuth,
} from "../src/agy-auth.js";
import { createCli } from "../src/commands.js";
import { parseAgentCageConfig } from "../src/config.js";
import {
  credentialsForCommand,
  hasAgentCredentials,
  normalizeCredentialEnv,
  prepareRunCredentials,
} from "../src/credentials.js";
import {
  defaultSandboxImage,
  dockerRunArgs,
  type DockerCommandResult,
  type DockerCommandRunner,
} from "../src/docker.js";
import { doctorProject, type DoctorCommandRunner } from "../src/doctor.js";
import { generateGitHubActionsWorkflow } from "../src/github-actions.js";
import type { GhRunner } from "../src/github-auth.js";
import { formatPrUsage, formatUsageTable, parseAgentUsage } from "../src/run/usage.js";
import { setupProject, type SetupPrompts } from "../src/setup.js";

const configHome = await mkdtemp(join(tmpdir(), "agent-cage-agy-config-"));
process.env.XDG_CONFIG_HOME = configHome;
process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "agent-cage-agy-codex-"));

function mockDockerRunner(
  handler: (args: string[]) => DockerCommandResult,
): DockerCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args: string[]): Promise<DockerCommandResult> {
      calls.push(args);
      return handler(args);
    },
  };
}

test("default model for agy is gemini-4-neon-high and config schema accepts agy", () => {
  assert.equal(defaultAgentModels.agy, "gemini-4-neon-high");
  const parsed = parseAgentCageConfig({
    verify: ["npm test"],
    agent: {
      implement: { provider: "agy" },
      review: { provider: "agy" },
    },
  });
  assert.deepEqual(parsed.config.agent.implement, {
    provider: "agy",
    model: "gemini-4-neon-high",
  });
  assert.deepEqual(parsed.config.agent.review, {
    provider: "agy",
    model: "gemini-4-neon-high",
  });
});

test("agyOptionArgs places --print=... last and configures workspace-write vs read-only", () => {
  const writeArgs = agyOptionArgs({
    access: "workspace-write",
    model: "gemini-4-neon-high",
  });
  assert.equal(writeArgs.includes("--dangerously-skip-permissions"), true);
  assert.equal(writeArgs.includes("--sandbox"), false);
  assert.match(writeArgs.at(-1) ?? "", /^--print=Follow the instructions/);

  const directWriteArgs = agyOptionArgs({
    access: "workspace-write",
    model: "gemini-4-neon-high",
    sandbox: true,
  });
  assert.equal(directWriteArgs.includes("--sandbox"), true);

  const readOnlyArgs = agyOptionArgs({
    access: "read-only",
    model: "gemini-4-neon-high",
    outputSchema: "/tmp/schema.json",
  });
  assert.equal(readOnlyArgs.includes("--dangerously-skip-permissions"), false);
  assert.equal(readOnlyArgs.includes("--json-schema"), true);
  const settingsIndex = readOnlyArgs.indexOf("--settings");
  const settings = JSON.parse(readOnlyArgs[settingsIndex + 1] ?? "{}") as {
    permissions?: { allow?: string[]; deny?: string[] };
  };
  assert.equal(settings.permissions?.deny?.includes("write_file(*)"), true);
  assert.equal(settings.permissions?.allow?.includes("command(git diff)"), true);
  assert.match(readOnlyArgs.at(-1) ?? "", /^--print=Follow the instructions/);
});

test("agentShellCommand builds agy commands with prompt on stdin", () => {
  const implementCmd = agentShellCommand(
    { provider: "agy", model: "gemini-4-neon-high" },
    {
      access: "workspace-write",
      prompt: "Implement feature X",
      executionMode: "docker",
    },
  );
  assert.equal(implementCmd.stdin, "Implement feature X");
  assert.match(implementCmd.command, /^agy '--model' 'gemini-4-neon-high'/);
  assert.doesNotMatch(implementCmd.command, /Implement feature X/);

  const reviewCmd = agentShellCommand(
    { provider: "agy", model: "gemini-4-neon-high" },
    {
      access: "read-only",
      prompt: "Review diff",
      executionMode: "docker",
      outputSchema: { type: "object" },
    },
  );
  assert.equal(reviewCmd.stdin, "Review diff");
  assert.match(reviewCmd.command, /printf %s '\{"type":"object"\}' > /);
  assert.match(reviewCmd.command, /&& agy '--model' 'gemini-4-neon-high'/);
  assert.equal(
    agyExecCommand({
      access: "workspace-write",
      model: "gemini-4-neon-high",
      sandbox: true,
    }).includes("'--sandbox'"),
    true,
  );
});

test("extractAgyResult and agyFailureCode parse Antigravity stream-json events", () => {
  const streamSuccess = [
    '{"event":"init","conversation_id":"conv-1"}',
    '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"Done!","usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":30,"cache_read_tokens":50,"total_tokens":200}}}',
  ].join("\n");
  assert.equal(extractAgyResult(streamSuccess), "Done!");

  const structuredSuccess = JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      response: '{"ok":true}',
      structured_output: { ok: true },
    },
  });
  assert.equal(extractAgyResult(structuredSuccess), '{"ok":true}');

  const authError = JSON.stringify({
    event: "result",
    result: {
      status: "ERROR",
      response: "",
      error: "authentication required: secret keyring is locked",
    },
  });
  assert.throws(() => extractAgyResult(authError), /secret keyring is locked/);
  assert.equal(agyFailureCode({ stdout: authError, stderr: "" }), "agent_auth_failed");
  assert.equal(
    agentFailureCode("agy", {
      stdout: "",
      stderr: "Error: model 'gemini-unknown' not found",
    }),
    "agent_model_unavailable",
  );
  assert.equal(
    agentFailureCode("agy", {
      stdout: "",
      stderr: "429 RESOURCE_EXHAUSTED: quota exceeded",
    }),
    "agent_rate_limited",
  );
  assert.match(
    agentRateLimitMessage("agy", { stdout: "", stderr: "quota exceeded" }),
    /Antigravity CLI reached its usage or rate limit/,
  );

  const usage = parseAgentUsage("agy", streamSuccess);
  assert.deepEqual(usage, {
    provider: "agy",
    inputTokens: 100,
    outputTokens: 20,
    thinkingTokens: 30,
    cacheReadTokens: 50,
    totalTokens: 200,
  });
  if (usage !== null) {
    const table = formatUsageTable(
      [{ stage: "implement", attempts: 1, durationMs: 5_000 }],
      [{ stage: "implement", usage }],
    );
    assert.match(table, /100 in \/ 20 out \/ 30 thinking \/ 50 cache read/);
    assert.equal(
      formatPrUsage(
        [{ stage: "implement", attempts: 1, durationMs: 5_000 }],
        [{ stage: "implement", usage }],
      ),
      "implement 5s 200 tokens",
    );
  }
});

test("credentialsForCommand scopes agy auth volume strictly to agy agent roles", async () => {
  const env = normalizeCredentialEnv({
    OPENAI_API_KEY: "openai-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
    GITHUB_TOKEN: "github-secret",
    APP_ENV: "test",
  });
  const agents = { implement: "agy", review: "codex" } as const;

  assert.deepEqual(
    credentialsForCommand("implement", {
      env,
      agents,
      agyAuthVolumeName: defaultAgyAuthVolumeName,
    }),
    { env: {}, agyAuthVolumeName: defaultAgyAuthVolumeName },
  );
  assert.deepEqual(
    credentialsForCommand("review", {
      env,
      agents,
      agyAuthVolumeName: defaultAgyAuthVolumeName,
    }),
    { env: { OPENAI_API_KEY: "openai-secret" } },
  );
  assert.deepEqual(
    credentialsForCommand("setup", {
      env,
      agents,
      agyAuthVolumeName: defaultAgyAuthVolumeName,
    }),
    { env: { APP_ENV: "test" } },
  );
  assert.deepEqual(
    credentialsForCommand("verify", {
      env,
      agents,
      agyAuthVolumeName: defaultAgyAuthVolumeName,
    }),
    { env: { APP_ENV: "test" } },
  );
  assert.deepEqual(
    credentialsForCommand("publish", {
      env,
      agents,
      agyAuthVolumeName: defaultAgyAuthVolumeName,
    }),
    { env: { GITHUB_TOKEN: "github-secret", GH_TOKEN: "github-secret" } },
  );

  assert.equal(
    hasAgentCredentials("agy", {
      env,
      codexAuthFileAvailable: true,
      agyAuthAvailable: false,
    }),
    false,
  );
  assert.equal(
    hasAgentCredentials("agy", {
      env: {},
      codexAuthFileAvailable: false,
      agyAuthAvailable: true,
    }),
    true,
  );

  let volumeLookups = 0;
  const runCredentials = await prepareRunCredentials({
    cwd: "/repo",
    agents,
    readEnv: async () => ({ GITHUB_TOKEN: "gh-secret" }),
    findCodexAuthFile: async () => null,
    findAgyAuthVolume: async () => {
      volumeLookups += 1;
      return defaultAgyAuthVolumeName;
    },
    findGithubToken: async () => null,
  });
  assert.equal(volumeLookups, 1);
  assert.deepEqual(runCredentials.command("implement"), {
    env: {},
    agyAuthVolumeName: defaultAgyAuthVolumeName,
  });
  assert.deepEqual(runCredentials.command("verify"), { env: {} });
});

test("dockerRunArgs mounts agy auth volume and unlocks gnome-keyring in dbus session", () => {
  const args = dockerRunArgs({
    image: defaultSandboxImage,
    networkName: "agent-cage-run-1",
    volumeName: "agent-cage-run-1-workspace",
    workspacePath: "/workspace",
    labels: { "agent-cage.run_id": "run-1" },
    env: {},
    agyAuthVolumeName: defaultAgyAuthVolumeName,
    command: "agy '--model' 'gemini-4-neon-high'",
    interactive: true,
  });
  const joinedArgs = args.join(" ");
  const shellCmd = args.at(-1) ?? "";

  assert.equal(
    joinedArgs.includes(
      `--mount type=volume,source=${defaultAgyAuthVolumeName},target=${agyAuthMountTarget}`,
    ),
    true,
  );
  assert.match(shellCmd, /ln -sfn .*\/keyrings \/home\/agent\/\.local\/share\/keyrings/);
  assert.match(shellCmd, /ln -sfn .*\/cli \/home\/agent\/\.gemini\/antigravity-cli/);
  assert.match(shellCmd, /dbus-run-session -- sh -lc/);
  assert.match(shellCmd, /gnome-keyring-daemon --unlock --components=secrets/);
});

test("loginAgyAuth labels volume without agent-cage.managed and cleans up aborted new volume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-agy-auth-"));
  try {
    // 1. Aborted login on a newly created volume removes the empty volume.
    let volumePresent = false;
    const abortedRunner = mockDockerRunner((args) => {
      if (args[0] === "version") return { exitCode: 0, stdout: "27.0.0\n", stderr: "" };
      if (args[0] === "volume" && args[1] === "inspect") {
        return volumePresent
          ? { exitCode: 0, stdout: "[]", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "no such volume" };
      }
      if (args[0] === "volume" && args[1] === "create") {
        volumePresent = true;
        return { exitCode: 0, stdout: defaultAgyAuthVolumeName, stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "rm") {
        volumePresent = false;
        return { exitCode: 0, stdout: defaultAgyAuthVolumeName, stderr: "" };
      }
      if (args[0] === "run" && args.includes("root")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // secret-tool lookup fails because user exited without signing in
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    const aborted = await loginAgyAuth(
      { cwd },
      {
        commandRunner: abortedRunner,
        interactiveRunner: async () => ({ exitCode: 0 }),
      },
    );
    assert.equal(aborted.authenticated, false);
    assert.equal(volumePresent, false);
    const createCall = abortedRunner.calls.find(
      (call) => call[0] === "volume" && call[1] === "create",
    );
    assert.ok(createCall?.includes(agyAuthVolumeLabel));
    assert.equal(
      createCall?.some((arg) => arg.includes("agent-cage.managed")),
      false,
    );

    // 2. Successful login keeps the volume and checkAgyAuthStatus / logoutAgyAuth work.
    const successRunner = mockDockerRunner((args) => {
      if (args[0] === "version") return { exitCode: 0, stdout: "27.0.0\n", stderr: "" };
      if (args[0] === "volume" && args[1] === "inspect") {
        return volumePresent
          ? { exitCode: 0, stdout: "[]", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "no such volume" };
      }
      if (args[0] === "volume" && args[1] === "create") {
        volumePresent = true;
        return { exitCode: 0, stdout: defaultAgyAuthVolumeName, stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "rm") {
        volumePresent = false;
        return { exitCode: 0, stdout: defaultAgyAuthVolumeName, stderr: "" };
      }
      const script = args.at(-1) ?? "";
      // In a container agy saves its token to a file in the volume, not to the
      // keyring, so only a check of that file proves the login was kept.
      if (script.includes("secret-tool")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (script.includes("antigravity-oauth-token")) {
        return script === `test -s ${agyOAuthTokenPath}`
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const loggedIn = await loginAgyAuth(
      { cwd },
      {
        commandRunner: successRunner,
        interactiveRunner: async () => ({ exitCode: 0 }),
      },
    );
    assert.equal(loggedIn.authenticated, true);
    assert.equal(volumePresent, true);

    const status = await checkAgyAuthStatus({ cwd }, { commandRunner: successRunner });
    assert.equal(status.authenticated, true);

    const loggedOut = await logoutAgyAuth({}, { commandRunner: successRunner });
    assert.equal(loggedOut.removed, true);
    assert.equal(volumePresent, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("CLI auth agy dispatches login, --status, and --logout", async () => {
  const calls: string[] = [];
  const cli = createCli({
    checkAgyAuthStatus: async () => {
      calls.push("status");
      return {
        volumeName: defaultAgyAuthVolumeName,
        volumeExists: true,
        authenticated: true,
        image: defaultSandboxImage,
      };
    },
    loginAgyAuth: async () => {
      calls.push("login");
      return {
        volumeName: defaultAgyAuthVolumeName,
        authenticated: true,
        image: defaultSandboxImage,
      };
    },
    logoutAgyAuth: async () => {
      calls.push("logout");
      return { volumeName: defaultAgyAuthVolumeName, removed: true };
    },
  });

  await cli.parseAsync(["node", "agent-cage", "auth", "agy", "--status"]);
  await cli.parseAsync(["node", "agent-cage", "auth", "agy"]);
  await cli.parseAsync(["node", "agent-cage", "auth", "agy", "--logout"]);
  assert.deepEqual(calls, ["status", "login", "logout"]);
});

test("doctor checks agy auth volume, probes agy with volume mount, and blocks Actions with agy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-agy-doctor-"));
  try {
    await writeFile(
      join(cwd, ".agent-cage.yml"),
      "verify:\n  - npm test\nruntime:\n  image: agent-cage/base:local\nagent:\n  implement:\n    provider: agy\n  review:\n    provider: agy\n",
      "utf8",
    );

    let volumeAvailable = false;
    const probeCalls: (readonly string[])[] = [];
    const runner: DoctorCommandRunner = async (command, args) => {
      if (command === "docker" && args[0] === "volume" && args[1] === "inspect") {
        return volumeAvailable
          ? { exitCode: 0, stdout: "[]", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "missing" };
      }
      if (command === "docker" && args[0] === "run") {
        probeCalls.push(args);
        return volumeAvailable
          ? { exitCode: 0, stdout: "{}", stderr: "" }
          : {
              exitCode: 1,
              stdout:
                '{"event":"result","result":{"status":"ERROR","error":"authentication required"}}',
              stderr: "",
            };
      }
      return { exitCode: 0, stdout: "true", stderr: "" };
    };

    const unauthenticated = await doctorProject(cwd, runner, { probe: true });
    assert.ok(
      unauthenticated.checks.some(
        (check) => check.name === "agy-auth" && check.status === "warning",
      ),
    );
    const failedProbe = unauthenticated.checks.find(
      (check) => check.name === "agent-probe:implement+review",
    );
    assert.equal(failedProbe?.status, "fail");
    assert.match(failedProbe?.message ?? "", /agent-cage auth agy/);

    volumeAvailable = true;
    const authenticated = await doctorProject(cwd, runner, { probe: true });
    assert.equal(authenticated.healthy, true);
    assert.ok(
      authenticated.checks.some(
        (check) => check.name === "agy-auth" && check.status === "pass",
      ),
    );
    assert.ok(
      probeCalls
        .at(-1)
        ?.some((arg) => arg.includes(`source=${defaultAgyAuthVolumeName}`)),
    );

    await writeFile(
      join(cwd, ".agent-cage.yml"),
      "verify:\n  - npm test\nagent:\n  implement:\n    provider: agy\nactions:\n  enabled: true\n  agent_cage_version: 0.1.0\n",
      "utf8",
    );
    const withActions = await doctorProject(cwd, runner);
    assert.equal(withActions.healthy, false);
    assert.ok(
      withActions.checks.some(
        (check) => check.name === "agy-actions" && check.status === "fail",
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("setup supports agy, disables GitHub Actions when agy is selected, and rejects workflow generation", async () => {
  assert.throws(
    () =>
      generateGitHubActionsWorkflow({
        agentCageVersion: "0.1.0",
        agents: { implement: "agy", review: "codex" },
      }),
    /local Docker auth volume/,
  );

  const cwd = await mkdtemp(join(tmpdir(), "agent-cage-agy-setup-"));
  const signedOutGh: GhRunner = async () => ({ exitCode: 1, stdout: "" });
  const missingVolumeDocker = mockDockerRunner(() => ({
    exitCode: 1,
    stdout: "",
    stderr: "missing",
  }));
  const prompts: SetupPrompts = {
    async input(message, defaultValue) {
      if (message.startsWith("Implementation agent")) return "agy";
      return defaultValue;
    },
    async secret() {
      return "";
    },
    async confirm(message, defaultValue) {
      if (message.startsWith("Enable GitHub Actions")) return true;
      return defaultValue;
    },
    close() {},
  };

  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
      "utf8",
    );
    await writeFile(join(cwd, "package-lock.json"), "{}\n", "utf8");

    const result = await setupProject(cwd, {}, prompts, {
      gh: signedOutGh,
      docker: missingVolumeDocker,
    });
    const config = parse(await readFile(join(cwd, ".agent-cage.yml"), "utf8")) as {
      agent: { implement: { provider: string; model: string } };
      actions: { enabled: boolean };
    };

    assert.deepEqual(config.agent.implement, {
      provider: "agy",
      model: "gemini-4-neon-high",
    });
    assert.equal(config.actions.enabled, false);
    assert.equal(result.actionsEnabled, false);
    assert.ok(
      result.notices.some((notice) => notice.includes("Disabled GitHub Actions")),
    );
    assert.ok(result.notices.some((notice) => notice.includes("agent-cage auth agy")));

    await assert.rejects(
      () =>
        setupProject(cwd, { yes: true, actions: true }, undefined, {
          gh: signedOutGh,
          docker: missingVolumeDocker,
        }),
      /cannot be enabled when agy is configured/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
