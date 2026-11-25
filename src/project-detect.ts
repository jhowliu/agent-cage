import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RedGreenConfig } from "./config.js";

/**
 * Toolchains the Agent Cage base image (node:22-bookworm) lacks. Listed in the
 * order their Dockerfile snippets are emitted; later entries may rely on
 * earlier ones (poetry is installed with uv, maven runs on the JDK).
 */
export const projectToolchains = [
  "corepack",
  "python",
  "uv",
  "poetry",
  "go",
  "rust",
  "jdk",
  "maven",
] as const;

export type ProjectToolchain = (typeof projectToolchains)[number];

export type ProjectEcosystem = "node" | "python" | "go" | "rust" | "java" | "make";

export type ProjectDetection = {
  ecosystems: ProjectEcosystem[];
  setup: string[];
  verify: string[];
  toolchains: ProjectToolchain[];
  // How to run one test file, when the test runner is known.
  redGreen: RedGreenConfig | null;
  // How to make the test runner write JUnit XML, when it is known and safe.
  junit: JunitOffer | null;
  evidence: EvidenceOffer | null;
};

export const junitRunners = ["node:test", "vitest", "jest", "pytest"] as const;
export type JunitRunner = (typeof junitRunners)[number];

/** Rewrites one detected verify command so the runner also writes JUnit XML. */
export type JunitOffer = {
  runner: JunitRunner;
  /** The detected verify command to rewrite. */
  command: string;
  /** The command with the reporter flags and the output directory. */
  replacement: string;
  /** The `reports.junit` glob the runner writes to. */
  glob: string;
  coverageFlags?: string;
};

export type EvidenceOffer = {
  tools: ("playwright" | "cypress")[];
  globs: string[];
  notes: string[];
};

const junitFile = "reports/junit.xml";

/** Read-only view of the repo root, so detection can be tested without a disk. */
export type ProjectFiles = {
  exists(name: string): Promise<boolean>;
  read(name: string): Promise<string | null>;
};

type EcosystemDetection = {
  ecosystem: ProjectEcosystem;
  setup: string[];
  verify: string[];
  toolchains: ProjectToolchain[];
  redGreen?: RedGreenConfig | null;
  junit?: JunitOffer | null;
  evidence?: EvidenceOffer | null;
};

export function projectFilesAt(cwd: string): ProjectFiles {
  return {
    async exists(name) {
      try {
        await access(join(cwd, name));
        return true;
      } catch {
        return false;
      }
    },
    async read(name) {
      try {
        return await readFile(join(cwd, name), "utf8");
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * Detects setup and verification commands from files at the repo root. Every
 * matching ecosystem contributes (a Node + Go repo runs both test suites);
 * `make test` is used only when nothing else supplies a verification command.
 */
export async function detectProject(files: ProjectFiles): Promise<ProjectDetection> {
  const detections: EcosystemDetection[] = [];
  for (const detect of [detectNode, detectPython, detectGo, detectRust, detectJava]) {
    const detection = await detect(files);
    if (detection !== null) detections.push(detection);
  }
  if (detections.every((detection) => detection.verify.length === 0)) {
    const make = await detectMake(files);
    if (make !== null) detections.push(make);
  }

  const toolchains = new Set(detections.flatMap((detection) => detection.toolchains));
  return {
    ecosystems: detections.map((detection) => detection.ecosystem),
    setup: detections.flatMap((detection) => detection.setup),
    verify: detections.flatMap((detection) => detection.verify),
    toolchains: projectToolchains.filter((toolchain) => toolchains.has(toolchain)),
    redGreen:
      detections.find((detection) => detection.redGreen != null)?.redGreen ?? null,
    junit: detections.find((detection) => detection.junit != null)?.junit ?? null,
    evidence:
      detections.find((detection) => detection.evidence != null)?.evidence ?? null,
  };
}

async function detectNode(files: ProjectFiles): Promise<EcosystemDetection | null> {
  const packageJsonText = await files.read("package.json");
  if (packageJsonText === null) return null;
  const packageJson = parsePackageJson(packageJsonText);

  const manager = await nodePackageManager(files, packageJson.packageManager);
  return {
    ecosystem: "node",
    setup: [manager.setup],
    verify: nodeVerifyCommands(manager.run, packageJson.scripts),
    toolchains: manager.toolchains,
    redGreen: nodeRedGreen(manager.run, packageJson),
    junit: nodeJunit(manager.run, packageJson),
    evidence: await nodeEvidence(files, packageJson.dependencies),
  };
}

async function nodeEvidence(
  files: ProjectFiles,
  dependencies: readonly string[],
): Promise<EvidenceOffer | null> {
  const offer: EvidenceOffer = { tools: [], globs: [], notes: [] };
  if (dependencies.includes("@playwright/test")) {
    offer.tools.push("playwright");
    offer.globs.push("test-results/**/*.png", "test-results/**/*.webm");
    let screenshotsEnabled = false;
    for (const extension of ["ts", "js", "mjs", "cjs"]) {
      const config = await files.read(`playwright.config.${extension}`);
      if (
        config !== null &&
        /\bscreenshot\s*:\s*(['"])(?:on|only-on-failure)\1/.test(config)
      ) {
        screenshotsEnabled = true;
      }
    }
    if (!screenshotsEnabled) {
      offer.notes.push(
        "Playwright saves screenshots only with use.screenshot set in playwright.config; setup does not change it.",
      );
    }
  }
  if (dependencies.includes("cypress")) {
    offer.tools.push("cypress");
    offer.globs.push("cypress/screenshots/**/*.png", "cypress/videos/**/*.mp4");
    offer.notes.push("Cypress records video only with video: true.");
  }
  return offer.tools.length === 0 ? null : offer;
}

/**
 * Adds the runner's JUnit reporter to `<manager> test` when the test script
 * runs the runner directly. A script that chains other commands, or wraps the
 * runner, gets no offer, since extra flags would reach the wrong command.
 */
function nodeJunit(
  runPrefix: string,
  packageJson: { scripts: Record<string, string>; dependencies: string[] },
): JunitOffer | null {
  const testScript = packageJson.scripts.test?.trim();
  if (testScript === undefined || /[&|;<>`$()]/.test(testScript)) return null;
  const command = runPrefix === "npm run" ? "npm test" : `${runPrefix} test`;
  // npm and pnpm 8 need `--` to forward flags to the script.
  const forward = runPrefix === "yarn" ? command : `${command} --`;
  const mkdir = "mkdir -p reports";
  const offer = (runner: JunitRunner, replacement: string): JunitOffer => ({
    runner,
    command,
    replacement,
    glob: junitFile,
    ...(runner === "node:test"
      ? {
          coverageFlags:
            "--experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info",
        }
      : runner === "jest"
        ? { coverageFlags: "--coverage --coverageReporters=lcov" }
        : runner === "vitest" &&
            packageJson.dependencies.some(
              (name) =>
                name === "@vitest/coverage-v8" || name === "@vitest/coverage-istanbul",
            )
          ? { coverageFlags: "--coverage --coverage.reporter=lcov" }
          : {}),
  });

  if (/^node\s+--test\b/.test(testScript)) {
    return offer(
      "node:test",
      `${mkdir} && ${forward} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${junitFile}`,
    );
  }
  if (/^vitest\b/.test(testScript)) {
    return offer(
      "vitest",
      `${mkdir} && ${forward} --reporter=default --reporter=junit --outputFile.junit=${junitFile}`,
    );
  }
  // Jest writes JUnit XML only through jest-junit, which setup never installs.
  if (/^jest\b/.test(testScript) && packageJson.dependencies.includes("jest-junit")) {
    return offer(
      "jest",
      `${mkdir} && JEST_JUNIT_OUTPUT_FILE=${junitFile} ${forward} --reporters=default --reporters=jest-junit`,
    );
  }
  if (/^jest\b/.test(testScript)) {
    return { ...offer("jest", forward), glob: "" };
  }
  return null;
}

const jsTestFiles = ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];

/**
 * Runs one test file with the runner the test script uses. A test script that
 * builds first (tests run from build output) gets no default: reverting the
 * source would not revert the build.
 */
function nodeRedGreen(
  runPrefix: string,
  packageJson: { scripts: Record<string, string>; dependencies: string[] },
): RedGreenConfig | null {
  const testScript = packageJson.scripts.test ?? "";
  const uses = (tool: string): boolean =>
    packageJson.dependencies.includes(tool) ||
    new RegExp(`\\b${tool}\\b`).test(testScript);
  const exec =
    runPrefix === "npm run" ? "npx" : runPrefix === "pnpm" ? "pnpm exec" : runPrefix;

  if (uses("vitest")) {
    return {
      test_files: jsTestFiles,
      support_files: [],
      run: `${exec} vitest run {file}`,
    };
  }
  if (uses("jest")) {
    return { test_files: jsTestFiles, support_files: [], run: `${exec} jest {file}` };
  }
  if (/^node\s+--test\b/.test(testScript.trim())) {
    return {
      test_files: ["**/*.test.{js,mjs,cjs}"],
      support_files: [],
      run: "node --test {file}",
    };
  }
  return null;
}

async function nodePackageManager(
  files: ProjectFiles,
  packageManagerField: string | undefined,
): Promise<{ setup: string; run: string; toolchains: ProjectToolchain[] }> {
  if (await files.exists("pnpm-lock.yaml")) {
    return {
      setup: "pnpm install --frozen-lockfile",
      run: "pnpm",
      toolchains: ["corepack"],
    };
  }
  if (await files.exists("yarn.lock")) {
    // Yarn 1 ships with the Node image; Yarn 2+ (Berry) comes from corepack.
    const berry =
      (await files.exists(".yarnrc.yml")) ||
      /^yarn@[2-9]/.test(packageManagerField ?? "");
    return berry
      ? { setup: "yarn install --immutable", run: "yarn", toolchains: ["corepack"] }
      : { setup: "yarn install --frozen-lockfile", run: "yarn", toolchains: [] };
  }
  if (await files.exists("package-lock.json")) {
    return { setup: "npm ci", run: "npm run", toolchains: [] };
  }
  // Without a lockfile, install without creating one so it never lands in the PR.
  return { setup: "npm install --no-package-lock", run: "npm run", toolchains: [] };
}

function nodeVerifyCommands(
  runPrefix: string,
  scripts: Record<string, string>,
): string[] {
  if (scripts.test !== undefined) {
    return [runPrefix === "npm run" ? "npm test" : `${runPrefix} test`];
  }
  if (scripts.typecheck !== undefined) return [`${runPrefix} typecheck`];
  if (scripts.build !== undefined) return [`${runPrefix} build`];
  return [];
}

function parsePackageJson(text: string): {
  scripts: Record<string, string>;
  packageManager: string | undefined;
  dependencies: string[];
} {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { scripts: {}, packageManager: undefined, dependencies: [] };
  }
  const scripts = "scripts" in parsed ? parsed.scripts : undefined;
  const packageManager = "packageManager" in parsed ? parsed.packageManager : undefined;
  const dependencies = ["dependencies", "devDependencies"].flatMap((key) => {
    const value: unknown =
      key in parsed ? (parsed as Record<string, unknown>)[key] : undefined;
    return value === null || typeof value !== "object" || Array.isArray(value)
      ? []
      : Object.keys(value);
  });
  return {
    dependencies,
    scripts:
      scripts === null || typeof scripts !== "object" || Array.isArray(scripts)
        ? {}
        : Object.fromEntries(
            Object.entries(scripts).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
    packageManager: typeof packageManager === "string" ? packageManager : undefined,
  };
}

// Python environments live in $HOME, outside the cloned workspace, so a
// virtualenv is never committed into the pull request.
const pythonVenv = "$HOME/.venv";

async function detectPython(files: ProjectFiles): Promise<EcosystemDetection | null> {
  const dependencies = (
    await Promise.all(
      ["requirements.txt", "pyproject.toml", "uv.lock", "poetry.lock"].map((name) =>
        files.read(name),
      ),
    )
  ).join("\n");
  const coverage = /\bpytest-cov\b/i.test(dependencies);
  if (await files.exists("uv.lock")) {
    return pythonDetection(["uv sync --frozen"], "uv run pytest", ["uv"], coverage);
  }
  if (await files.exists("poetry.lock")) {
    return pythonDetection(
      ["poetry install"],
      "poetry run pytest",
      ["uv", "poetry"],
      coverage,
    );
  }
  if (await files.exists("requirements.txt")) {
    return pythonDetection(
      [
        `python3 -m venv "${pythonVenv}" && "${pythonVenv}/bin/pip" install -r requirements.txt`,
      ],
      `"${pythonVenv}/bin/python" -m pytest`,
      ["python"],
      coverage,
    );
  }
  return null;
}

function pythonDetection(
  setup: string[],
  pytest: string,
  toolchains: ProjectToolchain[],
  coverage: boolean,
): EcosystemDetection {
  return {
    ecosystem: "python",
    setup,
    verify: [pytest],
    toolchains,
    redGreen: {
      test_files: ["**/test_*.py", "**/*_test.py"],
      support_files: ["**/conftest.py"],
      run: `${pytest} {file}`,
    },
    junit: {
      runner: "pytest",
      command: pytest,
      replacement: `mkdir -p reports && ${pytest} --junitxml=${junitFile}`,
      glob: junitFile,
      ...(coverage
        ? { coverageFlags: "--cov=. --cov-report=lcov:coverage/lcov.info" }
        : {}),
    },
  };
}

async function detectGo(files: ProjectFiles): Promise<EcosystemDetection | null> {
  if (!(await files.exists("go.mod"))) return null;
  return {
    ecosystem: "go",
    setup: ["go mod download"],
    verify: ["go test ./..."],
    toolchains: ["go"],
  };
}

async function detectRust(files: ProjectFiles): Promise<EcosystemDetection | null> {
  if (!(await files.exists("Cargo.toml"))) return null;
  return {
    ecosystem: "rust",
    setup: ["cargo fetch"],
    verify: ["cargo test"],
    toolchains: ["rust"],
  };
}

async function detectJava(files: ProjectFiles): Promise<EcosystemDetection | null> {
  if (await files.exists("pom.xml")) {
    return (await files.exists("mvnw"))
      ? { ecosystem: "java", setup: [], verify: ["./mvnw -B test"], toolchains: ["jdk"] }
      : {
          ecosystem: "java",
          setup: [],
          verify: ["mvn -B test"],
          toolchains: ["jdk", "maven"],
        };
  }
  const gradle =
    (await files.exists("build.gradle")) || (await files.exists("build.gradle.kts"));
  if (gradle && (await files.exists("gradlew"))) {
    return {
      ecosystem: "java",
      setup: [],
      verify: ["./gradlew test"],
      toolchains: ["jdk"],
    };
  }
  return null;
}

async function detectMake(files: ProjectFiles): Promise<EcosystemDetection | null> {
  const makefile = await files.read("Makefile");
  if (makefile === null || !/^test\s*:/m.test(makefile)) return null;
  return { ecosystem: "make", setup: [], verify: ["make test"], toolchains: [] };
}

type ToolchainSnippet = {
  lines: readonly string[];
  /** Directories to prepend to PATH (binaries outside /usr/local/bin). */
  paths?: readonly string[];
};

const toolchainSnippets: Record<ProjectToolchain, ToolchainSnippet> = {
  corepack: { lines: ["ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "RUN corepack enable"] },
  python: {
    lines: [
      "RUN apt-get update \\",
      "  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \\",
      "  && rm -rf /var/lib/apt/lists/*",
    ],
  },
  uv: {
    lines: [
      "COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/",
      "ENV UV_PROJECT_ENVIRONMENT=/home/agent/.venv UV_LINK_MODE=copy",
    ],
  },
  poetry: {
    lines: [
      "RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install poetry",
    ],
  },
  go: {
    lines: ["COPY --from=golang:1-bookworm /usr/local/go /usr/local/go"],
    paths: ["/usr/local/go/bin", "/home/agent/go/bin"],
  },
  rust: {
    lines: [
      "COPY --from=rust:1-bookworm --chown=agent:agent /usr/local/rustup /usr/local/rustup",
      "COPY --from=rust:1-bookworm --chown=agent:agent /usr/local/cargo /usr/local/cargo",
      "ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \\",
      "  CARGO_TARGET_DIR=/home/agent/cargo-target",
    ],
    paths: ["/usr/local/cargo/bin"],
  },
  jdk: {
    lines: [
      "COPY --from=eclipse-temurin:21-jdk /opt/java/openjdk /opt/java/openjdk",
      "ENV JAVA_HOME=/opt/java/openjdk",
    ],
    paths: ["/opt/java/openjdk/bin"],
  },
  maven: {
    lines: [
      "COPY --from=maven:3-eclipse-temurin-21 /usr/share/maven /usr/share/maven",
      "RUN ln -s /usr/share/maven/bin/mvn /usr/local/bin/mvn",
    ],
  },
};

/** Runtime Dockerfile that extends the sandbox image with the given toolchains. */
export function generateRuntimeDockerfile(
  baseImage: string,
  toolchains: readonly ProjectToolchain[],
): string {
  const ordered = projectToolchains.filter((toolchain) => toolchains.includes(toolchain));
  const paths = ordered.flatMap((toolchain) => toolchainSnippets[toolchain].paths ?? []);
  const pathLines =
    paths.length === 0
      ? []
      : [
          `ENV PATH=${paths.join(":")}:$PATH`,
          // The sandbox runs commands with `sh -lc`, and /etc/profile resets PATH
          // for login shells, so also export it from /etc/profile.d.
          `RUN echo 'export PATH="${paths.join(":")}:$PATH"' > /etc/profile.d/agent-cage-toolchains.sh`,
        ];
  return [
    `# Generated by \`agent-cage setup\` for: ${ordered.join(", ")}.`,
    "# Adds toolchains the Agent Cage base image lacks. Edit freely, and pin the",
    "# image tags below for reproducible runs.",
    `FROM ${baseImage}`,
    "",
    "USER root",
    ...ordered.flatMap((toolchain) => toolchainSnippets[toolchain].lines),
    ...pathLines,
    "USER agent",
    "",
  ].join("\n");
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EISDIR")
  );
}
