#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootPath = process.env.ROOT_MD;
const pointerPath = process.env.POINTER;
const legacyImportLines = parseLegacyImportLines();
const action = process.env.SCUBA_ROOT_ACTION || "install";

if (!rootPath || (action !== "remove" && !pointerPath)) {
  console.error("ROOT_MD and POINTER are required unless SCUBA_ROOT_ACTION=remove");
  process.exit(2);
}

const start = "<!-- scuba-stack:start -->";
const end = "<!-- scuba-stack:end -->";

let existing = "";
let rootExists = true;
try {
  existing = await readFile(rootPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  rootExists = false;
}

let next;
const blockPattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
if (action === "remove") {
  next = removeScubaBlockAndLegacyImports(existing, blockPattern);
} else {
  const pointer = (await readFile(pointerPath, "utf8")).trimEnd();
  const block = `${start}\n${pointer}\n${end}`;
  if (blockPattern.test(existing)) {
    next = existing.replace(blockPattern, block);
  } else {
    const withoutOldImports = legacyImportLines.length
      ? existing
          .split(/\r?\n/)
          .filter((line) => !legacyImportLines.includes(line.trim()))
          .join("\n")
          .replace(/\n+$/, "")
      : existing.replace(/\n+$/, "");
    next = withoutOldImports ? `${withoutOldImports}\n\n${block}\n` : `${block}\n`;
  }
}

if (next === existing) {
  process.exit(0);
}

await mkdir(path.dirname(rootPath), { recursive: true });
if (rootExists) {
  await copyFile(rootPath, `${rootPath}.scuba-bak.${timestamp()}`);
}
await writeFile(rootPath, next);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLegacyImportLines() {
  const rawJson = process.env.LEGACY_IMPORT_LINES_JSON;
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("LEGACY_IMPORT_LINES_JSON must be a JSON string array");
    }
    return parsed;
  }
  const single = process.env.IMPORT_LINE;
  return single ? [single] : [];
}

function removeScubaBlockAndLegacyImports(text, blockPattern) {
  const withoutBlock = text.replace(blockPattern, "").replace(/\n{3,}/g, "\n\n");
  const withoutOldImports = legacyImportLines.length
    ? withoutBlock
        .split(/\r?\n/)
        .filter((line) => !legacyImportLines.includes(line.trim()))
        .join("\n")
    : withoutBlock;
  return withoutOldImports.replace(/\n+$/, "") + (withoutOldImports.trim() ? "\n" : "");
}

function timestamp() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 17);
}
