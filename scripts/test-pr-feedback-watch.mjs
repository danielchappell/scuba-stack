#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LockBusyError,
  acquirePrStateLock,
  appendPrStateJsonl,
  resolvePrState,
  writePrStateJson,
  writePrStateText
} from "../tools/lib/pr-feedback-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHER = path.join(ROOT, "tools", "pr-feedback-watch.mjs");
const tests = [];

test("status and replay use PR-scoped team paths", async () => {
  await withTempDir("pathing", async (tmp) => {
    const tmpReal = await realpath(tmp);
    const status = runWatcher(["status", "--team", "alpha", "--pr", "17"], { cwd: tmp });
    assert.equal(status.status, 0, status.stderr);
    const statusSummary = parseStdoutJson(status);
    assert.equal(statusSummary.mode, "status");
    assert.equal(statusSummary.team, "alpha");
    assert.equal(statusSummary.pr, 17);
    assert.equal(
      statusSummary.state_paths.state_dir,
      path.join(tmpReal, ".scuba", "teams", "alpha", "pr-feedback", "pr-17")
    );
    assert.equal(statusSummary.state_paths.event_log, path.join(statusSummary.state_paths.state_dir, "events.jsonl"));
    assert.equal(statusSummary.state_paths.lock, path.join(statusSummary.state_paths.state_dir, "pr-feedback.lock"));

    const replay = runWatcher(["replay", "--team", "alpha", "--pr", "17"], { cwd: tmp });
    assert.equal(replay.status, 0, replay.stderr);
    const replaySummary = parseStdoutJson(replay);
    assert.equal(replaySummary.mode, "replay");
    assert.equal(replaySummary.status, "replayed");
    assert.equal(replaySummary.replay.current_event_count, 0);
    assert.ok(existsSync(path.join(tmp, ".scuba", "teams", "alpha", "pr-feedback", "pr-17", "event-index.json")));
  });
});

test("two PR numbers in one team use isolated state trees", async () => {
  await withTempDir("isolation", async (tmp) => {
    const first = resolvePrState({ rootDir: tmp, team: "alpha", pr: 1 });
    const second = resolvePrState({ rootDir: tmp, team: "alpha", pr: 2 });
    await appendPrStateJsonl(first, "watcher", "events.jsonl", eventRevision("review:1", "review:1:v1"));
    await appendPrStateJsonl(second, "watcher", "events.jsonl", eventRevision("review:2", "review:2:v1"));

    const one = parseStdoutJson(runWatcher(["replay", "--team", "alpha", "--pr", "1"], { cwd: tmp }));
    const two = parseStdoutJson(runWatcher(["replay", "--team", "alpha", "--pr", "2"], { cwd: tmp }));

    assert.deepEqual(one.replay.current_event_ids, ["review:1"]);
    assert.deepEqual(two.replay.current_event_ids, ["review:2"]);
    assert.notEqual(one.state_paths.state_dir, two.state_paths.state_dir);
    assert.notEqual(one.state_paths.lock, two.state_paths.lock);
    assert.notEqual(one.state_paths.snapshots_dir, two.state_paths.snapshots_dir);
    assert.notEqual(one.state_paths.closeout, two.state_paths.closeout);
  });
});

test("replay is deterministic and duplicate event revisions no-op", async () => {
  await withTempDir("replay", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("thread:1", "thread:1:v1", { state: "open" }));
    await appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("thread:1", "thread:1:v1", { state: "open" }));
    await appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("thread:1", "thread:1:v2", { state: "resolved" }));

    const first = parseStdoutJson(runWatcher(["replay", "--state-dir", state.stateDir]));
    const second = parseStdoutJson(runWatcher(["replay", "--state-dir", state.stateDir]));

    assert.deepEqual(first.replay, second.replay);
    assert.equal(first.replay.unique_revision_count, 2);
    assert.equal(first.replay.duplicate_revision_count, 1);
    assert.deepEqual(first.replay.current_event_ids, ["thread:1"]);
    assert.equal(first.replay.current_events[0].event_revision_id, "thread:1:v2");
    assert.equal(first.replay.current_events[0].payload.state, "resolved");
  });
});

test("atomic writes ignore interrupted temp files and preserve complete JSON/text", async () => {
  await withTempDir("atomic", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });

    await writePrStateJson(state, "watcher", "watcher-status.json", { schema_version: 1, status: "old" });
    await writeFile(path.join(state.stateDir, ".watcher-status.json.scuba-tmp-interrupted"), "{\"schema_version\":");
    await writePrStateJson(state, "watcher", "watcher-status.json", { schema_version: 1, status: "new" });
    assert.deepEqual(JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8")), {
      schema_version: 1,
      status: "new"
    });

    await writePrStateJson(state, "manager", "config.json", {
      schema_version: 1,
      team: "alpha",
      repo: "octo/repo",
      pr_number: 3,
      external_reviewer: { login: "reviewer" }
    });
    await writeFile(path.join(state.stateDir, ".config.json.scuba-tmp-interrupted"), "{\"team\":");
    await writePrStateJson(state, "manager", "config.json", {
      schema_version: 1,
      team: "alpha",
      repo: "octo/repo",
      pr_number: 3,
      external_reviewer: { login: "reviewer" },
      quiet_period_minutes: 20
    });
    const config = JSON.parse(await readFile(path.join(state.stateDir, "config.json"), "utf8"));
    assert.equal(config.quiet_period_minutes, 20);

    await writePrStateJson(state, "steward", "closeout.json", { schema_version: 1, status: "blocked" });
    await writeFile(path.join(state.stateDir, ".closeout.json.scuba-tmp-interrupted"), "{\"status\":");
    await writePrStateJson(state, "steward", "closeout.json", { schema_version: 1, status: "recorded" });
    assert.equal(JSON.parse(await readFile(path.join(state.stateDir, "closeout.json"), "utf8")).status, "recorded");

    await writePrStateText(state, "smoke", "audit/report.md", "complete report\n");
    await writeFile(path.join(state.stateDir, "audit", ".report.md.scuba-tmp-interrupted"), "partial");
    await writePrStateText(state, "smoke", "audit/report.md", "new complete report\n");
    assert.equal(await readFile(path.join(state.stateDir, "audit", "report.md"), "utf8"), "new complete report\n");

    await appendPrStateJsonl(state, "steward", "push-log.jsonl", { head_before: "a", head_after: "b" });
    assert.equal((await readFile(path.join(state.stateDir, "push-log.jsonl"), "utf8")).trim(), "{\"head_before\":\"a\",\"head_after\":\"b\"}");
  });
});

test("one PR lock serializes watcher, manager, steward, and smoke writers", async () => {
  await withTempDir("locks", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const lock = await acquirePrStateLock(state, {
      owner: "watcher",
      mode: "test",
      operation: "hold",
      timeoutMs: 0,
      staleMs: 30_000
    });
    try {
      const busy = runWatcher(["replay", "--state-dir", state.stateDir, "--lock-timeout-ms", "25"]);
      assert.equal(busy.status, 75);
      const busySummary = parseStdoutJson(busy);
      assert.equal(busySummary.reason, "lock_busy");

      await assertLockBusy(writePrStateJson(state, "manager", "config.json", validConfig(), { lockTimeoutMs: 25 }));
      await assertLockBusy(writePrStateJson(state, "steward", "dispositions.json", { schema_version: 1 }, { lockTimeoutMs: 25 }));
      await assertLockBusy(appendPrStateJsonl(state, "steward", "push-log.jsonl", { head_before: "a" }, { lockTimeoutMs: 25 }));
      await assertLockBusy(writePrStateJson(state, "steward", "closeout.json", { schema_version: 1 }, { lockTimeoutMs: 25 }));
      await assertLockBusy(writePrStateText(state, "smoke", "audit/report.md", "blocked\n", { lockTimeoutMs: 25 }));
    } finally {
      await lock.release();
    }

    const stewardLock = await acquirePrStateLock(state, {
      owner: "steward",
      mode: "test",
      operation: "hold",
      timeoutMs: 0,
      staleMs: 30_000
    });
    try {
      await assertLockBusy(appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("e", "e:v1"), { lockTimeoutMs: 25 }));
    } finally {
      await stewardLock.release();
    }
  });
});

test("explicit lock reuse is scoped to the selected PR state", async () => {
  await withTempDir("lock-scope", async (tmp) => {
    const first = resolvePrState({ rootDir: tmp, team: "alpha", pr: 1 });
    const second = resolvePrState({ rootDir: tmp, team: "alpha", pr: 2 });
    const firstLock = await acquirePrStateLock(first, {
      owner: "watcher",
      mode: "test",
      operation: "hold",
      timeoutMs: 0,
      staleMs: 30_000
    });
    const secondLock = await acquirePrStateLock(second, {
      owner: "steward",
      mode: "test",
      operation: "hold",
      timeoutMs: 0,
      staleMs: 30_000
    });

    try {
      await assert.rejects(
        writePrStateJson(second, "watcher", "watcher-status.json", {
          schema_version: 1,
          status: "wrong-state"
        }, { lock: firstLock }),
        (error) => error?.code === "lock_state_mismatch" && error?.exitCode === 20
      );
      assert.equal(existsSync(path.join(second.stateDir, "watcher-status.json")), false);
    } finally {
      await secondLock.release();
      await firstLock.release();
    }
  });
});

test("status records stale lock breaks durably", async () => {
  await withTempDir("stale-status", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    await writeFile(path.join(state.stateDir, "pr-feedback.lock"), JSON.stringify({
      schema_version: 1,
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "stale"
    }, null, 2) + "\n");

    const status = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1"]);

    assert.equal(status.status, 0, status.stderr);
    const summary = parseStdoutJson(status);
    assert.equal(summary.mode, "status");
    assert.equal(summary.status, "status_checked");
    const recorded = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(recorded.mode, "status");
    assert.equal(recorded.status, "status_checked");
    assert.equal(recorded.exit_code, 0);
    assert.equal(recorded.stale_lock_break.previous_lock.operation, "stale");
    assert.equal(existsSync(path.join(state.stateDir, "pr-feedback.lock")), false);
  });
});

test("owner allowlists reject cross-owner and escaping writes", async () => {
  await withTempDir("owners", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });

    await assertOwnerRejected(writePrStateJson(state, "watcher", "closeout.json", { schema_version: 1 }));
    await assertOwnerRejected(writePrStateJson(state, "steward", "watcher-status.json", { schema_version: 1 }));
    await assertOwnerRejected(writePrStateJson(state, "smoke", "config.json", validConfig()));
    await assertOwnerRejected(writePrStateJson(state, "manager", "dispositions.json", { schema_version: 1 }));
    await assertOwnerRejected(writePrStateJson(state, "watcher", "../escape.json", { schema_version: 1 }));
  });
});

test("corrupt canonical state fails closed while derived caches are recoverable", async () => {
  await withTempDir("corrupt", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("review:1", "review:1:v1"));
    await writeFile(path.join(state.stateDir, "event-index.json"), "{ broken cache\n");
    await writeFile(path.join(state.stateDir, "latest-snapshot.json"), "{ broken pointer\n");

    const recovered = parseStdoutJson(runWatcher(["replay", "--state-dir", state.stateDir]));
    assert.equal(recovered.status, "replayed");
    assert.deepEqual(recovered.replay.current_event_ids, ["review:1"]);

    await writeFile(path.join(state.stateDir, "events.jsonl"), "{\"event_id\":\"ok\",\"event_revision_id\":\"ok:v1\"}\n{ broken log\n");
    const corruptEvents = runWatcher(["replay", "--state-dir", state.stateDir]);
    assert.equal(corruptEvents.status, 20);
    const corruptEventsSummary = parseStdoutJson(corruptEvents);
    assert.equal(corruptEventsSummary.reason, "corrupt_state");
    assert.equal(corruptEventsSummary.file, path.join(state.stateDir, "events.jsonl"));

    const configState = resolvePrState({ stateDir: path.join(tmp, "bad-config") });
    await mkdir(configState.stateDir, { recursive: true });
    await writeFile(path.join(configState.stateDir, "config.json"), "{ broken config\n");
    const corruptConfig = runWatcher(["status", "--state-dir", configState.stateDir]);
    assert.equal(corruptConfig.status, 20);
    const corruptConfigSummary = parseStdoutJson(corruptConfig);
    assert.equal(corruptConfigSummary.reason, "corrupt_state");
    assert.equal(corruptConfigSummary.file, path.join(configState.stateDir, "config.json"));
  });
});

function test(name, fn) {
  tests.push({ name, fn });
}

function validConfig() {
  return {
    schema_version: 1,
    team: "alpha",
    repo: "octo/repo",
    pr_number: 7,
    external_reviewer: { login: "reviewer" },
    quiet_period_minutes: 20
  };
}

function eventRevision(eventId, revisionId, extra = {}) {
  return {
    schema_version: 1,
    event_id: eventId,
    event_revision_id: revisionId,
    observed_at: "2026-06-28T00:00:00.000Z",
    payload: extra
  };
}

async function assertLockBusy(promise) {
  await assert.rejects(promise, (error) => error instanceof LockBusyError || error?.code === "lock_busy");
}

async function assertOwnerRejected(promise) {
  await assert.rejects(promise, (error) => error?.code === "owner_path_forbidden" || error?.code === "invalid_state_path");
}

function runWatcher(args, options = {}) {
  const result = spawnSync("node", [WATCHER, ...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  return result;
}

function parseStdoutJson(result) {
  assert.ok(result.stdout.trim(), `expected stdout JSON, stderr was:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function withTempDir(label, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `scuba-pr-feedback-${label}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [index, { name, fn }] of tests.entries()) {
  try {
    await fn();
    console.log(`ok ${index + 1} - ${name}`);
  } catch (error) {
    console.error(`not ok ${index + 1} - ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
