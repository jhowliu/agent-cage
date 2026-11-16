import assert from "node:assert/strict";
import test from "node:test";
import {
  detectProject,
  generateRuntimeDockerfile,
  type ProjectDetection,
  type ProjectFiles,
} from "../src/project-detect.js";

function files(entries: Record<string, string>): ProjectFiles {
  return {
    async exists(name) {
      return name in entries;
    },
    async read(name) {
      return entries[name] ?? null;
    },
  };
}

function packageJson(
  scripts: Record<string, string>,
  packageManager?: string,
  devDependencies?: Record<string, string>,
): string {
  return JSON.stringify({
    scripts,
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
  });
}

const none: ProjectDetection = {
  ecosystems: [],
  setup: [],
  verify: [],
  toolchains: [],
  redGreen: null,
};

const jsTestFiles = ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];

function pytestRedGreen(pytest: string): ProjectDetection["redGreen"] {
  return {
    test_files: ["**/test_*.py", "**/*_test.py"],
    support_files: ["**/conftest.py"],
    run: `${pytest} {file}`,
  };
}

const cases: {
  name: string;
  files: Record<string, string>;
  expected: ProjectDetection;
}[] = [
  {
    name: "npm with a lockfile",
    files: {
      "package.json": packageJson({ test: "node --test" }),
      "package-lock.json": "{}",
    },
    expected: {
      ecosystems: ["node"],
      setup: ["npm ci"],
      verify: ["npm test"],
      toolchains: [],
      redGreen: {
        test_files: ["**/*.test.{js,mjs,cjs}"],
        support_files: [],
        run: "node --test {file}",
      },
    },
  },
  {
    name: "npm without a lockfile",
    files: { "package.json": packageJson({ typecheck: "tsc" }) },
    expected: {
      ecosystems: ["node"],
      setup: ["npm install --no-package-lock"],
      verify: ["npm run typecheck"],
      toolchains: [],
      redGreen: null,
    },
  },
  {
    name: "pnpm",
    files: { "package.json": packageJson({ test: "vitest" }), "pnpm-lock.yaml": "" },
    expected: {
      ecosystems: ["node"],
      setup: ["pnpm install --frozen-lockfile"],
      verify: ["pnpm test"],
      toolchains: ["corepack"],
      redGreen: {
        test_files: jsTestFiles,
        support_files: [],
        run: "pnpm exec vitest run {file}",
      },
    },
  },
  {
    name: "yarn 1",
    files: { "package.json": packageJson({ build: "tsc" }), "yarn.lock": "" },
    expected: {
      ecosystems: ["node"],
      setup: ["yarn install --frozen-lockfile"],
      verify: ["yarn build"],
      toolchains: [],
      redGreen: null,
    },
  },
  {
    name: "yarn berry from packageManager",
    files: {
      "package.json": packageJson({ test: "jest" }, "yarn@4.5.0"),
      "yarn.lock": "",
    },
    expected: {
      ecosystems: ["node"],
      setup: ["yarn install --immutable"],
      verify: ["yarn test"],
      toolchains: ["corepack"],
      redGreen: { test_files: jsTestFiles, support_files: [], run: "yarn jest {file}" },
    },
  },
  {
    name: "uv",
    files: { "pyproject.toml": "", "uv.lock": "" },
    expected: {
      ecosystems: ["python"],
      setup: ["uv sync --frozen"],
      verify: ["uv run pytest"],
      toolchains: ["uv"],
      redGreen: pytestRedGreen("uv run pytest"),
    },
  },
  {
    name: "poetry",
    files: { "pyproject.toml": "", "poetry.lock": "" },
    expected: {
      ecosystems: ["python"],
      setup: ["poetry install"],
      verify: ["poetry run pytest"],
      toolchains: ["uv", "poetry"],
      redGreen: pytestRedGreen("poetry run pytest"),
    },
  },
  {
    name: "requirements.txt installs into a venv outside the workspace",
    files: { "requirements.txt": "pytest\n" },
    expected: {
      ecosystems: ["python"],
      setup: [
        'python3 -m venv "$HOME/.venv" && "$HOME/.venv/bin/pip" install -r requirements.txt',
      ],
      verify: ['"$HOME/.venv/bin/python" -m pytest'],
      toolchains: ["python"],
      redGreen: pytestRedGreen('"$HOME/.venv/bin/python" -m pytest'),
    },
  },
  {
    name: "go",
    files: { "go.mod": "module example.com/app\n" },
    expected: {
      ecosystems: ["go"],
      setup: ["go mod download"],
      verify: ["go test ./..."],
      toolchains: ["go"],
      redGreen: null,
    },
  },
  {
    name: "rust",
    files: { "Cargo.toml": "" },
    expected: {
      ecosystems: ["rust"],
      setup: ["cargo fetch"],
      verify: ["cargo test"],
      toolchains: ["rust"],
      redGreen: null,
    },
  },
  {
    name: "maven",
    files: { "pom.xml": "" },
    expected: {
      ecosystems: ["java"],
      setup: [],
      verify: ["mvn -B test"],
      toolchains: ["jdk", "maven"],
      redGreen: null,
    },
  },
  {
    name: "maven wrapper",
    files: { "pom.xml": "", mvnw: "" },
    expected: {
      ecosystems: ["java"],
      setup: [],
      verify: ["./mvnw -B test"],
      toolchains: ["jdk"],
      redGreen: null,
    },
  },
  {
    name: "gradle wrapper",
    files: { "build.gradle.kts": "", gradlew: "" },
    expected: {
      ecosystems: ["java"],
      setup: [],
      verify: ["./gradlew test"],
      toolchains: ["jdk"],
      redGreen: null,
    },
  },
  {
    name: "gradle without a wrapper is left to the user",
    files: { "build.gradle": "" },
    expected: none,
  },
  {
    name: "Makefile test target when nothing else verifies",
    files: { Makefile: "build:\n\tcc main.c\n\ntest:\n\t./run-tests\n" },
    expected: {
      ecosystems: ["make"],
      setup: [],
      verify: ["make test"],
      toolchains: [],
      redGreen: null,
    },
  },
  {
    name: "Makefile is ignored when an ecosystem already verifies",
    files: { "go.mod": "", Makefile: "test:\n\tgo test ./...\n" },
    expected: {
      ecosystems: ["go"],
      setup: ["go mod download"],
      verify: ["go test ./..."],
      toolchains: ["go"],
      redGreen: null,
    },
  },
  {
    name: "Node tooling next to a Go module",
    files: {
      "package.json": packageJson({ lint: "eslint ." }),
      "package-lock.json": "{}",
      "go.mod": "",
    },
    expected: {
      ecosystems: ["node", "go"],
      setup: ["npm ci", "go mod download"],
      verify: ["go test ./..."],
      toolchains: ["go"],
      redGreen: null,
    },
  },
  {
    name: "vitest from devDependencies runs one file with npx",
    files: {
      "package.json": packageJson({ test: "npm run lint && npm run unit" }, undefined, {
        vitest: "^3.0.0",
      }),
      "package-lock.json": "{}",
    },
    expected: {
      ecosystems: ["node"],
      setup: ["npm ci"],
      verify: ["npm test"],
      toolchains: [],
      redGreen: {
        test_files: jsTestFiles,
        support_files: [],
        run: "npx vitest run {file}",
      },
    },
  },
  {
    name: "a test script that builds first has no red-green default",
    files: {
      "package.json": packageJson({ test: "npm run build && node --test dist/test" }),
      "package-lock.json": "{}",
    },
    expected: {
      ecosystems: ["node"],
      setup: ["npm ci"],
      verify: ["npm test"],
      toolchains: [],
      redGreen: null,
    },
  },
  { name: "nothing recognizable", files: { "README.md": "" }, expected: none },
];

for (const { name, files: entries, expected } of cases) {
  test(`detectProject: ${name}`, async () => {
    assert.deepEqual(await detectProject(files(entries)), expected);
  });
}

test("generateRuntimeDockerfile installs toolchains as root in a fixed order", () => {
  const dockerfile = generateRuntimeDockerfile("registry.example.com/base:1", [
    "maven",
    "poetry",
    "jdk",
    "uv",
    "go",
  ]);
  const lines = dockerfile.trimEnd().split("\n");

  assert.ok(lines[0]?.includes("for: uv, poetry, go, jdk, maven"));
  assert.ok(lines.includes("FROM registry.example.com/base:1"));
  assert.ok(
    lines.indexOf("USER root") < lines.findIndex((line) => line.includes("astral-sh/uv")),
  );
  assert.equal(lines.at(-1), "USER agent");

  const order = [
    "astral-sh/uv",
    "uv tool install poetry",
    "golang:1",
    "eclipse-temurin",
    "maven:3",
  ];
  const positions = order.map((marker) =>
    lines.findIndex((line) => line.includes(marker)),
  );
  assert.ok(positions.every((position) => position !== -1));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
});

test("generateRuntimeDockerfile keeps toolchain PATHs for the sandbox's login shell", () => {
  const lines = generateRuntimeDockerfile("base:1", ["go", "jdk"]).split("\n");
  const paths = "/usr/local/go/bin:/home/agent/go/bin:/opt/java/openjdk/bin";

  assert.ok(lines.includes(`ENV PATH=${paths}:$PATH`));
  assert.ok(
    lines.includes(
      `RUN echo 'export PATH="${paths}:$PATH"' > /etc/profile.d/agent-cage-toolchains.sh`,
    ),
  );
  assert.ok(
    !generateRuntimeDockerfile("base:1", ["uv", "corepack"]).includes("PATH="),
    "toolchains installed into /usr/local/bin need no PATH changes",
  );
});
