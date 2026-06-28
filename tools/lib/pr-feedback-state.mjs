import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm
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
const LOCK_REMOVAL_CLAIM_GRACE_MS = 1000;
const LOCK_REMOVAL_CLAIM_LEASE_MS = DEFAULT_LOCK_STALE_MS;

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
  const root = path.resolve(rootDir);
  const rootRelativeParts = [".scuba", "teams", team, "pr-feedback", `pr-${parsedPr}`];
  return buildPrState(
    path.resolve(root, ...rootRelativeParts),
    { team, pr: parsedPr, rootDir: root, rootRelativeParts }
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
      lock_id: randomUUID(),
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
      const lockIdentity = lockIdentityFromLock(lockBody);
      const lockObject = {
        lock_id: lockBody.lock_id,
        lockId: lockBody.lock_id,
        lockIdentity,
        owner,
        mode,
        operation,
        stateDir: state.stateDir,
        lockPath,
        staleBreak,
        released: false,
        async release() {
          if (lockObject.released) return;
          await removeLockIfMatching(lockPath, lockIdentity, state.stateDir);
          lockObject.released = true;
        }
      };
      return lockObject;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const broken = await maybeBreakStaleLock(lockPath, staleMs, state.stateDir);
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
    const existing = await readJsonlRecords(state, relativePath);
    existing.push(record);
    await writeTextAtomic(state, relativePath, existing.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  });
}

export async function readOptionalJson(state, relativePath) {
  const read = await readOptionalStateText(state, relativePath);
  if (!read) return null;
  try {
    return JSON.parse(read.text);
  } catch (error) {
    throw new CorruptStateError(read.displayPath, error.message);
  }
}

export async function loadConfig(state) {
  const config = await readOptionalJson(state, "config.json");
  if (!config) return null;
  validateConfig(config, state.paths.config, state);
  return config;
}

export async function replayEvents(state) {
  const read = await readOptionalStateText(state, "events.jsonl");
  if (!read) return emptyReplay();
  const { text, displayPath: file } = read;

  const seenRevisions = new Map();
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

    const canonical = canonicalJson(event);
    const priorRevision = seenRevisions.get(event.event_revision_id);
    if (priorRevision !== undefined) {
      if (priorRevision !== canonical) {
        throw new CorruptStateError(file, `line ${lineNumber}: conflicting duplicate event_revision_id '${event.event_revision_id}'`);
      }
      duplicateRevisionCount += 1;
      continue;
    }
    seenRevisions.set(event.event_revision_id, canonical);
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

function buildPrState(stateDir, { team = null, pr = null, rootDir = null, rootRelativeParts = null } = {}) {
  const state = {
    stateDir: path.resolve(stateDir),
    team,
    pr: parseOptionalPr(pr),
    rootDir,
    rootRelativeParts
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
  if (state.rootDir && state.rootRelativeParts) {
    await ensureContainedStateDir(state);
    return;
  }

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

async function ensureContainedStateDir(state) {
  const root = path.resolve(state.rootDir);
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new PrStateError(`Invalid PR state root: ${root}`, {
      code: "invalid_state_path",
      file: root,
      exitCode: 20
    });
  }
  const rootReal = await realpath(root);
  let current = root;

  for (const part of state.rootRelativeParts) {
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
    if (!isInsideOrSame(currentReal, rootReal)) {
      throw new PrStateError(`Unsafe PR state parent escapes selected root: ${current}`, {
        code: "invalid_state_path",
        file: current,
        exitCode: 20
      });
    }
  }
}

async function runStateWrite(state, owner, options, fn) {
  const lock = options.lock;
  if (lock) {
    await assertLockGuardsState(lock, state, owner);
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

async function assertLockGuardsState(lock, state, owner) {
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

  if (lock.released) {
    throw new PrStateError(`Cannot use released lock for ${owner} write`, {
      code: "lock_not_held",
      file: expectedLockPath,
      exitCode: 20
    });
  }

  const current = await readLockForIdentity(expectedLockPath);
  if (!current.schemaValid || !lockIdentityMatches(current.identity, lock.lockIdentity)) {
    throw new PrStateError(`Cannot use inactive lock for ${owner} write`, {
      code: "lock_not_held",
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

async function maybeBreakStaleLock(lockPath, fallbackStaleMs, stateDir) {
  let current;
  try {
    current = await readLockForIdentity(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  if (!lockIsBreakable(current, fallbackStaleMs)) return null;
  return removeLockIfMatching(lockPath, current.identity, stateDir, {
    broken_at: new Date().toISOString(),
    previous_lock: current.report
  });
}

async function readOptionalStateText(state, relativePath) {
  const resolved = await resolveExistingStateFile(state, relativePath);
  if (!resolved) return null;
  return {
    text: await readFile(resolved.path, "utf8"),
    displayPath: resolved.displayPath
  };
}

async function resolveExistingStateFile(state, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  await ensureStateDir(state);
  const stateRoot = path.resolve(state.stateDir);
  const stateReal = await realpath(state.stateDir);
  const parts = normalized.split("/");
  const name = parts.at(-1);
  let current = state.stateDir;

  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
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

  const displayPath = path.resolve(state.stateDir, ...parts);
  if (!isInsideOrSame(displayPath, stateRoot)) {
    throw new PrStateError(`State path escapes state dir: ${relativePath}`, {
      code: "invalid_state_path",
      exitCode: 20
    });
  }

  const file = path.join(current, name);
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new PrStateError(`Unsafe PR state file: ${displayPath}`, {
      code: "invalid_state_path",
      file: displayPath,
      exitCode: 20
    });
  }
  const fileReal = await realpath(file);
  if (!isInsideOrSame(fileReal, stateReal)) {
    throw new PrStateError(`State file escapes state dir: ${displayPath}`, {
      code: "invalid_state_path",
      file: displayPath,
      exitCode: 20
    });
  }
  return { path: fileReal, displayPath };
}

async function readJsonlRecords(state, relativePath) {
  const read = await readOptionalStateText(state, relativePath);
  if (!read) return [];
  const records = [];
  let lineNumber = 0;
  for (const line of read.text.split(/\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new CorruptStateError(read.displayPath, `line ${lineNumber}: ${error.message}`);
    }
  }
  return records;
}

async function readLockForIdentity(lockPath) {
  let stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PrStateError(`Unsafe PR feedback lock: ${lockPath}`, {
      code: "invalid_state_path",
      file: lockPath,
      exitCode: 20
    });
  }

  const raw = await readFile(lockPath, "utf8");
  let lock = null;
  let parseError = null;
  try {
    lock = JSON.parse(raw);
  } catch (error) {
    parseError = error;
  }
  const schemaValid = validLockSchema(lock);
  const identity = schemaValid
    ? lockIdentityFromLock(lock, raw)
    : corruptLockIdentity(raw, stats);
  return {
    raw,
    stats,
    lock,
    parseError,
    schemaValid,
    identity,
    report: lockReport(lock, { schemaValid, stats, parseError })
  };
}

function validLockSchema(lock) {
  return Boolean(lock &&
    typeof lock === "object" &&
    !Array.isArray(lock) &&
    lock.schema_version === PR_STATE_SCHEMA_VERSION &&
    typeof lock.lock_id === "string" &&
    lock.lock_id.length > 0 &&
    OWNER_KINDS.has(lock.owner) &&
    Number.isInteger(lock.pid) &&
    typeof lock.hostname === "string" &&
    lock.hostname.length > 0 &&
    Number.isFinite(Date.parse(lock.started_at)) &&
    Number.isFinite(Date.parse(lock.expires_at)) &&
    typeof lock.mode === "string" &&
    lock.mode.length > 0 &&
    typeof lock.operation === "string" &&
    lock.operation.length > 0);
}

function lockIsBreakable(current, fallbackStaleMs) {
  if (current.schemaValid) {
    const expiresAt = Date.parse(current.lock.expires_at);
    if (expiresAt > Date.now()) return false;
    if (current.lock.hostname === os.hostname() && isProcessAlive(current.lock.pid)) return false;
    return true;
  }
  return Date.now() - current.stats.mtimeMs > fallbackStaleMs;
}

async function removeLockIfMatching(lockPath, expectedIdentity, stateDir, removedValue = true) {
  const claimPath = lockRemovalClaimPath(lockPath, expectedIdentity);
  const claimed = await claimLockRemoval(claimPath, expectedIdentity);
  if (!claimed) return null;

  try {
    let current;
    try {
      current = await readLockForIdentity(lockPath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!lockIdentityMatches(current.identity, expectedIdentity)) {
      return null;
    }
    if (!await lockRemovalClaimMatches(claimPath, claimed)) {
      return null;
    }
    await rm(lockPath, { force: true });
    await fsyncDirectory(stateDir);
    return removedValue;
  } finally {
    await releaseLockRemovalClaim(claimPath, claimed);
    await fsyncDirectory(path.dirname(claimPath));
  }
}

async function claimLockRemoval(claimPath, expectedIdentity) {
  const identityKey = lockRemovalIdentityKey(expectedIdentity);

  while (true) {
    const claim = {
      schema_version: PR_STATE_SCHEMA_VERSION,
      kind: "pr-feedback-lock-removal-claim",
      identity_key: identityKey,
      claim_id: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      claimed_at: new Date().toISOString()
    };

    try {
      const handle = await open(claimPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(JSON.stringify(claim, null, 2) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(path.dirname(claimPath));
      return claim;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const existing = await readLockRemovalClaim(claimPath);
    if (!removalClaimIsStale(existing, identityKey)) return null;
    await rm(claimPath, { force: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await fsyncDirectory(path.dirname(claimPath));
  }
}

async function readLockRemovalClaim(claimPath) {
  let stats;
  try {
    stats = await lstat(claimPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, stale: true };
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { exists: true, stats, claim: null, valid: false };
  }

  let claim = null;
  try {
    claim = JSON.parse(await readFile(claimPath, "utf8"));
  } catch {
    return { exists: true, stats, claim: null, valid: false };
  }

  return {
    exists: true,
    stats,
    claim,
    valid: validLockRemovalClaim(claim)
  };
}

function validLockRemovalClaim(claim) {
  return Boolean(claim &&
    typeof claim === "object" &&
    !Array.isArray(claim) &&
    claim.schema_version === PR_STATE_SCHEMA_VERSION &&
    claim.kind === "pr-feedback-lock-removal-claim" &&
    typeof claim.identity_key === "string" &&
    /^[a-f0-9]{32}$/.test(claim.identity_key) &&
    (claim.claim_id === undefined || (typeof claim.claim_id === "string" && claim.claim_id.length > 0)) &&
    Number.isInteger(claim.pid) &&
    typeof claim.hostname === "string" &&
    claim.hostname.length > 0 &&
    Number.isFinite(Date.parse(claim.claimed_at)));
}

function removalClaimIsStale(existing, identityKey) {
  if (!existing.exists) return true;
  const ageMs = Date.now() - existing.stats.mtimeMs;
  if (!existing.valid) return ageMs > LOCK_REMOVAL_CLAIM_GRACE_MS;

  const claim = existing.claim;
  if (claim.identity_key !== identityKey) return true;
  if (removalClaimLeaseExpired(existing)) return true;
  if (claim.hostname === os.hostname()) return !isProcessAlive(claim.pid);
  return false;
}

function removalClaimLeaseExpired(existing) {
  const now = Date.now();
  const claimedAtMs = Date.parse(existing.claim.claimed_at);
  if (!Number.isFinite(claimedAtMs)) return true;
  if (claimedAtMs - now > LOCK_REMOVAL_CLAIM_GRACE_MS) return true;
  if (now - claimedAtMs > LOCK_REMOVAL_CLAIM_LEASE_MS) return true;
  return now - existing.stats.mtimeMs > LOCK_REMOVAL_CLAIM_LEASE_MS;
}

async function lockRemovalClaimMatches(claimPath, expectedClaim) {
  const current = await readLockRemovalClaim(claimPath);
  if (!current.valid) return false;
  return current.claim.identity_key === expectedClaim.identity_key &&
    current.claim.claim_id === expectedClaim.claim_id &&
    current.claim.pid === expectedClaim.pid &&
    current.claim.hostname === expectedClaim.hostname &&
    current.claim.claimed_at === expectedClaim.claimed_at;
}

async function releaseLockRemovalClaim(claimPath, expectedClaim) {
  if (!await lockRemovalClaimMatches(claimPath, expectedClaim)) return;
  await rm(claimPath, { force: true }).catch(() => {});
}

function lockRemovalClaimPath(lockPath, expectedIdentity) {
  return path.join(path.dirname(lockPath), `.pr-feedback.lock.remove-${lockRemovalIdentityKey(expectedIdentity)}.claim`);
}

function lockRemovalIdentityKey(expectedIdentity) {
  return sha256(canonicalJson(expectedIdentity)).slice(0, 32);
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

function corruptLockIdentity(raw, stats) {
  return {
    schema_valid: false,
    content_sha256: sha256(raw),
    size: stats.size,
    mtime_ms: stats.mtimeMs
  };
}

function lockIdentityMatches(actual, expected) {
  if (!actual || !expected) return false;
  if (actual.schema_valid !== expected.schema_valid) return false;
  if (actual.content_sha256 !== expected.content_sha256) return false;
  if (expected.schema_valid) {
    return actual.lock_id === expected.lock_id &&
      actual.owner === expected.owner &&
      actual.started_at === expected.started_at;
  }
  return actual.size === expected.size && actual.mtime_ms === expected.mtime_ms;
}

function lockReport(lock, { schemaValid, stats, parseError }) {
  const report = {
    schema_valid: schemaValid,
    corrupt_lock: !schemaValid,
    mtime: stats.mtime.toISOString()
  };
  if (parseError) report.parse_error = parseError.message;
  if (lock && typeof lock === "object" && !Array.isArray(lock)) {
    for (const key of ["schema_version", "lock_id", "owner", "pid", "hostname", "started_at", "expires_at", "mode", "operation"]) {
      if (lock[key] !== undefined) report[key] = lock[key];
    }
  }
  return report;
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
