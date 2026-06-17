#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = [];

test("neutral frontmatter and target profile mappings are valid", async () => {
  const manifests = await loadTargetManifests();

  for (const manifest of manifests) {
    assert.ok(["import", "managed-block"].includes(manifest.rootMode), `${manifest.id} has unsupported rootMode`);
    assert.ok(manifest.install?.skillDir, `${manifest.id} is missing install.skillDir`);
    assert.ok(manifest.install?.agentDir, `${manifest.id} is missing install.agentDir`);
    assert.ok(manifest.install?.hookDir, `${manifest.id} is missing install.hookDir`);
    if (manifest.rootMode === "import") {
      assert.ok(manifest.pointerImportLine, `${manifest.id} import mode requires pointerImportLine`);
    }
    if (manifest.rootMode === "managed-block") {
      assert.ok(Array.isArray(manifest.legacyImportLines), `${manifest.id} managed-block mode requires legacyImportLines`);
    }
  }

  for (const file of await agentFiles()) {
    const source = await readFile(path.join(ROOT, "agents", file), "utf8");
    const { data } = parseFrontmatter(source, `agents/${file}`);
    assert.deepEqual(Object.keys(data).sort(), [
      "description",
      "model_profile",
      "name",
      "tool_profile"
    ]);

    for (const manifest of manifests) {
      assert.ok(
        Object.hasOwn(manifest.models, data.model_profile),
        `${file} model_profile '${data.model_profile}' is not mapped by ${manifest.id}`
      );
      assert.ok(
        Object.hasOwn(manifest.toolProfiles, data.tool_profile),
        `${file} tool_profile '${data.tool_profile}' is not mapped by ${manifest.id}`
      );
    }
  }

  for (const file of await skillFiles()) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    const { data } = parseFrontmatter(source, file);
    assert.deepEqual(Object.keys(data).sort(), ["description", "name"]);
  }
});

test("neutral core prose does not leak target-specific mechanics", async () => {
  const files = [
    ...(await listMarkdownFiles(path.join(ROOT, "agents"))),
    ...(await listMarkdownFiles(path.join(ROOT, "skills"))),
    ...(await listMarkdownFiles(path.join(ROOT, "core"))),
    path.join(ROOT, "project-template", "TEMPLATE.md")
  ];
  const forbidden = [
    /\bCLAUDE\.md\b/,
    /\bAGENTS\.md\b/,
    /\bClaude\b/,
    /\bCodex\b/,
    /\bOpus\b/,
    /^tools:/m,
    /^model:\s*/m
  ];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${rel} matched forbidden core pattern ${pattern}`);
    }
  }
});

test("renderer emits the expected Claude and Codex target shapes", async () => {
  await withTempDir("render", async (tmp) => {
    const claudeOut = path.join(tmp, "claude");
    const codexOut = path.join(tmp, "codex");
    await run("node", ["scripts/render-target.mjs", "claude", claudeOut]);
    await run("node", ["scripts/render-target.mjs", "codex", codexOut]);

    const claudeManifest = await readJson(path.join(claudeOut, "target-manifest.json"));
    const codexManifest = await readJson(path.join(codexOut, "target-manifest.json"));
    assert.equal(claudeManifest.agentFormat, "claude-md");
    assert.equal(codexManifest.agentFormat, "codex-toml");

    const agents = await agentFiles();
    assert.deepEqual(
      (await readdir(path.join(claudeOut, "agents"))).sort(),
      agents
    );
    assert.deepEqual(
      (await readdir(path.join(codexOut, "agents"))).sort(),
      agents.map((file) => file.replace(/\.md$/, ".toml")).sort()
    );

    for (const file of agents) {
      const core = parseFrontmatter(
        await readFile(path.join(ROOT, "agents", file), "utf8"),
        `agents/${file}`
      ).data;

      const claude = parseFrontmatter(
        await readFile(path.join(claudeOut, "agents", file), "utf8"),
        `rendered claude ${file}`
      ).data;
      assert.equal(claude.model, claudeManifest.models[core.model_profile]);
      assert.equal(claude.tools, claudeManifest.toolProfiles[core.tool_profile].join(", "));
      assert.equal(claude.name, core.name);
      assert.equal(claude.description, core.description);
      assert.ok(!Object.hasOwn(claude, "model_profile"));
      assert.ok(!Object.hasOwn(claude, "tool_profile"));

      const codexText = await readFile(
        path.join(codexOut, "agents", file.replace(/\.md$/, ".toml")),
        "utf8"
      );
      assert.match(codexText, new RegExp(`^name = ${escapeRegExp(JSON.stringify(core.name))}$`, "m"));
      assert.match(codexText, /^developer_instructions = '''\n/m);
      assert.match(codexText, /^model = "gpt-5\.5"$/m);
      assert.match(codexText, /^model_reasoning_effort = "high"$/m);
      assert.match(codexText, new RegExp(`# Scuba tool profile: ${core.tool_profile};`));
      assert.ok(!codexText.startsWith("---\n"), `${file} rendered as TOML, not Markdown`);
    }

    assert.ok(existsSync(path.join(claudeOut, "hooks", "scuba-guard.sh")));
    assert.ok(existsSync(path.join(claudeOut, "hooks", "scuba-guard.policy.md")));
    assert.ok(existsSync(path.join(codexOut, "hooks", "README.md")));
    assert.ok(existsSync(path.join(codexOut, "hooks", "scuba-guard.policy.md")));
    assert.ok(!existsSync(path.join(codexOut, "hooks", "scuba-guard.sh")));
    assert.ok(existsSync(path.join(claudeOut, "project-template", "CLAUDE.md")));
    assert.ok(existsSync(path.join(codexOut, "project-template", "AGENTS.md")));
  });
});

test("renderer fails closed on unknown model_profile and tool_profile", async () => {
  await withTempDir("bad-render", async (tmp) => {
    const badModelRoot = path.join(tmp, "bad-model");
    await copyRepoFixture(badModelRoot);
    await replaceInFile(
      path.join(badModelRoot, "agents", "architect.md"),
      "model_profile: high_judgment",
      "model_profile: missing_model"
    );
    const badModel = await run("node", ["scripts/render-target.mjs", "claude", path.join(tmp, "out-model")], {
      cwd: badModelRoot,
      allowFailure: true
    });
    assert.notEqual(badModel.status, 0);
    assert.match(badModel.stderr, /unknown model_profile 'missing_model'/);

    const badToolRoot = path.join(tmp, "bad-tool");
    await copyRepoFixture(badToolRoot);
    await replaceInFile(
      path.join(badToolRoot, "agents", "architect.md"),
      "tool_profile: design",
      "tool_profile: missing_tool"
    );
    const badTool = await run("node", ["scripts/render-target.mjs", "claude", path.join(tmp, "out-tool")], {
      cwd: badToolRoot,
      allowFailure: true
    });
    assert.notEqual(badTool.status, 0);
    assert.match(badTool.stderr, /unknown tool_profile 'missing_tool'/);
  });
});

test("installer temp installs are surgical and idempotent for Claude and Codex", async () => {
  await withTempDir("install", async (tmp) => {
    await assertClaudeInstall(path.join(tmp, "claude-home"));
    await assertCodexInstall(path.join(tmp, "codex-home"));
  });
});

test("installer syntax and Claude hook fixture pass", async () => {
  await run("bash", ["-n", "install.sh"]);
  await run("bash", ["hooks/test-scuba-guard.sh"]);
});

function test(name, fn) {
  tests.push({ name, fn });
}

async function assertClaudeInstall(home) {
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(path.join(home, ".claude", "CLAUDE.md"), "# User Claude guidance\n");

  await install("claude", home);
  await addStaleManifestEntries(home, "claude");
  await install("claude", home);

  const root = await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8");
  assert.equal(count(root, "@~/.claude/scuba.md"), 1);
  assert.equal(await countMatching(path.join(home, ".claude"), /^CLAUDE\.md\.scuba-bak\./), 1);

  const sourceSkills = await skillNames();
  const sourceAgents = await agentFiles();
  assert.deepEqual(await dirNames(path.join(home, ".claude", "skills")), sourceSkills);
  assert.deepEqual(await fileNames(path.join(home, ".claude", "agents")), sourceAgents);
  assert.ok(existsSync(path.join(home, ".claude", "hooks", "scuba-guard.sh")));
  assert.ok(!existsSync(path.join(home, ".claude", "agents", "stale-agent.md")));
  assert.ok(!existsSync(path.join(home, ".claude", "skills", "stale-skill")));
  assert.ok(!existsSync(path.join(home, ".claude", "hooks", "stale-hook.sh")));

  const manifest = await readManifest(path.join(home, ".claude", ".scuba-manifest"));
  assert.equal(manifest.skill, sourceSkills.length);
  assert.equal(manifest.agent, sourceAgents.length);
  assert.equal(manifest.hook, 1);
}

async function assertCodexInstall(home) {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "AGENTS.md"),
    "# User Codex guidance\n\n@~/.codex/scuba.md\n"
  );

  await install("codex", home);
  await addStaleManifestEntries(home, "codex");
  await install("codex", home);

  const root = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
  assert.match(root, /^# User Codex guidance/m);
  assert.equal(count(root, "<!-- scuba-stack:start -->"), 1);
  assert.equal(count(root, "<!-- scuba-stack:end -->"), 1);
  assert.equal(count(root, "@~/.codex/scuba.md"), 0);
  assert.equal(await countMatching(path.join(home, ".codex"), /^AGENTS\.md\.scuba-bak\./), 1);

  const sourceSkills = await skillNames();
  const sourceAgents = (await agentFiles()).map((file) => file.replace(/\.md$/, ".toml")).sort();
  assert.deepEqual(await dirNames(path.join(home, ".agents", "skills")), sourceSkills);
  assert.deepEqual(await fileNames(path.join(home, ".codex", "agents")), sourceAgents);
  assert.ok(!existsSync(path.join(home, ".codex", "agents", "stale-agent.toml")));
  assert.ok(!existsSync(path.join(home, ".agents", "skills", "stale-skill")));
  assert.ok(!existsSync(path.join(home, ".codex", "hooks", "stale-hook.sh")));

  const manifest = await readManifest(path.join(home, ".codex", ".scuba-manifest"));
  assert.equal(manifest.skill, sourceSkills.length);
  assert.equal(manifest.agent, sourceAgents.length);
  assert.equal(manifest.hook ?? 0, 0);
}

async function addStaleManifestEntries(home, target) {
  if (target === "claude") {
    await writeFile(path.join(home, ".claude", "agents", "stale-agent.md"), "stale\n");
    await mkdir(path.join(home, ".claude", "skills", "stale-skill"), { recursive: true });
    await writeFile(path.join(home, ".claude", "skills", "stale-skill", "SKILL.md"), "stale\n");
    await writeFile(path.join(home, ".claude", "hooks", "stale-hook.sh"), "stale\n");
    await appendFile(
      path.join(home, ".claude", ".scuba-manifest"),
      "agent:stale-agent.md\nskill:stale-skill\nhook:stale-hook.sh\n"
    );
    return;
  }

  await writeFile(path.join(home, ".codex", "agents", "stale-agent.toml"), "stale\n");
  await mkdir(path.join(home, ".agents", "skills", "stale-skill"), { recursive: true });
  await writeFile(path.join(home, ".agents", "skills", "stale-skill", "SKILL.md"), "stale\n");
  await mkdir(path.join(home, ".codex", "hooks"), { recursive: true });
  await writeFile(path.join(home, ".codex", "hooks", "stale-hook.sh"), "stale\n");
  await appendFile(
    path.join(home, ".codex", ".scuba-manifest"),
    "agent:stale-agent.toml\nskill:stale-skill\nhook:stale-hook.sh\n"
  );
}

async function install(target, home) {
  await run("bash", ["install.sh", target], {
    env: { HOME: home }
  });
}

async function readManifest(file) {
  const text = await readFile(file, "utf8");
  const counts = {};
  for (const line of text.trim().split(/\n/)) {
    const [kind] = line.split(":", 1);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

async function loadTargetManifests() {
  const targetDir = path.join(ROOT, "targets");
  const targets = (await readdir(targetDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(targets.map((target) => readJson(path.join(targetDir, target, "manifest.json"))));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function parseFrontmatter(text, file) {
  if (!text.startsWith("---\n")) {
    throw new Error(`${file} is missing frontmatter`);
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${file} has unterminated frontmatter`);
  const raw = text.slice(4, end);
  const body = text.slice(end + 5);
  const data = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) throw new Error(`${file} has unsupported frontmatter line: ${line}`);
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body };
}

async function agentFiles() {
  return (await readdir(path.join(ROOT, "agents"))).filter((file) => file.endsWith(".md")).sort();
}

async function skillFiles() {
  const names = await skillNames();
  return names.map((name) => path.join("skills", name, "SKILL.md"));
}

async function skillNames() {
  const entries = await readdir(path.join(ROOT, "skills"), { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (existsSync(path.join(ROOT, "skills", entry.name, "SKILL.md"))) names.push(entry.name);
  }
  return names.sort();
}

async function listMarkdownFiles(dir) {
  const out = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

async function dirNames(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function fileNames(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

async function countMatching(dir, pattern) {
  try {
    const entries = await readdir(dir);
    return entries.filter((entry) => pattern.test(entry)).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

async function replaceInFile(file, from, to) {
  const text = await readFile(file, "utf8");
  assert.ok(text.includes(from), `${file} did not contain ${from}`);
  await writeFile(file, text.replace(from, to));
}

async function copyRepoFixture(dest) {
  await cp(ROOT, dest, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(ROOT, source);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      return !parts.includes(".git") &&
        !parts.includes(".scuba") &&
        !parts.includes(".codex") &&
        !parts.includes(".agents") &&
        !parts.includes("node_modules") &&
        !parts.some((part) => part.startsWith("_guard_repo."));
    }
  });
}

async function withTempDir(label, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `scuba-${label}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} exited ${result.status}`,
      result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
