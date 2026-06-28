#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

    await writePrStateJson(state, "steward", "hardening-rounds/round-1.json", {
      schema_version: 1,
      round: 1,
      status: "open"
    });
    assert.equal(
      JSON.parse(await readFile(path.join(state.stateDir, "hardening-rounds", "round-1.json"), "utf8")).status,
      "open"
    );
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
      await assertLockBusy(writePrStateJson(state, "steward", "hardening-rounds/round-1.json", { schema_version: 1 }, { lockTimeoutMs: 25 }));
      await assertLockBusy(writePrStateJson(state, "steward", "config.json", validConfig(), { lockTimeoutMs: 25 }));
      await assertLockBusy(writePrStateJson(state, "smoke", "config.json", validConfig(), { lockTimeoutMs: 25 }));
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

test("explicit lock reuse cannot be forged from copied identity fields", async () => {
  await withTempDir("lock-forgery", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const watcherLock = await acquirePrStateLock(state, {
      owner: "watcher",
      mode: "test",
      operation: "hold",
      timeoutMs: 0,
      staleMs: 30_000
    });

    try {
      const forgedLock = {
        owner: "steward",
        lockIdentity: watcherLock.lockIdentity,
        lockPath: watcherLock.lockPath,
        stateDir: watcherLock.stateDir,
        released: false
      };

      await assert.rejects(
        writePrStateJson(state, "steward", "closeout.json", {
          schema_version: 1,
          status: "forged-write"
        }, { lock: forgedLock }),
        (error) => error?.code === "lock_not_held" || error?.code === "owner_path_forbidden"
      );
      assert.equal(existsSync(path.join(state.stateDir, "closeout.json")), false);
      const currentLock = JSON.parse(await readFile(path.join(state.stateDir, "pr-feedback.lock"), "utf8"));
      assert.equal(currentLock.owner, "watcher");
    } finally {
      await watcherLock.release();
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

test("release stays held when matching lock removal is blocked", async () => {
  await withTempDir("release-blocked", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const lock = await acquirePrStateLock(state, {
      owner: "watcher",
      mode: "test",
      operation: "release-blocked",
      timeoutMs: 0,
      staleMs: 30_000
    });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    const claimPath = lockRemovalClaimPath(lockPath, lock.lockIdentity);

    await writeFile(claimPath, JSON.stringify({
      schema_version: 1,
      kind: "pr-feedback-lock-removal-claim",
      identity_key: lockRemovalIdentityKey(lock.lockIdentity),
      claim_id: "cross-host-remover",
      pid: 12345,
      hostname: "other-host",
      claimed_at: new Date().toISOString()
    }, null, 2) + "\n");

    try {
      await assert.rejects(
        lock.release(),
        (error) => error?.code === "lock_release_blocked" && error?.exitCode === 75
      );
      assert.equal(lock.released, false);
      assert.equal(existsSync(lockPath), true);
    } finally {
      await rm(claimPath, { force: true });
      await lock.release();
    }
  });
});

test("stale release never opens an acquisition gap over a live replacement lock", async () => {
  await withTempDir("stale-release-gap", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    const gapFile = path.join(tmp, "lock-gap-opened");
    const continueFile = path.join(tmp, "continue-release");
    const loader = path.join(tmp, "stale-release-gap-loader.mjs");
    const script = path.join(tmp, "stale-release-gap.mjs");

    await writeFile(loader, fsPromisesMockLoader(`
      import * as real from "node:fs/promises";
      export * from "node:fs/promises";

      let paused = false;
      const lockPath = process.env.SCUBA_STALE_RELEASE_GAP_LOCK;
      const gapFile = process.env.SCUBA_STALE_RELEASE_GAP_FILE;
      const continueFile = process.env.SCUBA_STALE_RELEASE_CONTINUE_FILE;

      async function waitForContinue() {
        for (;;) {
          try {
            await real.readFile(continueFile);
            return;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      }

      export async function rename(from, to) {
        const result = await real.rename(from, to);
        if (!paused && String(from) === lockPath && String(to).includes(".pr-feedback.lock.removing-")) {
          paused = true;
          await real.writeFile(gapFile, "gap\\n");
          await waitForContinue();
        }
        return result;
      }
    `));

    await writeFile(script, `
      import assert from "node:assert/strict";
      import { readFile, rm, writeFile } from "node:fs/promises";
      import {
        acquirePrStateLock,
        resolvePrState,
        writePrStateJson
      } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "tools", "lib", "pr-feedback-state.mjs")).href)};

      const state = resolvePrState({ stateDir: ${JSON.stringify(state.stateDir)} });
      const lockPath = ${JSON.stringify(lockPath)};
      const gapFile = ${JSON.stringify(gapFile)};
      const continueFile = ${JSON.stringify(continueFile)};

      const staleLock = await acquirePrStateLock(state, {
        owner: "watcher",
        mode: "test",
        operation: "superseded",
        timeoutMs: 0,
        staleMs: 30_000
      });
      await rm(lockPath, { force: true });

      const activeLock = await acquirePrStateLock(state, {
        owner: "steward",
        mode: "test",
        operation: "active-replacement",
        timeoutMs: 0,
        staleMs: 30_000
      });

      let thirdLock = null;
      try {
        const release = staleLock.release();
        let sawGap = false;
        for (let i = 0; i < 50; i += 1) {
          try {
            await readFile(gapFile, "utf8");
            sawGap = true;
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }

        if (sawGap) {
          thirdLock = await acquirePrStateLock(state, {
            owner: "manager",
            mode: "test",
            operation: "gap-acquirer",
            timeoutMs: 0,
            staleMs: 30_000
          });
        }

        await writeFile(continueFile, "continue\\n");
        await release;

        await writePrStateJson(state, "steward", "closeout.json", {
          schema_version: 1,
          status: "active-lock-still-current"
        }, { lock: activeLock });
        const currentLock = JSON.parse(await readFile(lockPath, "utf8"));
        assert.equal(currentLock.lock_id, activeLock.lock_id);
      } finally {
        if (thirdLock) await thirdLock.release();
        await activeLock.release();
      }
    `);

    const raced = runNode(["--loader", loader, script], {
      env: {
        SCUBA_STALE_RELEASE_GAP_LOCK: lockPath,
        SCUBA_STALE_RELEASE_GAP_FILE: gapFile,
        SCUBA_STALE_RELEASE_CONTINUE_FILE: continueFile
      }
    });

    assert.equal(raced.status, 0, raced.stderr);
  });
});

test("expired same-host live-pid locks stay busy while the local process is alive", async () => {
  await withTempDir("same-host-pid-reuse-lock", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    await writeFile(lockPath, JSON.stringify({
      schema_version: 1,
      lock_id: "expired-live-pid-lock",
      owner: "watcher",
      pid: process.pid,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "pid-reuse"
    }, null, 2) + "\n");

    const status = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);

    assert.equal(status.status, 75, status.stderr);
    const summary = parseStdoutJson(status);
    assert.equal(summary.reason, "lock_busy");
    assert.equal(existsSync(lockPath), true);
  });
});

test("future lock and claim timestamps cannot wedge recovery", async () => {
  await withTempDir("future-lock-claim-times", async (tmp) => {
    const futureLockState = resolvePrState({ stateDir: path.join(tmp, "future-lock") });
    await mkdir(futureLockState.stateDir, { recursive: true });
    const futureLockPath = path.join(futureLockState.stateDir, "pr-feedback.lock");
    await writeFile(futureLockPath, JSON.stringify({
      schema_version: 1,
      lock_id: "future-lock",
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2999-01-01T00:00:00.000Z",
      mode: "test",
      operation: "future"
    }, null, 2) + "\n");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(futureLockPath, staleTime, staleTime);

    const recoveredFutureLock = runWatcher([
      "status",
      "--state-dir",
      futureLockState.stateDir,
      "--lock-stale-ms",
      "1",
      "--lock-timeout-ms",
      "25"
    ]);
    assert.equal(recoveredFutureLock.status, 0, recoveredFutureLock.stderr);
    assert.equal(existsSync(futureLockPath), false);

    const futureMtimeState = resolvePrState({ stateDir: path.join(tmp, "future-mtime") });
    await mkdir(futureMtimeState.stateDir, { recursive: true });
    const futureMtimeLock = path.join(futureMtimeState.stateDir, "pr-feedback.lock");
    await writeFile(futureMtimeLock, "{}\n");
    const futureTime = new Date("2999-01-01T00:00:00.000Z");
    await utimes(futureMtimeLock, futureTime, futureTime);

    const recoveredFutureMtime = runWatcher([
      "status",
      "--state-dir",
      futureMtimeState.stateDir,
      "--lock-stale-ms",
      "1",
      "--lock-timeout-ms",
      "25"
    ]);
    assert.equal(recoveredFutureMtime.status, 0, recoveredFutureMtime.stderr);
    assert.equal(existsSync(futureMtimeLock), false);

    const futureClaimState = resolvePrState({ stateDir: path.join(tmp, "future-claim") });
    await mkdir(futureClaimState.stateDir, { recursive: true });
    const lockPath = path.join(futureClaimState.stateDir, "pr-feedback.lock");
    const lockBody = {
      schema_version: 1,
      lock_id: "stale-lock",
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "stale"
    };
    const lockRaw = JSON.stringify(lockBody, null, 2) + "\n";
    await writeFile(lockPath, lockRaw);
    const claimPath = lockRemovalClaimPath(lockPath, lockIdentityFromLock(lockBody, lockRaw));
    await writeFile(claimPath, "{ invalid claim\n");
    await utimes(claimPath, futureTime, futureTime);

    const recoveredFutureClaim = runWatcher([
      "status",
      "--state-dir",
      futureClaimState.stateDir,
      "--lock-stale-ms",
      "1",
      "--lock-timeout-ms",
      "25"
    ]);
    assert.equal(recoveredFutureClaim.status, 0, recoveredFutureClaim.stderr);
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(await removalClaimFiles(futureClaimState.stateDir), []);
  });
});

test("status records stale lock breaks durably", async () => {
  await withTempDir("stale-status", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    await writeFile(path.join(state.stateDir, "pr-feedback.lock"), JSON.stringify({
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

test("schema-invalid locks with future expires_at recover by mtime", async () => {
  await withTempDir("malformed-future-expires-lock", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    await writeFile(lockPath, JSON.stringify({
      expires_at: "2999-01-01T00:00:00.000Z"
    }, null, 2) + "\n");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const status = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);

    assert.equal(status.status, 0, status.stderr);
    const summary = parseStdoutJson(status);
    assert.equal(summary.status, "status_checked");
    const recorded = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(recorded.stale_lock_break.previous_lock.corrupt_lock, true);
    assert.equal(recorded.stale_lock_break.previous_lock.schema_valid, false);
    assert.equal(recorded.stale_lock_break.previous_lock.expires_at, "2999-01-01T00:00:00.000Z");
    assert.equal(existsSync(lockPath), false);
  });
});

test("stale removal claims are crash recoverable", async () => {
  await withTempDir("stale-removal-claim-recovery", async (tmp) => {
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

    const loader = path.join(tmp, "stale-claim-crash-loader.mjs");
    const script = path.join(tmp, "break-stale-lock-and-crash.mjs");
    await writeFile(loader, fsPromisesMockLoader(`
      import * as real from "node:fs/promises";
      export * from "node:fs/promises";

      let lockReads = 0;
      const lockPath = process.env.SCUBA_STALE_CLAIM_LOCK;

      export async function open(file, flags, mode) {
        const handle = await real.open(file, flags, mode);
        if (String(file) !== lockPath) return handle;
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === "readFile") {
              return async (...args) => {
                lockReads += 1;
                if (lockReads === 2) process.exit(99);
                return target.readFile(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          }
        });
      }
    `));
    await writeFile(script, `
      import { acquirePrStateLock, resolvePrState } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "tools", "lib", "pr-feedback-state.mjs")).href)};

      const state = resolvePrState({ stateDir: ${JSON.stringify(state.stateDir)} });
      const lock = await acquirePrStateLock(state, {
        owner: "watcher",
        mode: "test",
        operation: "after-crash",
        timeoutMs: 25,
        staleMs: 1
      });
      await lock.release();
    `);

    const crashed = runNode(["--loader", loader, script], {
      env: {
        SCUBA_STALE_CLAIM_LOCK: lockPath
      }
    });

    assert.equal(crashed.status, 99, crashed.stderr);
    assert.equal(existsSync(lockPath), true);
    assert.equal((await removalClaimFiles(state.stateDir)).length, 1);

    const recovered = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);

    assert.equal(recovered.status, 0, recovered.stderr);
    const summary = parseStdoutJson(recovered);
    assert.equal(summary.status, "status_checked");
    const recorded = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(recorded.stale_lock_break.previous_lock.operation, "stale");
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(await removalClaimFiles(state.stateDir), []);
  });
});

test("old same-host live-pid removal claims do not block stale lock recovery", async () => {
  await withTempDir("stale-removal-claim-live-pid", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    const lockBody = {
      schema_version: 1,
      lock_id: "stale-lock",
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "stale"
    };
    const lockRaw = JSON.stringify(lockBody, null, 2) + "\n";
    await writeFile(lockPath, lockRaw);
    const lockIdentity = lockIdentityFromLock(lockBody, lockRaw);
    const claimPath = lockRemovalClaimPath(lockPath, lockIdentity);
    await writeFile(claimPath, JSON.stringify({
      schema_version: 1,
      kind: "pr-feedback-lock-removal-claim",
      identity_key: lockRemovalIdentityKey(lockIdentity),
      claim_id: "old-live-pid-remover",
      pid: process.pid,
      hostname: os.hostname(),
      claimed_at: "2026-06-27T00:00:00.000Z"
    }, null, 2) + "\n");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(claimPath, staleTime, staleTime);

    const recovered = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);

    assert.equal(recovered.status, 0, recovered.stderr);
    const summary = parseStdoutJson(recovered);
    assert.equal(summary.status, "status_checked");
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(await removalClaimFiles(state.stateDir), []);
  });
});

test("mismatched identity removal claims do not block stale lock recovery", async () => {
  await withTempDir("stale-removal-claim-wrong-identity", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    const lockBody = {
      schema_version: 1,
      lock_id: "stale-lock",
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "stale"
    };
    const lockRaw = JSON.stringify(lockBody, null, 2) + "\n";
    await writeFile(lockPath, lockRaw);
    const lockIdentity = lockIdentityFromLock(lockBody, lockRaw);
    const claimPath = lockRemovalClaimPath(lockPath, lockIdentity);
    await writeFile(claimPath, JSON.stringify({
      schema_version: 1,
      kind: "pr-feedback-lock-removal-claim",
      identity_key: "0123456789abcdef0123456789abcdef",
      claim_id: "wrong-identity-remover",
      pid: process.pid,
      hostname: os.hostname(),
      claimed_at: "2026-06-27T00:00:00.000Z"
    }, null, 2) + "\n");

    const recovered = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);

    assert.equal(recovered.status, 0, recovered.stderr);
    const summary = parseStdoutJson(recovered);
    assert.equal(summary.status, "status_checked");
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(await removalClaimFiles(state.stateDir), []);
  });
});

test("stale removal claim recovery preserves a mismatched current lock", async () => {
  await withTempDir("stale-removal-claim-mismatch", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const staleLock = await acquirePrStateLock(state, {
      owner: "watcher",
      mode: "test",
      operation: "superseded",
      timeoutMs: 0,
      staleMs: 30_000
    });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    const claimPath = lockRemovalClaimPath(lockPath, staleLock.lockIdentity);
    await writeFile(claimPath, JSON.stringify({
      schema_version: 1,
      kind: "pr-feedback-lock-removal-claim",
      identity_key: lockRemovalIdentityKey(staleLock.lockIdentity),
      claim_id: "crashed-remover",
      pid: 0,
      hostname: os.hostname(),
      claimed_at: "2026-06-27T00:00:00.000Z"
    }, null, 2) + "\n");
    await rm(lockPath, { force: true });

    const activeLock = await acquirePrStateLock(state, {
      owner: "steward",
      mode: "test",
      operation: "active-replacement",
      timeoutMs: 0,
      staleMs: 30_000
    });

    try {
      await staleLock.release();
      await writePrStateJson(state, "steward", "closeout.json", {
        schema_version: 1,
        status: "active-lock-still-current"
      }, { lock: activeLock });
      const currentLock = JSON.parse(await readFile(lockPath, "utf8"));
      assert.equal(currentLock.lock_id, activeLock.lock_id);
      assert.equal(existsSync(claimPath), false);
    } finally {
      await activeLock.release();
    }
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
      const lockPath = process.env.SCUBA_STALE_RACE_LOCK;

      export async function open(file, flags, mode) {
        const handle = await real.open(file, flags, mode);
        if (String(file) !== lockPath) return handle;
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === "readFile") {
              return async (...args) => {
                const data = await target.readFile(...args);
                if (!raced) {
                  raced = true;
                  await real.writeFile(lockPath, process.env.SCUBA_STALE_RACE_REPLACEMENT);
                }
                return data;
              };
            }
            return Reflect.get(target, prop, receiver);
          }
        });
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

test("stale lock break never opens an acquisition gap over a live replacement lock", async () => {
  await withTempDir("stale-lock-restore-race", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    const gapFile = path.join(tmp, "lock-gap-opened");
    const continueFile = path.join(tmp, "continue-break");
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
    const loader = path.join(tmp, "stale-restore-race-loader.mjs");
    const script = path.join(tmp, "break-stale-lock-restore-race.mjs");
    await writeFile(loader, fsPromisesMockLoader(`
      import * as real from "node:fs/promises";
      export * from "node:fs/promises";

      let installedReplacement = false;
      let paused = false;
      const lockPath = process.env.SCUBA_STALE_RESTORE_RACE_LOCK;
      const gapFile = process.env.SCUBA_STALE_RESTORE_RACE_GAP_FILE;
      const continueFile = process.env.SCUBA_STALE_RESTORE_RACE_CONTINUE_FILE;

      async function waitForContinue() {
        for (;;) {
          try {
            await real.readFile(continueFile);
            return;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      }

      export async function open(file, flags, mode) {
        const handle = await real.open(file, flags, mode);
        if (String(file) !== lockPath) return handle;
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === "readFile") {
              return async (...args) => {
                const data = await target.readFile(...args);
                if (!installedReplacement) {
                  installedReplacement = true;
                  await real.writeFile(lockPath, process.env.SCUBA_STALE_RESTORE_RACE_REPLACEMENT);
                }
                return data;
              };
            }
            return Reflect.get(target, prop, receiver);
          }
        });
      }

      export async function rename(from, to) {
        const result = await real.rename(from, to);
        if (!paused && String(from) === lockPath && String(to).includes(".pr-feedback.lock.removing-")) {
          paused = true;
          await real.writeFile(gapFile, "gap\\n");
          await waitForContinue();
        }
        return result;
      }
    `));
    await writeFile(script, `
      import assert from "node:assert/strict";
      import { readFile, writeFile } from "node:fs/promises";
      import { acquirePrStateLock, resolvePrState } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "tools", "lib", "pr-feedback-state.mjs")).href)};

      const state = resolvePrState({ stateDir: ${JSON.stringify(state.stateDir)} });
      const lockPath = ${JSON.stringify(lockPath)};
      const gapFile = ${JSON.stringify(gapFile)};
      const continueFile = ${JSON.stringify(continueFile)};
      let thirdLock = null;
      try {
        const breakAttempt = acquirePrStateLock(state, {
          owner: "watcher",
          mode: "test",
          operation: "after-restore-race",
          timeoutMs: 25,
          staleMs: 1
        });
        const observedBreakAttempt = breakAttempt.then(
          (lock) => ({ lock }),
          (error) => ({ error })
        );

        let sawGap = false;
        for (let i = 0; i < 50; i += 1) {
          try {
            await readFile(gapFile, "utf8");
            sawGap = true;
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }

        if (sawGap) {
          thirdLock = await acquirePrStateLock(state, {
            owner: "manager",
            mode: "test",
            operation: "gap-acquirer",
            timeoutMs: 0,
            staleMs: 30_000
          });
        }

        await writeFile(continueFile, "continue\\n");
        const breakResult = await observedBreakAttempt;
        assert.equal(breakResult.error?.code, "lock_busy");
        const currentLock = JSON.parse(await readFile(lockPath, "utf8"));
        assert.equal(currentLock.lock_id, "fresh-replacement");
        assert.equal(currentLock.owner, "steward");
      } finally {
        if (thirdLock) await thirdLock.release();
      }
    `);

    const raced = runNode(["--loader", loader, script], {
      env: {
        SCUBA_STALE_RESTORE_RACE_LOCK: lockPath,
        SCUBA_STALE_RESTORE_RACE_REPLACEMENT: JSON.stringify(replacement, null, 2) + "\n",
        SCUBA_STALE_RESTORE_RACE_GAP_FILE: gapFile,
        SCUBA_STALE_RESTORE_RACE_CONTINUE_FILE: continueFile
      }
    });

    assert.equal(raced.status, 0, raced.stderr);
    const currentLock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(currentLock.lock_id, "fresh-replacement");
    assert.equal(currentLock.owner, "steward");
  });
});

test("authoritative state, lock, and claim reads reject hardlinked files", async () => {
  await withTempDir("hardlinked-reads", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const outside = path.join(tmp, "outside");
    await mkdir(state.stateDir, { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(path.join(outside, "events.jsonl"), JSON.stringify(eventRevision("outside", "outside:v1", {
      token: "S02_HARDLINK_SECRET"
    })) + "\n");
    await link(path.join(outside, "events.jsonl"), path.join(state.stateDir, "events.jsonl"));
    const replay = runWatcher(["replay", "--state-dir", state.stateDir]);
    assert.equal(replay.status, 20);
    assert.equal(parseStdoutJson(replay).reason, "invalid_state_path");
    assert.ok(!replay.stdout.includes("S02_HARDLINK_SECRET"));
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
    }, null, 2) + "\n");
    await link(path.join(outside, "pr-feedback.lock"), path.join(state.stateDir, "pr-feedback.lock"));
    const lockStatus = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);
    assert.equal(lockStatus.status, 20);
    assert.equal(parseStdoutJson(lockStatus).reason, "invalid_state_path");
    assert.ok(!lockStatus.stdout.includes("S02_LOCK_SECRET"));
    await rm(path.join(state.stateDir, "pr-feedback.lock"), { force: true });

    const lockPath = path.join(state.stateDir, "pr-feedback.lock");
    const lockBody = {
      schema_version: 1,
      lock_id: "stale-lock",
      owner: "watcher",
      pid: 0,
      hostname: os.hostname(),
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "stale"
    };
    const lockRaw = JSON.stringify(lockBody, null, 2) + "\n";
    await writeFile(lockPath, lockRaw);
    const claimPath = lockRemovalClaimPath(lockPath, lockIdentityFromLock(lockBody, lockRaw));
    await writeFile(path.join(outside, "claim"), JSON.stringify({
      schema_version: 1,
      kind: "pr-feedback-lock-removal-claim",
      identity_key: lockRemovalIdentityKey(lockIdentityFromLock(lockBody, lockRaw)),
      claim_id: "hardlinked-claim",
      pid: 12345,
      hostname: "other-host",
      claimed_at: new Date().toISOString()
    }, null, 2) + "\n");
    await link(path.join(outside, "claim"), claimPath);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(claimPath, staleTime, staleTime);

    const recovered = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(await removalClaimFiles(state.stateDir), []);
  });
});

test("unsafe removal claims cannot block stale lock recovery through path metadata", async () => {
  await withTempDir("unsafe-claim-authority", async (tmp) => {
    const outside = path.join(tmp, "outside");
    await mkdir(outside, { recursive: true });

    async function assertUnsafeClaimRecovered(label, installClaim) {
      const state = resolvePrState({ stateDir: path.join(tmp, label) });
      await mkdir(state.stateDir, { recursive: true });
      const lockPath = path.join(state.stateDir, "pr-feedback.lock");
      const lockBody = {
        schema_version: 1,
        lock_id: `${label}-stale-lock`,
        owner: "watcher",
        pid: 0,
        hostname: os.hostname(),
        started_at: "2026-06-27T00:00:00.000Z",
        expires_at: "2026-06-27T00:00:01.000Z",
        mode: "test",
        operation: "stale"
      };
      const lockRaw = JSON.stringify(lockBody, null, 2) + "\n";
      await writeFile(lockPath, lockRaw);
      const lockIdentity = lockIdentityFromLock(lockBody, lockRaw);
      const claimPath = lockRemovalClaimPath(lockPath, lockIdentity);
      const claimBody = JSON.stringify({
        schema_version: 1,
        kind: "pr-feedback-lock-removal-claim",
        identity_key: lockRemovalIdentityKey(lockIdentity),
        claim_id: `${label}-unsafe-claim`,
        pid: 12345,
        hostname: "other-host",
        claimed_at: new Date().toISOString()
      }, null, 2) + "\n";

      await installClaim({ claimPath, claimBody });

      const recovered = runWatcher([
        "status",
        "--state-dir",
        state.stateDir,
        "--lock-stale-ms",
        "1",
        "--lock-timeout-ms",
        "25"
      ]);

      assert.equal(recovered.status, 0, `${label}: ${recovered.stderr}`);
      assert.equal(existsSync(lockPath), false, label);
      assert.deepEqual(await removalClaimFiles(state.stateDir), [], label);
    }

    await assertUnsafeClaimRecovered("hardlinked-claim", async ({ claimPath, claimBody }) => {
      const outsideClaim = path.join(outside, "hardlinked-claim");
      await writeFile(outsideClaim, claimBody);
      await link(outsideClaim, claimPath);
    });

    await assertUnsafeClaimRecovered("symlinked-claim", async ({ claimPath, claimBody }) => {
      const outsideClaim = path.join(outside, "symlinked-claim");
      await writeFile(outsideClaim, claimBody);
      await symlink(outsideClaim, claimPath);
    });
  });
});

test("state reads are bound to the validated file, not a later symlink swap", async () => {
  await withTempDir("read-race", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const outside = path.join(tmp, "outside");
    await mkdir(state.stateDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    const statusPath = path.join(state.stateDir, "watcher-status.json");
    const outsideStatus = path.join(outside, "watcher-status.json");
    await writeFile(statusPath, JSON.stringify(watcherStatusFixture("initial")) + "\n");
    await writeFile(outsideStatus, JSON.stringify(watcherStatusFixture("S02_RACE_SECRET")) + "\n");
    const statusReal = await realpath(statusPath);

    const loader = path.join(tmp, "read-race-loader.mjs");
    await writeFile(loader, fsPromisesMockLoader(`
      import * as real from "node:fs/promises";
      export * from "node:fs/promises";

      let swapped = false;
      const statusPath = process.env.SCUBA_READ_RACE_STATUS;
      const statusReal = process.env.SCUBA_READ_RACE_STATUS_REAL;
      const outsideStatus = process.env.SCUBA_READ_RACE_OUTSIDE_STATUS;

      export async function readFile(file, ...args) {
        if (!swapped && (String(file) === statusPath || String(file) === statusReal)) {
          swapped = true;
          await real.rm(statusPath, { force: true });
          await real.symlink(outsideStatus, statusPath);
        }
        return real.readFile(file, ...args);
      }
    `));

    const status = runNode(["--loader", loader, WATCHER, "status", "--state-dir", state.stateDir], {
      env: {
        SCUBA_READ_RACE_STATUS: statusPath,
        SCUBA_READ_RACE_STATUS_REAL: statusReal,
        SCUBA_READ_RACE_OUTSIDE_STATUS: outsideStatus
      }
    });

    assert.equal(status.status, 0, status.stderr);
    const summary = parseStdoutJson(status);
    assert.equal(summary.status, "initial");
    assert.ok(!status.stdout.includes("S02_RACE_SECRET"));
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

    await writePrStateJson(state, "steward", "config.json", validConfig());
    await writePrStateJson(state, "smoke", "config.json", validConfig());
    await writePrStateJson(state, "steward", "hardening-rounds/round-2.json", {
      schema_version: 1,
      round: 2
    });

    await assertOwnerRejected(writePrStateJson(state, "watcher", "closeout.json", { schema_version: 1 }));
    await assertOwnerRejected(writePrStateJson(state, "steward", "watcher-status.json", { schema_version: 1 }));
    await assertOwnerRejected(writePrStateJson(state, "manager", "dispositions.json", { schema_version: 1 }));
    await assertOwnerRejected(writePrStateJson(state, "watcher", "../escape.json", { schema_version: 1 }));
  });
});

test("event replay treats prototype keys as data and validates revisions", async () => {
  await withTempDir("event-prototype-schema", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    const eventLog = path.join(state.stateDir, "events.jsonl");

    await writeFile(eventLog, [
      "{\"schema_version\":1,\"event_id\":\"__proto__\",\"event_revision_id\":\"proto:v1\",\"observed_at\":\"2026-06-28T00:00:00.000Z\",\"payload\":{}}",
      ""
    ].join("\n"));
    const replay = runWatcher(["replay", "--state-dir", state.stateDir]);
    assert.equal(replay.status, 0, replay.stderr);
    const index = JSON.parse(await readFile(path.join(state.stateDir, "event-index.json"), "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(index.latest_by_event_id, "__proto__"), true);
    assert.equal(index.latest_by_event_id["__proto__"], "proto:v1");

    await writeFile(eventLog, [
      "{\"schema_version\":1,\"event_id\":\"thread:1\",\"event_revision_id\":\"thread:1:v1\",\"observed_at\":\"2026-06-28T00:00:00.000Z\",\"payload\":{\"__proto__\":{\"state\":\"open\"}}}",
      "{\"schema_version\":1,\"event_id\":\"thread:1\",\"event_revision_id\":\"thread:1:v1\",\"observed_at\":\"2026-06-28T00:00:00.000Z\",\"payload\":{\"__proto__\":{\"state\":\"resolved\"}}}",
      ""
    ].join("\n"));
    const conflict = runWatcher(["replay", "--state-dir", state.stateDir]);
    assert.equal(conflict.status, 20);
    assert.equal(parseStdoutJson(conflict).reason, "corrupt_state");

    await writeFile(eventLog, "{\"event_id\":\"thread:2\",\"event_revision_id\":\"thread:2:v1\"}\n");
    const invalidSchema = runWatcher(["replay", "--state-dir", state.stateDir]);
    assert.equal(invalidSchema.status, 20);
    assert.equal(parseStdoutJson(invalidSchema).reason, "corrupt_state");
  });
});

test("status and config JSON must be schema-valid before becoming authoritative", async () => {
  await withTempDir("status-config-schema", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await mkdir(state.stateDir, { recursive: true });
    await writeFile(path.join(state.stateDir, "watcher-status.json"), JSON.stringify({
      status: "external_approved"
    }) + "\n");
    await writeFile(path.join(state.stateDir, "closeout.json"), "[]\n");

    const invalidStatus = runWatcher(["status", "--state-dir", state.stateDir]);
    assert.equal(invalidStatus.status, 20);
    const invalidStatusSummary = parseStdoutJson(invalidStatus);
    assert.equal(invalidStatusSummary.reason, "corrupt_state");
    assert.equal(invalidStatusSummary.file, path.join(state.stateDir, "watcher-status.json"));

    const reviewerState = resolvePrState({ stateDir: path.join(tmp, "bad-reviewer") });
    await mkdir(reviewerState.stateDir, { recursive: true });
    await writeFile(path.join(reviewerState.stateDir, "config.json"), JSON.stringify({
      ...validConfig(),
      external_reviewer: {}
    }, null, 2) + "\n");
    const invalidReviewer = runWatcher(["status", "--state-dir", reviewerState.stateDir]);
    assert.equal(invalidReviewer.status, 20);
    assert.equal(parseStdoutJson(invalidReviewer).reason, "configuration_invalid");

    const repoState = resolvePrState({ stateDir: path.join(tmp, "bad-repo") });
    await mkdir(repoState.stateDir, { recursive: true });
    await writeFile(path.join(repoState.stateDir, "config.json"), JSON.stringify({
      ...validConfig(),
      repo: { owner: "bad/owner", name: "repo" }
    }, null, 2) + "\n");
    const invalidRepo = runWatcher(["status", "--state-dir", repoState.stateDir]);
    assert.equal(invalidRepo.status, 20);
    assert.equal(parseStdoutJson(invalidRepo).reason, "configuration_invalid");

    for (const [label, team] of [["blank-team", " "], ["path-team", "bad/team"]]) {
      const badTeamState = resolvePrState({ stateDir: path.join(tmp, label) });
      await mkdir(badTeamState.stateDir, { recursive: true });
      await writeFile(path.join(badTeamState.stateDir, "config.json"), JSON.stringify({
        ...validConfig(),
        team
      }, null, 2) + "\n");
      const invalidTeam = runWatcher(["status", "--state-dir", badTeamState.stateDir]);
      assert.equal(invalidTeam.status, 20);
      assert.equal(parseStdoutJson(invalidTeam).reason, "configuration_invalid");
    }

    for (const [label, configText] of [
      ["rounded-pr", `{
        "schema_version": 1,
        "team": "alpha",
        "repo": "octo/repo",
        "pr_number": 9007199254740993,
        "external_reviewer": { "login": "reviewer" }
      }\n`],
      ["huge-pr", `{
        "schema_version": 1,
        "team": "alpha",
        "repo": "octo/repo",
        "pr_number": 1e100,
        "external_reviewer": { "login": "reviewer" }
      }\n`]
    ]) {
      const badPrState = resolvePrState({ stateDir: path.join(tmp, label) });
      await mkdir(badPrState.stateDir, { recursive: true });
      await writeFile(path.join(badPrState.stateDir, "config.json"), configText);
      const invalidPr = runWatcher(["status", "--state-dir", badPrState.stateDir]);
      assert.equal(invalidPr.status, 20);
      assert.equal(parseStdoutJson(invalidPr).reason, "configuration_invalid");
    }
  });
});

test("CLI validates numeric inputs and selectors before runtime state operations", async () => {
  await withTempDir("cli-validation", async (tmp) => {
    const roundedPr = runWatcher(["status", "--team", "alpha", "--pr", "9007199254740993"], { cwd: tmp });
    assert.equal(roundedPr.status, 30);
    assert.equal(parseStdoutJson(roundedPr).reason, "usage");

    const hugeLock = runWatcher(["status", "--state-dir", path.join(tmp, "pr-state"), "--lock-stale-ms", "9007199254740993"]);
    assert.equal(hugeLock.status, 30);
    const hugeLockSummary = parseStdoutJson(hugeLock);
    assert.equal(hugeLockSummary.mode, "status");
    assert.equal(hugeLockSummary.reason, "usage");

    const mixedSelector = runWatcher(["snapshot", "--state-dir", path.join(tmp, "pr-state"), "--team", "alpha", "--pr", "1"]);
    assert.equal(mixedSelector.status, 30);
    assert.equal(parseStdoutJson(mixedSelector).reason, "usage");

    const emptyStateDirMixed = runWatcher(["replay", "--state-dir", "", "--team", "alpha", "--pr", "1"], { cwd: tmp });
    assert.equal(emptyStateDirMixed.status, 30);
    assert.equal(parseStdoutJson(emptyStateDirMixed).reason, "usage");
    assert.equal(
      existsSync(path.join(tmp, ".scuba", "teams", "alpha", "pr-feedback", "pr-1", "event-index.json")),
      false
    );

    const emptyTeamWithStateDir = runWatcher(["snapshot", "--state-dir", path.join(tmp, "snapshot-state"), "--team", ""]);
    assert.equal(emptyTeamWithStateDir.status, 30);
    assert.equal(parseStdoutJson(emptyTeamWithStateDir).reason, "usage");

    const emptyPrWithStateDir = runWatcher(["poll", "--state-dir", path.join(tmp, "poll-state"), "--pr", ""]);
    assert.equal(emptyPrWithStateDir.status, 30);
    assert.equal(parseStdoutJson(emptyPrWithStateDir).reason, "usage");

    const badPollSelector = runWatcher(["poll", "--team", "bad/team", "--pr", "0"], { cwd: tmp });
    assert.equal(badPollSelector.status, 30);
    assert.equal(parseStdoutJson(badPollSelector).reason, "usage");

    const missingLockValue = runWatcher(["status", "--lock-timeout-ms"]);
    assert.equal(missingLockValue.status, 30);
    const missingLockValueSummary = parseStdoutJson(missingLockValue);
    assert.equal(missingLockValueSummary.mode, "status");
    assert.equal(missingLockValueSummary.reason, "usage");
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

test("snapshot auth failure fails closed before trusted collection", async () => {
  await withTempDir("snapshot-auth", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await writePrStateJson(state, "manager", "config.json", validConfig());
    const fakeGh = await writeFakeGh(tmp, {
      auth: { exitCode: 1, stderr: "not logged in to github.com\n" }
    });

    const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });

    assert.equal(snapshot.status, 20, snapshot.stderr);
    const summary = parseStdoutJson(snapshot);
    assert.equal(summary.status, "blocked_watcher_unavailable");
    assert.equal(summary.reason, "auth_failed");
    assert.equal(summary.check_aggregate, null);
    assert.equal(summary.mergeability, null);
    assert.equal(existsSync(path.join(state.stateDir, "closeout.json")), false);
    assert.equal(JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8")).reason, "auth_failed");
    assert.deepEqual((await fakeGh.calls()).map((call) => call.args.slice(0, 2)), [["auth", "status"]]);
  });
});

test("snapshot GitHub channel and malformed data failures fail closed distinctly", async () => {
  await withTempDir("snapshot-channel-errors", async (tmp) => {
    const cases = [
      ["rate-limit", { exitCode: 1, stderr: "API rate limit exceeded for installation\n" }, "github_rate_limited"],
      ["network", { exitCode: 1, stderr: "could not resolve host: api.github.com\n" }, "network_error"],
      ["permission", { exitCode: 1, stderr: "HTTP 403: Resource not accessible by integration\n" }, "permission_denied"],
      ["repo-not-found", { body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] } }, "repo_not_found"],
      ["pr-not-found", { body: { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }] } }, "pr_not_found"],
      ["malformed-json", { stdout: "{ not json\n" }, "malformed_github_data"],
      ["partial-response", { body: prGraphqlResponse({ headSha: null }) }, "malformed_github_data"]
    ];

    for (const [label, response, reason] of cases) {
      const state = resolvePrState({ stateDir: path.join(tmp, label) });
      await writePrStateJson(state, "manager", "config.json", validConfig());
      const fakeGh = await writeFakeGh(path.join(tmp, `fake-${label}`), {
        graphql: [response]
      });

      const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });

      assert.equal(snapshot.status, 20, `${label}: ${snapshot.stderr}`);
      const summary = parseStdoutJson(snapshot);
      assert.equal(summary.status, "blocked_watcher_unavailable", label);
      assert.equal(summary.reason, reason, label);
      assert.equal(existsSync(path.join(state.stateDir, "closeout.json")), false, label);
      const watcherStatus = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
      assert.equal(watcherStatus.reason, reason, label);
    }
  });
});

test("snapshot reads PR identity, head SHA, and mergeability from the configured single PR", async () => {
  await withTempDir("snapshot-single-pr", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await writePrStateJson(state, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/test"]
    }));
    const fakeGh = await writeFakeGh(tmp, {
      graphql: [okPrResponse({
        headSha: "abc123singlepr",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        contexts: [
          checkRun({ name: "ci/test", conclusion: "SUCCESS", status: "COMPLETED", headSha: "abc123singlepr" })
        ]
      })]
    });

    const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });

    assert.equal(snapshot.status, 0, snapshot.stderr);
    const summary = parseStdoutJson(snapshot);
    assert.equal(summary.status, "snapshot_collected");
    assert.equal(summary.reason, null);
    assert.equal(summary.repo, "octo/repo");
    assert.equal(summary.current_head_sha, "abc123singlepr");
    assert.equal(summary.check_aggregate, "checks_green");
    assert.equal(summary.mergeability.mergeable, "MERGEABLE");
    assert.equal(summary.mergeability.merge_state_status, "CLEAN");
    assert.equal(summary.snapshot_id.includes("abc123singlepr"), true);

    const immutable = JSON.parse(await readFile(path.join(state.stateDir, "snapshots", `${summary.snapshot_id}.json`), "utf8"));
    assert.equal(immutable.pr.node_id, "PR_kwDO_single");
    assert.equal(immutable.pr.head.oid, "abc123singlepr");
    assert.equal(immutable.pr.base.oid, "base123");
    assert.equal(immutable.mergeability.source, "single_pr_graphql");
    assert.equal(immutable.mergeability.attempts, 1);
    assert.equal(immutable.checks.source, "statusCheckRollup");
    assert.equal(immutable.checks.contexts[0].source_kind, "check_run");
    assert.equal(immutable.checks.contexts[0].node_id, "CR_kwDO_ci_test");
    assert.equal(immutable.checks.contexts[0].database_id, 101);
    assert.equal(immutable.checks.contexts[0].head_source, "workflow_run");
    assert.equal(immutable.checks.contexts[0].app.slug, "github-actions");
    assert.equal(immutable.checks.contexts[0].url, "https://github.com/octo/repo/actions/runs/1");
    assert.equal(immutable.checks.contexts[0].started_at, "2026-06-28T00:01:00Z");
    assert.equal(immutable.checks.contexts[0].completed_at, "2026-06-28T00:02:00Z");
    assert.equal(immutable.head_sha, "abc123singlepr");
    assert.deepEqual(JSON.parse(await readFile(path.join(state.stateDir, "latest-snapshot.json"), "utf8")), immutable);

    const calls = await fakeGh.calls();
    assert.equal(calls.filter((call) => call.args[0] === "api").length, 1);
    assert.ok(calls.some((call) => call.args.join(" ").includes("pullRequest(number: $number)")));
    assert.ok(!calls.some((call) => call.args.join(" ").includes("pr list")));
  });
});

test("snapshot pins trusted gh reads to github.com even when GH_HOST differs", async () => {
  await withTempDir("snapshot-host-pin", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await writePrStateJson(state, "manager", "config.json", validConfig());
    const fakeGh = await writeFakeGh(tmp, {
      requireApiHostname: "github.com",
      graphql: [okPrResponse()]
    });

    const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], {
      env: { ...fakeGh.env, GH_HOST: "enterprise.example.com" }
    });

    assert.equal(snapshot.status, 0, snapshot.stderr);
    const calls = await fakeGh.calls();
    const auth = calls.find((call) => call.args[0] === "auth");
    const api = calls.find((call) => call.args[0] === "api");
    assert.deepEqual(auth.args.slice(0, 4), ["auth", "status", "--hostname", "github.com"]);
    assert.equal(api.args[0], "api");
    assert.equal(api.args[1], "graphql");
    assert.equal(api.args[api.args.indexOf("--hostname") + 1], "github.com");

    const summary = parseStdoutJson(snapshot);
    const immutable = JSON.parse(await readFile(path.join(state.stateDir, "snapshots", `${summary.snapshot_id}.json`), "utf8"));
    assert.equal(immutable.source.hostname, "github.com");
  });
});

test("snapshot compares repository identity case-insensitively and persists canonical GitHub casing", async () => {
  await withTempDir("snapshot-repo-casing", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "canonical") });
    await writePrStateJson(state, "manager", "config.json", validConfig({
      repo: "Octo/Repo"
    }));
    const fakeGh = await writeFakeGh(path.join(tmp, "fake-canonical"), {
      graphql: [okPrResponse({
        repoOwner: "octo",
        repoName: "Repo",
        author: null
      })]
    });

    const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });

    assert.equal(snapshot.status, 0, snapshot.stderr);
    const summary = parseStdoutJson(snapshot);
    assert.equal(summary.repo, "octo/Repo");
    const immutable = JSON.parse(await readFile(path.join(state.stateDir, "snapshots", `${summary.snapshot_id}.json`), "utf8"));
    assert.equal(immutable.repo, "octo/Repo");
    assert.equal(immutable.repository.owner, "octo");
    assert.equal(immutable.repository.name, "Repo");
    assert.equal(immutable.pr.author.login, null);

    const mismatch = resolvePrState({ stateDir: path.join(tmp, "mismatch") });
    await writePrStateJson(mismatch, "manager", "config.json", validConfig({
      repo: { owner: "octo", name: "repo" }
    }));
    const mismatchGh = await writeFakeGh(path.join(tmp, "fake-mismatch"), {
      graphql: [okPrResponse({ repoOwner: "octo", repoName: "other" })]
    });
    const failed = runWatcher(["snapshot", "--state-dir", mismatch.stateDir], { env: mismatchGh.env });
    assert.equal(failed.status, 20, failed.stderr);
    assert.equal(parseStdoutJson(failed).reason, "malformed_github_data");
  });
});

test("snapshot retries unknown mergeability and blocks after the retry budget", async () => {
  await withTempDir("snapshot-mergeability", async (tmp) => {
    const successState = resolvePrState({ stateDir: path.join(tmp, "success") });
    await writePrStateJson(successState, "manager", "config.json", validConfig());
    const successGh = await writeFakeGh(path.join(tmp, "fake-success"), {
      graphql: [
        okPrResponse({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
        okPrResponse({ mergeable: null, mergeStateStatus: "UNKNOWN" }),
        okPrResponse({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" })
      ]
    });

    const resolved = runWatcher([
      "snapshot",
      "--state-dir",
      successState.stateDir,
      "--mergeability-retry-delay-ms",
      "0"
    ], { env: successGh.env });

    assert.equal(resolved.status, 0, resolved.stderr);
    const resolvedSummary = parseStdoutJson(resolved);
    assert.equal(resolvedSummary.mergeability.mergeable, "MERGEABLE");
    assert.equal(resolvedSummary.mergeability.attempts, 3);
    assert.equal((await successGh.calls()).filter((call) => call.args[0] === "api").length, 3);

    const exhaustedState = resolvePrState({ stateDir: path.join(tmp, "exhausted") });
    await writePrStateJson(exhaustedState, "manager", "config.json", validConfig());
    const exhaustedGh = await writeFakeGh(path.join(tmp, "fake-exhausted"), {
      graphql: [
        okPrResponse({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
        okPrResponse({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
        okPrResponse({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
        okPrResponse({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
        okPrResponse({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })
      ]
    });

    const blocked = runWatcher([
      "snapshot",
      "--state-dir",
      exhaustedState.stateDir,
      "--mergeability-retry-delay-ms",
      "0"
    ], { env: exhaustedGh.env });

    assert.equal(blocked.status, 20, blocked.stderr);
    const blockedSummary = parseStdoutJson(blocked);
    assert.equal(blockedSummary.status, "blocked_mergeability_unknown");
    assert.equal(blockedSummary.reason, "mergeability_unknown");
    assert.equal(blockedSummary.mergeability.attempts, 5);
    assert.equal((await exhaustedGh.calls()).filter((call) => call.args[0] === "api").length, 5);
    const watcherStatus = JSON.parse(await readFile(path.join(exhaustedState.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(watcherStatus.status, "blocked_mergeability_unknown");
    assert.equal(watcherStatus.reason, "mergeability_unknown");
    assert.equal(watcherStatus.last_successful_snapshot_id, null);
    const latest = JSON.parse(await readFile(path.join(exhaustedState.stateDir, "latest-snapshot.json"), "utf8"));
    assert.equal(latest.snapshot_id, blockedSummary.snapshot_id);
    assert.equal(latest.status, "blocked_mergeability_unknown");
  });
});

test("snapshot aggregates required checks, statuses, missing contexts, and invalid reviewer overlap", async () => {
  await withTempDir("snapshot-checks", async (tmp) => {
    const cases = [
      ["green", ["ci/test", "lint", "style"], [
        checkRun({ name: "ci/test", conclusion: "SUCCESS" }),
        statusContext({ context: "lint", state: "SUCCESS" }),
        checkRun({ name: "style", conclusion: "SKIPPED" })
      ], "checks_green"],
      ["pending", ["ci/test", "lint"], [
        checkRun({ name: "ci/test", status: "IN_PROGRESS", conclusion: null }),
        statusContext({ context: "lint", state: "SUCCESS" })
      ], "checks_pending"],
      ["failed", ["ci/test", "lint"], [
        checkRun({ name: "ci/test", conclusion: "ACTION_REQUIRED", status: "COMPLETED" }),
        statusContext({ context: "lint", state: "SUCCESS" })
      ], "checks_failed"],
      ["missing", ["ci/test", "lint"], [
        checkRun({ name: "ci/test", conclusion: "SUCCESS" })
      ], "checks_missing"],
      ["not-required", [], [
        checkRun({ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" })
      ], "checks_not_required"]
    ];

    for (const [label, required, contexts, aggregate] of cases) {
      const state = resolvePrState({ stateDir: path.join(tmp, label) });
      await writePrStateJson(state, "manager", "config.json", validConfig({
        required_check_contexts: required
      }));
      const fakeGh = await writeFakeGh(path.join(tmp, `fake-${label}`), {
        graphql: [okPrResponse({ contexts })]
      });

      const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });

      assert.equal(snapshot.status, 0, `${label}: ${snapshot.stderr}`);
      const summary = parseStdoutJson(snapshot);
      assert.equal(summary.check_aggregate, aggregate, label);
      const immutable = JSON.parse(await readFile(path.join(state.stateDir, "snapshots", `${summary.snapshot_id}.json`), "utf8"));
      assert.equal(immutable.checks.aggregate, aggregate, label);
      assert.deepEqual(immutable.checks.required_contexts, required, label);
    }

    const normalizedState = resolvePrState({ stateDir: path.join(tmp, "normalized-required") });
    await writePrStateJson(normalizedState, "manager", "config.json", validConfig({
      required_check_contexts: [" ci/test ", "ci/test"]
    }));
    const normalizedGh = await writeFakeGh(path.join(tmp, "fake-normalized"), {
      graphql: [okPrResponse({
        contexts: [checkRun({ name: "ci/test", conclusion: "SUCCESS" })]
      })]
    });
    const normalized = runWatcher(["snapshot", "--state-dir", normalizedState.stateDir], { env: normalizedGh.env });
    assert.equal(normalized.status, 0, normalized.stderr);
    const normalizedSummary = parseStdoutJson(normalized);
    assert.equal(normalizedSummary.check_aggregate, "checks_green");
    const normalizedSnapshot = JSON.parse(await readFile(path.join(normalizedState.stateDir, "snapshots", `${normalizedSummary.snapshot_id}.json`), "utf8"));
    assert.deepEqual(normalizedSnapshot.checks.required_contexts, ["ci/test"]);
    assert.deepEqual(normalizedSnapshot.checks.missing_required_contexts, []);

    const invalidState = resolvePrState({ stateDir: path.join(tmp, "invalid-overlap") });
    await writePrStateJson(invalidState, "manager", "config.json", validConfig({
      external_reviewer: { name: "ci/reviewer" },
      required_check_contexts: ["ci/reviewer"]
    }));
    const invalidGh = await writeFakeGh(path.join(tmp, "fake-invalid"), {
      graphql: [okPrResponse()]
    });

    const invalid = runWatcher(["snapshot", "--state-dir", invalidState.stateDir], { env: invalidGh.env });

    assert.equal(invalid.status, 20, invalid.stderr);
    const invalidSummary = parseStdoutJson(invalid);
    assert.equal(invalidSummary.status, "blocked_watcher_unavailable");
    assert.equal(invalidSummary.reason, "configuration_invalid");
    assert.equal((await invalidGh.calls()).filter((call) => call.args[0] === "api").length, 0);
  });
});

test("snapshot validates local state and lock before any gh execution", async () => {
  await withTempDir("snapshot-local-before-gh", async (tmp) => {
    const missingConfig = resolvePrState({ stateDir: path.join(tmp, "missing-config") });
    const missingConfigGh = await writeFakeGh(path.join(tmp, "fake-missing-config"), {
      graphql: [okPrResponse()]
    });
    const missing = runWatcher(["snapshot", "--state-dir", missingConfig.stateDir], { env: missingConfigGh.env });
    assert.equal(missing.status, 20, missing.stderr);
    assert.equal(parseStdoutJson(missing).reason, "configuration_missing");
    assert.deepEqual(await missingConfigGh.calls(), []);
    assert.equal(JSON.parse(await readFile(path.join(missingConfig.stateDir, "watcher-status.json"), "utf8")).reason, "configuration_missing");

    const corruptConfig = resolvePrState({ stateDir: path.join(tmp, "corrupt-config") });
    await mkdir(corruptConfig.stateDir, { recursive: true });
    const corruptConfigPath = path.join(corruptConfig.stateDir, "config.json");
    await writeFile(corruptConfigPath, "{ broken config\n");
    const corruptConfigGh = await writeFakeGh(path.join(tmp, "fake-corrupt-config"), {
      graphql: [okPrResponse()]
    });
    const corrupt = runWatcher(["snapshot", "--state-dir", corruptConfig.stateDir], { env: corruptConfigGh.env });
    assert.equal(corrupt.status, 20, corrupt.stderr);
    const corruptSummary = parseStdoutJson(corrupt);
    assert.equal(corruptSummary.reason, "corrupt_state");
    assert.equal(corruptSummary.file, corruptConfigPath);
    assert.equal(await readFile(corruptConfigPath, "utf8"), "{ broken config\n");
    assert.deepEqual(await corruptConfigGh.calls(), []);

    const missingReviewer = resolvePrState({ stateDir: path.join(tmp, "missing-reviewer") });
    await writePrStateJson(missingReviewer, "manager", "config.json", {
      schema_version: 1,
      team: "alpha",
      repo: "octo/repo",
      pr_number: 7
    });
    const reviewerGh = await writeFakeGh(path.join(tmp, "fake-missing-reviewer"), {
      graphql: [okPrResponse()]
    });
    const reviewer = runWatcher(["snapshot", "--state-dir", missingReviewer.stateDir], { env: reviewerGh.env });
    assert.equal(reviewer.status, 20, reviewer.stderr);
    assert.equal(parseStdoutJson(reviewer).reason, "configuration_missing");
    assert.deepEqual(await reviewerGh.calls(), []);

    const corruptEvents = resolvePrState({ stateDir: path.join(tmp, "corrupt-events") });
    await writePrStateJson(corruptEvents, "manager", "config.json", validConfig());
    await writeFile(path.join(corruptEvents.stateDir, "events.jsonl"), "{ broken event\n");
    const corruptEventsGh = await writeFakeGh(path.join(tmp, "fake-corrupt-events"), {
      graphql: [okPrResponse()]
    });
    const corruptEventResult = runWatcher(["snapshot", "--state-dir", corruptEvents.stateDir], { env: corruptEventsGh.env });
    assert.equal(corruptEventResult.status, 20, corruptEventResult.stderr);
    assert.equal(parseStdoutJson(corruptEventResult).reason, "corrupt_state");
    assert.deepEqual(await corruptEventsGh.calls(), []);

    const lockState = resolvePrState({ stateDir: path.join(tmp, "locked") });
    await writePrStateJson(lockState, "manager", "config.json", validConfig());
    const lockGh = await writeFakeGh(path.join(tmp, "fake-locked"), {
      graphql: [okPrResponse()]
    });
    const stewardLock = await acquirePrStateLock(lockState, {
      owner: "steward",
      mode: "test",
      operation: "hold",
      timeoutMs: 0,
      staleMs: 30_000
    });
    try {
      const locked = runWatcher(["snapshot", "--state-dir", lockState.stateDir, "--lock-timeout-ms", "25"], { env: lockGh.env });
      assert.equal(locked.status, 75, locked.stderr);
      assert.equal(parseStdoutJson(locked).reason, "lock_busy");
      assert.deepEqual(await lockGh.calls(), []);
    } finally {
      await stewardLock.release();
    }
  });
});

test("status and replay remain local modes that do not invoke gh", async () => {
  await withTempDir("local-no-gh", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    const fakeGh = await writeFakeGh(tmp, {
      auth: { exitCode: 2, stderr: "status/replay should not call gh\n" },
      graphql: [{ exitCode: 2, stderr: "status/replay should not call api\n" }]
    });

    const status = runWatcher(["status", "--state-dir", state.stateDir], { env: fakeGh.env });
    assert.equal(status.status, 0, status.stderr);
    const replay = runWatcher(["replay", "--state-dir", state.stateDir], { env: fakeGh.env });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(await fakeGh.calls(), []);
  });
});

test("snapshot handles missing, hung, and nonzero gh as bounded channel failures", async () => {
  await withTempDir("snapshot-gh-channel", async (tmp) => {
    const missingGhState = resolvePrState({ stateDir: path.join(tmp, "missing-gh") });
    await writePrStateJson(missingGhState, "manager", "config.json", validConfig());
    const emptyBin = path.join(tmp, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    const missingGh = runWatcher(["snapshot", "--state-dir", missingGhState.stateDir], {
      env: { PATH: emptyBin }
    });
    assert.equal(missingGh.status, 20, missingGh.stderr);
    assert.equal(parseStdoutJson(missingGh).reason, "gh_unavailable");

    const timeoutState = resolvePrState({ stateDir: path.join(tmp, "timeout") });
    await writePrStateJson(timeoutState, "manager", "config.json", validConfig());
    const timeoutGh = await writeFakeGh(path.join(tmp, "fake-timeout"), {
      graphql: [{ sleepMs: 500, body: prGraphqlResponse() }]
    });
    const timeoutStarted = Date.now();
    const timedOut = runWatcher(["snapshot", "--state-dir", timeoutState.stateDir], {
      env: { ...timeoutGh.env, SCUBA_GH_COMMAND_TIMEOUT_MS: "25" }
    });
    const timeoutElapsed = Date.now() - timeoutStarted;
    assert.equal(timedOut.status, 20, timedOut.stderr);
    assert.equal(parseStdoutJson(timedOut).reason, "gh_command_timeout");
    assert.ok(timeoutElapsed < 1_000, `timeout elapsed ${timeoutElapsed}ms`);

    const resistantState = resolvePrState({ stateDir: path.join(tmp, "sigterm-resistant") });
    await writePrStateJson(resistantState, "manager", "config.json", validConfig());
    const resistantGh = await writeFakeGh(path.join(tmp, "fake-sigterm-resistant"), {
      graphql: [{ sleepMs: 1_500, ignoreSigterm: true, body: prGraphqlResponse() }]
    });
    const resistantStarted = Date.now();
    const resistant = runWatcher(["snapshot", "--state-dir", resistantState.stateDir], {
      env: { ...resistantGh.env, SCUBA_GH_COMMAND_TIMEOUT_MS: "25" }
    });
    const resistantElapsed = Date.now() - resistantStarted;
    assert.equal(resistant.status, 20, resistant.stderr);
    assert.equal(parseStdoutJson(resistant).reason, "gh_command_timeout");
    assert.ok(resistantElapsed < 1_000, `SIGTERM-resistant timeout elapsed ${resistantElapsed}ms`);

    const authRaceState = resolvePrState({ stateDir: path.join(tmp, "auth-race") });
    await writePrStateJson(authRaceState, "manager", "config.json", validConfig());
    const authRaceGh = await writeFakeGh(path.join(tmp, "fake-auth-race"), {
      graphql: [{
        exitCode: 1,
        stdout: JSON.stringify(prGraphqlResponse()),
        stderr: "HTTP 401: Bad credentials\n"
      }]
    });
    const authRace = runWatcher(["snapshot", "--state-dir", authRaceState.stateDir], { env: authRaceGh.env });
    assert.equal(authRace.status, 20, authRace.stderr);
    assert.equal(parseStdoutJson(authRace).reason, "auth_failed");

    const noisyState = resolvePrState({ stateDir: path.join(tmp, "noisy") });
    await writePrStateJson(noisyState, "manager", "config.json", validConfig());
    const secret = "ghp_REDACTIONPROBETOKEN1234567890abcdef";
    const huge = `token_${"x".repeat(5000)} ${secret}`;
    const noisyGh = await writeFakeGh(path.join(tmp, "fake-noisy"), {
      auth: { exitCode: 1, stdout: huge, stderr: huge }
    });
    const noisy = runWatcher(["snapshot", "--state-dir", noisyState.stateDir], { env: noisyGh.env });
    assert.equal(noisy.status, 20, noisy.stderr);
    const noisySummary = parseStdoutJson(noisy);
    assert.equal(noisySummary.reason, "auth_failed");
    assert.ok(noisySummary.github_error.stderr_excerpt.length < 530);
    assertNoSecret(noisy.stdout, secret);
    const noisyStatus = JSON.parse(await readFile(path.join(noisyState.stateDir, "watcher-status.json"), "utf8"));
    assert.ok(noisyStatus.last_error.message.length < 530);
    assertNoSecret(JSON.stringify(noisyStatus), secret);
  });
});

test("snapshot rejects partial GraphQL errors, incomplete check rollups, and malformed required PR data", async () => {
  await withTempDir("snapshot-malformed-data", async (tmp) => {
    const cases = [
      ["partial-errors", { body: { ...prGraphqlResponse(), errors: [{ type: "SOMETHING", message: "partial data cannot be trusted" }] } }, "malformed_github_data"],
      ["rollup-page", { body: prGraphqlResponse({ pageInfo: { hasNextPage: true, endCursor: "cursor-1" } }) }, "github_collection_incomplete"],
      ["missing-page-info", { body: prGraphqlResponse({ statusCheckRollup: { contexts: { nodes: [] } } }) }, "github_collection_incomplete"],
      ["null-page-info", { body: prGraphqlResponse({ statusCheckRollup: { contexts: { pageInfo: null, nodes: [] } } }) }, "github_collection_incomplete"],
      ["wrong-shape", { stdout: "[]\n" }, "malformed_github_data"]
    ];

    for (const [label, response, reason] of cases) {
      const state = resolvePrState({ stateDir: path.join(tmp, label) });
      await writePrStateJson(state, "manager", "config.json", validConfig());
      const fakeGh = await writeFakeGh(path.join(tmp, `fake-${label}`), {
        graphql: [response]
      });
      const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });
      assert.equal(snapshot.status, 20, `${label}: ${snapshot.stderr}`);
      assert.equal(parseStdoutJson(snapshot).reason, reason, label);
      assert.equal(existsSync(path.join(state.stateDir, "latest-snapshot.json")), false, label);
    }

    const rateState = resolvePrState({ stateDir: path.join(tmp, "graphql-rate") });
    await writePrStateJson(rateState, "manager", "config.json", validConfig());
    const rateGh = await writeFakeGh(path.join(tmp, "fake-graphql-rate"), {
      graphql: [{
        body: {
          ...prGraphqlResponse(),
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]
        }
      }]
    });
    const rate = runWatcher(["snapshot", "--state-dir", rateState.stateDir], { env: rateGh.env });
    assert.equal(rate.status, 20, rate.stderr);
    assert.equal(parseStdoutJson(rate).reason, "github_rate_limited");

    const secretState = resolvePrState({ stateDir: path.join(tmp, "graphql-secret") });
    await writePrStateJson(secretState, "manager", "config.json", validConfig());
    const secret = "ghp_GRAPHQLREDACTIONTOKEN1234567890abcdef";
    const secretGh = await writeFakeGh(path.join(tmp, "fake-graphql-secret"), {
      graphql: [{
        body: {
          ...prGraphqlResponse(),
          errors: [{ type: "SOMETHING", message: `partial ${secret} cannot be trusted` }]
        }
      }]
    });
    const secretResult = runWatcher(["snapshot", "--state-dir", secretState.stateDir], { env: secretGh.env });
    assert.equal(secretResult.status, 20, secretResult.stderr);
    const secretSummary = parseStdoutJson(secretResult);
    assert.equal(secretSummary.reason, "malformed_github_data");
    assertNoSecret(secretResult.stdout, secret);
    const secretStatus = JSON.parse(await readFile(path.join(secretState.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(secretStatus.last_error.github.api_errors[0].type, "SOMETHING");
    assertNoSecret(JSON.stringify(secretStatus), secret);
  });
});

test("snapshot treats nullable statusCheckRollup as empty check evidence", async () => {
  await withTempDir("snapshot-null-rollup", async (tmp) => {
    const notRequiredState = resolvePrState({ stateDir: path.join(tmp, "not-required") });
    await writePrStateJson(notRequiredState, "manager", "config.json", validConfig({
      required_check_contexts: []
    }));
    const notRequiredGh = await writeFakeGh(path.join(tmp, "fake-not-required"), {
      graphql: [okPrResponse({ statusCheckRollup: null })]
    });
    const notRequired = runWatcher(["snapshot", "--state-dir", notRequiredState.stateDir], { env: notRequiredGh.env });
    assert.equal(notRequired.status, 0, notRequired.stderr);
    assert.equal(parseStdoutJson(notRequired).check_aggregate, "checks_not_required");

    const missingState = resolvePrState({ stateDir: path.join(tmp, "missing") });
    await writePrStateJson(missingState, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/test"]
    }));
    const missingGh = await writeFakeGh(path.join(tmp, "fake-missing"), {
      graphql: [okPrResponse({ statusCheckRollup: null })]
    });
    const missing = runWatcher(["snapshot", "--state-dir", missingState.stateDir], { env: missingGh.env });
    assert.equal(missing.status, 0, missing.stderr);
    const missingSummary = parseStdoutJson(missing);
    assert.equal(missingSummary.check_aggregate, "checks_missing");
    const missingSnapshot = JSON.parse(await readFile(path.join(missingState.stateDir, "snapshots", `${missingSummary.snapshot_id}.json`), "utf8"));
    assert.deepEqual(missingSnapshot.checks.missing_required_contexts, ["ci/test"]);
  });
});

test("snapshot fails closed when statusCheckRollup advertises an uncollected 101st context", async () => {
  await withTempDir("snapshot-rollup-truncated-101", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await writePrStateJson(state, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/page-one-green", "ci/page-two-failed"]
    }));
    const pageOneContexts = Array.from({ length: 100 }, (_, index) => checkRun({
      name: index === 0 ? "ci/page-one-green" : `ci/filler-${index}`,
      conclusion: "SUCCESS"
    }));
    const fakeGh = await writeFakeGh(tmp, {
      graphql: [okPrResponse({
        contexts: pageOneContexts,
        pageInfo: {
          hasNextPage: true,
          endCursor: "cursor-after-100"
        }
      })]
    });

    const snapshot = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });

    assert.equal(snapshot.status, 20, snapshot.stderr);
    const summary = parseStdoutJson(snapshot);
    assert.equal(summary.reason, "github_collection_incomplete");
    assert.equal(summary.status, "blocked_watcher_unavailable");
    assert.equal(summary.check_aggregate, null);
    assert.equal(existsSync(path.join(state.stateDir, "latest-snapshot.json")), false);
    const calls = await fakeGh.calls();
    assert.ok(calls.some((call) => call.args.join(" ").includes("pageInfo")));
  });
});

test("snapshot mergeability retry remains bounded and coherent across final PR reads", async () => {
  await withTempDir("snapshot-mergeability-coherence", async (tmp) => {
    const nullThenClean = resolvePrState({ stateDir: path.join(tmp, "null-clean") });
    await writePrStateJson(nullThenClean, "manager", "config.json", validConfig());
    const nullThenCleanGh = await writeFakeGh(path.join(tmp, "fake-null-clean"), {
      graphql: [
        okPrResponse({ mergeable: null, mergeStateStatus: "CLEAN" }),
        okPrResponse({ mergeable: "MERGEABLE", mergeStateStatus: "UNKNOWN" }),
        okPrResponse({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })
      ]
    });
    const finalConflict = runWatcher([
      "snapshot",
      "--state-dir",
      nullThenClean.stateDir,
      "--mergeability-retry-delay-ms",
      "0"
    ], { env: nullThenCleanGh.env });
    assert.equal(finalConflict.status, 0, finalConflict.stderr);
    const conflictSummary = parseStdoutJson(finalConflict);
    assert.equal(conflictSummary.mergeability.mergeable, "CONFLICTING");
    assert.equal(conflictSummary.mergeability.merge_state_status, "DIRTY");
    assert.equal(conflictSummary.mergeability.attempts, 3);

    const headChange = resolvePrState({ stateDir: path.join(tmp, "head-change") });
    await writePrStateJson(headChange, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/test"]
    }));
    const headChangeGh = await writeFakeGh(path.join(tmp, "fake-head-change"), {
      graphql: [
        okPrResponse({
          headSha: "aaa111",
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          contexts: [checkRun({ name: "ci/test", conclusion: "SUCCESS", headSha: "aaa111" })]
        }),
        okPrResponse({
          headSha: "bbb222",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          contexts: [checkRun({ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED", headSha: "bbb222" })]
        })
      ]
    });
    const finalHead = runWatcher([
      "snapshot",
      "--state-dir",
      headChange.stateDir,
      "--mergeability-retry-delay-ms",
      "0"
    ], { env: headChangeGh.env });
    assert.equal(finalHead.status, 0, finalHead.stderr);
    const finalHeadSummary = parseStdoutJson(finalHead);
    assert.equal(finalHeadSummary.current_head_sha, "bbb222");
    assert.equal(finalHeadSummary.check_aggregate, "checks_failed");
    const immutable = JSON.parse(await readFile(path.join(headChange.stateDir, "snapshots", `${finalHeadSummary.snapshot_id}.json`), "utf8"));
    assert.deepEqual(immutable.checks.contexts.map((context) => context.head_sha), ["bbb222"]);

    const staleHead = resolvePrState({ stateDir: path.join(tmp, "expected-head") });
    await writePrStateJson(staleHead, "manager", "config.json", validConfig({
      expected_head_sha: "aaa111"
    }));
    const staleHeadGh = await writeFakeGh(path.join(tmp, "fake-expected-head"), {
      graphql: [okPrResponse({ headSha: "bbb222" })]
    });
    const stale = runWatcher(["snapshot", "--state-dir", staleHead.stateDir], { env: staleHeadGh.env });
    assert.equal(stale.status, 20, stale.stderr);
    const staleSummary = parseStdoutJson(stale);
    assert.equal(staleSummary.status, "blocked_stale_head");
    assert.equal(staleSummary.reason, "blocked_stale_head");
    assert.equal(staleSummary.expected_head_sha, "aaa111");
    assert.equal(staleSummary.actual_head_sha, "bbb222");
    const staleStatus = JSON.parse(await readFile(path.join(staleHead.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(staleStatus.last_error.expected_head_sha, "aaa111");
    assert.equal(staleStatus.last_error.actual_head_sha, "bbb222");
  });
});

test("snapshot check aggregation is current-head filtered and deterministic", async () => {
  await withTempDir("snapshot-current-head-checks", async (tmp) => {
    const staleOnly = resolvePrState({ stateDir: path.join(tmp, "stale-only") });
    await writePrStateJson(staleOnly, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/test"]
    }));
    const staleOnlyGh = await writeFakeGh(path.join(tmp, "fake-stale-only"), {
      graphql: [okPrResponse({
        headSha: "bbb222",
        contexts: [checkRun({ name: "ci/test", conclusion: "SUCCESS", headSha: "aaa111" })]
      })]
    });
    const staleOnlyResult = runWatcher(["snapshot", "--state-dir", staleOnly.stateDir], { env: staleOnlyGh.env });
    assert.equal(staleOnlyResult.status, 0, staleOnlyResult.stderr);
    const staleOnlySummary = parseStdoutJson(staleOnlyResult);
    assert.equal(staleOnlySummary.check_aggregate, "checks_missing");
    const staleOnlySnapshot = JSON.parse(await readFile(path.join(staleOnly.stateDir, "snapshots", `${staleOnlySummary.snapshot_id}.json`), "utf8"));
    assert.equal(staleOnlySnapshot.checks.contexts[0].is_current_head, false);

    const mixed = resolvePrState({ stateDir: path.join(tmp, "mixed") });
    await writePrStateJson(mixed, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/test", "lint", "typecheck"]
    }));
    const mixedGh = await writeFakeGh(path.join(tmp, "fake-mixed"), {
      graphql: [okPrResponse({
        headSha: "bbb222",
        contexts: [
          checkRun({ name: "ci/test", conclusion: "SUCCESS", headSha: "aaa111" }),
          checkRun({ name: "ci/test", conclusion: "SUCCESS", headSha: "bbb222" }),
          checkRun({ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED", headSha: "bbb222" }),
          checkRun({ name: "lint", status: "IN_PROGRESS", conclusion: "SUCCESS", headSha: "bbb222" }),
          statusContext({ context: "style", state: "EXPECTED" })
        ]
      })]
    });
    const mixedResult = runWatcher(["snapshot", "--state-dir", mixed.stateDir], { env: mixedGh.env });
    assert.equal(mixedResult.status, 0, mixedResult.stderr);
    const mixedSummary = parseStdoutJson(mixedResult);
    assert.equal(mixedSummary.check_aggregate, "checks_missing");
    const mixedSnapshot = JSON.parse(await readFile(path.join(mixed.stateDir, "snapshots", `${mixedSummary.snapshot_id}.json`), "utf8"));
    assert.deepEqual(mixedSnapshot.checks.missing_required_contexts, ["typecheck"]);
    assert.ok(mixedSnapshot.checks.contexts.some((context) => context.context === "ci/test" && context.state === "failed"));
    assert.ok(mixedSnapshot.checks.contexts.some((context) => context.context === "lint" && context.state === "pending"));

    const mapping = resolvePrState({ stateDir: path.join(tmp, "mapping") });
    await writePrStateJson(mapping, "manager", "config.json", validConfig({
      required_check_contexts: ["neutral", "skipped", "startup", "pending-null", "expected"]
    }));
    const mappingGh = await writeFakeGh(path.join(tmp, "fake-mapping"), {
      graphql: [okPrResponse({
        contexts: [
          checkRun({ name: "neutral", conclusion: "NEUTRAL" }),
          checkRun({ name: "skipped", conclusion: "SKIPPED" }),
          checkRun({ name: "startup", conclusion: "STARTUP_FAILURE", status: "COMPLETED" }),
          checkRun({ name: "pending-null", conclusion: null, status: "COMPLETED" }),
          statusContext({ context: "expected", state: "EXPECTED" })
        ]
      })]
    });
    const mappingResult = runWatcher(["snapshot", "--state-dir", mapping.stateDir], { env: mappingGh.env });
    assert.equal(mappingResult.status, 0, mappingResult.stderr);
    const mappingSnapshot = JSON.parse(await readFile(
      path.join(mapping.stateDir, "snapshots", `${parseStdoutJson(mappingResult).snapshot_id}.json`),
      "utf8"
    ));
    const byContext = Object.fromEntries(mappingSnapshot.checks.contexts.map((context) => [context.context, context.state]));
    assert.equal(byContext.neutral, "green");
    assert.equal(byContext.skipped, "green");
    assert.equal(byContext.startup, "failed");
    assert.equal(byContext["pending-null"], "pending");
    assert.equal(byContext.expected, "pending");

    const commitOnly = resolvePrState({ stateDir: path.join(tmp, "commit-only") });
    await writePrStateJson(commitOnly, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/test"]
    }));
    const commitOnlyGh = await writeFakeGh(path.join(tmp, "fake-commit-only"), {
      graphql: [okPrResponse({
        contexts: [checkRun({
          name: "ci/test",
          workflowRun: null,
          commitOid: "abc123head",
          conclusion: "SUCCESS"
        })]
      })]
    });
    const commitOnlyResult = runWatcher(["snapshot", "--state-dir", commitOnly.stateDir], { env: commitOnlyGh.env });
    assert.equal(commitOnlyResult.status, 0, commitOnlyResult.stderr);
    const commitOnlySummary = parseStdoutJson(commitOnlyResult);
    assert.equal(commitOnlySummary.check_aggregate, "checks_green");
    const commitOnlySnapshot = JSON.parse(await readFile(path.join(commitOnly.stateDir, "snapshots", `${commitOnlySummary.snapshot_id}.json`), "utf8"));
    assert.equal(commitOnlySnapshot.checks.contexts[0].head_sha, "abc123head");
    assert.equal(commitOnlySnapshot.checks.contexts[0].head_source, "check_suite_commit");

    const missingHead = resolvePrState({ stateDir: path.join(tmp, "missing-head") });
    await writePrStateJson(missingHead, "manager", "config.json", validConfig({
      required_check_contexts: ["ci/test"]
    }));
    const missingHeadGh = await writeFakeGh(path.join(tmp, "fake-missing-head"), {
      graphql: [okPrResponse({
        contexts: [checkRun({
          name: "ci/test",
          workflowRun: null,
          commitOid: null,
          conclusion: "SUCCESS"
        })]
      })]
    });
    const missingHeadResult = runWatcher(["snapshot", "--state-dir", missingHead.stateDir], { env: missingHeadGh.env });
    assert.equal(missingHeadResult.status, 0, missingHeadResult.stderr);
    const missingHeadSummary = parseStdoutJson(missingHeadResult);
    assert.equal(missingHeadSummary.check_aggregate, "checks_missing");
    const missingHeadSnapshot = JSON.parse(await readFile(path.join(missingHead.stateDir, "snapshots", `${missingHeadSummary.snapshot_id}.json`), "utf8"));
    assert.equal(missingHeadSnapshot.checks.contexts[0].head_sha, null);
    assert.equal(missingHeadSnapshot.checks.contexts[0].is_current_head, false);
  });
});

test("snapshot writes append-only immutable records under a fixed clock", async () => {
  await withTempDir("snapshot-append-only", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await writePrStateJson(state, "manager", "config.json", validConfig());
    const fakeGh = await writeFakeGh(path.join(tmp, "fake-append-only"), {
      graphql: [
        okPrResponse({ title: "first fixed-clock evidence" }),
        okPrResponse({ title: "second fixed-clock evidence" })
      ]
    });

    const fixed = "2026-06-28T00:00:00.000Z";
    const first = runWatcherWithFixedNow(["snapshot", "--state-dir", state.stateDir], fixed, { env: fakeGh.env });
    const second = runWatcherWithFixedNow(["snapshot", "--state-dir", state.stateDir], fixed, { env: fakeGh.env });

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const firstSummary = parseStdoutJson(first);
    const secondSummary = parseStdoutJson(second);
    assert.notEqual(firstSummary.snapshot_id, secondSummary.snapshot_id);
    const snapshotFiles = (await readdir(path.join(state.stateDir, "snapshots"))).filter((entry) => entry.endsWith(".json")).sort();
    assert.deepEqual(snapshotFiles, [`${firstSummary.snapshot_id}.json`, `${secondSummary.snapshot_id}.json`].sort());
    const titles = [];
    for (const file of snapshotFiles) {
      titles.push(JSON.parse(await readFile(path.join(state.stateDir, "snapshots", file), "utf8")).pr.title);
    }
    assert.deepEqual(titles.sort(), ["first fixed-clock evidence", "second fixed-clock evidence"]);
  });
});

test("snapshot write and release failures produce one blocked JSON result without clean current status", async () => {
  await withTempDir("snapshot-write-release-failure", async (tmp) => {
    const statusFailureState = resolvePrState({ stateDir: path.join(tmp, "status-failure") });
    await writePrStateJson(statusFailureState, "manager", "config.json", validConfig());
    await mkdir(path.join(statusFailureState.stateDir, "watcher-status.json"));
    const statusFailureGh = await writeFakeGh(path.join(tmp, "fake-status-failure"), {
      graphql: [okPrResponse()]
    });
    const statusFailure = runWatcher(["snapshot", "--state-dir", statusFailureState.stateDir], { env: statusFailureGh.env });
    assert.equal(statusFailure.status, 20, statusFailure.stderr);
    const statusFailureSummary = parseStdoutJson(statusFailure);
    assert.equal(statusFailureSummary.reason, "invalid_state_path");
    assert.equal(statusFailureSummary.snapshot_id, null);
    assert.equal(existsSync(path.join(statusFailureState.stateDir, "latest-snapshot.json")), false);

    const blockedWriteState = resolvePrState({ stateDir: path.join(tmp, "blocked-write") });
    await writePrStateJson(blockedWriteState, "manager", "config.json", validConfig());
    await writeFile(path.join(blockedWriteState.stateDir, "snapshots"), "not a directory\n");
    const blockedWriteGh = await writeFakeGh(path.join(tmp, "fake-blocked-write"), {
      graphql: Array.from({ length: 5 }, () => okPrResponse({
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN"
      }))
    });
    const blockedWrite = runWatcher([
      "snapshot",
      "--state-dir",
      blockedWriteState.stateDir,
      "--mergeability-retry-delay-ms",
      "0"
    ], { env: blockedWriteGh.env });
    assert.equal(blockedWrite.status, 20, blockedWrite.stderr);
    const blockedWriteSummary = parseStdoutJson(blockedWrite);
    assert.equal(blockedWriteSummary.reason, "invalid_state_path");
    assert.equal(blockedWriteSummary.snapshot_id, null);
    assert.equal(existsSync(path.join(blockedWriteState.stateDir, "latest-snapshot.json")), false);

    const releaseFailureState = resolvePrState({ stateDir: path.join(tmp, "release-failure") });
    await writePrStateJson(releaseFailureState, "manager", "config.json", validConfig());
    const releaseFailureGh = await writeFakeGh(path.join(tmp, "fake-release-failure"), {
      graphql: [{ ...okPrResponse(), blockLockRelease: true }]
    });
    const releaseFailure = runWatcher(["snapshot", "--state-dir", releaseFailureState.stateDir], {
      env: {
        ...releaseFailureGh.env,
        SCUBA_FAKE_GH_LOCK_PATH: path.join(releaseFailureState.stateDir, "pr-feedback.lock")
      }
    });
    assert.equal(releaseFailure.status, 75, releaseFailure.stderr);
    const releaseSummary = parseStdoutJson(releaseFailure);
    assert.equal(releaseSummary.reason, "lock_release_blocked");
    const releaseStatus = JSON.parse(await readFile(path.join(releaseFailureState.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(releaseStatus.status, "blocked_watcher_unavailable");
    assert.equal(releaseStatus.reason, "lock_release_blocked");
  });
});

test("local status/replay preserve last success and record real timing", async () => {
  await withTempDir("snapshot-status-continuity", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await writePrStateJson(state, "manager", "config.json", validConfig());
    const fakeGh = await writeFakeGh(path.join(tmp, "fake-success"), {
      graphql: [{ sleepMs: 80, body: prGraphqlResponse() }]
    });
    const success = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });
    assert.equal(success.status, 0, success.stderr);
    const successSummary = parseStdoutJson(success);
    let statusRecord = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(statusRecord.last_successful_snapshot_id, successSummary.snapshot_id);
    assert.ok(Date.parse(statusRecord.completed_at) > Date.parse(statusRecord.started_at));

    const replay = runWatcher(["replay", "--state-dir", state.stateDir]);
    assert.equal(replay.status, 0, replay.stderr);
    statusRecord = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(statusRecord.last_successful_snapshot_id, successSummary.snapshot_id);

    await writeFile(path.join(state.stateDir, "pr-feedback.lock"), JSON.stringify({
      schema_version: 1,
      lock_id: "stale-lock",
      owner: "watcher",
      pid: 99999999,
      hostname: "stale-host",
      started_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-06-27T00:00:01.000Z",
      mode: "test",
      operation: "stale"
    }, null, 2) + "\n");
    const status = runWatcher(["status", "--state-dir", state.stateDir, "--lock-stale-ms", "1", "--lock-timeout-ms", "25"]);
    assert.equal(status.status, 0, status.stderr);
    statusRecord = JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8"));
    assert.equal(statusRecord.last_successful_snapshot_id, successSummary.snapshot_id);
    assert.equal(statusRecord.stale_lock_break.previous_lock.operation, "stale");
  });
});

test("snapshot preserves prior evidence boundaries and leaves events and steward files unchanged", async () => {
  await withTempDir("snapshot-boundaries", async (tmp) => {
    const state = resolvePrState({ stateDir: path.join(tmp, "pr-state") });
    await writePrStateJson(state, "manager", "config.json", validConfig({
      repo: { owner: "octo", name: "repo" }
    }));
    await appendPrStateJsonl(state, "watcher", "events.jsonl", eventRevision("review:1", "review:1:v1"));
    await writePrStateJson(state, "steward", "closeout.json", { schema_version: 1, status: "steward-closeout" });
    await writePrStateJson(state, "steward", "dispositions.json", { schema_version: 1, dispositions: [] });
    await appendPrStateJsonl(state, "steward", "push-log.jsonl", { head_before: "a", head_after: "b" });
    await writePrStateJson(state, "steward", "hardening-rounds/round-1.json", { schema_version: 1, status: "open" });

    const eventBytesBefore = await readFile(path.join(state.stateDir, "events.jsonl"), "utf8");
    const closeoutBefore = await readFile(path.join(state.stateDir, "closeout.json"), "utf8");
    const dispositionsBefore = await readFile(path.join(state.stateDir, "dispositions.json"), "utf8");
    const pushBefore = await readFile(path.join(state.stateDir, "push-log.jsonl"), "utf8");
    const roundBefore = await readFile(path.join(state.stateDir, "hardening-rounds", "round-1.json"), "utf8");

    const fakeGh = await writeFakeGh(path.join(tmp, "fake-success"), {
      graphql: [okPrResponse()]
    });
    const success = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: fakeGh.env });
    assert.equal(success.status, 0, success.stderr);
    const successSummary = parseStdoutJson(success);
    assert.equal(successSummary.repo, "octo/repo");
    assert.equal(successSummary.terminal_state, null);
    assert.equal(existsSync(path.join(state.stateDir, "events.jsonl")), true);
    assert.equal(await readFile(path.join(state.stateDir, "events.jsonl"), "utf8"), eventBytesBefore);
    assert.equal(await readFile(path.join(state.stateDir, "closeout.json"), "utf8"), closeoutBefore);
    assert.equal(await readFile(path.join(state.stateDir, "dispositions.json"), "utf8"), dispositionsBefore);
    assert.equal(await readFile(path.join(state.stateDir, "push-log.jsonl"), "utf8"), pushBefore);
    assert.equal(await readFile(path.join(state.stateDir, "hardening-rounds", "round-1.json"), "utf8"), roundBefore);

    const latestBeforeFailure = await readFile(path.join(state.stateDir, "latest-snapshot.json"), "utf8");
    const authFailGh = await writeFakeGh(path.join(tmp, "fake-auth-fail-boundary"), {
      auth: { exitCode: 1, stderr: "auth expired\n" }
    });
    const failed = runWatcher(["snapshot", "--state-dir", state.stateDir], { env: authFailGh.env });
    assert.equal(failed.status, 20, failed.stderr);
    const failedSummary = parseStdoutJson(failed);
    assert.equal(failedSummary.snapshot_id, null);
    assert.equal(await readFile(path.join(state.stateDir, "latest-snapshot.json"), "utf8"), latestBeforeFailure);
    assert.equal(JSON.parse(await readFile(path.join(state.stateDir, "watcher-status.json"), "utf8")).last_successful_snapshot_id, successSummary.snapshot_id);
    assert.equal(await readFile(path.join(state.stateDir, "closeout.json"), "utf8"), closeoutBefore);
  });
});

function test(name, fn) {
  tests.push({ name, fn });
}

function validConfig(overrides = {}) {
  return {
    schema_version: 1,
    team: "alpha",
    repo: "octo/repo",
    pr_number: 7,
    external_reviewer: { login: "reviewer" },
    quiet_period_minutes: 20,
    ...overrides
  };
}

async function writeFakeGh(tmp, scenario) {
  await mkdir(tmp, { recursive: true });
  const binDir = path.join(tmp, "bin");
  await mkdir(binDir, { recursive: true });
  const scenarioPath = path.join(tmp, "fake-gh-scenario.json");
  const statePath = path.join(tmp, "fake-gh-state.json");
  const logPath = path.join(tmp, "fake-gh-calls.jsonl");
  const ghPath = path.join(binDir, "gh");
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2) + "\n");
  await writeFile(ghPath, fakeGhSource());
  await chmod(ghPath, 0o755);
  return {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SCUBA_FAKE_GH_SCENARIO: scenarioPath,
      SCUBA_FAKE_GH_STATE: statePath,
      SCUBA_FAKE_GH_LOG: logPath
    },
    async calls() {
      if (!existsSync(logPath)) return [];
      return (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  };
}

function fakeGhSource() {
  return `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.SCUBA_FAKE_GH_SCENARIO, "utf8"));
const statePath = process.env.SCUBA_FAKE_GH_STATE;
const logPath = process.env.SCUBA_FAKE_GH_LOG;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { graphqlCalls: 0 };
let activeResponse = null;

appendFileSync(logPath, JSON.stringify({ args }) + "\\n");

process.on("SIGTERM", () => {
  if (activeResponse?.ignoreSigterm) return;
  process.exit(143);
});

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
}

async function finish(response = {}) {
  activeResponse = response;
  if (response.blockLockRelease) blockLockRelease();
  if (Number.isSafeInteger(response.sleepMs) && response.sleepMs > 0) {
    await sleep(response.sleepMs);
  }
  if (response.stdout !== undefined) process.stdout.write(String(response.stdout));
  else if (response.body !== undefined) process.stdout.write(JSON.stringify(response.body));
  if (response.stderr !== undefined) process.stderr.write(String(response.stderr));
  process.exit(response.exitCode ?? 0);
}

function blockLockRelease() {
  const lockPath = process.env.SCUBA_FAKE_GH_LOCK_PATH;
  if (!lockPath) return;
  const raw = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(raw);
  const identity = {
    schema_valid: true,
    lock_id: lock.lock_id,
    owner: lock.owner,
    started_at: lock.started_at,
    content_sha256: sha256(raw)
  };
  const identityKey = sha256(JSON.stringify(canonicalize(identity))).slice(0, 32);
  const claimPath = path.join(path.dirname(lockPath), ".pr-feedback.lock.remove-" + identityKey + ".claim");
  writeFileSync(claimPath, JSON.stringify({
    kind: "pr-feedback-lock-removal-claim",
    identity_key: identityKey,
    pid: process.pid,
    hostname: "fake-gh",
    created_at: new Date().toISOString()
  }, null, 2) + "\\n", { flag: "wx" });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) normalized[key] = canonicalize(value[key]);
    return normalized;
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hostnameArg() {
  const index = args.indexOf("--hostname");
  return index === -1 ? null : args[index + 1] ?? null;
}

if (args[0] === "auth" && args[1] === "status") {
  await finish(scenario.auth ?? { exitCode: 0, stdout: "github.com\\n" });
}

if (args[0] === "api" && args[1] === "graphql") {
  if (scenario.requireApiHostname && hostnameArg() !== scenario.requireApiHostname) {
    await finish({
      exitCode: 2,
      stderr: "api graphql missing --hostname " + scenario.requireApiHostname + "\\n"
    });
  }
  const responses = Array.isArray(scenario.graphql) ? scenario.graphql : [scenario.graphql ?? {}];
  const index = Math.min(state.graphqlCalls, responses.length - 1);
  state.graphqlCalls += 1;
  save();
  await finish(responses[index]);
}

process.stderr.write("unexpected fake gh invocation: " + args.join(" ") + "\\n");
process.exit(2);
`;
}

function okPrResponse(options = {}) {
  return { body: prGraphqlResponse(options) };
}

function prGraphqlResponse({
  headSha = "abc123head",
  mergeable = "MERGEABLE",
  mergeStateStatus = "CLEAN",
  contexts = [],
  pageInfo = { hasNextPage: false, endCursor: null },
  statusCheckRollup,
  author = { login: "author" },
  repoOwner = "octo",
  repoName = "repo",
  title = "S03 snapshot"
} = {}) {
  return {
    data: {
      repository: {
        id: "R_kwDO_repo",
        name: repoName,
        owner: { login: repoOwner },
        defaultBranchRef: { name: "main", target: { oid: "base123" } },
        url: `https://github.com/${repoOwner}/${repoName}`,
        pullRequest: {
          id: "PR_kwDO_single",
          databaseId: 7,
          number: 7,
          state: "OPEN",
          isDraft: false,
          title,
          url: `https://github.com/${repoOwner}/${repoName}/pull/7`,
          author,
          baseRefName: "main",
          baseRefOid: "base123",
          headRefName: "feature/s03",
          headRefOid: headSha,
          createdAt: "2026-06-28T00:00:00Z",
          updatedAt: "2026-06-28T00:05:00Z",
          mergeable,
          mergeStateStatus,
          statusCheckRollup: statusCheckRollup === undefined ? {
            contexts: {
              pageInfo,
              nodes: contexts
            }
          } : statusCheckRollup
        }
      },
      rateLimit: {
        limit: 5000,
        remaining: 4999,
        resetAt: "2026-06-28T01:00:00Z"
      }
    }
  };
}

function checkRun({
  nodeId = "CR_kwDO_ci_test",
  databaseId = 101,
  name,
  status = "COMPLETED",
  conclusion = "SUCCESS",
  headSha = "abc123head",
  workflowRun,
  commitOid
} = {}) {
  const resolvedWorkflowRun = workflowRun !== undefined ? workflowRun : { headSha };
  const resolvedCommitOid = commitOid !== undefined ? commitOid : headSha;
  return {
    __typename: "CheckRun",
    id: nodeId,
    databaseId,
    name,
    status,
    conclusion,
    url: "https://github.com/octo/repo/actions/runs/1",
    detailsUrl: "https://github.com/octo/repo/actions/runs/1",
    startedAt: "2026-06-28T00:01:00Z",
    completedAt: "2026-06-28T00:02:00Z",
    checkSuite: {
      workflowRun: resolvedWorkflowRun,
      commit: resolvedCommitOid ? { oid: resolvedCommitOid } : null,
      app: {
        databaseId: 15368,
        slug: "github-actions",
        name: "GitHub Actions",
        owner: { login: "github" }
      }
    }
  };
}

function statusContext({ context, state = "SUCCESS" } = {}) {
  return {
    __typename: "StatusContext",
    id: `status-${context}`,
    context,
    state,
    targetUrl: "https://github.com/octo/repo/status",
    createdAt: "2026-06-28T00:01:30Z",
    updatedAt: "2026-06-28T00:02:30Z",
    creator: { login: "ci-bot" }
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

function watcherStatusFixture(status) {
  return {
    schema_version: 1,
    mode: "status",
    status,
    reason: null,
    started_at: "2026-06-28T00:00:00.000Z",
    completed_at: "2026-06-28T00:00:01.000Z",
    last_successful_snapshot_id: null,
    last_error: null,
    stale_lock_break: null,
    exit_code: 0
  };
}

async function removalClaimFiles(stateDir) {
  return (await readdir(stateDir))
    .filter((entry) => /^\.pr-feedback\.lock\.remove-[a-f0-9]{32}\.claim$/.test(entry))
    .sort();
}

function lockRemovalClaimPath(lockPath, expectedIdentity) {
  return path.join(path.dirname(lockPath), `.pr-feedback.lock.remove-${lockRemovalIdentityKey(expectedIdentity)}.claim`);
}

function lockIdentityFromLock(lock, raw = JSON.stringify(lock, null, 2) + "\n") {
  return {
    schema_valid: true,
    lock_id: lock.lock_id,
    owner: lock.owner,
    started_at: lock.started_at,
    content_sha256: sha256(raw)
  };
}

function lockRemovalIdentityKey(expectedIdentity) {
  return sha256(canonicalJson(expectedIdentity)).slice(0, 32);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalize(value[key]);
    }
    return normalized;
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function runWatcherWithFixedNow(args, fixedNow, options = {}) {
  const source = `
    const fixedNow = ${JSON.stringify(fixedNow)};
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedNow] : args));
      }
      static now() {
        return new RealDate(fixedNow).getTime();
      }
    }
    globalThis.Date = FixedDate;
    process.argv = [process.execPath, ${JSON.stringify(WATCHER)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(pathToFileURL(WATCHER).href)});
  `;
  return runNode(["--input-type=module", "--eval", source], options);
}

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
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

function assertNoSecret(text, secret) {
  assert.equal(String(text).includes(secret), false, `secret leaked in:\n${text}`);
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
