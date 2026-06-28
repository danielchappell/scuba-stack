import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const PR_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_LOCK_TIMEOUT_MS = 100;
export const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
export const DEFAULT_TEXT_LIMIT_BYTES = 1024 * 1024;

export const PR_STATE_OWNERSHIP = Object.freeze({
  watcher: Object.freeze([
    "watcher-status.json",
    "events.jsonl",
    "event-index.json",
    "latest-snapshot.json",
    "snapshots/"
  ]),
  manager: Object.freeze(["config.json"]),
  steward: Object.freeze([
    "dispositions.json",
    "closeout.json",
    "push-log.jsonl",
    "hardening-rounds/"
  ]),
  smoke: Object.freeze(["audit/"])
});

const OWNER_KINDS = new Set(Object.keys(PR_STATE_OWNERSHIP));

export class PrStateError extends Error {
  constructor(message, { code, file, exitCode } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.file = file;
    this.exitCode = exitCode;
  }
}

export class LockBusyError extends PrStateError {
  constructor(lockPath) {
    super(`PR feedback state lock is busy: ${lockPath}`, {
      code: "lock_busy",
      file: lockPath,
      exitCode: 75
    });
  }
}

export class CorruptStateError extends PrStateError {
  constructor(file, detail) {
    super(`Corrupt PR feedback state in ${file}: ${detail}`, {
      code: "corrupt_state",
      file,
      exitCode: 20
    });
  }
}

export class ConfigurationError extends PrStateError {
  constructor(file, detail) {
    super(`Invalid PR feedback config in ${file}: ${detail}`, {
      code: "configuration_invalid",
      file,
      exitCode: 20
    });
  }
}

export function resolvePrState({ stateDir, rootDir = process.cwd(), team, pr } = {}) {
  if (stateDir) {
    return buildPrState(path.resolve(rootDir, stateDir), { team, pr: parseOptionalPr(pr) });
  }

  if (!team) {
    throw new PrStateError("Missing --team when --state-dir is not provided", {
      code: "usage",
      exitCode: 30
    });
  }
  const parsedPr = parseRequiredPr(pr);
  validateTeamName(team);
  return buildPrState(
    path.resolve(rootDir, ".scuba", "teams", team, "pr-feedback", `pr-${parsedPr}`),
    { team, pr: parsedPr }
  );
}

export function statePaths(state) {
  const stateDir = state.stateDir;
  return {
    state_dir: stateDir,
    config: path.join(stateDir, "config.json"),
    watcher_status: path.join(stateDir, "watcher-status.json"),
    event_log: path.join(stateDir, "events.jsonl"),
    event_index: path.join(stateDir, "event-index.json"),
    snapshots_dir: path.join(stateDir, "snapshots"),
    latest_snapshot: path.join(stateDir, "latest-snapshot.json"),
    dispositions: path.join(stateDir, "dispositions.json"),
    hardening_rounds_dir: path.join(stateDir, "hardening-rounds"),
    closeout: path.join(stateDir, "closeout.json"),
    push_log: path.join(stateDir, "push-log.jsonl"),
    audit_dir: path.join(stateDir, "audit"),
    lock: path.join(stateDir, "pr-feedback.lock")
  };
}

export async function acquirePrStateLock(state, {
  owner,
  mode,
  operation,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_LOCK_STALE_MS
} = {}) {
  validateOwner(owner);
  if (!mode) throw new PrStateError("Lock mode is required", { code: "usage", exitCode: 30 });
  if (!operation) throw new PrStateError("Lock operation is required", { code: "usage", exitCode: 30 });

  await ensureStateDir(state);
  const lockPath = state.paths.lock;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let staleBreak = null;

  while (true) {
    const now = new Date();
    const lockBody = {
      schema_version: PR_STATE_SCHEMA_VERSION,
      owner,
      pid: process.pid,
      hostname: os.hostname(),
      started_at: now.toISOString(),
      expires_at: new Date(now.getTime() + Math.max(1, staleMs)).toISOString(),
      mode,
      operation
    };

    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(JSON.stringify(lockBody, null, 2) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(state.stateDir);
      return {
        owner,
        mode,
        operation,
        stateDir: state.stateDir,
        lockPath,
        staleBreak,
        async release() {
          try {
            await unlink(lockPath);
            await fsyncDirectory(state.stateDir);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const broken = await maybeBreakStaleLock(lockPath, staleMs);
      if (broken) {
        staleBreak = broken;
        continue;
      }
      if (Date.now() >= deadline) throw new LockBusyError(lockPath);
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}

export async function withPrStateLock(state, options, fn) {
  const lock = await acquirePrStateLock(state, options);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

export async function writePrStateJson(state, owner, relativePath, value, options = {}) {
  assertOwnerCanWrite(owner, relativePath);
  return runStateWrite(state, owner, options, async () => {
    await writeJsonAtomic(state, relativePath, value);
  });
}

export async function writePrStateText(state, owner, relativePath, value, options = {}) {
  assertOwnerCanWrite(owner, relativePath);
  const bytes = Buffer.byteLength(value, "utf8");
  const maxBytes = options.maxBytes ?? DEFAULT_TEXT_LIMIT_BYTES;
  if (bytes > maxBytes) {
    throw new PrStateError(`Refusing to write ${bytes} bytes to ${relativePath}; limit is ${maxBytes}`, {
      code: "state_write_too_large",
      exitCode: 20
    });
  }
  return runStateWrite(state, owner, options, async () => {
    await writeTextAtomic(state, relativePath, value);
  });
}

export async function appendPrStateJsonl(state, owner, relativePath, record, options = {}) {
  assertOwnerCanWrite(owner, relativePath);
  return runStateWrite(state, owner, options, async () => {
    const target = await prepareDestination(state, relativePath);
    const handle = await open(target.path, "a", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(target.parentReal);
  });
}

export async function readOptionalJson(state, relativePath) {
  const file = path.join(state.stateDir, normalizeRelativePath(relativePath));
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CorruptStateError(file, error.message);
  }
}

export async function loadConfig(state) {
  const config = await readOptionalJson(state, "config.json");
  if (!config) return null;
  validateConfig(config, state.paths.config, state);
  return config;
}

export async function replayEvents(state) {
  const file = state.paths.event_log;
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyReplay();
    throw error;
  }

  const seenRevisions = new Set();
  const currentByEvent = new Map();
  let duplicateRevisionCount = 0;
  let lineNumber = 0;

  for (const line of text.split(/\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new CorruptStateError(file, `line ${lineNumber}: ${error.message}`);
    }

    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new CorruptStateError(file, `line ${lineNumber}: event revision is not an object`);
    }
    if (typeof event.event_id !== "string" || event.event_id.length === 0) {
      throw new CorruptStateError(file, `line ${lineNumber}: missing event_id`);
    }
    if (typeof event.event_revision_id !== "string" || event.event_revision_id.length === 0) {
      throw new CorruptStateError(file, `line ${lineNumber}: missing event_revision_id`);
    }

    if (seenRevisions.has(event.event_revision_id)) {
      duplicateRevisionCount += 1;
      continue;
    }
    seenRevisions.add(event.event_revision_id);
    currentByEvent.set(event.event_id, event);
  }

  const currentEvents = [...currentByEvent.values()].sort((a, b) => a.event_id.localeCompare(b.event_id));
  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    unique_revision_count: seenRevisions.size,
    duplicate_revision_count: duplicateRevisionCount,
    current_event_count: currentEvents.length,
    current_event_ids: currentEvents.map((event) => event.event_id),
    current_events: currentEvents
  };
}

export function eventIndexFromReplay(replay) {
  const latest_by_event_id = {};
  for (const event of replay.current_events) {
    latest_by_event_id[event.event_id] = event.event_revision_id;
  }
  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    source: "events.jsonl",
    revision_count: replay.unique_revision_count,
    duplicate_revision_count: replay.duplicate_revision_count,
    latest_by_event_id
  };
}

export function validateOwner(owner) {
  if (!OWNER_KINDS.has(owner)) {
    throw new PrStateError(`Unknown PR state owner '${owner}'`, {
      code: "owner_path_forbidden",
      exitCode: 20
    });
  }
}

export function assertOwnerCanWrite(owner, relativePath) {
  validateOwner(owner);
  const normalized = normalizeRelativePath(relativePath);
  const allowed = PR_STATE_OWNERSHIP[owner].some((entry) => {
    if (entry.endsWith("/")) return normalized.startsWith(entry) && normalized.length > entry.length;
    return normalized === entry;
  });
  if (!allowed) {
    throw new PrStateError(`${owner} cannot write ${relativePath}`, {
      code: "owner_path_forbidden",
      exitCode: 20
    });
  }
  return normalized;
}

export function normalizeRelativePath(relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new PrStateError("State path is required", {
      code: "invalid_state_path",
      exitCode: 20
    });
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new PrStateError(`State path must be relative: ${relativePath}`, {
      code: "invalid_state_path",
      exitCode: 20
    });
  }
  const parts = relativePath.split(/[\\/]+/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new PrStateError(`State path is unsafe: ${relativePath}`, {
      code: "invalid_state_path",
      exitCode: 20
    });
  }
  return parts.join("/");
}

function buildPrState(stateDir, { team = null, pr = null } = {}) {
  const state = {
    stateDir: path.resolve(stateDir),
    team,
    pr: parseOptionalPr(pr)
  };
  state.paths = statePaths(state);
  return state;
}

function parseOptionalPr(value) {
  if (value === undefined || value === null || value === "") return null;
  return parseRequiredPr(value);
}

function parseRequiredPr(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new PrStateError(`Invalid PR number '${value}'`, {
      code: "usage",
      exitCode: 30
    });
  }
  return number;
}

function validateTeamName(team) {
  if (typeof team !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(team)) {
    throw new PrStateError(`Invalid team name '${team}'`, {
      code: "usage",
      exitCode: 30
    });
  }
}

async function ensureStateDir(state) {
  await mkdir(state.stateDir, { recursive: true });
  const entry = await lstat(state.stateDir);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new PrStateError(`Invalid PR state directory: ${state.stateDir}`, {
      code: "invalid_state_path",
      file: state.stateDir,
      exitCode: 20
    });
  }
}

async function runStateWrite(state, owner, options, fn) {
  const lock = options.lock;
  if (lock) {
    assertLockGuardsState(lock, state, owner);
    return fn();
  }

  return withPrStateLock(state, {
    owner,
    mode: options.mode ?? "write",
    operation: options.operation ?? "write_state",
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
  }, fn);
}

function assertLockGuardsState(lock, state, owner) {
  if (lock.owner !== owner) {
    throw new PrStateError(`Cannot use ${lock.owner} lock for ${owner} write`, {
      code: "owner_path_forbidden",
      exitCode: 20
    });
  }

  const expectedLockPath = path.resolve(state.paths.lock);
  const actualLockPath = typeof lock.lockPath === "string" ? path.resolve(lock.lockPath) : null;
  if (actualLockPath !== expectedLockPath) {
    throw new PrStateError(`Cannot use lock from another PR state for ${owner} write`, {
      code: "lock_state_mismatch",
      file: expectedLockPath,
      exitCode: 20
    });
  }

  if (lock.stateDir && path.resolve(lock.stateDir) !== path.resolve(state.stateDir)) {
    throw new PrStateError(`Cannot use lock from another PR state for ${owner} write`, {
      code: "lock_state_mismatch",
      file: expectedLockPath,
      exitCode: 20
    });
  }
}

async function writeJsonAtomic(state, relativePath, value) {
  await writeTextAtomic(state, relativePath, JSON.stringify(value, null, 2) + "\n");
}

async function writeTextAtomic(state, relativePath, value) {
  const target = await prepareDestination(state, relativePath);
  const tempName = `.${target.name}.scuba-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempPath = path.join(target.parentReal, tempName);
  try {
    const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertDestinationSafe(target);
    await rename(tempPath, target.path);
    await fsyncDirectory(target.parentReal);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function prepareDestination(state, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  await ensureStateDir(state);
  const stateReal = await realpath(state.stateDir);
  const parts = normalized.split("/");
  const name = parts.at(-1);
  const parentParts = parts.slice(0, -1);
  let current = state.stateDir;

  for (const part of parentParts) {
    current = path.join(current, part);
    await mkdir(current).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new PrStateError(`Unsafe PR state parent: ${current}`, {
        code: "invalid_state_path",
        file: current,
        exitCode: 20
      });
    }
    const currentReal = await realpath(current);
    if (!isInsideOrSame(currentReal, stateReal)) {
      throw new PrStateError(`Unsafe PR state parent escapes state dir: ${current}`, {
        code: "invalid_state_path",
        file: current,
        exitCode: 20
      });
    }
  }

  const parentReal = await realpath(current);
  const destination = path.join(parentReal, name);
  const lexicalDestination = path.resolve(state.stateDir, ...parts);
  if (!isInsideOrSame(lexicalDestination, path.resolve(state.stateDir))) {
    throw new PrStateError(`State path escapes state dir: ${relativePath}`, {
      code: "invalid_state_path",
      exitCode: 20
    });
  }

  const target = { path: destination, parentReal, name };
  await assertDestinationSafe(target);
  return target;
}

async function assertDestinationSafe(target) {
  try {
    const entry = await lstat(target.path);
    if (!entry.isFile()) {
      throw new PrStateError(`Unsafe PR state destination is not a regular file: ${target.path}`, {
        code: "invalid_state_path",
        file: target.path,
        exitCode: 20
      });
    }
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

async function maybeBreakStaleLock(lockPath, fallbackStaleMs) {
  let raw = null;
  let stats = null;
  try {
    stats = await stat(lockPath);
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  let lock = null;
  try {
    lock = JSON.parse(raw);
  } catch {
    const expiredByMtime = Date.now() - stats.mtimeMs > fallbackStaleMs;
    if (!expiredByMtime) return null;
  }

  if (lock) {
    const expiresAt = Date.parse(lock.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) return null;
    if (lock.hostname === os.hostname() && isProcessAlive(lock.pid)) return null;
  }

  try {
    await unlink(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return {
    broken_at: new Date().toISOString(),
    previous_lock: lock ?? { corrupt_lock: true, mtime: stats.mtime.toISOString() }
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function validateConfig(config, file, state) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigurationError(file, "config must be an object");
  }
  const schemaVersion = config.schema_version ?? config.schemaVersion;
  if (schemaVersion !== PR_STATE_SCHEMA_VERSION) {
    throw new ConfigurationError(file, "schema_version must be 1");
  }
  if (typeof config.team !== "string" || config.team.length === 0) {
    throw new ConfigurationError(file, "team is required");
  }
  const configPr = config.pr_number ?? config.prNumber;
  if (!Number.isInteger(configPr) || configPr <= 0) {
    throw new ConfigurationError(file, "pr_number must be a positive integer");
  }
  if (state.team && config.team !== state.team) {
    throw new ConfigurationError(file, `team '${config.team}' does not match selected team '${state.team}'`);
  }
  if (state.pr && configPr !== state.pr) {
    throw new ConfigurationError(file, `pr_number ${configPr} does not match selected PR ${state.pr}`);
  }
  if (!validRepo(config.repo)) {
    throw new ConfigurationError(file, "repo must be 'owner/name' or { owner, name }");
  }
  if (config.quiet_period_minutes !== undefined &&
      (!Number.isFinite(config.quiet_period_minutes) || config.quiet_period_minutes <= 0)) {
    throw new ConfigurationError(file, "quiet_period_minutes must be a positive number");
  }
  if (config.expected_head_sha !== undefined &&
      (typeof config.expected_head_sha !== "string" || config.expected_head_sha.length === 0)) {
    throw new ConfigurationError(file, "expected_head_sha must be a non-empty string");
  }
  if (!validReviewerConfig(config.external_reviewer)) {
    throw new ConfigurationError(file, "external_reviewer must be a non-empty string or object");
  }
  if (config.required_check_contexts !== undefined && !stringArray(config.required_check_contexts)) {
    throw new ConfigurationError(file, "required_check_contexts must be an array of strings");
  }
  if (config.base_branch !== undefined && !nonEmptyString(config.base_branch)) {
    throw new ConfigurationError(file, "base_branch must be a non-empty string");
  }
  if (config.head_branch !== undefined && !nonEmptyString(config.head_branch)) {
    throw new ConfigurationError(file, "head_branch must be a non-empty string");
  }
}

function validRepo(repo) {
  if (typeof repo === "string") return /^[^/\s]+\/[^/\s]+$/.test(repo);
  return Boolean(repo &&
    typeof repo === "object" &&
    typeof repo.owner === "string" &&
    repo.owner.length > 0 &&
    typeof repo.name === "string" &&
    repo.name.length > 0);
}

function validReviewerConfig(reviewer) {
  if (typeof reviewer === "string") return reviewer.length > 0;
  return Boolean(reviewer && typeof reviewer === "object" && !Array.isArray(reviewer));
}

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => nonEmptyString(entry));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function emptyReplay() {
  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    unique_revision_count: 0,
    duplicate_revision_count: 0,
    current_event_count: 0,
    current_event_ids: [],
    current_events: []
  };
}

async function fsyncDirectory(dir) {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort across platforms.
  }
}

function isInsideOrSame(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
