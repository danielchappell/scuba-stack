#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const USAGE = `Usage:
  node scripts/audit-codex-jsonl.mjs <root-thread-id> [--codex-home <path>] [--out <path>] [--acceptance] [--require-subagents] [--require-subagent-metadata]
  node scripts/audit-codex-jsonl.mjs --list-recent [--codex-home <path>]

Audits Codex Desktop/CLI JSONL session logs by building a parent/subagent tree.
The default report uses operational metadata, not raw transcript or reasoning text.
Acceptance mode writes the same report, then exits nonzero for blocking proof gaps.`;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const codexHome = args.codexHome ?? path.join(os.homedir(), ".codex");
const index = await readSessionIndex(path.join(codexHome, "session_index.jsonl"));

if (args.listRecent) {
  const recent = [...index.values()]
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, 30);
  for (const item of recent) {
    console.log(`${item.updated_at ?? "unknown"}  ${item.id}  ${item.thread_name ?? ""}`);
  }
  process.exit(0);
}

if (!args.rootThreadId) {
  fail(`Missing root thread id.\n\n${USAGE}`);
}

const sessionFiles = [
  ...(await listJsonlFiles(path.join(codexHome, "sessions"))),
  ...(await listJsonlFiles(path.join(codexHome, "archived_sessions")))
];
const sessions = [];
for (const file of sessionFiles) {
  const session = await parseSessionFile(file);
  if (session.id) {
    const indexEntry = index.get(session.id);
    session.threadName = indexEntry?.thread_name ?? session.threadName ?? "";
    session.indexUpdatedAt = indexEntry?.updated_at ?? "";
    sessions.push(session);
  }
}

const byId = new Map();
for (const session of sessions) {
  const existing = byId.get(session.id);
  if (!existing || compareSessionFreshness(session, existing) > 0) {
    byId.set(session.id, session);
  }
}

const childrenByParent = new Map();
for (const session of byId.values()) {
  if (!session.parentId) continue;
  const children = childrenByParent.get(session.parentId) ?? [];
  children.push(session);
  childrenByParent.set(session.parentId, children);
}
for (const children of childrenByParent.values()) {
  children.sort((a, b) => String(a.firstTimestamp ?? "").localeCompare(String(b.firstTimestamp ?? "")));
}

const selected = collectDescendants(args.rootThreadId, byId, childrenByParent);
const report = renderReport({
  rootThreadId: args.rootThreadId,
  codexHome,
  sessions: selected,
  byId,
  childrenByParent
});

if (args.out) {
  await writeFile(args.out, report);
} else {
  process.stdout.write(report);
}

if (args.acceptance) {
  const failures = collectAcceptanceFailures({
    sessions: selected,
    rootThreadId: args.rootThreadId,
    byId,
    requireSubagents: args.requireSubagents,
    requireSubagentMetadata: args.requireSubagentMetadata
  });
  if (failures.length > 0) {
    console.error("Codex JSONL audit acceptance failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(2);
  }
}

function parseArgs(argv) {
  const parsed = {
    acceptance: false,
    codexHome: process.env.CODEX_HOME || undefined,
    help: false,
    listRecent: false,
    out: undefined,
    requireSubagents: false,
    requireSubagentMetadata: false,
    rootThreadId: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--acceptance") {
      parsed.acceptance = true;
    } else if (arg === "--list-recent") {
      parsed.listRecent = true;
    } else if (arg === "--require-subagents") {
      parsed.requireSubagents = true;
    } else if (arg === "--require-subagent-metadata") {
      parsed.requireSubagentMetadata = true;
    } else if (arg === "--codex-home") {
      parsed.codexHome = requireValue(argv, ++i, arg);
    } else if (arg === "--out") {
      parsed.out = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    } else if (!parsed.rootThreadId) {
      parsed.rootThreadId = arg;
    } else {
      fail(`Unexpected positional argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${option}`);
  }
  return value;
}

async function readSessionIndex(file) {
  const map = new Map();
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return map;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.id) map.set(item.id, item);
    } catch {
      // Ignore corrupt index lines; individual session files remain authoritative.
    }
  }
  return map;
}

async function listJsonlFiles(dir) {
  const files = [];

  async function walk(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  await walk(dir);
  return files.sort();
}

async function parseSessionFile(file) {
  const text = await readFile(file, "utf8");
  const summary = {
    file,
    id: "",
    parentId: "",
    threadName: "",
    threadSource: "",
    agentNickname: "",
    agentRole: "",
    agentPath: "",
    cwd: "",
    originator: "",
    cliVersion: "",
    source: "",
    firstTimestamp: "",
    lastTimestamp: "",
    lineCount: 0,
    parseErrors: 0,
    responseItemCounts: new Map(),
    topLevelCounts: new Map(),
    taskStarted: 0,
    taskComplete: 0,
    taskAborted: 0,
    taskDurationsMs: [],
    functionCalls: new Map(),
    customToolCalls: new Map(),
    scubaPaths: new Set(),
    worktreePaths: new Set(),
    skillReferences: new Set(),
    model: "",
    effort: "",
    collaborationMode: ""
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    summary.lineCount += 1;
    collectPathEvidence(summary, line);

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      summary.parseErrors += 1;
      continue;
    }

    increment(summary.topLevelCounts, record.type ?? "unknown");
    if (record.timestamp) {
      summary.firstTimestamp ||= record.timestamp;
      summary.lastTimestamp = record.timestamp;
    }

    if (record.type === "session_meta") {
      applySessionMeta(summary, record.payload);
    } else if (record.type === "turn_context") {
      applyTurnContext(summary, record.payload);
    } else if (record.type === "event_msg") {
      applyEventMessage(summary, record.payload);
    } else if (record.type === "response_item") {
      applyResponseItem(summary, record.payload);
    }
  }

  return summary;
}

function applySessionMeta(summary, payload = {}) {
  summary.id ||= payload.id ?? "";
  summary.parentId ||= payload.parent_thread_id ?? "";
  summary.threadSource ||= payload.thread_source ?? "";
  summary.agentNickname ||= payload.agent_nickname ?? "";
  summary.agentRole ||= payload.agent_role ?? "";
  summary.cwd ||= payload.cwd ?? "";
  summary.originator ||= payload.originator ?? "";
  summary.cliVersion ||= payload.cli_version ?? "";

  const spawn = payload.source?.subagent?.thread_spawn;
  if (spawn) {
    summary.parentId ||= spawn.parent_thread_id ?? "";
    summary.agentPath ||= spawn.agent_path ?? "";
    summary.agentNickname ||= spawn.agent_nickname ?? "";
    summary.agentRole ||= spawn.agent_role ?? "";
  }

  if (typeof payload.source === "string") {
    summary.source ||= payload.source;
  } else if (payload.source?.subagent) {
    summary.source ||= "subagent";
  }
}

function applyTurnContext(summary, payload = {}) {
  summary.model ||= payload.model ?? payload.collaboration_mode?.settings?.model ?? "";
  summary.effort ||= payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort ?? "";
  summary.collaborationMode ||= payload.collaboration_mode?.mode ?? payload.collaboration_mode?.kind ?? "";
}

function applyEventMessage(summary, payload = {}) {
  if (payload.type === "task_started") {
    summary.taskStarted += 1;
  } else if (payload.type === "task_complete") {
    summary.taskComplete += 1;
    if (payload.duration_ms != null) summary.taskDurationsMs.push(payload.duration_ms);
  } else if (payload.type === "task_aborted" || payload.type === "turn_aborted") {
    summary.taskAborted += 1;
  }
}

function applyResponseItem(summary, payload = {}) {
  const type = payload.type ?? "unknown";
  increment(summary.responseItemCounts, type);

  if (type === "function_call") {
    increment(summary.functionCalls, payload.name ?? "unknown");
  } else if (type === "custom_tool_call") {
    increment(summary.customToolCalls, payload.name ?? payload.call_id ?? "custom_tool_call");
  }
}

function collectPathEvidence(summary, line) {
  for (const match of line.matchAll(/(?:\/[^\s"'`\\]+)?\.scuba\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/g)) {
    summary.scubaPaths.add(cleanPath(match[0]));
  }
  for (const match of line.matchAll(/(?:\/[^\s"'`\\]+)?\.codex\/worktrees\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/g)) {
    summary.worktreePaths.add(cleanPath(match[0]));
  }
  for (const match of line.matchAll(/\.agents\/skills\/([A-Za-z0-9-]+)\/SKILL\.md/g)) {
    summary.skillReferences.add(match[1]);
  }
}

function cleanPath(value) {
  return value.replace(/[),.;:]+$/, "");
}

function collectDescendants(rootId, byId, childrenByParent) {
  const selected = new Map();

  function visit(id) {
    const session = byId.get(id);
    if (session) selected.set(id, session);
    for (const child of childrenByParent.get(id) ?? []) {
      if (!selected.has(child.id)) visit(child.id);
    }
  }

  visit(rootId);
  return [...selected.values()];
}

function renderReport({ rootThreadId, codexHome, sessions, byId, childrenByParent }) {
  const root = byId.get(rootThreadId);
  const lines = [];
  lines.push("# Codex JSONL Audit");
  lines.push("");
  lines.push(`- Codex home: \`${codexHome}\``);
  lines.push(`- Root thread: \`${rootThreadId}\`${root?.threadName ? ` (${root.threadName})` : ""}`);
  lines.push(`- Sessions in tree: ${sessions.length}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push("");

  if (!root) {
    lines.push("## Blocking Gap");
    lines.push("");
    lines.push(`No JSONL session file was found for root thread \`${rootThreadId}\`.`);
    lines.push("");
  }

  lines.push("## Session Tree");
  lines.push("");
  if (root) {
    renderTree(lines, root, childrenByParent, 0);
  } else {
    for (const child of childrenByParent.get(rootThreadId) ?? []) {
      renderTree(lines, child, childrenByParent, 0);
    }
  }
  lines.push("");

  lines.push("## Session Summary");
  lines.push("");
  lines.push("| Thread | Parent | Source | Agent | Tasks | Reasoning Items | Tool Calls | `.scuba` Evidence | Raw JSONL |");
  lines.push("|---|---|---|---|---:|---:|---|---:|---|");
  for (const session of sessions) {
    lines.push(`|${[
      tableCell(sessionLabel(session)),
      tableCell(session.parentId ? shortId(session.parentId) : ""),
      tableCell(session.threadSource || session.source || ""),
      tableCell(agentLabel(session)),
      taskCell(session),
      String(session.responseItemCounts.get("reasoning") ?? 0),
      tableCell(formatMap(session.functionCalls, 4) || formatMap(session.customToolCalls, 4)),
      String(session.scubaPaths.size),
      tableCell(session.file)
    ].join("|")}|`);
  }
  lines.push("");

  const gaps = collectGaps(sessions, rootThreadId, byId);
  lines.push("## Audit Gaps");
  lines.push("");
  if (gaps.length === 0) {
    lines.push("- None detected from session metadata.");
  } else {
    for (const gap of gaps) lines.push(`- ${gap}`);
  }
  lines.push("");

  lines.push("## `.scuba` Evidence");
  lines.push("");
  const allScubaPaths = uniqueSorted(sessions.flatMap((session) => [...session.scubaPaths]));
  if (allScubaPaths.length === 0) {
    lines.push("- No `.scuba` paths found in this JSONL tree.");
  } else {
    for (const item of allScubaPaths.slice(0, 80)) lines.push(`- \`${item}\``);
    if (allScubaPaths.length > 80) lines.push(`- ... ${allScubaPaths.length - 80} more`);
  }
  lines.push("");

  lines.push("## Worktree Evidence");
  lines.push("");
  const allWorktreePaths = uniqueSorted(sessions.flatMap((session) => [...session.worktreePaths]));
  if (allWorktreePaths.length === 0) {
    lines.push("- No `.codex/worktrees` paths found in this JSONL tree.");
  } else {
    for (const item of allWorktreePaths.slice(0, 80)) lines.push(`- \`${item}\``);
    if (allWorktreePaths.length > 80) lines.push(`- ... ${allWorktreePaths.length - 80} more`);
  }
  lines.push("");

  lines.push("## Skill References");
  lines.push("");
  const allSkills = uniqueSorted(sessions.flatMap((session) => [...session.skillReferences]));
  if (allSkills.length === 0) {
    lines.push("- No installed Scuba skill file references found in this JSONL tree.");
  } else {
    for (const skill of allSkills) lines.push(`- \`${skill}\``);
  }
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  lines.push("- This report intentionally avoids printing raw transcript or reasoning text. Use the raw JSONL paths above for targeted follow-up when needed.");
  lines.push("- `reasoning` counts prove reasoning records exist in the log; they are counted as audit metadata, not reproduced.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function renderTree(lines, session, childrenByParent, depth) {
  const prefix = "  ".repeat(depth);
  const details = [
    session.threadSource || session.source || "session",
    agentLabel(session),
    session.threadName
  ].filter(Boolean).join("; ");
  lines.push(`${prefix}- \`${session.id}\`${details ? ` - ${details}` : ""}`);
  for (const child of childrenByParent.get(session.id) ?? []) {
    renderTree(lines, child, childrenByParent, depth + 1);
  }
}

function collectGaps(sessions, rootThreadId, byId) {
  const gaps = [];
  if (!byId.has(rootThreadId)) {
    gaps.push(`Missing root session JSONL for \`${rootThreadId}\`.`);
  }
  for (const session of sessions) {
    if (session.parseErrors > 0) {
      gaps.push(`${shortId(session.id)} has ${session.parseErrors} JSON parse error(s).`);
    }
    if (isSubagentSession(session, rootThreadId) && !session.parentId) {
      gaps.push(`${shortId(session.id)} is a subagent session with no parent id.`);
    }
    if (isSubagentSession(session, rootThreadId) && !session.agentNickname && !session.agentRole && !session.agentPath) {
      gaps.push(`${shortId(session.id)} is a subagent session without nickname, role, or agent path metadata.`);
    }
    if (session.taskStarted > session.taskComplete + session.taskAborted) {
      gaps.push(`${shortId(session.id)} has ${session.taskStarted} task start(s) but only ${session.taskComplete} complete and ${session.taskAborted} aborted event(s).`);
    }
  }
  return gaps;
}

function collectAcceptanceFailures({ sessions, rootThreadId, byId, requireSubagents, requireSubagentMetadata }) {
  const failures = [];
  if (!byId.has(rootThreadId)) {
    failures.push(`Missing root session JSONL for \`${rootThreadId}\`.`);
  }

  const subagents = sessions.filter((session) => isSubagentSession(session, rootThreadId));
  if (requireSubagents && subagents.length === 0) {
    failures.push("No subagent session metadata was found for the requested proof claim.");
  }

  for (const session of sessions) {
    if (session.parseErrors > 0) {
      failures.push(`${shortId(session.id)} has ${session.parseErrors} JSON parse error(s).`);
    }
    if (session.taskStarted > session.taskComplete + session.taskAborted) {
      failures.push(`${shortId(session.id)} has ${session.taskStarted} task start(s) but only ${session.taskComplete} complete and ${session.taskAborted} aborted event(s).`);
    }
    if (requireSubagentMetadata && isSubagentSession(session, rootThreadId)) {
      if (!session.parentId) {
        failures.push(`${shortId(session.id)} is a subagent session with no parent id.`);
      }
      if (!session.agentNickname && !session.agentRole && !session.agentPath) {
        failures.push(`${shortId(session.id)} is a subagent session without nickname, role, or agent path metadata.`);
      }
    }
  }

  return failures;
}

function isSubagentSession(session, rootThreadId) {
  return session.id !== rootThreadId &&
    (session.threadSource === "subagent" || session.source === "subagent" || Boolean(session.parentId));
}

function sessionLabel(session) {
  const name = session.threadName ? ` ${session.threadName}` : "";
  return `${shortId(session.id)}${name}`;
}

function agentLabel(session) {
  const parts = [];
  if (session.agentNickname) parts.push(session.agentNickname);
  if (session.agentRole) parts.push(session.agentRole);
  if (session.agentPath) parts.push(session.agentPath);
  return parts.join(" / ");
}

function taskCell(session) {
  const pieces = [];
  if (session.taskStarted) pieces.push(`started ${session.taskStarted}`);
  if (session.taskComplete) pieces.push(`complete ${session.taskComplete}`);
  if (session.taskAborted) pieces.push(`aborted ${session.taskAborted}`);
  return pieces.length ? pieces.join(", ") : "";
}

function formatMap(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, value]) => `${key} x${value}`)
    .join(", ");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function tableCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function shortId(id) {
  if (!id) return "";
  return id.length > 8 ? id.slice(0, 8) : id;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function compareSessionFreshness(a, b) {
  return String(a.lastTimestamp || a.indexUpdatedAt || "").localeCompare(String(b.lastTimestamp || b.indexUpdatedAt || ""));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
