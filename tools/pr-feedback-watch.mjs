#!/usr/bin/env node

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ConfigurationError,
  ConfigurationMissingError,
  CorruptStateError,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LockBusyError,
  MAX_LOCK_DURATION_MS,
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

const GITHUB_HOSTNAME = "github.com";
const MERGEABILITY_MAX_ATTEMPTS = 5;
const DEFAULT_MERGEABILITY_RETRY_DELAY_MS = 250;
const GH_COMMAND_TIMEOUT_MS = envPositiveInteger("SCUBA_GH_COMMAND_TIMEOUT_MS", 10_000);
const GH_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DIAGNOSTIC_LIMIT_CHARS = 500;

const USAGE = `Usage: pr-feedback-watch.mjs <snapshot|poll|replay|status> [options]

Modes:
  status   Read local watcher status and closeout summary without GitHub.
  replay   Rebuild current event state from canonical events.jsonl.
  snapshot Collect one authenticated GitHub PR evidence snapshot.
  poll     Recognized for later watcher slices; no terminal polling yet.

State selection:
  --state-dir <dir>         Use an explicit PR state directory.
  --team <team> --pr <n>    Use .scuba/teams/<team>/pr-feedback/pr-<n>/.

Snapshot options:
  --mergeability-retry-delay-ms <n>
                            Delay between UNKNOWN mergeability retries. Default: ${DEFAULT_MERGEABILITY_RETRY_DELAY_MS}.

Lock options:
  --lock-timeout-ms <n>     Bounded lock wait. Default: ${DEFAULT_LOCK_TIMEOUT_MS}.
  --lock-stale-ms <n>       Lock expiry window. Default: ${DEFAULT_LOCK_STALE_MS}.
`;

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  const attemptedMode = attemptedModeFromArgs(process.argv.slice(2));
  process.stderr.write(`${error.message}\n\n${USAGE}`);
  writeSummary({
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode: attemptedMode,
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
  } else if (command === "snapshot") {
    process.exitCode = await runSnapshot(options);
  } else if (command === "poll") {
    resolveStateFromOptions(options);
    process.stderr.write("pr-feedback-watch.mjs poll is recognized but terminal polling is not implemented in S03.\n");
    writeSummary({
      schema_version: PR_STATE_SCHEMA_VERSION,
      mode: command,
      status: "not_implemented",
      reason: "mode_not_implemented_in_s03",
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
    let watcherStatus = validateWatcherStatus(
      await readOptionalJson(state, "watcher-status.json"),
      state.paths.watcher_status
    );
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
    const closeout = validateCloseout(
      await readOptionalJson(state, "closeout.json"),
      state.paths.closeout
    );
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

async function runSnapshot(options) {
  const state = resolveStateFromOptions(options);
  let lock;
  let config = null;

  try {
    lock = await acquireWatcherLock(state, "snapshot", options);
    config = await requireSnapshotConfig(state);
    validateSnapshotConfig(config);
    await replayEvents(state);

    await assertGhAuthenticated();

    const snapshotResult = await collectSnapshot(config, options);
    await writeSnapshotState(state, lock, snapshotResult, {
      status: "snapshot_collected",
      reason: null,
      exitCode: 0
    });

    writeSummary(snapshotSummary(state, config, snapshotResult, {
      status: "snapshot_collected",
      reason: null,
      exitCode: 0
    }));
    return 0;
  } catch (error) {
    if (error.code === "mergeability_unknown" && error.snapshotResult) {
      await writeSnapshotState(state, lock, error.snapshotResult, {
        status: "blocked_mergeability_unknown",
        reason: "mergeability_unknown",
        exitCode: 20,
        error,
        updateLatest: false
      }).catch((statusError) => {
        process.stderr.write(`Failed to write blocked mergeability snapshot state: ${statusError.message}\n`);
      });
      process.stderr.write(`${error.message}\n`);
      writeSummary(snapshotSummary(state, config, error.snapshotResult, {
        status: "blocked_mergeability_unknown",
        reason: "mergeability_unknown",
        exitCode: 20,
        error
      }));
      return 20;
    }
    return await handleSnapshotError(error, state, lock, config);
  } finally {
    if (lock) await lock.release();
  }
}

async function requireSnapshotConfig(state) {
  const config = await loadConfig(state);
  if (!config) {
    throw new PrStateError(`Missing PR feedback config: ${state.paths.config}`, {
      code: "configuration_missing",
      file: state.paths.config,
      exitCode: 20
    });
  }
  return config;
}

function validateSnapshotConfig(config) {
  const required = new Set((config.required_check_contexts ?? []).map((context) => context.trim()));
  const reviewerContexts = reviewerCheckIdentities(config.external_reviewer);
  const overlap = [...reviewerContexts].filter((identity) => required.has(identity));
  if (overlap.length > 0) {
    throw new ConfigurationError(
      "config.json",
      `external reviewer check identity also configured as required non-reviewer check: ${overlap.join(", ")}`
    );
  }
}

function reviewerCheckIdentities(reviewer) {
  const identities = new Set();
  if (typeof reviewer === "string" && reviewer.trim()) identities.add(reviewer.trim());
  if (plainObject(reviewer)) {
    for (const key of ["check_context", "context", "name", "login", "username", "app_slug", "slug"]) {
      const value = reviewer[key];
      if (typeof value === "string" && value.trim()) identities.add(value.trim());
    }
  }
  return identities;
}

async function runGh(args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const child = spawn("gh", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(githubError("gh_command_timeout", `gh command timed out after ${GH_COMMAND_TIMEOUT_MS}ms`, {
        status: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        args
      }));
    }, GH_COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const captured = appendBounded(stdout, chunk);
      stdout = captured.value;
      stdoutTruncated = stdoutTruncated || captured.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const captured = appendBounded(stderr, chunk);
      stderr = captured.value;
      stderrTruncated = stderrTruncated || captured.truncated;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = error.code === "ENOENT" ? "gh_unavailable" : "gh_spawn_failed";
      reject(githubError(code, `Unable to execute gh: ${error.message}`, {
        status: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        args
      }));
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        args
      });
    });
  });
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= GH_OUTPUT_LIMIT_BYTES) {
    return { value: next, truncated: false };
  }
  return {
    value: Buffer.from(next, "utf8").subarray(0, GH_OUTPUT_LIMIT_BYTES).toString("utf8"),
    truncated: true
  };
}

async function assertGhAuthenticated() {
  const result = await runGh(["auth", "status", "--hostname", GITHUB_HOSTNAME]);
  if (result.status !== 0) {
    throw githubError("auth_failed", "gh auth status failed", result);
  }
}

async function collectSnapshot(config, options) {
  const startedAt = new Date().toISOString();
  const attempts = [];
  const retryDelayMs = options.mergeabilityRetryDelayMs ?? DEFAULT_MERGEABILITY_RETRY_DELAY_MS;
  let normalized = null;

  for (let attempt = 1; attempt <= MERGEABILITY_MAX_ATTEMPTS; attempt += 1) {
    const response = await readSinglePrGraphql(config);
    normalized = normalizePrSnapshotResponse(response, config, attempt, attempts);
    attempts.push({
      attempt,
      head_sha: normalized.head_sha,
      mergeable: normalized.mergeability.mergeable,
      merge_state_status: normalized.mergeability.merge_state_status,
      observed_at: normalized.collected_at
    });

    if (!mergeabilityIsUnknown(normalized.mergeability)) break;
    if (attempt < MERGEABILITY_MAX_ATTEMPTS && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  if (!normalized) {
    throw githubError("malformed_github_data", "GitHub response did not produce a PR snapshot");
  }

  normalized.mergeability.attempts = attempts.length;
  normalized.mergeability.retry_budget = MERGEABILITY_MAX_ATTEMPTS;
  normalized.mergeability.attempt_history = attempts;
  normalized.started_at = startedAt;
  normalized.completed_at = new Date().toISOString();
  normalized.timing.started_at = normalized.started_at;
  normalized.timing.completed_at = normalized.completed_at;
  normalized.snapshot_id = snapshotId(normalized);

  if (mergeabilityIsUnknown(normalized.mergeability)) {
    const error = new PrStateError("GitHub mergeability remained UNKNOWN after the retry budget", {
      code: "mergeability_unknown",
      exitCode: 20
    });
    error.snapshotResult = normalized;
    throw error;
  }

  return normalized;
}

async function readSinglePrGraphql(config) {
  const repo = repoParts(config.repo);
  const prNumber = config.pr_number ?? config.prNumber;
  const result = await runGh([
    "api",
    "graphql",
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
    "-F",
    `number=${prNumber}`,
    "-f",
    `query=${singlePrQuery()}`
  ]);

  if (result.status !== 0) {
    throw classifyGhCommandFailure(result);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw githubError("malformed_github_data", `GitHub API returned malformed JSON: ${error.message}`, result);
  }

  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  if (errors.length > 0) {
    throw graphqlErrorsFailure(errors, result, parsed);
  }

  return parsed;
}

function singlePrQuery() {
  return `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        id
        name
        owner { login }
        defaultBranchRef { name target { oid } }
        url
        pullRequest(number: $number) {
          id
          databaseId
          number
          state
          isDraft
          title
          url
          author { login }
          baseRefName
          baseRefOid
          headRefName
          headRefOid
          createdAt
          updatedAt
          mergeable
          mergeStateStatus
          statusCheckRollup {
            contexts(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                __typename
                ... on CheckRun {
                  databaseId
                  name
                  status
                  conclusion
                  url
                  detailsUrl
                  startedAt
                  completedAt
                  checkSuite {
                    workflowRun { headSha }
                    app {
                      databaseId
                      slug
                      name
                      owner { login }
                    }
                  }
                }
                ... on StatusContext {
                  id
                  context
                  state
                  targetUrl
                  createdAt
                  updatedAt
                  creator { login }
                }
              }
            }
          }
        }
      }
      rateLimit {
        limit
        remaining
        resetAt
        used
      }
    }
  `;
}

function normalizePrSnapshotResponse(response, config, attempt, priorAttempts) {
  const repoConfig = repoParts(config.repo);
  const data = response?.data;
  if (!plainObject(data)) {
    throw githubError("malformed_github_data", "GitHub response missing data object", null, response);
  }

  const repository = data.repository;
  if (repository === null) {
    throw githubError("repo_not_found", `Repository not found: ${repoConfig.owner}/${repoConfig.name}`, null, response);
  }
  if (!plainObject(repository)) {
    throw githubError("malformed_github_data", "GitHub response missing repository object", null, response);
  }
  const repositoryOwner = requireString(repository.owner?.login, "repository.owner.login");
  const repositoryName = requireString(repository.name, "repository.name");
  if (repositoryOwner !== repoConfig.owner || repositoryName !== repoConfig.name) {
    throw githubError("malformed_github_data", "GitHub repository identity did not match config", null, response);
  }

  const pr = repository.pullRequest;
  if (pr === null) {
    throw githubError("pr_not_found", `Pull request not found: ${repoConfig.owner}/${repoConfig.name}#${config.pr_number ?? config.prNumber}`, null, response);
  }
  if (!plainObject(pr)) {
    throw githubError("malformed_github_data", "GitHub response missing pullRequest object", null, response);
  }

  const headSha = requireString(pr.headRefOid, "pullRequest.headRefOid");
  if (config.expected_head_sha !== undefined && config.expected_head_sha !== headSha) {
    const error = new PrStateError(`Snapshot head ${headSha} does not match expected head ${config.expected_head_sha}`, {
      code: "blocked_stale_head",
      exitCode: 20
    });
    error.expectedHeadSha = config.expected_head_sha;
    error.actualHeadSha = headSha;
    throw error;
  }
  const baseOid = optionalString(pr.baseRefOid);
  const collectedAt = new Date().toISOString();
  const requiredContexts = config.required_check_contexts ?? [];
  const normalizedContexts = normalizeCheckContexts(pr.statusCheckRollup, headSha);
  const checkAggregate = aggregateChecks(requiredContexts, normalizedContexts);
  const prNumber = requireNumber(pr.number, "pullRequest.number");
  if (prNumber !== (config.pr_number ?? config.prNumber)) {
    throw githubError("malformed_github_data", "GitHub pullRequest number did not match config", null, response);
  }

  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode: "snapshot",
    snapshot_id: null,
    status: "snapshot_collected",
    reason: null,
    source: {
      adapter: "gh",
      hostname: GITHUB_HOSTNAME,
      read: "single_pr_graphql",
      attempt
    },
    team: config.team,
    repo: `${repoConfig.owner}/${repoConfig.name}`,
    repository: {
      owner: repositoryOwner,
      name: repositoryName,
      id: optionalString(repository.id),
      default_branch: optionalString(repository.defaultBranchRef?.name),
      default_branch_oid: optionalString(repository.defaultBranchRef?.target?.oid),
      url: optionalString(repository.url)
    },
    pr: {
      number: prNumber,
      node_id: requireString(pr.id, "pullRequest.id"),
      database_id: optionalNumber(pr.databaseId),
      state: requireString(pr.state, "pullRequest.state"),
      is_draft: requireBoolean(pr.isDraft, "pullRequest.isDraft"),
      title: optionalString(pr.title),
      url: requireString(pr.url, "pullRequest.url"),
      author: {
        login: requireString(pr.author?.login, "pullRequest.author.login")
      },
      base: {
        ref: requireString(pr.baseRefName, "pullRequest.baseRefName"),
        oid: baseOid
      },
      head: {
        ref: requireString(pr.headRefName, "pullRequest.headRefName"),
        oid: headSha
      },
      created_at: requireTimestamp(pr.createdAt, "pullRequest.createdAt"),
      updated_at: requireTimestamp(pr.updatedAt, "pullRequest.updatedAt")
    },
    head_sha: headSha,
    mergeability: {
      source: "single_pr_graphql",
      mergeable: pr.mergeable ?? null,
      merge_state_status: pr.mergeStateStatus ?? null,
      attempts: priorAttempts.length + 1,
      retry_budget: MERGEABILITY_MAX_ATTEMPTS,
      attempt_history: [],
      observed_at: collectedAt
    },
    checks: {
      source: "statusCheckRollup",
      aggregate: checkAggregate.aggregate,
      required_contexts: [...requiredContexts],
      missing_required_contexts: checkAggregate.missing,
      contexts: normalizedContexts
    },
    github: {
      rate_limit: normalizeRateLimit(data.rateLimit),
      api_errors: normalizeApiErrors(response.errors)
    },
    timing: {
      collected_at: collectedAt,
      started_at: null,
      completed_at: null
    },
    collected_at: collectedAt,
    started_at: null,
    completed_at: null
  };
}

function normalizeCheckContexts(statusCheckRollup, headSha) {
  if (!plainObject(statusCheckRollup) || !plainObject(statusCheckRollup.contexts)) {
    throw githubError("malformed_github_data", "GitHub response missing complete statusCheckRollup contexts");
  }
  if (statusCheckRollup.contexts.pageInfo?.hasNextPage === true) {
    throw githubError("github_collection_incomplete", "GitHub statusCheckRollup collection is incomplete");
  }
  const nodes = statusCheckRollup.contexts.nodes;
  if (!Array.isArray(nodes)) {
    throw githubError("malformed_github_data", "GitHub response statusCheckRollup contexts.nodes must be an array");
  }

  return nodes
    .map((node) => normalizeCheckContext(node, headSha))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.source_kind.localeCompare(b.source_kind));
}

function normalizeCheckContext(node, headSha) {
  if (!plainObject(node)) throw githubError("malformed_github_data", "GitHub statusCheckRollup node must be an object");
  if (node.__typename === "CheckRun") {
    const contextHeadSha = optionalString(node.checkSuite?.workflowRun?.headSha);
    const name = optionalString(node.name);
    if (!name) throw githubError("malformed_github_data", "GitHub CheckRun missing name");
    const isCurrentHead = !contextHeadSha || contextHeadSha === headSha;
    return {
      source_kind: "check_run",
      id: optionalNumber(node.databaseId),
      name,
      context: name,
      status: normalizeUpper(node.status),
      conclusion: normalizeUpper(node.conclusion),
      state: checkRunGateState(node),
      app: normalizeApp(node.checkSuite?.app),
      source: normalizeApp(node.checkSuite?.app),
      url: optionalString(node.detailsUrl) ?? optionalString(node.url),
      started_at: optionalTimestamp(node.startedAt),
      completed_at: optionalTimestamp(node.completedAt),
      head_sha: contextHeadSha ?? headSha,
      is_current_head: isCurrentHead
    };
  }

  if (node.__typename === "StatusContext") {
    const context = optionalString(node.context);
    if (!context) return null;
    return {
      source_kind: "status_context",
      id: optionalString(node.id),
      name: context,
      context,
      status: normalizeUpper(node.state),
      conclusion: null,
      state: statusContextGateState(node),
      app: null,
      source: {
        login: optionalString(node.creator?.login)
      },
      url: optionalString(node.targetUrl),
      started_at: optionalTimestamp(node.createdAt),
      completed_at: optionalTimestamp(node.updatedAt),
      head_sha: headSha,
      is_current_head: true
    };
  }

  throw githubError("malformed_github_data", `Unsupported GitHub statusCheckRollup node type: ${node.__typename}`);
}

function aggregateChecks(requiredContexts, contexts) {
  if (!requiredContexts || requiredContexts.length === 0) {
    return {
      aggregate: "checks_not_required",
      missing: []
    };
  }

  const byName = new Map();
  for (const context of contexts.filter((entry) => entry.is_current_head)) {
    const key = context.context ?? context.name;
    const prior = byName.get(key);
    if (!prior || checkSeverity(context.state) > checkSeverity(prior.state)) {
      byName.set(key, context);
    }
  }

  const missing = requiredContexts.filter((context) => !byName.has(context));
  if (missing.length > 0) {
    return {
      aggregate: "checks_missing",
      missing
    };
  }

  const required = requiredContexts.map((context) => byName.get(context));
  if (required.some((context) => context.state === "failed")) return { aggregate: "checks_failed", missing: [] };
  if (required.some((context) => context.state === "pending")) return { aggregate: "checks_pending", missing: [] };
  return { aggregate: "checks_green", missing: [] };
}

function checkRunGateState(node) {
  const conclusion = normalizeUpper(node.conclusion);
  const status = normalizeUpper(node.status);
  if (status && status !== "COMPLETED") return "pending";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "green";
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion)) return "failed";
  if (!conclusion) return "pending";
  return "failed";
}

function statusContextGateState(node) {
  const state = normalizeUpper(node.state);
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) return "green";
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(state)) return "failed";
  return "pending";
}

function checkSeverity(state) {
  if (state === "failed") return 3;
  if (state === "pending") return 2;
  if (state === "green") return 1;
  return 0;
}

async function writeSnapshotState(state, lock, snapshotResult, {
  status,
  reason,
  exitCode,
  error = null,
  updateLatest = true
}) {
  snapshotResult.status = status;
  snapshotResult.reason = reason;
  snapshotResult.timing.started_at = snapshotResult.started_at;
  snapshotResult.timing.completed_at = snapshotResult.completed_at;

  await writePrStateJson(state, "watcher", `snapshots/${snapshotResult.snapshot_id}.json`, snapshotResult, {
    lock,
    operation: "write_snapshot"
  });
  if (updateLatest) {
    await writePrStateJson(state, "watcher", "latest-snapshot.json", snapshotResult, {
      lock,
      operation: "write_latest_snapshot"
    });
  }
  await writePrStateJson(state, "watcher", "watcher-status.json", watcherStatusRecord({
    mode: "snapshot",
    status,
    reason,
    exitCode,
    error,
    staleLockBreak: lock.staleBreak,
    lastSuccessfulSnapshotId: status === "snapshot_collected"
      ? snapshotResult.snapshot_id
      : await previousSuccessfulSnapshotId(state)
  }), {
    lock,
    operation: "write_watcher_status"
  });
}

async function handleSnapshotError(error, state, lock, config) {
  const exitCode = exitCodeForError(error);
  const reason = reasonForError(error);
  process.stderr.write(`${error.message}\n`);

  if (lock && reason !== "lock_busy") {
    await writePrStateJson(state, "watcher", "watcher-status.json", watcherStatusRecord({
      mode: "snapshot",
      status: statusForSnapshotFailure(reason),
      reason,
      exitCode,
      error,
      staleLockBreak: lock.staleBreak,
      lastSuccessfulSnapshotId: await previousSuccessfulSnapshotId(state)
    }), {
      lock,
      operation: "write_watcher_status"
    }).catch((statusError) => {
      process.stderr.write(`Failed to write watcher-status.json: ${statusError.message}\n`);
    });
  }

  writeSummary({
    ...baseSummary(state, config, {
      mode: "snapshot",
      status: statusForSnapshotFailure(reason),
      reason
    }),
    file: error.file ?? null,
    exit_code: exitCode,
    expected_head_sha: error.expectedHeadSha ?? null,
    actual_head_sha: error.actualHeadSha ?? null,
    github_error: error.githubMetadata ?? null
  });
  return exitCode;
}

function statusForSnapshotFailure(reason) {
  if (reason === "blocked_stale_head") return "blocked_stale_head";
  return "blocked_watcher_unavailable";
}

function snapshotSummary(state, config, snapshotResult, { status, reason, exitCode, error = null }) {
  return {
    ...baseSummary(state, config, {
      mode: "snapshot",
      status,
      reason
    }),
    repo: snapshotResult.repo,
    current_head_sha: snapshotResult.head_sha,
    snapshot_id: snapshotResult.snapshot_id,
    check_aggregate: snapshotResult.checks.aggregate,
    mergeability: snapshotResult.mergeability,
    exit_code: exitCode,
    github_error: error?.githubMetadata ?? null
  };
}

function classifyGhCommandFailure(result) {
  const text = `${result.stderr}\n${result.stdout}`;
  const lower = text.toLowerCase();
  if (/\b401\b|bad credentials|authentication failed|requires authentication/.test(lower)) {
    return githubError("auth_failed", "GitHub API authentication failed after auth status succeeded", result);
  }
  if (/rate.?limit|secondary rate limit|api rate limit exceeded/.test(lower)) {
    return githubError("github_rate_limited", "GitHub API rate limit prevented trusted collection", result);
  }
  if (/could not resolve host|failed to connect|connection reset|connection refused|timed out|timeout|tls|ssl|502|503|504|bad gateway|service unavailable/.test(lower)) {
    return githubError("network_error", "GitHub API network transport failed", result);
  }
  if (/\b403\b|forbidden|resource not accessible|insufficient.+scope|permission/.test(lower)) {
    return githubError("permission_denied", "GitHub API permission denied", result);
  }
  if (/repository.+not found|could not resolve to a repository/.test(lower)) {
    return githubError("repo_not_found", "GitHub repository was not found", result);
  }
  if (/pull.?request.+not found|could not resolve to a pullrequest|not found/.test(lower)) {
    return githubError("pr_not_found", "GitHub pull request was not found", result);
  }
  return githubError("network_error", "GitHub API command failed", result);
}

function graphqlErrorsFailure(errors, result, response) {
  const text = errors.map((entry) => githubErrorText(entry)).join("\n");
  const lower = text.toLowerCase();
  if (errors.some((entry) => entry?.type === "RATE_LIMITED") || /rate.?limit|secondary rate limit/.test(lower)) {
    return githubError("github_rate_limited", "GitHub API rate limit prevented trusted collection", result, response);
  }
  if (/\b401\b|bad credentials|authentication failed|requires authentication/.test(lower)) {
    return githubError("auth_failed", "GitHub API authentication failed after auth status succeeded", result, response);
  }
  if (/\b403\b|forbidden|resource not accessible|insufficient.+scope|permission/.test(lower)) {
    return githubError("permission_denied", "GitHub API permission denied", result, response);
  }
  if (/repository/.test(lower) && /not_found|not found|could not resolve/.test(lower)) {
    return githubError("repo_not_found", "GitHub repository was not found", result, response);
  }
  if (/pull.?request|pullrequest/.test(lower) && /not_found|not found|could not resolve/.test(lower)) {
    return githubError("pr_not_found", "GitHub pull request was not found", result, response);
  }
  return githubError("malformed_github_data", "GitHub GraphQL response included errors with partial data", result, response);
}

function githubErrorText(error) {
  if (typeof error === "string") return error;
  if (plainObject(error)) return JSON.stringify(error);
  return String(error);
}

function githubError(code, message, result = null, response = null) {
  const error = new PrStateError(message, {
    code,
    exitCode: 20
  });
  error.githubMetadata = {
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    stdout_truncated: Boolean(result?.stdoutTruncated),
    stderr_truncated: Boolean(result?.stderrTruncated),
    stdout_excerpt: boundedDiagnostic(result?.stdout ?? ""),
    stderr_excerpt: boundedDiagnostic(result?.stderr ?? ""),
    api_errors: normalizeApiErrors(response?.errors),
    rate_limit: normalizeRateLimit(response?.data?.rateLimit ?? response?.rateLimit)
  };
  return error;
}

function repoParts(repo) {
  if (typeof repo === "string") {
    const [owner, name] = repo.split("/");
    return { owner, name };
  }
  return {
    owner: repo.owner,
    name: repo.name
  };
}

function mergeabilityIsUnknown(mergeability) {
  const mergeable = normalizeUpper(mergeability.mergeable);
  const mergeStateStatus = normalizeUpper(mergeability.merge_state_status);
  return !mergeable ||
    !mergeStateStatus ||
    mergeable === "UNKNOWN" ||
    mergeStateStatus === "UNKNOWN";
}

function snapshotId(snapshot) {
  const time = (snapshot.completed_at ?? new Date().toISOString()).replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/u, "");
  const head = snapshot.head_sha.replace(/[^0-9A-Za-z]+/g, "").slice(0, 16);
  return `${time}-pr-${snapshot.pr.number}-${head}`;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw githubError("malformed_github_data", `GitHub response missing required string ${label}`);
  }
  return value;
}

function requireNumber(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw githubError("malformed_github_data", `GitHub response missing required number ${label}`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw githubError("malformed_github_data", `GitHub response missing required boolean ${label}`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw githubError("malformed_github_data", `GitHub response missing required timestamp ${label}`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function optionalTimestamp(value) {
  if (value === null || value === undefined) return null;
  return requireTimestamp(value, "optional timestamp");
}

function normalizeApp(app) {
  if (!plainObject(app)) return null;
  return {
    id: optionalNumber(app.databaseId),
    slug: optionalString(app.slug),
    name: optionalString(app.name),
    owner: {
      login: optionalString(app.owner?.login)
    }
  };
}

function normalizeRateLimit(rateLimit) {
  if (!plainObject(rateLimit)) return null;
  return {
    limit: optionalNumber(rateLimit.limit),
    remaining: optionalNumber(rateLimit.remaining),
    used: optionalNumber(rateLimit.used),
    reset_at: optionalTimestamp(rateLimit.resetAt)
  };
}

function normalizeApiErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((entry) => {
    if (!plainObject(entry)) return { message: boundedDiagnostic(String(entry)) };
    return {
      type: optionalString(entry.type),
      message: boundedDiagnostic(entry.message ?? githubErrorText(entry)),
      path: Array.isArray(entry.path) ? entry.path.map((part) => String(part)) : null
    };
  });
}

function normalizeUpper(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/[-\s]+/g, "_").toUpperCase();
}

async function previousSuccessfulSnapshotId(state) {
  const status = await readOptionalJson(state, "watcher-status.json").catch(() => null);
  return typeof status?.last_successful_snapshot_id === "string"
    ? status.last_successful_snapshot_id
    : null;
}

function boundedDiagnostic(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= DIAGNOSTIC_LIMIT_CHARS) return text;
  return `${text.slice(0, DIAGNOSTIC_LIMIT_CHARS)}...<truncated>`;
}

function envPositiveInteger(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
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
    else if (key === "mergeability-retry-delay-ms") options.mergeabilityRetryDelayMs = parseNonNegativeInteger(value, arg);
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
  const hasStateDir = hasOption(options, "stateDir");
  const hasTeam = hasOption(options, "team");
  const hasPr = hasOption(options, "pr");

  if (hasStateDir && (hasTeam || hasPr)) {
    throw new PrStateError("--state-dir cannot be combined with --team or --pr", {
      code: "usage",
      exitCode: 30
    });
  }
  if (hasStateDir && options.stateDir.length === 0) {
    throw new PrStateError("--state-dir must be a non-empty path", {
      code: "usage",
      exitCode: 30
    });
  }
  if (hasTeam && options.team.length === 0) {
    throw new PrStateError("--team must be a non-empty value", {
      code: "usage",
      exitCode: 30
    });
  }
  if (hasPr && options.pr.length === 0) {
    throw new PrStateError("--pr must be a non-empty value", {
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

function hasOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key);
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

function watcherStatusRecord({
  mode,
  status,
  reason = null,
  exitCode,
  error = null,
  staleLockBreak = null,
  lastSuccessfulSnapshotId = null
}) {
  const now = new Date().toISOString();
  return {
    schema_version: PR_STATE_SCHEMA_VERSION,
    mode,
    status,
    reason,
    started_at: now,
    completed_at: now,
    last_successful_snapshot_id: lastSuccessfulSnapshotId,
    last_error: error ? {
      reason: reasonForError(error),
      message: boundedDiagnostic(error.message),
      file: error.file ?? null
    } : null,
    stale_lock_break: staleLockBreak,
    exit_code: exitCode
  };
}

function reasonForError(error) {
  if (error instanceof LockBusyError || error.code === "lock_busy") return "lock_busy";
  if (error instanceof CorruptStateError || error.code === "corrupt_state") return "corrupt_state";
  if (error instanceof ConfigurationMissingError || error.code === "configuration_missing") return "configuration_missing";
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
  return parseBoundedInteger(value, label, { min: 0 });
}

function parsePositiveInteger(value, label) {
  return parseBoundedInteger(value, label, { min: 1 });
}

function parseBoundedInteger(value, label, { min }) {
  const kind = min === 0 ? "non-negative" : "positive";
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PrStateError(`${label} must be a ${kind} integer`, {
      code: "usage",
      exitCode: 30
    });
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > MAX_LOCK_DURATION_MS) {
    throw new PrStateError(`${label} must be a ${kind} safe integer no greater than ${MAX_LOCK_DURATION_MS}`, {
      code: "usage",
      exitCode: 30
    });
  }
  return number;
}

function attemptedModeFromArgs(args) {
  const [first] = args;
  if (!first || first.startsWith("-")) return null;
  return first;
}

function validateWatcherStatus(value, file) {
  if (value === null) return null;
  if (!plainObject(value)) throw new CorruptStateError(file, "watcher-status.json must be an object");
  if (value.schema_version !== PR_STATE_SCHEMA_VERSION) {
    throw new CorruptStateError(file, "watcher-status.json schema_version must be 1");
  }
  if (!nonEmptyString(value.mode)) throw new CorruptStateError(file, "watcher-status.json mode is required");
  if (!nonEmptyString(value.status)) throw new CorruptStateError(file, "watcher-status.json status is required");
  if (value.reason !== null && value.reason !== undefined && !nonEmptyString(value.reason)) {
    throw new CorruptStateError(file, "watcher-status.json reason must be null or a non-empty string");
  }
  if (!validTimestamp(value.started_at) || !validTimestamp(value.completed_at)) {
    throw new CorruptStateError(file, "watcher-status.json timestamps are required");
  }
  if (!Number.isInteger(value.exit_code) || value.exit_code < 0) {
    throw new CorruptStateError(file, "watcher-status.json exit_code must be a non-negative integer");
  }
  if (value.last_error !== null && value.last_error !== undefined && !plainObject(value.last_error)) {
    throw new CorruptStateError(file, "watcher-status.json last_error must be null or an object");
  }
  if (value.stale_lock_break !== null && value.stale_lock_break !== undefined && !plainObject(value.stale_lock_break)) {
    throw new CorruptStateError(file, "watcher-status.json stale_lock_break must be null or an object");
  }
  return value;
}

function validateCloseout(value, file) {
  if (value === null) return null;
  if (!plainObject(value)) throw new CorruptStateError(file, "closeout.json must be an object");
  if (value.schema_version !== PR_STATE_SCHEMA_VERSION) {
    throw new CorruptStateError(file, "closeout.json schema_version must be 1");
  }
  if (!nonEmptyString(value.status)) throw new CorruptStateError(file, "closeout.json status is required");
  return value;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function writeSummary(summary) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
