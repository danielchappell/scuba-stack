#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_BEHAVIOR_BASELINE = "3926827c74ab4adba42abfa715d130dd69860df9";
const APPROVED_CLAUDE_PROMPT_DIFFS = new Map([
  ["global-CLAUDE.md", [
    "spec-reviewer",
    "acceptance-verifier"
  ]],
  ["agents/bug-fixer.md", [
    "PR hardening round",
    "one cohesive fix commit"
  ]],
  ["agents/hunter.md", [
    "implemented code and PR diffs",
    "Edge cases are not optional"
  ]],
  ["agents/intake-drafter.md", [
    "Challenge packet",
    "must not be empty for substantive asks"
  ]],
  ["agents/steward.md", [
    "acceptance-verifier",
    "post-fix",
    "PR hardening round",
    "exactly two fresh hunters"
  ]],
  ["skills/adversarial-review/SKILL.md", [
    "Review profiles",
    "standard profile is three hunters",
    "Reaction hardening profile",
    "exactly two fresh hunters"
  ]],
  ["skills/chief-of-staff/SKILL.md", [
    "Lifecycle contract",
    "Substantive work follows the full lifecycle"
  ]],
  ["skills/intake/SKILL.md", [
    "zero-question intake",
    "challenge packet",
    "failed intake"
  ]],
  ["skills/roadmap/SKILL.md", [
    "Lifecycle event vocabulary",
    "status.md"
  ]],
  ["skills/ship-gate/SKILL.md", [
    "acceptance-verifier",
    "standard profile",
    "PR hardening rounds",
    "one cohesive fix commit"
  ]],
  ["skills/team-manager/SKILL.md", [
    "Lifecycle contract",
    "acceptance-verifier"
  ]],
  ["project-template/CLAUDE.md", [
    "Scuba Review Overrides",
    "high-risk triggers"
  ]]
]);
const tests = [];

test("neutral frontmatter and target profile mappings are valid", async () => {
  const manifests = await loadTargetManifests();

  for (const manifest of manifests) {
    assert.ok(["import", "managed-block", "manual"].includes(manifest.rootMode), `${manifest.id} has unsupported rootMode`);
    assert.ok(manifest.install?.skillDir, `${manifest.id} is missing install.skillDir`);
    assert.ok(manifest.install?.agentDir, `${manifest.id} is missing install.agentDir`);
    assert.ok(manifest.install?.hookDir, `${manifest.id} is missing install.hookDir`);
    assert.equal(manifest.toolDir, "tools", `${manifest.id} renders shared tools under tools/`);
    assert.equal(manifest.install?.toolDir, "tools", `${manifest.id} installs shared tools under target tools/`);
    assert.ok(manifest.terms?.installedSkillDir, `${manifest.id} is missing terms.installedSkillDir`);
    assert.ok(manifest.terms?.installedToolDir, `${manifest.id} is missing terms.installedToolDir`);
    if (manifest.promptDir) {
      assert.ok(manifest.install?.promptDir, `${manifest.id} promptDir requires install.promptDir`);
    }
    if (manifest.rootMode === "import") {
      assert.ok(manifest.pointerImportLine, `${manifest.id} import mode requires pointerImportLine`);
    }
    if (manifest.rootMode === "managed-block") {
      assert.ok(Array.isArray(manifest.legacyImportLines), `${manifest.id} managed-block mode requires legacyImportLines`);
    }
    if (manifest.rootMode === "manual") {
      assert.ok(Array.isArray(manifest.legacyImportLines), `${manifest.id} manual mode requires legacyImportLines`);
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

  for (const file of await skillFiles({ includeTargetSkills: true })) {
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
    assert.equal(claudeManifest.toolDir, "tools");
    assert.equal(codexManifest.toolDir, "tools");

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
      assert.match(codexText, /^model_reasoning_effort = "xhigh"$/m);
      assert.match(codexText, new RegExp(`# Scuba tool profile: ${core.tool_profile};`));
      assert.ok(!codexText.startsWith("---\n"), `${file} rendered as TOML, not Markdown`);
    }

    assert.ok(existsSync(path.join(claudeOut, "hooks", "scuba-guard.sh")));
    assert.ok(existsSync(path.join(claudeOut, "hooks", "scuba-guard.policy.md")));
    assert.ok(existsSync(path.join(codexOut, "hooks", "scuba-guard.sh")));
    assert.ok(existsSync(path.join(codexOut, "hooks", "scuba-guard.policy.md")));
    assert.ok(existsSync(path.join(claudeOut, "tools", "pr-feedback-watch.mjs")));
    assert.ok(existsSync(path.join(codexOut, "tools", "pr-feedback-watch.mjs")));
    assert.equal(
      await readFile(path.join(claudeOut, "tools", "pr-feedback-watch.mjs"), "utf8"),
      await readFile(path.join(ROOT, "tools", "pr-feedback-watch.mjs"), "utf8")
    );
    assert.equal(
      await readFile(path.join(codexOut, "tools", "pr-feedback-watch.mjs"), "utf8"),
      await readFile(path.join(ROOT, "tools", "pr-feedback-watch.mjs"), "utf8")
    );
    assert.ok(existsSync(path.join(claudeOut, "project-template", "CLAUDE.md")));
    assert.ok(existsSync(path.join(codexOut, "project-template", "AGENTS.md")));
    assert.ok(!existsSync(path.join(claudeOut, "skills", "scuba", "SKILL.md")));
    assert.ok(existsSync(path.join(codexOut, ".agents", "skills", "scuba", "SKILL.md")));
    assert.ok(!existsSync(path.join(codexOut, "prompts", "scuba.md")));
    assert.ok(!existsSync(path.join(codexOut, "scuba.md")));

    const scubaSkill = await readFile(path.join(codexOut, ".agents", "skills", "scuba", "SKILL.md"), "utf8");
    assert.match(scubaSkill, /description: Initialize the current session under Scuba Stack only when the user explicitly invokes Scuba/);
    assert.match(scubaSkill, /rest of this session/);
    assert.match(scubaSkill, /chief-of-staff\/SKILL\.md/);
    assert.match(scubaSkill, /refuses required delegation/);
    assert.match(scubaSkill, /Do not block the lead thread on long-running workers/);
    assert.match(scubaSkill, /Do not ask the user to type "continue"/);
    assert.doesNotMatch(scubaSkill, /\$ARGUMENTS/);
    assert.doesNotMatch(scubaSkill, /User request:/);
    assert.doesNotMatch(scubaSkill, /argument-hint:/);

    const claudePointer = await readFile(path.join(claudeOut, "scuba.md"), "utf8");
    assert.match(claudePointer, /`~\/\.claude\/skills\/<skill-name>\/SKILL\.md`/);
    assert.match(claudePointer, /`~\/\.claude\/skills\/chief-of-staff\/SKILL\.md`/);
  });
});

test("lifecycle hardening contracts are present in rendered prompts", async () => {
  await withTempDir("lifecycle-render", async (tmp) => {
    const out = path.join(tmp, "claude");
    await run("node", ["scripts/render-target.mjs", "claude", out]);

    const chief = await readFile(path.join(out, "skills", "chief-of-staff", "SKILL.md"), "utf8");
    assert.match(chief, /architect spec -> spec-reviewer CLEAN -> user spec go\/no-go/);
    assert.match(chief, /Tiny/);
    assert.match(chief, /High-risk/);

    const intake = await readFile(path.join(out, "skills", "intake", "SKILL.md"), "utf8");
    assert.match(intake, /Substantive intake cannot be zero-question intake/);
    assert.match(intake, /challenge packet/);
    assert.match(intake, /assumption audit/);
    assert.match(intake, /confirmation\/correction opportunity/);
    assert.match(intake, /failed intake/);

    const intakeDrafter = await readFile(path.join(out, "agents", "intake-drafter.md"), "utf8");
    assert.match(intakeDrafter, /Challenge packet/);
    assert.match(intakeDrafter, /must not be empty for substantive asks/);

    const team = await readFile(path.join(out, "skills", "team-manager", "SKILL.md"), "utf8");
    assert.match(team, /post-fix acceptance verification/);
    assert.match(team, /The user does not approve every slice plan/);

    const review = await readFile(path.join(out, "skills", "adversarial-review", "SKILL.md"), "utf8");
    assert.match(review, /Light/);
    assert.match(review, /Standard/);
    assert.match(review, /High-risk/);
    assert.match(review, /correctness\/edge cases/);
    assert.match(review, /Reaction hardening profile/);
    assert.match(review, /bug-class hunter/);
    assert.match(review, /adjacent-surface hunter/);

    const shipGate = await readFile(path.join(out, "skills", "ship-gate", "SKILL.md"), "utf8");
    assert.match(shipGate, /PR hardening rounds/);
    assert.match(shipGate, /current head SHA/);
    assert.match(shipGate, /exactly two fresh adversarial reviewers/);
    assert.match(shipGate, /one cohesive fix commit/);

    const steward = await readFile(path.join(out, "agents", "steward.md"), "utf8");
    assert.match(steward, /Run the PR hardening round/);
    assert.match(steward, /exactly two fresh hunters/);
    assert.match(steward, /whole reconciled worklist as one batch/);

    const bugFixer = await readFile(path.join(out, "agents", "bug-fixer.md"), "utf8");
    assert.match(bugFixer, /For a PR hardening round/);
    assert.match(bugFixer, /comment-by-comment conditional patches/);
    assert.match(bugFixer, /one cohesive fix commit/);

    const roadmap = await readFile(path.join(out, "skills", "roadmap", "SKILL.md"), "utf8");
    for (const event of [
      "spec.started",
      "spec.clean",
      "spec.waiting-user",
      "plan.approved",
      "acceptance.failed",
      "acceptance.clean",
      "pr.opened",
      "pr.fixing",
      "durability.pushed"
    ]) {
      assert.match(roadmap, new RegExp(escapeRegExp(event)));
    }

    for (const role of ["spec-reviewer", "plan-reviewer", "acceptance-verifier"]) {
      assert.ok(existsSync(path.join(out, "agents", `${role}.md`)), `${role} agent is rendered`);
    }

    const template = await readFile(path.join(out, "project-template", "CLAUDE.md"), "utf8");
    assert.match(template, /Scuba Review Overrides/);
  });
});

test("Claude render preserves baseline except approved lifecycle deltas", async () => {
  await withTempDir("claude-baseline", async (tmp) => {
    const out = path.join(tmp, "claude");
    await run("node", ["scripts/render-target.mjs", "claude", out]);

    await assertClaudeBaselineOrApprovedDelta(
      "global-CLAUDE.md",
      path.join(out, "scuba.md"),
      `${CLAUDE_BEHAVIOR_BASELINE}:global-CLAUDE.md`
    );

    for (const file of gitList("agents")) {
      if (!file.endsWith(".md")) continue;
      await assertClaudeBaselineOrApprovedDelta(file, path.join(out, file), `${CLAUDE_BEHAVIOR_BASELINE}:${file}`);
    }

    for (const file of gitList("skills")) {
      await assertClaudeBaselineOrApprovedDelta(file, path.join(out, file), `${CLAUDE_BEHAVIOR_BASELINE}:${file}`);
    }

    await assertClaudeBaselineOrApprovedDelta(
      "project-template/CLAUDE.md",
      path.join(out, "project-template", "CLAUDE.md"),
      `${CLAUDE_BEHAVIOR_BASELINE}:project-template/CLAUDE.md`
    );
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
    await assertCodexInstallWithInvalidHookConfig(path.join(tmp, "codex-invalid-home"));
  });
});

test("installer rejects invalid prior tool manifest entries before mutating", async () => {
  await withTempDir("install-invalid-tools", async (tmp) => {
    for (const [target, targetHome] of [
      ["claude", ".claude"],
      ["codex", ".codex"]
    ]) {
      for (const invalidEntry of ["tool:\n", "tool:/tmp/scuba-tool-escape.mjs\n", "tool:../escape.mjs\n"]) {
        const home = path.join(tmp, `${target}-${invalidEntry.replace(/[^a-z0-9]/gi, "-")}`);
        await install(target, home);
        const targetRoot = path.join(home, targetHome);
        const validStale = path.join(targetRoot, "tools", "stale-valid.mjs");
        await mkdir(path.dirname(validStale), { recursive: true });
        await writeFile(validStale, "stale\n");
        await appendFile(
          path.join(targetRoot, ".scuba-manifest"),
          `tool:stale-valid.mjs\n${invalidEntry}`
        );
        const manifestBefore = await readFile(path.join(targetRoot, ".scuba-manifest"), "utf8");

        const result = await installAllowFailure(target, home);

        assert.notEqual(result.status, 0, `${target} accepted invalid manifest entry ${JSON.stringify(invalidEntry)}`);
        assert.match(result.stderr, /Invalid tool manifest entry|invalid tool manifest entry/i);
        assert.ok(existsSync(validStale), `${target} removed valid stale tool before rejecting invalid entry`);
        assert.equal(await readFile(path.join(targetRoot, ".scuba-manifest"), "utf8"), manifestBefore);
      }
    }
  });
});

test("installer rejects unsafe current tool destinations before copying", async () => {
  await withTempDir("install-tool-containment", async (tmp) => {
    await assertUnsafeToolDestinationRejected({
      label: "codex-tool-dir-symlink",
      target: "codex",
      home: path.join(tmp, "codex-symlinked-tool-dir"),
      setup: async (home) => {
        const outside = path.join(tmp, "outside-tool-dir");
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await mkdir(outside, { recursive: true });
        await symlink(outside, path.join(home, ".codex", "tools"));
        return {
          forbiddenPath: path.join(outside, "pr-feedback-watch.mjs")
        };
      }
    });

    await assertUnsafeToolDestinationRejected({
      label: "codex-final-tool-symlink",
      target: "codex",
      home: path.join(tmp, "codex-final-symlink"),
      setup: async (home) => {
        const outside = path.join(tmp, "outside-final.mjs");
        await mkdir(path.join(home, ".codex", "tools"), { recursive: true });
        await writeFile(outside, "outside\n");
        await symlink(outside, path.join(home, ".codex", "tools", "pr-feedback-watch.mjs"));
        return {
          forbiddenPath: outside,
          forbiddenContent: "outside\n"
        };
      }
    });

    await assertUnsafeToolDestinationRejected({
      label: "codex-final-tool-directory",
      target: "codex",
      home: path.join(tmp, "codex-final-directory"),
      setup: async (home) => {
        await mkdir(path.join(home, ".codex", "tools", "pr-feedback-watch.mjs"), { recursive: true });
        return {
          forbiddenPath: path.join(home, ".codex", "tools", "pr-feedback-watch.mjs")
        };
      }
    });

    await assertUnsafeToolDestinationRejected({
      label: "codex-final-tool-fifo",
      target: "codex",
      home: path.join(tmp, "codex-final-fifo"),
      setup: async (home) => {
        const fifo = path.join(home, ".codex", "tools", "pr-feedback-watch.mjs");
        await mkdir(path.dirname(fifo), { recursive: true });
        await run("mkfifo", [fifo]);
        return {
          forbiddenPath: fifo
        };
      }
    });

    const badRoot = path.join(tmp, "bad-install-tool-dir");
    const badHome = path.join(tmp, "bad-install-tool-dir-home");
    await copyRepoFixture(badRoot);
    await mutateJsonFile(path.join(badRoot, "targets", "codex", "manifest.json"), (manifest) => {
      manifest.install.toolDir = "../outside-tools";
      return manifest;
    });
    const badInstallDirResult = await run("bash", ["install.sh", "codex"], {
      cwd: badRoot,
      env: { HOME: badHome },
      allowFailure: true
    });
    assert.notEqual(badInstallDirResult.status, 0);
    assert.match(badInstallDirResult.stderr, /Invalid tool install directory|invalid tool install directory/i);
    assert.ok(!existsSync(path.join(badHome, ".codex", ".scuba-manifest")));
  });
});

test("installer syntax and Claude hook fixture pass", async () => {
  await run("bash", ["-n", "install.sh"]);
  await run("bash", ["hooks/test-scuba-guard.sh"]);
  await run("bash", ["hooks/test-codex-scuba-guard.sh"]);
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

  const sourceSkills = await targetSkillNames("claude");
  const sourceAgents = await agentFiles();
  assert.deepEqual(await dirNames(path.join(home, ".claude", "skills")), sourceSkills);
  assert.deepEqual(await fileNames(path.join(home, ".claude", "agents")), sourceAgents);
  assert.ok(existsSync(path.join(home, ".claude", "hooks", "scuba-guard.sh")));
  assert.ok(existsSync(path.join(home, ".claude", "tools", "pr-feedback-watch.mjs")));
  await assertExecutable(path.join(home, ".claude", "tools", "pr-feedback-watch.mjs"));
  assert.ok(!existsSync(path.join(home, ".claude", "agents", "stale-agent.md")));
  assert.ok(!existsSync(path.join(home, ".claude", "skills", "stale-skill")));
  assert.ok(!existsSync(path.join(home, ".claude", "hooks", "stale-hook.sh")));
  assert.ok(!existsSync(path.join(home, ".claude", "tools", "stale-tool.mjs")));
  assert.equal(await readFile(path.join(home, ".claude", "tools", "user-tool.mjs"), "utf8"), "user\n");

  const manifest = await readManifest(path.join(home, ".claude", ".scuba-manifest"));
  assert.equal(manifest.skill, sourceSkills.length);
  assert.equal(manifest.agent, sourceAgents.length);
  assert.equal(manifest.hook, 1);
  assert.equal(manifest.tool, 1);
}

async function assertCodexInstall(home) {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "AGENTS.md"),
    "# User Codex guidance\n\n@~/.codex/scuba.md\n\n<!-- scuba-stack:start -->\nstale scuba block\n<!-- scuba-stack:end -->\n"
  );
  await writeFile(
    path.join(home, ".codex", "hooks.json"),
    JSON.stringify({
      PreToolUse: [
        {
          matcher: "^Bash$",
          hooks: [{ type: "command", command: "/usr/bin/true" }]
        }
      ]
    }, null, 2) + "\n"
  );

  await install("codex", home);
  await addStaleManifestEntries(home, "codex");
  await install("codex", home);

  const root = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
  assert.match(root, /^# User Codex guidance/m);
  assert.doesNotMatch(root, /chief-of-staff\/SKILL\.md/);
  assert.equal(count(root, "<!-- scuba-stack:start -->"), 0);
  assert.equal(count(root, "<!-- scuba-stack:end -->"), 0);
  assert.equal(count(root, "@~/.codex/scuba.md"), 0);
  assert.equal(await countMatching(path.join(home, ".codex"), /^AGENTS\.md\.scuba-bak\./), 1);

  const sourceSkills = await targetSkillNames("codex");
  const sourceAgents = (await agentFiles()).map((file) => file.replace(/\.md$/, ".toml")).sort();
  assert.deepEqual(await dirNames(path.join(home, ".agents", "skills")), sourceSkills);
  assert.deepEqual(await fileNames(path.join(home, ".codex", "agents")), sourceAgents);
  assert.deepEqual(await fileNames(path.join(home, ".codex", "prompts")), []);
  assert.ok(existsSync(path.join(home, ".agents", "skills", "scuba", "SKILL.md")));
  assert.ok(existsSync(path.join(home, ".codex", "hooks", "scuba-guard.sh")));
  assert.ok(existsSync(path.join(home, ".codex", "tools", "pr-feedback-watch.mjs")));
  await assertExecutable(path.join(home, ".codex", "tools", "pr-feedback-watch.mjs"));
  assert.ok(!existsSync(path.join(home, ".codex", "agents", "stale-agent.toml")));
  assert.ok(!existsSync(path.join(home, ".agents", "skills", "stale-skill")));
  assert.ok(!existsSync(path.join(home, ".codex", "prompts", "stale-prompt.md")));
  assert.ok(!existsSync(path.join(home, ".codex", "hooks", "stale-hook.sh")));
  assert.ok(!existsSync(path.join(home, ".codex", "tools", "stale-tool.mjs")));
  assert.equal(await readFile(path.join(home, ".codex", "tools", "user-tool.mjs"), "utf8"), "user\n");
  assert.equal(await countMatching(path.join(home, ".codex"), /^hooks\.json\.scuba-bak\./), 1);

  const scubaSkill = await readFile(path.join(home, ".agents", "skills", "scuba", "SKILL.md"), "utf8");
  assert.match(scubaSkill, /Start the rest of this session under Scuba Stack/);
  assert.match(scubaSkill, /only when the user explicitly invokes Scuba/);
  assert.ok(!existsSync(path.join(home, ".codex", "scuba.md")));

  const hooks = await readJson(path.join(home, ".codex", "hooks.json"));
  assert.equal(
    hooks.hooks.PreToolUse.filter((entry) =>
      (entry.hooks ?? []).some((hook) => (hook.command ?? "").endsWith("/scuba-guard.sh"))
    ).length,
    1
  );
  assert.equal(
    hooks.hooks.PreToolUse.filter((entry) =>
      (entry.hooks ?? []).some((hook) => hook.command === "/usr/bin/true")
    ).length,
    1
  );
  assert.equal(hooks.PreToolUse, undefined);

  const manifest = await readManifest(path.join(home, ".codex", ".scuba-manifest"));
  assert.equal(manifest.skill, sourceSkills.length);
  assert.equal(manifest.agent, sourceAgents.length);
  assert.equal(manifest.hook, 1);
  assert.equal(manifest.tool, 1);
  assert.equal(manifest.prompt ?? 0, 0);
  assert.equal(manifest["settings-hook"], 1);
}

async function assertCodexInstallWithInvalidHookConfig(home) {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "AGENTS.md"), "# User Codex guidance\n");
  await writeFile(path.join(home, ".codex", "hooks.json"), "{ not json\n");

  await install("codex", home);

  assert.equal(await readFile(path.join(home, ".codex", "hooks.json"), "utf8"), "{ not json\n");
  assert.ok(existsSync(path.join(home, ".codex", "hooks", "scuba-guard.sh")));
}

async function addStaleManifestEntries(home, target) {
  if (target === "claude") {
    await writeFile(path.join(home, ".claude", "agents", "stale-agent.md"), "stale\n");
    await mkdir(path.join(home, ".claude", "skills", "stale-skill"), { recursive: true });
    await writeFile(path.join(home, ".claude", "skills", "stale-skill", "SKILL.md"), "stale\n");
    await writeFile(path.join(home, ".claude", "hooks", "stale-hook.sh"), "stale\n");
    await mkdir(path.join(home, ".claude", "tools"), { recursive: true });
    await writeFile(path.join(home, ".claude", "tools", "stale-tool.mjs"), "stale\n");
    await writeFile(path.join(home, ".claude", "tools", "user-tool.mjs"), "user\n");
    await appendFile(
      path.join(home, ".claude", ".scuba-manifest"),
      "agent:stale-agent.md\nskill:stale-skill\nhook:stale-hook.sh\ntool:stale-tool.mjs\n"
    );
    return;
  }

  await writeFile(path.join(home, ".codex", "agents", "stale-agent.toml"), "stale\n");
  await mkdir(path.join(home, ".agents", "skills", "stale-skill"), { recursive: true });
  await writeFile(path.join(home, ".agents", "skills", "stale-skill", "SKILL.md"), "stale\n");
  await mkdir(path.join(home, ".codex", "prompts"), { recursive: true });
  await writeFile(path.join(home, ".codex", "prompts", "stale-prompt.md"), "stale\n");
  await mkdir(path.join(home, ".codex", "hooks"), { recursive: true });
  await writeFile(path.join(home, ".codex", "hooks", "stale-hook.sh"), "stale\n");
  await mkdir(path.join(home, ".codex", "tools"), { recursive: true });
  await writeFile(path.join(home, ".codex", "tools", "stale-tool.mjs"), "stale\n");
  await writeFile(path.join(home, ".codex", "tools", "user-tool.mjs"), "user\n");
  await appendFile(
    path.join(home, ".codex", ".scuba-manifest"),
    "agent:stale-agent.toml\nskill:stale-skill\nprompt:stale-prompt.md\nhook:stale-hook.sh\ntool:stale-tool.mjs\n"
  );
}

async function install(target, home) {
  await run("bash", ["install.sh", target], {
    env: { HOME: home }
  });
}

async function installAllowFailure(target, home) {
  return run("bash", ["install.sh", target], {
    env: { HOME: home },
    allowFailure: true
  });
}

async function assertUnsafeToolDestinationRejected({ label, target, home, setup }) {
  const guard = await setup(home);
  const existedBefore = guard.forbiddenPath ? existsSync(guard.forbiddenPath) : false;
  const before = guard.forbiddenPath && existsSync(guard.forbiddenPath)
    ? await readMaybeFile(guard.forbiddenPath)
    : undefined;
  const result = await installAllowFailure(target, home);

  assert.notEqual(result.status, 0, `${label} was accepted`);
  assert.match(result.stderr, /Unsafe tool destination|invalid tool install directory|refusing/i);
  if (guard.forbiddenContent !== undefined) {
    assert.equal(await readFile(guard.forbiddenPath, "utf8"), guard.forbiddenContent);
  } else if (existedBefore) {
    assert.ok(existsSync(guard.forbiddenPath), `${label} removed the existing collision node`);
    assert.equal(await readMaybeFile(guard.forbiddenPath), before);
  } else if (before === undefined) {
    assert.ok(!existsSync(guard.forbiddenPath), `${label} wrote ${guard.forbiddenPath}`);
  }
  assert.ok(!existsSync(path.join(home, target === "claude" ? ".claude" : ".codex", ".scuba-manifest")));
}

async function assertExecutable(file) {
  const stats = await lstat(file);
  assert.ok(stats.isFile(), `${file} is not a regular file`);
  assert.ok((stats.mode & 0o111) !== 0, `${file} is not executable`);
}

async function readMaybeFile(file) {
  const stats = await lstat(file);
  if (!stats.isFile()) return undefined;
  return readFile(file, "utf8");
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

async function assertFileEqualsGit(file, gitRef) {
  const actual = await readFile(file, "utf8");
  const expected = gitShow(gitRef);
  assert.equal(actual, expected, `${path.relative(ROOT, file)} diverged from ${gitRef}`);
}

async function assertClaudeBaselineOrApprovedDelta(rel, file, gitRef) {
  const actual = await readFile(file, "utf8");
  const expected = gitShow(gitRef);
  const approvedNeedles = APPROVED_CLAUDE_PROMPT_DIFFS.get(rel);
  if (!approvedNeedles) {
    assert.equal(actual, expected, `${rel} diverged from ${gitRef} without an approved prompt delta`);
    return;
  }

  assert.notEqual(actual, expected, `${rel} is marked as an approved prompt delta but did not change`);
  for (const needle of approvedNeedles) {
    assert.ok(actual.includes(needle), `${rel} approved prompt delta is missing '${needle}'`);
  }
}

function gitShow(gitRef) {
  const result = spawnSync("git", ["show", gitRef], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git show ${gitRef} exited ${result.status}\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

function gitList(prefix) {
  const result = spawnSync("git", ["ls-tree", "-r", "--name-only", CLAUDE_BEHAVIOR_BASELINE, prefix], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-tree ${prefix} exited ${result.status}\n${result.stderr.trim()}`);
  }
  return result.stdout.trim().split(/\n/).filter(Boolean);
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

async function skillFiles({ includeTargetSkills = false } = {}) {
  const files = (await skillNames()).map((name) => path.join("skills", name, "SKILL.md"));
  if (!includeTargetSkills) return files;

  const targetDir = path.join(ROOT, "targets");
  const targets = (await readdir(targetDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const targetName of targets) {
    for (const skill of await targetOnlySkillNames(targetName)) {
      files.push(path.join("targets", targetName, "skills", skill, "SKILL.md"));
    }
  }
  return files.sort();
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

async function targetSkillNames(targetName) {
  return [...new Set([...(await skillNames()), ...(await targetOnlySkillNames(targetName))])].sort();
}

async function targetOnlySkillNames(targetName) {
  const skillDir = path.join(ROOT, "targets", targetName, "skills");
  try {
    const entries = await readdir(skillDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && existsSync(path.join(skillDir, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
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

async function mutateJsonFile(file, mutate) {
  const data = JSON.parse(await readFile(file, "utf8"));
  const next = mutate(data) ?? data;
  await writeFile(file, JSON.stringify(next, null, 2) + "\n");
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
