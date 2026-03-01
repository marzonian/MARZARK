#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const ROOT = process.cwd();
const HEARTBEAT_DIR = path.join(ROOT, ".heartbeat");
const STATE_FILE = path.join(HEARTBEAT_DIR, "state.json");
const REPORT_MD = path.join(HEARTBEAT_DIR, "latest-report.md");
const REPORT_JSON = path.join(HEARTBEAT_DIR, "latest-report.json");

const DRY_RUN = process.env.HEARTBEAT_DRY_RUN === "true";
const SHOULD_COMMIT = process.env.HEARTBEAT_COMMIT !== "false";
const SHOULD_PUSH = process.env.HEARTBEAT_PUSH === "true";

function run(cmd, options = {}) {
  try {
    return cp.execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    }).trim();
  } catch (error) {
    if (options.allowFail) {
      return "";
    }
    const stderr = error.stderr ? String(error.stderr) : String(error.message);
    throw new Error(`Command failed: ${cmd}\n${stderr}`);
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getTrackedPaths(config) {
  const configured = Array.isArray(config?.memory?.tracked_paths)
    ? config.memory.tracked_paths
    : [];
  return configured.length > 0 ? configured : ["heartbeat.md", "config.json", "skills/"];
}

function parseGitLog(raw) {
  if (!raw) {
    return [];
  }

  const sections = raw
    .split("--COMMIT--")
    .map((item) => item.trim())
    .filter(Boolean);

  return sections.map((section) => {
    const lines = section
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const [hash = "", date = "", subject = "", ...files] = lines;
    return {
      hash,
      date,
      subject,
      files: Array.from(new Set(files))
    };
  });
}

function buildFingerprint(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function summarizeOptimizations(config, commits) {
  const suggestions = [];

  if (commits.length === 0) {
    suggestions.push("No tracked memory commits detected; heartbeat can remain in low-cost idle mode.");
  }

  if (config?.optimization?.skip_no_change_cycles) {
    suggestions.push("No-change cycle skipping is enabled to reduce unnecessary model/runtime cost.");
  } else {
    suggestions.push("Enable skip_no_change_cycles to reduce repeated processing when repository memory is unchanged.");
  }

  if (config?.optimization?.diff_first_scanning) {
    suggestions.push("Diff-first scanning is enabled to reduce latency vs full-repository scans.");
  } else {
    suggestions.push("Enable diff_first_scanning for lower latency and reduced token usage.");
  }

  return suggestions;
}

function formatMarkdown(report) {
  const lines = [];
  lines.push("# Heartbeat Report");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Tracked paths: ${report.tracked_paths.join(", ")}`);
  lines.push(`Relevant commit count: ${report.relevant_commit_count}`);
  lines.push("");
  lines.push("## Recent Memory Changes");

  if (report.recent_commits.length === 0) {
    lines.push("- No tracked memory changes found.");
  } else {
    report.recent_commits.forEach((commit) => {
      lines.push(`- ${commit.hash.slice(0, 8)} | ${commit.date} | ${commit.subject}`);
      if (commit.files.length > 0) {
        lines.push(`  files: ${commit.files.join(", ")}`);
      }
    });
  }

  lines.push("");
  lines.push("## Optimization Suggestions");
  report.optimization_suggestions.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Policy");
  lines.push(`- External API calls: ${report.policy.external_api_calls}`);
  lines.push(`- Fallback reasoning: ${report.policy.fallback_reasoning}`);
  lines.push("");
  lines.push(`- Dry run: ${report.dry_run}`);

  return `${lines.join("\n")}\n`;
}

function commitHeartbeatFiles(message) {
  run("git add .heartbeat/latest-report.md .heartbeat/latest-report.json .heartbeat/state.json");

  const hasStaged = run("git diff --cached --name-only", { allowFail: true });
  if (!hasStaged) {
    console.log("No staged heartbeat changes to commit.");
    return false;
  }

  const actorName = process.env.GITHUB_ACTOR || "github-actions[bot]";
  const actorEmail = process.env.GIT_AUTHOR_EMAIL || "41898282+github-actions[bot]@users.noreply.github.com";
  run(`git config user.name "${actorName}"`);
  run(`git config user.email "${actorEmail}"`);
  run(`git commit -m "${message}"`);
  return true;
}

function main() {
  run("git rev-parse --is-inside-work-tree");

  const configPath = path.join(ROOT, "config.json");
  const config = readJson(configPath, {});
  const trackedPaths = getTrackedPaths(config);

  const gitLogCmd = [
    "git log",
    "-n 20",
    '--pretty=format:"--COMMIT--%n%H%n%cI%n%s"',
    "--name-only",
    "--",
    ...trackedPaths.map((p) => `"${p}"`)
  ].join(" ");

  const rawLog = run(gitLogCmd, { allowFail: true });
  const commits = parseGitLog(rawLog);

  const reportPayload = {
    generated_at: new Date().toISOString(),
    tracked_paths: trackedPaths,
    relevant_commit_count: commits.length,
    recent_commits: commits,
    optimization_suggestions: summarizeOptimizations(config, commits),
    policy: {
      external_api_calls: config?.policy?.external_api_calls || "require_secret",
      fallback_reasoning: config?.policy?.fallback_reasoning || "local_ollama_only"
    },
    dry_run: DRY_RUN
  };

  const fingerprintPayload = {
    tracked_paths: trackedPaths,
    commits: commits.map((commit) => ({
      hash: commit.hash,
      files: commit.files
    }))
  };

  const fingerprint = buildFingerprint(fingerprintPayload);
  const previousState = readJson(STATE_FILE, {});
  const changed = previousState.fingerprint !== fingerprint;

  if (!changed) {
    console.log("Heartbeat: no tracked memory changes since last report. Skipping file update.");
    return;
  }

  ensureDir(HEARTBEAT_DIR);

  const nextState = {
    fingerprint,
    last_reported_at: reportPayload.generated_at,
    tracked_paths: trackedPaths,
    relevant_commit_count: commits.length
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(reportPayload, null, 2));
  fs.writeFileSync(REPORT_MD, formatMarkdown(reportPayload));
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));

  console.log("Heartbeat: updated report files.");

  if (DRY_RUN || !SHOULD_COMMIT) {
    console.log("Heartbeat: commit disabled by configuration.");
    return;
  }

  const committed = commitHeartbeatFiles("chore(heartbeat): refresh memory report");
  if (!committed) {
    return;
  }

  if (SHOULD_PUSH) {
    run("git push");
    console.log("Heartbeat: pushed heartbeat commit.");
  } else {
    console.log("Heartbeat: push disabled by configuration.");
  }
}

main();
