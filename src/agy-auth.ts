import { execa } from "execa";
import {
  agyAuthMountTarget,
  commandWithAgyKeyring,
  defaultAgyAuthVolumeName,
} from "./agent/agy.js";
import { loadAgentCageConfigFile } from "./config-file.js";
import {
  defaultSandboxImage,
  execaDockerCommandRunner,
  type DockerCommandRunner,
} from "./docker.js";
import { RunFailureError } from "./run/errors.js";

// Distinct from `agent-cage.managed=true` so `agent-cage cleanup` never wipes
// the persistent Antigravity login volume alongside ephemeral per-run volumes.
export const agyAuthVolumeLabel = "agent-cage.auth_provider=agy";

export type AgyInteractiveRunner = (
  args: readonly string[],
) => Promise<{ exitCode: number }>;

export type AgyAuthStatus = {
  volumeName: string;
  volumeExists: boolean;
  authenticated: boolean;
  image: string;
};

export type AgyLoginResult = {
  volumeName: string;
  authenticated: boolean;
  image: string;
};

export type AgyLogoutResult = {
  volumeName: string;
  removed: boolean;
};

export type AgyAuthDependencies = {
  commandRunner?: DockerCommandRunner | undefined;
  interactiveRunner?: AgyInteractiveRunner | undefined;
};

const defaultInteractiveRunner: AgyInteractiveRunner = async (args) => {
  const result = await execa("docker", args, {
    stdio: "inherit",
    reject: false,
  });
  return { exitCode: result.exitCode ?? 1 };
};

export async function resolveAgyAuthImage(
  cwd: string,
  explicitImage?: string | undefined,
): Promise<string> {
  if (explicitImage !== undefined && explicitImage.trim() !== "") {
    return explicitImage.trim();
  }
  const configState = await loadAgentCageConfigFile(cwd);
  if (configState.status === "valid") {
    return configState.config.runtime.image;
  }
  return defaultSandboxImage;
}

export async function isAgyAuthVolumePresent(
  volumeName: string = defaultAgyAuthVolumeName,
  runner: DockerCommandRunner = execaDockerCommandRunner,
): Promise<boolean> {
  const result = await runner.run(["volume", "inspect", volumeName]);
  return result.exitCode === 0;
}

export async function checkAgyAuthStatus(
  options: {
    cwd: string;
    volumeName?: string | undefined;
    image?: string | undefined;
  },
  dependencies: AgyAuthDependencies = {},
): Promise<AgyAuthStatus> {
  const runner = dependencies.commandRunner ?? execaDockerCommandRunner;
  const volumeName = options.volumeName ?? defaultAgyAuthVolumeName;
  const image = await resolveAgyAuthImage(options.cwd, options.image);
  await assertDockerAvailable(runner);

  const volumeExists = await isAgyAuthVolumePresent(volumeName, runner);
  if (!volumeExists) {
    return { volumeName, volumeExists: false, authenticated: false, image };
  }

  const lookup = await runner.run([
    "run",
    "--rm",
    "--user",
    "agent",
    "--mount",
    `type=volume,source=${volumeName},target=${agyAuthMountTarget}`,
    image,
    "sh",
    "-lc",
    commandWithAgyKeyring(
      "secret-tool lookup service gemini username antigravity >/dev/null 2>&1",
    ),
  ]);

  return {
    volumeName,
    volumeExists: true,
    authenticated: lookup.exitCode === 0,
    image,
  };
}

export async function loginAgyAuth(
  options: {
    cwd: string;
    volumeName?: string | undefined;
    image?: string | undefined;
  },
  dependencies: AgyAuthDependencies = {},
): Promise<AgyLoginResult> {
  const runner = dependencies.commandRunner ?? execaDockerCommandRunner;
  const interactive = dependencies.interactiveRunner ?? defaultInteractiveRunner;
  const volumeName = options.volumeName ?? defaultAgyAuthVolumeName;
  const image = await resolveAgyAuthImage(options.cwd, options.image);
  await assertDockerAvailable(runner);

  const existedBefore = await isAgyAuthVolumePresent(volumeName, runner);
  if (!existedBefore) {
    const created = await runner.run([
      "volume",
      "create",
      "--label",
      agyAuthVolumeLabel,
      volumeName,
    ]);
    if (created.exitCode !== 0) {
      throw new Error(
        `Failed to create Docker volume ${volumeName}: ${created.stderr.trim()}`,
      );
    }
  }

  // Ensure the volume root is writable by `agent` even on custom images that
  // did not pre-create the mount target directory.
  const chowned = await runner.run([
    "run",
    "--rm",
    "--user",
    "root",
    "--mount",
    `type=volume,source=${volumeName},target=${agyAuthMountTarget}`,
    image,
    "sh",
    "-lc",
    `chown -R agent:agent ${agyAuthMountTarget}`,
  ]);
  if (chowned.exitCode !== 0) {
    throw new Error(
      `Failed to initialize permissions on ${volumeName}: ${chowned.stderr.trim()}`,
    );
  }

  await interactive([
    "run",
    "--rm",
    "-it",
    "--user",
    "agent",
    "--mount",
    `type=volume,source=${volumeName},target=${agyAuthMountTarget}`,
    image,
    "sh",
    "-lc",
    commandWithAgyKeyring("agy"),
  ]);

  const status = await checkAgyAuthStatus(
    { cwd: options.cwd, volumeName, image },
    { commandRunner: runner },
  );

  if (!existedBefore && !status.authenticated) {
    await runner.run(["volume", "rm", volumeName]);
  }

  return {
    volumeName,
    authenticated: status.authenticated,
    image,
  };
}

export async function logoutAgyAuth(
  options: {
    volumeName?: string | undefined;
  } = {},
  dependencies: AgyAuthDependencies = {},
): Promise<AgyLogoutResult> {
  const runner = dependencies.commandRunner ?? execaDockerCommandRunner;
  const volumeName = options.volumeName ?? defaultAgyAuthVolumeName;
  await assertDockerAvailable(runner);

  if (!(await isAgyAuthVolumePresent(volumeName, runner))) {
    return { volumeName, removed: false };
  }

  const removed = await runner.run(["volume", "rm", volumeName]);
  if (removed.exitCode !== 0) {
    throw new Error(
      `Failed to remove Docker volume ${volumeName}: ${removed.stderr.trim()}`,
    );
  }

  return { volumeName, removed: true };
}

async function assertDockerAvailable(runner: DockerCommandRunner): Promise<void> {
  const info = await runner.run(["version", "--format", "{{.Server.Version}}"]);
  if (info.exitCode !== 0) {
    const detail = info.stderr.trim();
    throw new RunFailureError(
      "docker_unavailable",
      detail === "" ? "The Docker daemon is not reachable." : detail,
    );
  }
}
