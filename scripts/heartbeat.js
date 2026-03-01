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

const DEFAULT_MAX_COMMITS_SCAN = 20;
const DEFAULT_TRACKED_PATHS = ["heartbeat.md", "config.json", "skills/"];

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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") {
      return true;
    }
    if (lowered === "false") {
      return false;
    }
  }
  return fallback;
}

function getTrackedPaths(config) {
  const configured = Array.isArray(config?.memory?.tracked_paths)
    ? config.memory.tracked_paths.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  return configured.length > 0 ? configured : DEFAULT_TRACKED_PATHS;
}

function getHeartbeatSettings(config) {
  const heartbeat = config?.heartbeat || {};
  return {
    max_commits_scan: parsePositiveInt(heartbeat.max_commits_scan, DEFAULT_MAX_COMMITS_SCAN),
    report_on_no_change: parseBoolean(heartbeat.report_on_no_change, false)
  };
}

function getPolicyState(config) {
  const policy = config?.policy || {};
  const allowedSecrets = Array.isArray(policy.allowed_secrets)
    ? policy.allowed_secrets
        .filter((name) => typeof name === "string" && /^[A-Z0-9_]+$/.test(name))
        .map((name) => name.trim())
    : [];
  const presentAllowedSecrets = allowedSecrets.filter((name) => Boolean(process.env[name]));
  const externalApiCalls = typeof policy.external_api_calls === "string"
    ? policy.external_api_calls
    : "require_secret";

  let externalApiEnabled = false;
  let externalApiReason = "";

  if (externalApiCalls === "allow") {
    externalApiEnabled = true;
    externalApiReason = "Policy set to allow.";
  } else if (externalApiCalls === "deny") {
    externalApiEnabled = false;
    externalApiReason = "Policy set to deny.";
  } else if (externalApiCalls === "require_secret") {
    if (allowedSecrets.length === 0) {
      externalApiEnabled = false;
      externalApiReason = "No approved secrets configured in policy.allowed_secrets.";
    } else if (presentAllowedSecrets.length === 0) {
      externalApiEnabled = false;
      externalApiReason = "No approved secrets are present in environment.";
    } else {
      externalApiEnabled = true;
      externalApiReason = "At least one approved secret is present in environment.";
    }
  } else {
    externalApiEnabled = false;
    externalApiReason = `Unknown external_api_calls policy '${externalApiCalls}', defaulting to deny.`;
  }

  return {
    external_api_calls: externalApiCalls,
    default_without_secret: policy.default_without_secret || "deny",
    fallback_reasoning: policy.fallback_reasoning || "local_ollama_only",
    allowed_secrets: allowedSecrets,
    present_allowed_secrets: presentAllowedSecrets,
    external_api_enabled: externalApiEnabled,
    external_api_reason: externalApiReason
  };
}

function enforceReasoningPolicy(config, policyState) {
  const provider = typeof config?.runtime?.reasoning_provider === "string"
    ? config.runtime.reasoning_provider
    : "ollama";
  const providerKey = provider.toLowerCase();

  if (providerKey !== "ollama" && !policyState.external_api_enabled) {
    throw new Error(
      `reasoning_provider='${provider}' requires external API access, but access is blocked: ${policyState.external_api_reason}`
    );
  }

  if (policyState.external_api_enabled) {
    console.log(`Heartbeat: external APIs enabled (${policyState.external_api_reason})`);
  } else {
    console.log(`Heartbeat: external APIs disabled (${policyState.external_api_reason})`);
  }

  return provider;
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

function summarizeOptimizations(config, commits, heartbeatSettings, policyState) {
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

  if (heartbeatSettings.report_on_no_change) {
    suggestions.push("report_on_no_change is enabled; expect frequent report updates with higher commit noise.");
  } else {
    suggestions.push("report_on_no_change is disabled; no-change cycles are skipped to reduce churn.");
  }

  if (!policyState.external_api_enabled) {
    suggestions.push("External APIs are gated off unless an approved secret is present.");
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
  lines.push(`No-change cycle: ${report.no_change_cycle}`);
  lines.push("");
  lines.push("## Heartbeat Settings");
  lines.push(`- max_commits_scan: ${report.heartbeat_settings.max_commits_scan}`);
  lines.push(`- report_on_no_change: ${report.heartbeat_settings.report_on_no_change}`);
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
  lines.push(`- External API enabled this run: ${report.policy.external_api_enabled}`);
  lines.push(`- External API gate reason: ${report.policy.external_api_reason}`);
  lines.push(`- Approved secrets: ${report.policy.allowed_secrets.join(", ") || "none"}`);
  lines.push(`- Present approved secrets: ${report.policy.present_allowed_secrets.join(", ") || "none"}`);
  lines.push(`- Fallback reasoning: ${report.policy.fallback_reasoning}`);
  lines.push(`- Reasoning provider: ${report.runtime.reasoning_provider}`);
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
  run(`git config user.name ${shellQuote(actorName)}`);
  run(`git config user.email ${shellQuote(actorEmail)}`);
  run(`git commit -m ${shellQuote(message)}`);
  return true;
}

function main() {
  run("git rev-parse --is-inside-work-tree");

  const configPath = path.join(ROOT, "config.json");
  const config = readJson(configPath, {});
  const trackedPaths = getTrackedPaths(config);
  const heartbeatSettings = getHeartbeatSettings(config);
  const policyState = getPolicyState(config);
  const reasoningProvider = enforceReasoningPolicy(config, policyState);

  const gitLogCmd = [
    "git log",
    `-n ${heartbeatSettings.max_commits_scan}`,
    '--pretty=format:"--COMMIT--%n%H%n%cI%n%s"',
    "--name-only",
    "--",
    ...trackedPaths.map((item) => `"${item}"`)
  ].join(" ");

  const rawLog = run(gitLogCmd, { allowFail: true });
  const commits = parseGitLog(rawLog);

  const fingerprintPayload = {
    tracked_paths: trackedPaths,
    heartbeat_settings: heartbeatSettings,
    policy_gate: {
      external_api_calls: policyState.external_api_calls,
      external_api_enabled: policyState.external_api_enabled,
      present_allowed_secrets: policyState.present_allowed_secrets
    },
    runtime: {
      reasoning_provider: reasoningProvider
    },
    commits: commits.map((commit) => ({
      hash: commit.hash,
      files: commit.files
    }))
  };

  const fingerprint = buildFingerprint(fingerprintPayload);
  const previousState = readJson(STATE_FILE, {});
  const changed = previousState.fingerprint !== fingerprint;

  if (!changed && !heartbeatSettings.report_on_no_change) {
    console.log("Heartbeat: no tracked memory changes since last report. Skipping file update.");
    return;
  }

  const reportPayload = {
    generated_at: new Date().toISOString(),
    tracked_paths: trackedPaths,
    relevant_commit_count: commits.length,
    recent_commits: commits,
    no_change_cycle: !changed,
    heartbeat_settings: heartbeatSettings,
    optimization_suggestions: summarizeOptimizations(config, commits, heartbeatSettings, policyState),
    policy: policyState,
    runtime: {
      reasoning_provider: reasoningProvider
    },
    dry_run: DRY_RUN
  };

  ensureDir(HEARTBEAT_DIR);

  const nextState = {
    fingerprint,
    last_reported_at: reportPayload.generated_at,
    tracked_paths: trackedPaths,
    relevant_commit_count: commits.length,
    no_change_cycle: reportPayload.no_change_cycle
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
