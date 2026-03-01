#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = process.cwd();

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

function getTrackedPaths(config) {
  const paths = config?.memory?.tracked_paths;
  if (Array.isArray(paths) && paths.length > 0) {
    return paths;
  }
  return ["heartbeat.md", "config.json", "skills/"];
}

function parseGitLog(raw) {
  if (!raw) {
    return [];
  }

  const sections = raw
    .split("--COMMIT--")
    .map((value) => value.trim())
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
      files
    };
  });
}

function main() {
  run("git rev-parse --is-inside-work-tree");
  const config = readJson(path.join(ROOT, "config.json"), {});
  const trackedPaths = getTrackedPaths(config);

  const logCmd = [
    "git log",
    "-n 5",
    '--pretty=format:"--COMMIT--%n%H%n%cI%n%s"',
    "--name-only",
    "--",
    ...trackedPaths.map((item) => `"${item}"`)
  ].join(" ");

  const recentCommits = parseGitLog(run(logCmd, { allowFail: true }));
  const latestReport = readJson(path.join(ROOT, ".heartbeat", "latest-report.json"), null);

  const result = {
    skill: "repo-memory-summary",
    generated_at: new Date().toISOString(),
    tracked_paths: trackedPaths,
    recent_commits: recentCommits,
    heartbeat_report_present: Boolean(latestReport),
    heartbeat_relevant_commit_count: latestReport ? latestReport.relevant_commit_count : null
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
