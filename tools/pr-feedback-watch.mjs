#!/usr/bin/env node

import {
  ConfigurationError,
  CorruptStateError,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LockBusyError,
  PR_STATE_SCHEMA_VERSION,
  PrStateError,
  acquirePrStateLock,
  eventIndexFromReplay,
  loadConfig,
  readOptionalJson,
  replayEvents,
  resolvePrState,
  writePrStateJson
} from "./lib/pr-feedback-state.mjs";

const USAGE = `Usage: pr-feedback-watch.mjs <snapshot|poll|replay|status> [options]

Modes:
  status   Read local watcher status and closeout summary without GitHub.
  replay   Rebuild current event state from canonical events.jsonl.
  snapshot Recognized for later watcher slices; no GitHub collection in S02.
  poll     Recognized for later watcher slices; no GitHub collection in S02.

State selection:
  --state-dir <dir>         Use an explicit PR state directory.
  --team <team> --pr <n>    Use .scuba/teams/<team>/pr-feedback/pr-<n>/.

Lock options:
  --lock-timeout-ms <n>     Bounded lock wait. Default: ${DEFAULT_LOCK_TIMEOUT_MS}.
  --lock-stale-ms <n>       Lock expiry window. Default: ${DEFAULT_LOCK_STALE_MS}.
`;

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n${USAGE}`);
  writeSummary({
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode: null,
    status: "usage_error",
    reason: "usage",
    exit_code: 30
  });
  process.exit(30);
}

const { command, options } = parsed;

if (!command || command === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

try {
  if (command === "status") {
    process.exitCode = await runStatus(options);
  } else if (command === "replay") {
    process.exitCode = await runReplay(options);
  } else if (command === "snapshot" || command === "poll") {
    process.stderr.write(`pr-feedback-watch.mjs ${command} is recognized but GitHub collection is not implemented in S02.\n`);
    writeSummary({
      schema_version: PR_STATE_SCHEMA_VERSION,
      mode: command,
      status: "not_implemented",
      reason: "mode_not_implemented_in_s02",
      exit_code: 30
    });
    process.exitCode = 30;
  } else {
    throw new PrStateError(`Unknown pr-feedback-watch.mjs command: ${command}`, {
      code: "usage",
      exitCode: 30
    });
  }
} catch (error) {
  process.exitCode = handleTopLevelError(error, command);
}

async function runStatus(options) {
  const state = resolveStateFromOptions(options);
  let lock;
  try {
    lock = await acquireWatcherLock(state, "status", options);
    const config = await loadConfig(state);
    let watcherStatus = await readOptionalJson(state, "watcher-status.json");
    if (lock.staleBreak) {
      watcherStatus = watcherStatusRecord({
        mode: "status",
        status: "status_checked",
        exitCode: 0,
        staleLockBreak: lock.staleBreak
      });
      await writePrStateJson(state, "watcher", "watcher-status.json", watcherStatus, {
        lock,
        operation: "write_watcher_status"
      });
    }
    const closeout = await readOptionalJson(state, "closeout.json");
    writeSummary(baseSummary(state, config, {
      mode: "status",
      status: watcherStatus?.status ?? "no_status",
      watcherStatus,
      closeout
    }));
    return 0;
  } catch (error) {
    return await handleStateError(error, state, lock, "status");
  } finally {
    if (lock) await lock.release();
  }
}

async function runReplay(options) {
  const state = resolveStateFromOptions(options);
  let lock;
  try {
    lock = await acquireWatcherLock(state, "replay", options);
    const config = await loadConfig(state);
    const replay = await replayEvents(state);

    await writePrStateJson(state, "watcher", "event-index.json", eventIndexFromReplay(replay), {
      lock,
      operation: "write_event_index"
    });
    await writePrStateJson(state, "watcher", "watcher-status.json", watcherStatusRecord({
      mode: "replay",
      status: "replayed",
      exitCode: 0,
      staleLockBreak: lock.staleBreak
    }), {
      lock,
      operation: "write_watcher_status"
    });

    writeSummary(baseSummary(state, config, {
      mode: "replay",
      status: "replayed",
      replay
    }));
    return 0;
  } catch (error) {
    return await handleStateError(error, state, lock, "replay");
  } finally {
    if (lock) await lock.release();
  }
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = {};

  if (command === "--help" || command === "-h") return { command: "help", options };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") return { command: "help", options };
    if (!arg.startsWith("--")) {
      throw new PrStateError(`Unexpected positional argument '${arg}'`, {
        code: "usage",
        exitCode: 30
      });
    }
    const key = arg.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new PrStateError(`Missing value for ${arg}`, {
        code: "usage",
        exitCode: 30
      });
    }
    index += 1;

    if (key === "state-dir") options.stateDir = value;
    else if (key === "team") options.team = value;
    else if (key === "pr") options.pr = value;
    else if (key === "lock-timeout-ms") options.lockTimeoutMs = parseNonNegativeInteger(value, arg);
    else if (key === "lock-stale-ms") options.lockStaleMs = parsePositiveInteger(value, arg);
    else {
      throw new PrStateError(`Unknown option ${arg}`, {
        code: "usage",
        exitCode: 30
      });
    }
  }

  return { command, options };
}

function resolveStateFromOptions(options) {
  if (options.stateDir && (options.team || options.pr)) {
    throw new PrStateError("--state-dir cannot be combined with --team or --pr", {
      code: "usage",
      exitCode: 30
    });
  }
  return resolvePrState({
    stateDir: options.stateDir,
    team: options.team,
    pr: options.pr
  });
}

async function acquireWatcherLock(state, mode, options) {
  return acquirePrStateLock(state, {
    owner: "watcher",
    mode,
    operation: mode,
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
  });
}

async function handleStateError(error, state, lock, mode) {
  const exitCode = exitCodeForError(error);
  const reason = reasonForError(error);
  process.stderr.write(`${error.message}\n`);

  if (lock && reason !== "lock_busy") {
    await writePrStateJson(state, "watcher", "watcher-status.json", watcherStatusRecord({
      mode,
      status: "blocked_watcher_unavailable",
      reason,
      exitCode,
      error,
      staleLockBreak: lock.staleBreak
    }), {
      lock,
      operation: "write_watcher_status"
    }).catch((statusError) => {
      process.stderr.write(`Failed to write watcher-status.json: ${statusError.message}\n`);
    });
  }

  writeSummary(errorSummary(state, {
    mode,
    status: "blocked_watcher_unavailable",
    reason,
    exitCode,
    error
  }));
  return exitCode;
}

function handleTopLevelError(error, mode = "unknown") {
  const exitCode = exitCodeForError(error);
  const reason = reasonForError(error);
  process.stderr.write(`${error.message}\n`);
  writeSummary({
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode,
    status: exitCode === 30 ? "usage_error" : "blocked_watcher_unavailable",
    reason,
    file: error.file ?? null,
    exit_code: exitCode
  });
  return exitCode;
}

function baseSummary(state, config, fields = {}) {
  const configPr = config?.pr_number ?? config?.prNumber;
  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode: fields.mode,
    team: state.team ?? config?.team ?? null,
    pr: state.pr ?? configPr ?? null,
    repo: config?.repo ?? null,
    current_head_sha: null,
    snapshot_id: null,
    status: fields.status,
    terminal_state: null,
    reason: fields.reason ?? null,
    unclassified_current_head_event_count: 0,
    current_head_dispositions: {
      real: 0,
      deferred: 0,
      invalid: 0
    },
    check_aggregate: null,
    mergeability: null,
    quiet_period: null,
    state_paths: state.paths,
    watcher_status: fields.watcherStatus,
    closeout: fields.closeout,
    replay: fields.replay
  };
}

function errorSummary(state, { mode, status, reason, exitCode, error }) {
  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode,
    team: state?.team ?? null,
    pr: state?.pr ?? null,
    repo: null,
    current_head_sha: null,
    snapshot_id: null,
    status,
    terminal_state: null,
    reason,
    file: error.file ?? null,
    exit_code: exitCode,
    state_paths: state?.paths ?? null
  };
}

function watcherStatusRecord({ mode, status, reason = null, exitCode, error = null, staleLockBreak = null }) {
  const now = new Date().toISOString();
  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode,
    status,
    reason,
    started_at: now,
    completed_at: now,
    last_successful_snapshot_id: null,
    last_error: error ? {
      reason: reasonForError(error),
      message: error.message,
      file: error.file ?? null
    } : null,
    stale_lock_break: staleLockBreak,
    exit_code: exitCode
  };
}

function reasonForError(error) {
  if (error instanceof LockBusyError || error.code === "lock_busy") return "lock_busy";
  if (error instanceof CorruptStateError || error.code === "corrupt_state") return "corrupt_state";
  if (error instanceof ConfigurationError || error.code === "configuration_invalid") return "configuration_invalid";
  if (error.code === "usage") return "usage";
  return error.code ?? "state_error";
}

function exitCodeForError(error) {
  if (typeof error.exitCode === "number") return error.exitCode;
  if (error instanceof LockBusyError || error.code === "lock_busy") return 75;
  if (error.code === "usage") return 30;
  return 20;
}

function parseNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new PrStateError(`${label} must be a non-negative integer`, {
      code: "usage",
      exitCode: 30
    });
  }
  return number;
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new PrStateError(`${label} must be a positive integer`, {
      code: "usage",
      exitCode: 30
    });
  }
  return number;
}

function writeSummary(summary) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
