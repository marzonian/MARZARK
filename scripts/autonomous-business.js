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

function isoMinutesAgo(minutes) {
  const safeMinutes = Math.max(1, parseNumber(minutes, 120));
  const date = new Date(Date.now() - (safeMinutes * 60 * 1000));
  return date.toISOString();
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
  const errors = [];
  const quoteResults = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const endpoint = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        });

        if (!response.ok) {
          errors.push(`FMP ${symbol}: HTTP ${response.status}`);
          return null;
        }

        const payload = await response.json();
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (!row || typeof row !== "object") {
          errors.push(`FMP ${symbol}: empty payload`);
          return null;
        }

        return {
          symbol: String(row.symbol || symbol),
          price: parseNumber(row.price ?? row.lastSalePrice, null),
          change_pct: parseNumber(row.changesPercentage ?? row.changePercent ?? row.change_percentage, null),
          volume: parseNumber(row.volume ?? row.avgVolume, null)
        };
      } catch (error) {
        errors.push(`FMP ${symbol}: ${error.message || String(error)}`);
        return null;
      }
    })
  );

  return {
    quotes: quoteResults.filter((item) => item && item.symbol),
    errors
  };
}

function parseDatabentoJsonRows(payloadText) {
  const trimmed = String(payloadText || "").trim();
  if (!trimmed) {
    return [];
  }

  // Databento JSON encoding can be either a JSON value or newline-delimited JSON objects.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.data)) {
        return parsed.data;
      }
      return [parsed];
    }
  } catch (_error) {
    // Fall through to NDJSON parsing.
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function buildDatabentoSymbolMap(rows) {
  const symbolByInstrumentId = new Map();

  rows.forEach((row) => {
    if (!row || typeof row !== "object") {
      return;
    }

    const inSymbol = String(row.stype_in_symbol || row.raw_symbol || row.symbol || "").trim();
    const instrumentId = String(row.instrument_id ?? row.i ?? row.stype_out_symbol ?? "").trim();
    if (!inSymbol || !instrumentId) {
      return;
    }

    symbolByInstrumentId.set(instrumentId, inSymbol);
  });

  return symbolByInstrumentId;
}

function pickDatabentoSymbol(row, symbolByInstrumentId) {
  const direct = String(
    row.symbol ||
    row.raw_symbol ||
    row.stype_in_symbol ||
    row.stype_out_symbol ||
    row.s ||
    ""
  ).trim();
  if (direct && !/^\d+$/.test(direct)) {
    return direct;
  }

  const instrumentId = String(row.instrument_id ?? row.i ?? "").trim();
  if (instrumentId && symbolByInstrumentId.has(instrumentId)) {
    return symbolByInstrumentId.get(instrumentId);
  }
  if (instrumentId) {
    return `ID:${instrumentId}`;
  }
  return "";
}

function parseDatabentoErrorInfo(payloadText) {
  const fallback = {
    case: "",
    message: truncate(String(payloadText || ""), 240),
    availableEndIso: null
  };

  try {
    const parsed = JSON.parse(String(payloadText || "{}"));
    const detail = parsed && typeof parsed === "object" ? parsed.detail : null;
    const detailObj = detail && typeof detail === "object" ? detail : {};
    const detailMessage = String(detailObj.message || fallback.message);
    const errorCase = String(detailObj.case || "");

    const match = detailMessage.match(/available end of dataset [^']+ \('([^']+)'\)/i);
    const availableEndRaw = match ? String(match[1]) : "";
    const availableEndIso = availableEndRaw ? availableEndRaw.replace(" ", "T") : null;

    return {
      case: errorCase,
      message: detailMessage,
      availableEndIso
    };
  } catch (_error) {
    return fallback;
  }
}

async function fetchDatabentoQuotes(options) {
  const {
    symbols,
    apiKey,
    dataset,
    schema,
    stypeIn,
    stypeOut,
    lookbackMinutes
  } = options;

  const endpoint = "https://hist.databento.com/v0/timeseries.get_range";
  const authHeader = Buffer.from(`${apiKey}:`).toString("base64");
  const buildBody = (stypeOutValue, startIso, endIso) => new URLSearchParams({
    dataset,
    schema,
    symbols: symbols.join(","),
    stype_in: stypeIn,
    stype_out: stypeOutValue,
    start: startIso,
    end: endIso,
    encoding: "json",
    compression: "none",
    map_symbols: "true"
  });

  async function requestRange(stypeOutValue, startIso, endIso) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json,text/plain"
      },
      body: buildBody(stypeOutValue, startIso, endIso)
    });
    const responseText = await response.text();
    return { response, responseText, stypeOutValue, startIso, endIso };
  }

  let requestStypeOut = stypeOut;
  let requestStartIso = isoMinutesAgo(lookbackMinutes);
  let requestEndIso = new Date().toISOString();
  let requestResult = await requestRange(requestStypeOut, requestStartIso, requestEndIso);

  for (let attempt = 0; attempt < 3 && !requestResult.response.ok; attempt += 1) {
    const errorInfo = parseDatabentoErrorInfo(requestResult.responseText);

    if (
      requestResult.response.status === 422 &&
      errorInfo.case === "symbology_invalid_request" &&
      requestStypeOut !== "instrument_id"
    ) {
      requestStypeOut = "instrument_id";
      requestResult = await requestRange(requestStypeOut, requestStartIso, requestEndIso);
      continue;
    }

    if (
      requestResult.response.status === 422 &&
      errorInfo.case === "data_start_after_available_end" &&
      errorInfo.availableEndIso
    ) {
      const availableEnd = new Date(errorInfo.availableEndIso);
      if (!Number.isNaN(availableEnd.getTime())) {
        requestEndIso = availableEnd.toISOString();
        requestStartIso = new Date(availableEnd.getTime() - (Math.max(1, parseNumber(lookbackMinutes, 180)) * 60 * 1000)).toISOString();
        requestResult = await requestRange(requestStypeOut, requestStartIso, requestEndIso);
        continue;
      }
    }

    break;
  }

  if (!requestResult.response.ok) {
    const errorInfo = parseDatabentoErrorInfo(requestResult.responseText);
    throw new Error(`Databento request failed with status ${requestResult.response.status}: ${errorInfo.message}`);
  }

  const rows = parseDatabentoJsonRows(requestResult.responseText);
  const symbolByInstrumentId = buildDatabentoSymbolMap(rows);
  const bySymbol = new Map();

  rows.forEach((row) => {
    if (!row || typeof row !== "object") {
      return;
    }

    const symbol = pickDatabentoSymbol(row, symbolByInstrumentId);
    if (!symbol || symbol === "NaN") {
      return;
    }

    const ts = String(row.ts_event || row.ts_recv || row.ts || "");
    const open = parseNumber(row.open, null);
    const close = parseNumber(row.close, null);
    const last = parseNumber(row.price ?? row.last ?? row.last_price, null);
    const volume = parseNumber(row.volume ?? row.size ?? 0, 0);

    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, []);
    }

    bySymbol.get(symbol).push({
      ts,
      open: open !== null ? open : close,
      close: close !== null ? close : open !== null ? open : last,
      volume
    });
  });

  const quotes = [];
  bySymbol.forEach((records, symbol) => {
    records.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const first = records.find((item) => item.open !== null || item.close !== null);
    const last = [...records].reverse().find((item) => item.close !== null || item.open !== null);
    if (!first || !last) {
      return;
    }

    const startPrice = parseNumber(first.open ?? first.close, null);
    const endPrice = parseNumber(last.close ?? last.open, null);
    if (startPrice === null || endPrice === null || startPrice === 0) {
      return;
    }

    const totalVolume = records.reduce((acc, item) => acc + parseNumber(item.volume, 0), 0);
    const changePct = ((endPrice - startPrice) / startPrice) * 100;

    quotes.push({
      symbol,
      price: endPrice,
      change_pct: changePct,
      volume: totalVolume
    });
  });

  return {
    quotes,
    errors: []
  };
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
    notes.push("Send channel alerts (Discord/Telegram) with a premium link and clear invalidation levels.");
  } else if (marketDataStatus.enabled && signals.length === 0) {
    notes.push("No high-move signals this cycle. Publish a risk management tip for audience retention.");
    notes.push("Post a watchlist-only update and prepare next cycle triggers.");
  } else {
    notes.push("Market data feed disabled. Add the configured provider API secret to activate live signal generation.");
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
  lines.push(`- Provider: ${report.market_data.provider}`);
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
  lines.push(`- Discord configured: ${report.discord.configured}`);
  lines.push(`- Discord attempted: ${report.discord.attempted}`);
  lines.push(`- Discord sent: ${report.discord.sent}`);
  lines.push(`- Discord reason: ${report.discord.reason}`);
  lines.push("");
  lines.push(`- Dry run: ${report.dry_run}`);

  return `${lines.join("\n")}\n`;
}

function buildUpdateMessage(report, maxChars) {
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

async function sendDiscordMessage(webhookUrl, message) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: message
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook request failed with status ${response.status}: ${body}`);
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
  const maxDiscordChars = Math.max(300, parseNumber(localConfig?.updates?.max_discord_chars, 1800));

  const marketProvider = String(localConfig?.policy?.market_data_provider || "databento").toLowerCase();
  const marketSecretName = String(
    localConfig?.policy?.market_data_secret || (marketProvider === "databento" ? "DATABENTO_API_KEY" : "FMP_API_KEY")
  );
  const databentoDataset = String(localConfig?.policy?.databento_dataset || "DBEQ.BASIC");
  const databentoSchema = String(localConfig?.policy?.databento_schema || "ohlcv-1m");
  const databentoLookbackMinutes = parseNumber(localConfig?.policy?.databento_lookback_minutes, 180);
  const databentoStypeIn = String(localConfig?.policy?.databento_stype_in || "raw_symbol");
  const databentoStypeOut = String(localConfig?.policy?.databento_stype_out || "instrument_id");

  const telegramSecrets = Array.isArray(localConfig?.policy?.telegram_secrets)
    ? localConfig.policy.telegram_secrets
    : ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const discordSecretName = String(localConfig?.policy?.discord_secret || "DISCORD_WEBHOOK_URL");

  const marketSecretStatus = getSecretStatus(marketSecretName, allowedSecrets);
  const approvedSecretPresent = allowedSecrets.some((secretName) => Boolean(process.env[secretName]));
  const externalApisAllowed = policyAllowsExternalApi(globalConfig, approvedSecretPresent);

  let marketDataStatus = {
    provider: marketProvider,
    enabled: false,
    reason: "Market data disabled by policy or missing approved secret."
  };
  let quotes = [];

  if (externalApisAllowed && marketSecretStatus.usable) {
    try {
      let fetched;
      if (marketProvider === "databento") {
        fetched = await fetchDatabentoQuotes({
          symbols,
          apiKey: process.env[marketSecretName],
          dataset: databentoDataset,
          schema: databentoSchema,
          stypeIn: databentoStypeIn,
          stypeOut: databentoStypeOut,
          lookbackMinutes: databentoLookbackMinutes
        });
      } else if (marketProvider === "financialmodelingprep" || marketProvider === "fmp") {
        fetched = await fetchFmpQuotes(symbols, process.env[marketSecretName]);
      } else {
        throw new Error(`Unsupported market data provider '${marketProvider}'`);
      }

      quotes = fetched.quotes;
      if (quotes.length > 0) {
        marketDataStatus = {
          provider: marketProvider,
          enabled: true,
          reason: fetched.errors.length > 0
            ? `Market data active with partial errors: ${fetched.errors.join("; ")}`
            : "Market data feed active via secret-gated provider."
        };
      } else {
        marketDataStatus = {
          provider: marketProvider,
          enabled: false,
          reason: fetched.errors.length > 0
            ? `Market data provider error: ${fetched.errors.join("; ")}`
            : "Market data provider returned no quotes."
        };
      }
    } catch (error) {
      marketDataStatus = {
        provider: marketProvider,
        enabled: false,
        reason: `Market data provider error: ${error.message || String(error)}`
      };
    }
  } else if (!marketSecretStatus.approved) {
    marketDataStatus = {
      provider: marketProvider,
      enabled: false,
      reason: `${marketSecretName} is not allowlisted in config.json policy.allowed_secrets.`
    };
  } else if (!marketSecretStatus.present) {
    marketDataStatus = {
      provider: marketProvider,
      enabled: false,
      reason: `${marketSecretName} secret is missing.`
    };
  } else if (!externalApisAllowed) {
    marketDataStatus = {
      provider: marketProvider,
      enabled: false,
      reason: "External API access is blocked by global policy."
    };
  }

  const signals = buildSignals(quotes, minMovePct);
  const recommendations = buildRecommendations(signals, marketDataStatus);
  const telegramTokenStatus = getSecretStatus(telegramSecrets[0], allowedSecrets);
  const telegramChatStatus = getSecretStatus(telegramSecrets[1], allowedSecrets);
  const telegramConfigured = externalApisAllowed && telegramTokenStatus.usable && telegramChatStatus.usable;
  const discordSecretStatus = getSecretStatus(discordSecretName, allowedSecrets);
  const discordConfigured = externalApisAllowed && discordSecretStatus.usable;

  const fingerprintPayload = {
    business: localConfig.business || {},
    symbols,
    delivery_config: {
      send_on_no_change: sendOnNoChange,
      max_telegram_chars: maxTelegramChars,
      max_discord_chars: maxDiscordChars,
      telegram_secret_names: telegramSecrets,
      discord_secret_name: discordSecretName,
      market_data_provider: marketProvider,
      market_data_secret: marketSecretName,
      databento_dataset: databentoDataset,
      databento_schema: databentoSchema
    },
    delivery_ready: {
      external_apis_allowed: externalApisAllowed,
      telegram_configured: telegramConfigured,
      discord_configured: discordConfigured
    },
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
    discord: {
      configured: discordConfigured,
      attempted: false,
      sent: false,
      reason: discordConfigured
        ? "Discord is configured."
        : "Discord disabled: missing allowlisted or present secret."
    },
    dry_run: DRY_RUN
  };

  if (telegramConfigured) {
    const telegramMessage = buildUpdateMessage(report, maxTelegramChars);
    if (DRY_RUN) {
      report.telegram.reason = "Dry run enabled; Telegram send skipped.";
    } else {
      report.telegram.attempted = true;
      try {
        await sendTelegramMessage(process.env[telegramSecrets[0]], process.env[telegramSecrets[1]], telegramMessage);
        report.telegram.sent = true;
        report.telegram.reason = "Telegram message sent successfully.";
      } catch (error) {
        report.telegram.sent = false;
        report.telegram.reason = `Telegram send failed: ${error.message || String(error)}`;
      }
    }
  }

  if (discordConfigured) {
    const discordMessage = buildUpdateMessage(report, maxDiscordChars);
    if (DRY_RUN) {
      report.discord.reason = "Dry run enabled; Discord send skipped.";
    } else {
      report.discord.attempted = true;
      try {
        await sendDiscordMessage(process.env[discordSecretName], discordMessage);
        report.discord.sent = true;
        report.discord.reason = "Discord message sent successfully.";
      } catch (error) {
        report.discord.sent = false;
        report.discord.reason = `Discord send failed: ${error.message || String(error)}`;
      }
    }
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
        last_telegram_reason: report.telegram.reason,
        last_discord_sent: report.discord.sent,
        last_discord_reason: report.discord.reason
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
