#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("divergent duplicate event revisions fail closed as corrupt state", async () => {
  await withTempDir("duplicate-conflict", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("thread:1", "thread:1:v1", { state: "open" }));
    await appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("thread:1", "thread:1:v1", { state: "resolved" }));

    const replay = runWatcher(["replay", "--state-dir", state.stateDir]);

    assert.equal(replay.status, 20);
    const summary = parseStdoutJson(replay);
    assert.equal(summary.reason, "corrupt_state");
    assert.equal(summary.file, path.join(state.stateDir, "events.jsonl"));
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

test("failed JSONL append leaves the canonical log complete", async () => {
  await withTempDir("jsonl-append-failure", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await appendPrStateJsonl(state, "steward", "push-log.jsonl", { head_before: "a", head_after: "b" });
    const before = await readFile(path.join(state.stateDir, "push-log.jsonl"), "utf8");

    const loader = path.join(tmp, "jsonl-fault-loader.mjs");
    const script = path.join(tmp, "append-jsonl-with-fault.mjs");
    await writeFile(loader, fsPromisesMockLoader(`
      import * as real from "node:fs/promises";
      export * from "node:fs/promises";

      export async function open(file, flags, mode) {
        const handle = await real.open(file, flags, mode);
        const name = String(file);
        const isAppend = flags === "a";
        const isJsonlTemp = name.includes(".push-log.jsonl.scuba-tmp-");
        if (!isAppend && !isJsonlTemp) return handle;
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === "writeFile") {
              return async (data, ...args) => {
                const text = String(data);
                await target.writeFile(text.slice(0, Math.max(1, Math.floor(text.length / 2))), ...args);
                throw new Error("injected partial JSONL write failure");
              };
            }
            return Reflect.get(target, prop, receiver);
          }
        });
      }
    `));
    await writeFile(script, `
      import { appendPrStateJsonl, resolvePrState } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "tools", "lib", "pr-feedback-state.mjs")).href)};

      const state = resolvePrState({ stateDir: ${JSON.stringify(state.stateDir)} });
      await appendPrStateJsonl(state, "steward", "push-log.jsonl", { head_before: "b", head_after: "c" });
    `);

    const failed = runNode(["--loader", loader, script]);

    assert.notEqual(failed.status, 0, failed.stderr);
    const after = await readFile(path.join(state.stateDir, "push-log.jsonl"), "utf8");
    assert.equal(after, before);
    assert.deepEqual(after.trim().split("\n").map((line) => JSON.parse(line)), [{ head_before: "a", head_after: "b" }]);
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

test("explicit lock reuse requires the current live lock instance", async () => {
  await withTempDir("lock-live-identity", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const watcherLock = await acquirePrStateLock(state, {
      owner: "watcher",
      mode: "test",
      operation: "released",
      timeoutMs: 0,
      staleMs: 30_000
    });
    await watcherLock.release();

    const stewardLock = await acquirePrStateLock(state, {
      owner: "steward",
      mode: "test",
      operation: "current",
      timeoutMs: 0,
      staleMs: 30_000
    });

    try {
      await assert.rejects(
        writePrStateJson(state, "watcher", "watcher-status.json", {
          schema_version: 1,
          status: "wrote-with-released-lock"
        }, { lock: watcherLock }),
        (error) => error?.code === "lock_not_held" || error?.code === "lock_state_mismatch"
      );

      await watcherLock.release();
      const currentLock = JSON.parse(await readFile(path.join(state.stateDir, "pr-feedback.lock"), "utf8"));
      assert.equal(currentLock.owner, "steward");
      assert.equal(currentLock.operation, "current");
    } finally {
      await stewardLock.release();
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

test("malformed parsed lock files become stale-breakable by mtime", async () => {
  await withTempDir("malformed-stale-lock", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    await writeFile(lockPath, "{}\n");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const status = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);

    assert.equal(status.status, 0, status.stderr);
    const summary = parseStdoutJson(status);
    assert.equal(summary.status, "status_checked");
    const recorded = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(recorded.stale_lock_break.previous_lock.corrupt_lock, true);
    assert.equal(recorded.stale_lock_break.previous_lock.schema_valid, false);
    assert.equal(existsSync(lockPath), false);
  });
});

test("stale lock break does not delete a fresh replacement lock", async () => {
  await withTempDir("stale-lock-race", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    await writeFile(lockPath, JSON.stringify({
      schema_version: 1,
      lock_id: "stale-lock",
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "stale"
    }, null, 2) + "\n");

    const replacement = {
      schema_version: 1,
      lock_id: "fresh-replacement",
      owner: "steward",
      pid: process.pid,
      hostname: os.hostname(),
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      mode: "test",
      operation: "replacement"
    };
    const loader = path.join(tmp, "stale-race-loader.mjs");
    const script = path.join(tmp, "break-stale-lock.mjs");
    await writeFile(loader, fsPromisesMockLoader(`
      import * as real from "node:fs/promises";
      export * from "node:fs/promises";

      let raced = false;
      async function installReplacement(file) {
        if (raced || String(file) !== process.env.SCUBA_STALE_RACE_LOCK) return;
        raced = true;
        await real.writeFile(file, process.env.SCUBA_STALE_RACE_REPLACEMENT);
      }

      export async function unlink(file) {
        await installReplacement(file);
        return real.unlink(file);
      }

      export async function rename(from, to) {
        await installReplacement(from);
        return real.rename(from, to);
      }
    `));
    await writeFile(script, `
      import { acquirePrStateLock, resolvePrState } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "tools", "lib", "pr-feedback-state.mjs")).href)};

      const state = resolvePrState({ stateDir: ${JSON.stringify(state.stateDir)} });
      try {
        const lock = await acquirePrStateLock(state, {
          owner: "watcher",
          mode: "test",
          operation: "after-race",
          timeoutMs: 25,
          staleMs: 1
        });
        await lock.release();
      } catch (error) {
        process.stderr.write(error.message + "\\n");
        process.exit(error.exitCode ?? 1);
      }
    `);

    const raced = runNode(["--loader", loader, script], {
      env: {
        SCUBA_STALE_RACE_LOCK: lockPath,
        SCUBA_STALE_RACE_REPLACEMENT: JSON.stringify(replacement, null, 2) + "\n"
      }
    });

    assert.equal(raced.status, 75, raced.stderr);
    const currentLock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(currentLock.lock_id, "fresh-replacement");
    assert.equal(currentLock.owner, "steward");
  });
});

test("state reads and lock handling reject symlink escapes", async () => {
  await withTempDir("read-symlink", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const outside = path.join(tmp, "outside");
    await mkdir(state.stateDir, { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(path.join(outside, "watcher-status.json"), JSON.stringify({
      schema_version: 1,
      status: "S02_STATUS_SECRET"
    }) + "\n");
    await symlink(path.join(outside, "watcher-status.json"), path.join(state.stateDir, "watcher-status.json"));
    const status = runWatcher(["status", "--state-dir", state.stateDir]);
    assert.equal(status.status, 20);
    assert.equal(parseStdoutJson(status).reason, "invalid_state_path");
    assert.ok(!status.stdout.includes("S02_STATUS_SECRET"));
    await rm(path.join(state.stateDir, "watcher-status.json"), { force: true });

    await writeFile(path.join(outside, "events.jsonl"), JSON.stringify(eventRevision("outside", "outside:v1", {
      token: "S02_EVENT_SECRET"
    })) + "\n");
    await symlink(path.join(outside, "events.jsonl"), path.join(state.stateDir, "events.jsonl"));
    const replay = runWatcher(["replay", "--state-dir", state.stateDir]);
    assert.equal(replay.status, 20);
    assert.equal(parseStdoutJson(replay).reason, "invalid_state_path");
    assert.ok(!replay.stdout.includes("S02_EVENT_SECRET"));
    await rm(path.join(state.stateDir, "events.jsonl"), { force: true });

    await writeFile(path.join(outside, "pr-feedback.lock"), JSON.stringify({
      schema_version: 1,
      lock_id: "outside-lock",
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "S02_LOCK_SECRET"
    }) + "\n");
    await symlink(path.join(outside, "pr-feedback.lock"), path.join(state.stateDir, "pr-feedback.lock"));
    const lockStatus = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1"]);
    assert.equal(lockStatus.status, 20);
    assert.equal(parseStdoutJson(lockStatus).reason, "invalid_state_path");
    assert.ok(!lockStatus.stdout.includes("S02_LOCK_SECRET"));
  });
});

test("team PR state creation rejects symlinked fixed parents", async () => {
  await withTempDir("team-symlink-parent", async (tmp) => {
    const root = path.join(tmp, "root");
    const outside = path.join(tmp, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, ".scuba"));

    const replay = runWatcher(["replay", "--team", "alpha", "--pr", "9"], { cwd: root });

    assert.equal(replay.status, 20);
    const summary = parseStdoutJson(replay);
    assert.equal(summary.reason, "invalid_state_path");
    assert.equal(existsSync(path.join(outside, "teams", "alpha", "pr-feedback", "pr-9", "event-index.json")), false);
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
  return runNode([WATCHER, ...args], options);
}

function runNode(args, options = {}) {
  const result = spawnSync("node", args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  return result;
}

function fsPromisesMockLoader(mockSource) {
  return `
    export async function resolve(specifier, context, defaultResolve) {
      if (specifier === "node:fs/promises" && context.parentURL !== "mock:fs-promises") {
        return { url: "mock:fs-promises", shortCircuit: true };
      }
      return defaultResolve(specifier, context, defaultResolve);
    }

    export async function load(url, context, defaultLoad) {
      if (url === "mock:fs-promises") {
        return {
          format: "module",
          shortCircuit: true,
          source: ${JSON.stringify(mockSource)}
        };
      }
      return defaultLoad(url, context, defaultLoad);
    }
  `;
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
