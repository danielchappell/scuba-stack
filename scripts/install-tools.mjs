#!/usr/bin/env node
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function usage() {
  console.error("Usage: node scripts/install-tools.mjs <validate-install-dir|validate-manifest|validate-copy-plan|remove-one|copy> ...");
  process.exit(2);
}

const [mode, ...args] = process.argv.slice(2);
if (!mode) usage();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isInsideOrSame(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitRelativePath(value, label) {
  if (!value) fail(`Invalid ${label}: empty path`);
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    fail(`Invalid ${label}: absolute path '${value}'`);
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`Invalid ${label}: unsafe path '${value}'`);
  }
  return parts;
}

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function realpathExisting(file) {
  return realpath(file);
}

async function buildToolContext(targetHome, installToolDir, { create = false } = {}) {
  const parts = splitRelativePath(installToolDir, "tool install directory");
  const homeReal = await realpathExisting(targetHome);
  const toolPath = path.resolve(targetHome, ...parts);
  if (!isInsideOrSame(toolPath, path.resolve(targetHome))) {
    fail(`Invalid tool install directory: '${installToolDir}' escapes target home`);
  }

  let current = targetHome;
  for (const part of parts) {
    current = path.join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    const resolved = entry.isSymbolicLink() ? await realpathExisting(current) : current;
    const resolvedReal = entry.isSymbolicLink() ? resolved : await realpathExisting(current);
    if (!isInsideOrSame(resolvedReal, homeReal)) {
      fail(`Invalid tool install directory: '${installToolDir}' resolves outside target home`);
    }
    const entryStat = entry.isSymbolicLink() ? await stat(current) : entry;
    if (!entryStat.isDirectory()) {
      fail(`Invalid tool install directory: '${installToolDir}' is not a directory`);
    }
  }

  if (create) await mkdir(toolPath, { recursive: true });
  if (!(await pathExists(toolPath))) {
    return { homeReal, toolPath, toolReal: toolPath };
  }

  const toolReal = await realpathExisting(toolPath);
  if (!isInsideOrSame(toolReal, homeReal)) {
    fail(`Invalid tool install directory: '${installToolDir}' resolves outside target home`);
  }
  const toolStats = await stat(toolPath);
  if (!toolStats.isDirectory()) {
    fail(`Invalid tool install directory: '${installToolDir}' is not a directory`);
  }
  return { homeReal, toolPath, toolReal };
}

async function validateParentContained(parentPath, toolReal) {
  let current = parentPath;
  const missing = [];
  while (!(await pathExists(current))) {
    missing.push(path.basename(current));
    const next = path.dirname(current);
    if (next === current) fail(`Unsafe tool destination: cannot resolve parent '${parentPath}'`);
    current = next;
  }

  const parentReal = await realpathExisting(current);
  if (!isInsideOrSame(parentReal, toolReal)) {
    fail(`Unsafe tool destination: parent '${parentPath}' resolves outside tool directory`);
  }
  const parentStats = await stat(current);
  if (!parentStats.isDirectory()) {
    fail(`Unsafe tool destination: parent '${current}' is not a directory`);
  }
  return missing;
}

function destinationFor(context, relativePath, label = "tool manifest entry") {
  const parts = splitRelativePath(relativePath, label);
  const destination = path.resolve(context.toolPath, ...parts);
  if (!isInsideOrSame(destination, path.resolve(context.toolPath))) {
    fail(`Invalid ${label}: '${relativePath}' escapes tool directory`);
  }
  return { parts, destination, normalized: parts.join("/") };
}

async function validateExistingManifestDestination(context, relativePath) {
  const { destination } = destinationFor(context, relativePath, "tool manifest entry");
  await validateParentContained(path.dirname(destination), context.toolReal);
  if (!(await pathExists(destination))) return;

  const entry = await lstat(destination);
  if (entry.isSymbolicLink()) {
    const target = await realpathExisting(destination);
    if (!isInsideOrSame(target, context.toolReal)) {
      fail(`Invalid tool manifest entry: '${relativePath}' resolves outside tool directory`);
    }
    return;
  }
  if (!entry.isFile()) {
    fail(`Invalid tool manifest entry: '${relativePath}' is not a regular file`);
  }
}

async function validateCopyDestination(context, relativePath) {
  const { destination } = destinationFor(context, relativePath, "tool destination");
  await validateParentContained(path.dirname(destination), context.toolReal);
  if (!(await pathExists(destination))) return;

  const entry = await lstat(destination);
  if (!entry.isFile()) {
    fail(`Unsafe tool destination: '${relativePath}' is not a regular file`);
  }
}

async function toolEntriesFromManifest(manifestFile) {
  if (!(await pathExists(manifestFile))) return [];
  const text = await readFile(manifestFile, "utf8");
  return text.split(/\n/).filter((line) => line.startsWith("tool:")).map((line) => line.slice("tool:".length));
}

async function listToolFiles(sourceDir) {
  const files = [];

  async function walk(dir, prefix = []) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(dir, entry.name);
      const relative = [...prefix, entry.name];
      if (entry.isDirectory()) {
        await walk(sourcePath, relative);
        continue;
      }
      if (!entry.isFile()) {
        fail(`Unsafe tool source: '${relative.join("/")}' is not a regular file`);
      }
      const normalized = relative.join("/");
      splitRelativePath(normalized, "tool source");
      files.push({ sourcePath, relative: normalized });
    }
  }

  await walk(sourceDir);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function validateManifest(targetHome, installToolDir, manifestFile) {
  const context = await buildToolContext(targetHome, installToolDir, { create: false });
  for (const entry of await toolEntriesFromManifest(manifestFile)) {
    await validateExistingManifestDestination(context, entry);
  }
}

async function validateCopyPlan(sourceDir, targetHome, installToolDir) {
  const context = await buildToolContext(targetHome, installToolDir, { create: true });
  for (const file of await listToolFiles(sourceDir)) {
    await validateCopyDestination(context, file.relative);
  }
}

async function removeOne(targetHome, installToolDir, relativePath) {
  const context = await buildToolContext(targetHome, installToolDir, { create: false });
  await validateExistingManifestDestination(context, relativePath);
  const { destination } = destinationFor(context, relativePath, "tool manifest entry");
  await rm(destination, { force: true });
}

async function hasExecutableShebang(sourcePath) {
  const handle = await open(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buffer, 0, 2, 0);
    return bytesRead === 2 && buffer.toString("utf8") === "#!";
  } finally {
    await handle.close();
  }
}

async function copyTools(sourceDir, targetHome, installToolDir) {
  const context = await buildToolContext(targetHome, installToolDir, { create: true });
  const files = await listToolFiles(sourceDir);
  for (const file of files) {
    await validateCopyDestination(context, file.relative);
  }

  for (const file of files) {
    const { destination, normalized } = destinationFor(context, file.relative, "tool destination");
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true });
    await validateParentContained(parent, context.toolReal);
    await validateCopyDestination(context, file.relative);

    const tempName = `.${path.basename(destination)}.scuba-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempPath = path.join(parent, tempName);
    try {
      await copyFile(file.sourcePath, tempPath, constants.COPYFILE_EXCL);
      await chmod(tempPath, (await hasExecutableShebang(file.sourcePath)) ? 0o755 : 0o644);
      await rename(tempPath, destination);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    process.stdout.write(`tool:${normalized}\n`);
  }
}

try {
  if (mode === "validate-install-dir") {
    if (args.length !== 2) usage();
    await buildToolContext(args[0], args[1], { create: true });
  } else if (mode === "validate-manifest") {
    if (args.length !== 3) usage();
    await validateManifest(args[0], args[1], args[2]);
  } else if (mode === "validate-copy-plan") {
    if (args.length !== 3) usage();
    await validateCopyPlan(args[0], args[1], args[2]);
  } else if (mode === "remove-one") {
    if (args.length !== 3) usage();
    await removeOne(args[0], args[1], args[2]);
  } else if (mode === "copy") {
    if (args.length !== 3) usage();
    await copyTools(args[0], args[1], args[2]);
  } else {
    usage();
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
