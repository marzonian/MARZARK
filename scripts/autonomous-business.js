#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, ".autonomous");
const STATE_FILE = path.join(OUTPUT_DIR, "state.json");
const REPORT_JSON = path.join(OUTPUT_DIR, "latest-report.json");
const REPORT_MD = path.join(OUTPUT_DIR, "latest-report.md");

const DRY_RUN = process.env.AUTO_DRY_RUN === "true";
const SHOULD_COMMIT = process.env.AUTO_COMMIT !== "false";
const SHOULD_PUSH = process.env.AUTO_PUSH === "true";

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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function truncate(text, maxChars) {
  const safeText = String(text);
  if (safeText.length <= maxChars) {
    return safeText;
  }
  return `${safeText.slice(0, Math.max(0, maxChars - 3))}...`;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSecretStatus(secretName, allowedSecrets) {
  const approved = allowedSecrets.includes(secretName);
  const present = Boolean(process.env[secretName]);
  return {
    name: secretName,
    approved,
    present,
    usable: approved && present
  };
}

function policyAllowsExternalApi(globalConfig, approvedSecretPresent) {
  const externalPolicy = globalConfig?.policy?.external_api_calls || "require_secret";

  if (externalPolicy === "allow") {
    return true;
  }
  if (externalPolicy === "deny") {
    return false;
  }
  if (externalPolicy === "require_secret") {
    return approvedSecretPresent;
  }
  return false;
}

async function fetchFmpQuotes(symbols, apiKey) {
  const endpoint = `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`FMP API request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("FMP API payload is not an array.");
  }

  return payload
    .map((item) => ({
      symbol: String(item.symbol || ""),
      price: parseNumber(item.price, null),
      change_pct: parseNumber(item.changesPercentage, null),
      volume: parseNumber(item.volume, null)
    }))
    .filter((item) => item.symbol);
}

function buildSignals(quotes, minMovePct) {
  const signals = [];
  const numericThreshold = Math.abs(parseNumber(minMovePct, 0.5));

  quotes.forEach((quote) => {
    if (quote.change_pct === null) {
      return;
    }
    if (Math.abs(quote.change_pct) < numericThreshold) {
      return;
    }

    const direction = quote.change_pct > 0 ? "UP" : "DOWN";
    signals.push({
      symbol: quote.symbol,
      direction,
      change_pct: quote.change_pct,
      summary: `${quote.symbol} ${direction} ${quote.change_pct.toFixed(2)}%`
    });
  });

  return signals;
}

function buildRecommendations(signals, marketDataStatus) {
  const notes = [];

  if (marketDataStatus.enabled && signals.length > 0) {
    notes.push("Publish a premium update with entry/invalidations for top 2 signals.");
    notes.push("Send a Telegram alert preview and link to paid channel/offer.");
  } else if (marketDataStatus.enabled && signals.length === 0) {
    notes.push("No high-move signals this cycle. Publish a risk management tip for audience retention.");
    notes.push("Post a watchlist-only update and prepare next cycle triggers.");
  } else {
    notes.push("Market data feed disabled. Add FMP_API_KEY secret to activate live signal generation.");
    notes.push("Keep sending cadence updates so subscribers receive consistent communication.");
  }

  return notes;
}

function buildFingerprint(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Autonomous Business Report");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Business: ${report.business.name}`);
  lines.push(`Offer: ${report.business.offer}`);
  lines.push(`Price: $${report.business.price_usd_monthly}/month`);
  lines.push(`No-change cycle: ${report.no_change_cycle}`);
  lines.push("");
  lines.push("## Market Data");
  lines.push(`- Enabled: ${report.market_data.enabled}`);
  lines.push(`- Reason: ${report.market_data.reason}`);
  lines.push(`- Symbols: ${report.trading.symbols.join(", ")}`);
  lines.push(`- Quotes collected: ${report.quotes.length}`);
  lines.push("");
  lines.push("## Signals");

  if (report.signals.length === 0) {
    lines.push("- No signals met threshold this cycle.");
  } else {
    report.signals.forEach((signal) => {
      lines.push(`- ${signal.summary}`);
    });
  }

  lines.push("");
  lines.push("## Recommendations");
  report.recommendations.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Delivery");
  lines.push(`- Telegram configured: ${report.telegram.configured}`);
  lines.push(`- Telegram attempted: ${report.telegram.attempted}`);
  lines.push(`- Telegram sent: ${report.telegram.sent}`);
  lines.push(`- Telegram reason: ${report.telegram.reason}`);
  lines.push("");
  lines.push(`- Dry run: ${report.dry_run}`);

  return `${lines.join("\n")}\n`;
}

function buildTelegramMessage(report, maxChars) {
  const signalLine = report.signals.length > 0
    ? report.signals.map((item) => item.summary).join(" | ")
    : "No high-move signals this cycle.";

  const text = [
    `MARZARK Update (${new Date(report.generated_at).toISOString()})`,
    `Offer: ${report.business.offer} ($${report.business.price_usd_monthly}/mo)`,
    `Market feed: ${report.market_data.enabled ? "ON" : "OFF"} (${report.market_data.reason})`,
    `Signals: ${signalLine}`,
    `Recommendation: ${report.recommendations[0]}`
  ].join("\n");

  return truncate(text, maxChars);
}

async function sendTelegramMessage(botToken, chatId, message) {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API request failed with status ${response.status}: ${body}`);
  }
}

function commitOutputs(message) {
  run("git add .autonomous/latest-report.md .autonomous/latest-report.json .autonomous/state.json");
  const hasStaged = run("git diff --cached --name-only", { allowFail: true });
  if (!hasStaged) {
    console.log("Autonomous: no staged files to commit.");
    return false;
  }

  const actorName = process.env.GITHUB_ACTOR || "github-actions[bot]";
  const actorEmail = process.env.GIT_AUTHOR_EMAIL || "41898282+github-actions[bot]@users.noreply.github.com";
  run(`git config user.name ${shellQuote(actorName)}`);
  run(`git config user.email ${shellQuote(actorEmail)}`);
  run(`git commit -m ${shellQuote(message)}`);
  return true;
}

async function main() {
  run("git rev-parse --is-inside-work-tree");

  const globalConfig = readJson(path.join(ROOT, "config.json"), {});
  const localConfig = readJson(path.join(ROOT, "autonomous.config.json"), {});
  const previousState = readJson(STATE_FILE, {});

  const allowedSecrets = Array.isArray(globalConfig?.policy?.allowed_secrets)
    ? globalConfig.policy.allowed_secrets.filter((name) => typeof name === "string")
    : [];

  const symbols = Array.isArray(localConfig?.trading?.symbols) && localConfig.trading.symbols.length > 0
    ? localConfig.trading.symbols.map((item) => String(item))
    : ["SPY", "QQQ", "IWM", "DIA"];

  const minMovePct = parseNumber(localConfig?.trading?.min_price_move_pct_alert, 0.5);
  const sendOnNoChange = Boolean(localConfig?.updates?.send_on_no_change);
  const maxTelegramChars = Math.max(300, parseNumber(localConfig?.updates?.max_telegram_chars, 3500));

  const marketSecretName = String(localConfig?.policy?.market_data_secret || "FMP_API_KEY");
  const telegramSecrets = Array.isArray(localConfig?.policy?.telegram_secrets)
    ? localConfig.policy.telegram_secrets
    : ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];

  const marketSecretStatus = getSecretStatus(marketSecretName, allowedSecrets);
  const approvedSecretPresent = allowedSecrets.some((secretName) => Boolean(process.env[secretName]));
  const externalApisAllowed = policyAllowsExternalApi(globalConfig, approvedSecretPresent);

  let marketDataStatus = {
    enabled: false,
    reason: "Market data disabled by policy or missing approved secret."
  };
  let quotes = [];

  if (externalApisAllowed && marketSecretStatus.usable) {
    quotes = await fetchFmpQuotes(symbols, process.env[marketSecretName]);
    marketDataStatus = {
      enabled: true,
      reason: "Market data feed active via secret-gated provider."
    };
  } else if (!marketSecretStatus.approved) {
    marketDataStatus = {
      enabled: false,
      reason: `${marketSecretName} is not allowlisted in config.json policy.allowed_secrets.`
    };
  } else if (!marketSecretStatus.present) {
    marketDataStatus = {
      enabled: false,
      reason: `${marketSecretName} secret is missing.`
    };
  } else if (!externalApisAllowed) {
    marketDataStatus = {
      enabled: false,
      reason: "External API access is blocked by global policy."
    };
  }

  const signals = buildSignals(quotes, minMovePct);
  const recommendations = buildRecommendations(signals, marketDataStatus);

  const fingerprintPayload = {
    business: localConfig.business || {},
    symbols,
    market_data_enabled: marketDataStatus.enabled,
    market_data_reason: marketDataStatus.reason,
    quotes: quotes.map((item) => ({
      symbol: item.symbol,
      price: item.price === null ? null : Number(item.price.toFixed(2)),
      change_pct: item.change_pct === null ? null : Number(item.change_pct.toFixed(2))
    })),
    signals
  };

  const fingerprint = buildFingerprint(fingerprintPayload);
  const changed = previousState.fingerprint !== fingerprint;

  if (process.env.AUTO_DEBUG === "true") {
    console.log(`Autonomous: previous fingerprint=${previousState.fingerprint || "none"}`);
    console.log(`Autonomous: current fingerprint=${fingerprint}`);
  }

  if (!changed && !sendOnNoChange) {
    console.log("Autonomous: no meaningful change detected; skipping report/update cycle.");
    return;
  }

  const telegramTokenStatus = getSecretStatus(telegramSecrets[0], allowedSecrets);
  const telegramChatStatus = getSecretStatus(telegramSecrets[1], allowedSecrets);
  const telegramConfigured = externalApisAllowed && telegramTokenStatus.usable && telegramChatStatus.usable;

  const report = {
    generated_at: new Date().toISOString(),
    no_change_cycle: !changed,
    business: {
      name: String(localConfig?.business?.name || "MARZARK Trading Intelligence"),
      offer: String(localConfig?.business?.offer || "Risk-first market brief with premium alert candidates"),
      price_usd_monthly: parseNumber(localConfig?.business?.price_usd_monthly, 29)
    },
    trading: {
      symbols,
      min_price_move_pct_alert: minMovePct
    },
    market_data: marketDataStatus,
    quotes,
    signals,
    recommendations,
    policy: {
      external_api_policy: globalConfig?.policy?.external_api_calls || "require_secret",
      allowed_secrets: allowedSecrets,
      approved_secret_present: approvedSecretPresent
    },
    telegram: {
      configured: telegramConfigured,
      attempted: false,
      sent: false,
      reason: telegramConfigured
        ? "Telegram is configured."
        : "Telegram disabled: missing allowlisted or present secrets."
    },
    dry_run: DRY_RUN
  };

  if (telegramConfigured && !DRY_RUN) {
    const message = buildTelegramMessage(report, maxTelegramChars);
    report.telegram.attempted = true;
    await sendTelegramMessage(process.env[telegramSecrets[0]], process.env[telegramSecrets[1]], message);
    report.telegram.sent = true;
    report.telegram.reason = "Telegram message sent successfully.";
  } else if (telegramConfigured && DRY_RUN) {
    report.telegram.attempted = false;
    report.telegram.sent = false;
    report.telegram.reason = "Dry run enabled; Telegram send skipped.";
  }

  ensureDir(OUTPUT_DIR);
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_MD, toMarkdown(report));
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        fingerprint,
        last_reported_at: report.generated_at,
        last_telegram_sent: report.telegram.sent,
        last_telegram_reason: report.telegram.reason
      },
      null,
      2
    )
  );

  console.log("Autonomous: report files updated.");

  if (DRY_RUN || !SHOULD_COMMIT) {
    console.log("Autonomous: commit disabled by configuration.");
    return;
  }

  const committed = commitOutputs("chore(autonomous): refresh business update report");
  if (!committed) {
    return;
  }

  if (SHOULD_PUSH) {
    run("git push");
    console.log("Autonomous: pushed report commit.");
  } else {
    console.log("Autonomous: push disabled by configuration.");
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
