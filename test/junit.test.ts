import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  formatJunitFailures,
  formatJunitItems,
  parseJunit,
  readJunitReports,
} from "../src/run/junit.js";

test("parseJunit counts testcases under a testsuites root", () => {
  const summary = parseJunit(`<?xml version="1.0"?>
<testsuites tests="99">
  <testsuite name="a" tests="0">
    <testcase classname="A" name="ok"/>
    <testcase classname="A" name="bad"><failure message="boom&#10;more">trace</failure></testcase>
  </testsuite>
  <testsuite name="b"><testcase classname="B" name="later"><skipped/></testcase></testsuite>
</testsuites>`);
  assert.deepEqual(summary, {
    passed: 1,
    failed: 1,
    skipped: 1,
    failures: [{ classname: "A", name: "bad", message: "boom" }],
  });
});

test("parseJunit reads a single testsuite root and counts one testcase", () => {
  const summary = parseJunit(
    `<testsuite><testcase classname="X" name="only"/></testsuite>`,
  );
  assert.equal(summary?.passed, 1);
});

test("parseJunit follows nested suites and counts error as failed", () => {
  const summary = parseJunit(`<testsuite name="outer">
  <testsuite name="inner">
    <testcase classname="I" name="e"><error>Crash: bad\nstack</error></testcase>
    <testcase classname="I" name="p"/>
  </testsuite>
</testsuite>`);
  assert.equal(summary?.passed, 1);
  assert.equal(summary?.failed, 1);
  assert.deepEqual(summary?.failures, [
    { classname: "I", name: "e", message: "Crash: bad" },
  ]);
});

test("parseJunit rejects text that is not JUnit", () => {
  assert.equal(parseJunit("<testsuite><testcase></testsuite>"), null);
  assert.equal(parseJunit("not xml"), null);
  assert.equal(parseJunit("<html/>"), null);
});

test("formatJunitItems sums files, names each and reports unreadable ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cage-junit-"));
  try {
    const files = {
      "reports/a.xml": `<testsuite><testcase name="1"/><testcase name="2"/></testsuite>`,
      "reports/b.xml": `<testsuite><testcase name="3"><skipped/></testcase></testsuite>`,
      "reports/c.xml": "<broken",
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "verify-1-reports", path)), { recursive: true });
      await writeFile(join(dir, "verify-1-reports", path), text);
    }
    const results = await readJunitReports((name) => join(dir, name), {
      iteration: 1,
      directory: "verify-1-reports",
      files: Object.keys(files).map((path) => ({ kind: "junit", path, bytes: 1 })),
      skipped: [],
    });

    assert.deepEqual(formatJunitItems(results), [
      "Tests: 2 passed, 0 failed, 1 skipped (JUnit: reports/a.xml, reports/b.xml)",
      "Tests: could not read reports/c.xml",
    ]);
    assert.deepEqual(formatJunitItems([]), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatJunitFailures lists at most 20 failures", () => {
  const failures = Array.from({ length: 22 }, (_, index) => ({
    classname: "S",
    name: `t${index}`,
    message: "nope",
  }));
  const text = formatJunitFailures([
    { path: "x.xml", ok: true, summary: { passed: 0, failed: 22, skipped: 0, failures } },
  ]);
  assert.match(text ?? "", /^Failed tests \(22\):\n- S > t0: nope/);
  assert.match(text ?? "", /- S > t19: nope\n- \.\.\. and 2 more$/);
  assert.equal(formatJunitFailures([]), null);
});
