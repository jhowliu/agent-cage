import assert from "node:assert/strict";
import test from "node:test";
import { changedLineCoverage } from "../src/run/coverage.js";

const diff = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -10,2 +10,6 @@
 context
-old
+one
+two
+three
+four
+comment
`;

test("changed-line coverage counts executable additions and merges uncovered ranges", () => {
  const lcov =
    "SF:/workspace/src/math.js\nDA:10,0\nDA:11,1\nDA:12,0\nDA:13,0\nDA:14,0\nend_of_record\nSF:/outside/src/math.js\nDA:11,0\nend_of_record";
  assert.equal(
    changedLineCoverage(diff, [lcov], "/workspace"),
    "Changed-line coverage: 1 of 4 lines (25%). Not covered: src/math.js:12-14",
  );
  assert.equal(
    changedLineCoverage(diff, [lcov.replace("/workspace/", "")], "/workspace"),
    changedLineCoverage(diff, [lcov], "/workspace"),
  );
  assert.equal(
    changedLineCoverage(diff, [lcov.replace("/workspace/", "/host/repo/")], "/host/repo"),
    changedLineCoverage(diff, [lcov], "/workspace"),
  );
});

test("changed-line coverage has a distinct no executable lines item", () => {
  assert.equal(
    changedLineCoverage(diff, ["SF:src/math.js\nDA:10,1\nend_of_record"], "/workspace"),
    "Changed-line coverage: no changed lines are executable",
  );
});

test("repeated LCOV records count each line once and merge hits", () => {
  assert.equal(
    changedLineCoverage(
      diff,
      [
        "SF:src/math.js\nDA:11,0\nend_of_record",
        "SF:src/math.js\nDA:11,2\nend_of_record",
      ],
      "/workspace",
    ),
    "Changed-line coverage: 1 of 1 lines (100%).",
  );
});
