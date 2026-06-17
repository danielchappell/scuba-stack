#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function usage() {
  console.error("Usage: node scripts/render-target.mjs <target> <out-dir>");
  process.exit(2);
}

const [, , target, outDirArg] = process.argv;
if (!target || !outDirArg) usage();

const outDir = path.resolve(outDirArg);
const manifestPath = path.join(ROOT, "targets", target, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

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

function yamlLine(key, value) {
  return `${key}: ${value}\n`;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlLiteralMultiline(value) {
  if (value.includes("'''")) {
    throw new Error("Codex TOML renderer cannot safely emit a body containing triple single quotes");
  }
  return `'''\n${value.replace(/\n?$/, "\n")}'''`;
}

function requireProfile(map, name, label, file) {
  if (!name) throw new Error(`${file} is missing ${label}`);
  if (!(name in map)) throw new Error(`${file} uses unknown ${label} '${name}'`);
  return map[name];
}

async function renderPointer() {
  const pointer = await readFile(path.join(ROOT, "core", "pointer.md"), "utf8");
  await writeFile(path.join(outDir, manifest.pointerFile), pointer);
}

async function renderAgents() {
  const agentsOut = path.join(outDir, manifest.agentDir);
  await mkdir(agentsOut, { recursive: true });
  const files = (await readdir(path.join(ROOT, "agents"))).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const sourcePath = path.join(ROOT, "agents", file);
    const source = await readFile(sourcePath, "utf8");
    const { data, body } = parseFrontmatter(source, sourcePath);
    const model = requireProfile(manifest.models, data.model_profile, "model_profile", file);
    const tools = requireProfile(manifest.toolProfiles, data.tool_profile, "tool_profile", file);

    if (manifest.agentFormat === "claude-md") {
      const rendered =
        "---\n" +
        yamlLine("name", data.name) +
        yamlLine("description", data.description) +
        yamlLine("tools", tools.join(", ")) +
        yamlLine("model", model) +
        "---\n" +
        body;
      await writeFile(path.join(agentsOut, file), rendered);
      continue;
    }

    if (manifest.agentFormat === "codex-toml") {
      const reasoning = manifest.reasoning?.[data.model_profile];
      const rendered = [
        `name = ${tomlString(data.name)}`,
        `description = ${tomlString(data.description)}`,
        model === "inherit" ? null : `model = ${tomlString(model)}`,
        reasoning ? `model_reasoning_effort = ${tomlString(reasoning)}` : null,
        `# Scuba tool profile: ${data.tool_profile}; Codex maps this role to the ${tools} built-in posture.`,
        `developer_instructions = ${tomlLiteralMultiline(body.trimStart())}`,
        ""
      ].filter(Boolean).join("\n");
      await writeFile(path.join(agentsOut, file.replace(/\.md$/, ".toml")), rendered);
      continue;
    }

    throw new Error(`Unsupported agentFormat '${manifest.agentFormat}'`);
  }
}

async function renderSkills() {
  await cp(path.join(ROOT, "skills"), path.join(outDir, manifest.skillDir), {
    recursive: true
  });
}

async function renderHooks() {
  const hooksOut = path.join(outDir, manifest.hookDir);
  await mkdir(hooksOut, { recursive: true });
  const targetHooks = path.join(ROOT, "targets", target, "hooks");
  try {
    await cp(targetHooks, hooksOut, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const policy = await readFile(path.join(ROOT, "core", "hooks", "scuba-guard.policy.md"), "utf8");
  await writeFile(path.join(hooksOut, "scuba-guard.policy.md"), policy);

  const guard = manifest.hooks?.["scuba-guard"];
  if (guard && guard.install === false) {
    await writeFile(
      path.join(hooksOut, "README.md"),
      `# Scuba Guard\n\n${guard.reason}\n\nThe target-neutral policy is in \`scuba-guard.policy.md\`.\n`
    );
  }
}

async function renderProjectTemplate() {
  const template = await readFile(path.join(ROOT, "project-template", "TEMPLATE.md"), "utf8");
  const templateOut = path.join(outDir, "project-template");
  await mkdir(templateOut, { recursive: true });
  await writeFile(path.join(templateOut, manifest.rootInstructionFile), template);
}

async function renderManifest() {
  await writeFile(path.join(outDir, "target-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await renderManifest();
await renderPointer();
await renderSkills();
await renderAgents();
await renderHooks();
await renderProjectTemplate();
