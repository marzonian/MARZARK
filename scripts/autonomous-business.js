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
const DAILY_PREMIUM_JSON = path.join(OUTPUT_DIR, "daily-premium.json");
const DAILY_PREMIUM_MD = path.join(OUTPUT_DIR, "daily-premium.md");
const WEEKLY_SUMMARY_JSON = path.join(OUTPUT_DIR, "weekly-summary.json");
const WEEKLY_SUMMARY_MD = path.join(OUTPUT_DIR, "weekly-summary.md");

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    let millis;
    if (numeric > 10_000_000_000_000_000) {
      // Nanoseconds epoch
      millis = numeric / 1_000_000;
    } else if (numeric > 10_000_000_000_000) {
      // Microseconds epoch
      millis = numeric / 1000;
    } else if (numeric > 1_000_000_000_000) {
      // Milliseconds epoch
      millis = numeric;
    } else {
      // Seconds epoch
      millis = numeric * 1000;
    }
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toUtcDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function getIsoWeekParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const utcDate = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);

  return {
    year: utcDate.getUTCFullYear(),
    week
  };
}

function toIsoWeekKey(value) {
  const parts = getIsoWeekParts(value);
  if (!parts) {
    return null;
  }
  return `${parts.year}-W${String(parts.week).padStart(2, "0")}`;
}

function formatNumber(value, fractionDigits = 2) {
  const numeric = parseNumber(value, null);
  if (numeric === null) {
    return "n/a";
  }
  return numeric.toFixed(fractionDigits);
}

function normalizePrice(value) {
  const numeric = parseNumber(value, null);
  if (numeric === null) {
    return null;
  }
  // Databento OHLCV prices may be integer nanodollars on some datasets/schemas.
  if (Math.abs(numeric) >= 1_000_000) {
    return numeric / 1_000_000_000;
  }
  return numeric;
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
          volume: parseNumber(row.volume ?? row.avgVolume, null),
          as_of: toIsoTimestamp(
            row.timestamp ??
            row.lastUpdated ??
            row.updatedAt ??
            row.priceTimestamp ??
            row.date
          )
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
    const open = normalizePrice(row.open);
    const close = normalizePrice(row.close);
    const last = normalizePrice(row.price ?? row.last ?? row.last_price);
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
      volume: totalVolume,
      as_of: toIsoTimestamp(last.ts || requestResult.endIso),
      bars_count: records.length
    });
  });

  return {
    quotes,
    errors: []
  };
}

function buildSignals(quotes, minMovePct, riskConfig, previousState) {
  const numericThreshold = Math.abs(parseNumber(minMovePct, 0.5));
  const maxAlertsPerCycle = Math.max(1, parseNumber(riskConfig?.max_alerts_per_cycle, 2));
  const maxAbsMovePct = Math.max(numericThreshold, Math.abs(parseNumber(riskConfig?.max_abs_move_pct, 6)));
  const minVolume = Math.max(0, parseNumber(riskConfig?.min_volume, 0));
  const maxQuoteAgeMinutes = Math.max(1, parseNumber(riskConfig?.max_quote_age_minutes, 720));
  const symbolCooldownMinutes = Math.max(0, parseNumber(riskConfig?.symbol_cooldown_minutes, 120));
  const preferHighVolume = riskConfig?.prefer_high_volume !== false;

  const previousRecentSignals = Array.isArray(previousState?.recent_signals)
    ? previousState.recent_signals
    : [];
  const lastSignalBySymbol = new Map();
  previousRecentSignals.forEach((item) => {
    const symbol = String(item?.symbol || "").trim();
    const ts = toIsoTimestamp(item?.ts);
    if (!symbol || !ts) {
      return;
    }
    const millis = new Date(ts).getTime();
    if (Number.isNaN(millis)) {
      return;
    }
    if (!lastSignalBySymbol.has(symbol) || millis > lastSignalBySymbol.get(symbol)) {
      lastSignalBySymbol.set(symbol, millis);
    }
  });

  const nowMs = Date.now();
  const maxVolumeSeen = quotes.reduce((acc, quote) => {
    const volume = parseNumber(quote?.volume, 0);
    return Math.max(acc, volume);
  }, 0);

  const candidates = [];
  const filtered = [];
  const counters = {
    missing_change: 0,
    under_min_move: 0,
    over_max_move: 0,
    low_volume: 0,
    stale_quote: 0,
    cooldown: 0
  };

  quotes.forEach((quote) => {
    const symbol = String(quote?.symbol || "").trim();
    if (!symbol) {
      return;
    }

    const changePct = parseNumber(quote?.change_pct, null);
    if (changePct === null) {
      counters.missing_change += 1;
      filtered.push({ symbol, reason: "missing_change" });
      return;
    }

    const absMove = Math.abs(changePct);
    if (absMove < numericThreshold) {
      counters.under_min_move += 1;
      filtered.push({ symbol, reason: "under_min_move" });
      return;
    }

    if (absMove > maxAbsMovePct) {
      counters.over_max_move += 1;
      filtered.push({ symbol, reason: "over_max_move" });
      return;
    }

    const volume = parseNumber(quote?.volume, null);
    if (minVolume > 0 && volume !== null && volume < minVolume) {
      counters.low_volume += 1;
      filtered.push({ symbol, reason: "low_volume" });
      return;
    }

    const asOfIso = toIsoTimestamp(quote?.as_of);
    const ageMinutes = asOfIso
      ? (nowMs - new Date(asOfIso).getTime()) / 60000
      : null;
    if (ageMinutes !== null && Number.isFinite(ageMinutes) && ageMinutes > maxQuoteAgeMinutes) {
      counters.stale_quote += 1;
      filtered.push({ symbol, reason: "stale_quote" });
      return;
    }

    if (symbolCooldownMinutes > 0 && lastSignalBySymbol.has(symbol)) {
      const previousMs = lastSignalBySymbol.get(symbol);
      const elapsedMinutes = (nowMs - previousMs) / 60000;
      if (Number.isFinite(elapsedMinutes) && elapsedMinutes < symbolCooldownMinutes) {
        counters.cooldown += 1;
        filtered.push({ symbol, reason: "cooldown" });
        return;
      }
    }

    const direction = changePct > 0 ? "UP" : "DOWN";
    const moveScore = clamp(absMove / maxAbsMovePct, 0, 1);
    const volumeScore = maxVolumeSeen > 0
      ? clamp(parseNumber(volume, 0) / maxVolumeSeen, 0, 1)
      : 0.5;
    const freshnessScore = ageMinutes === null
      ? 0.5
      : clamp(1 - (Math.max(0, ageMinutes) / (maxQuoteAgeMinutes * 2)), 0, 1);
    const riskScore = Number((
      (moveScore * 0.55) +
      ((preferHighVolume ? volumeScore : 0.5) * 0.25) +
      (freshnessScore * 0.20)
    ).toFixed(3));

    candidates.push({
      symbol,
      direction,
      change_pct: changePct,
      volume,
      as_of: asOfIso,
      risk_score: riskScore,
      summary: `${symbol} ${direction} ${changePct.toFixed(2)}% | risk ${riskScore.toFixed(2)}`
    });
  });

  candidates.sort((a, b) => {
    if (b.risk_score !== a.risk_score) {
      return b.risk_score - a.risk_score;
    }
    const absA = Math.abs(a.change_pct);
    const absB = Math.abs(b.change_pct);
    if (absB !== absA) {
      return absB - absA;
    }
    return parseNumber(b.volume, 0) - parseNumber(a.volume, 0);
  });

  const signals = candidates.slice(0, maxAlertsPerCycle);
  const droppedByCap = Math.max(0, candidates.length - signals.length);

  return {
    signals,
    diagnostics: {
      filters: {
        min_move_pct: numericThreshold,
        max_abs_move_pct: maxAbsMovePct,
        min_volume: minVolume,
        max_quote_age_minutes: maxQuoteAgeMinutes,
        symbol_cooldown_minutes: symbolCooldownMinutes,
        max_alerts_per_cycle: maxAlertsPerCycle
      },
      counts: {
        quotes_total: quotes.length,
        candidates_before_cap: candidates.length,
        selected: signals.length,
        dropped_by_cap: droppedByCap,
        missing_change: counters.missing_change,
        under_min_move: counters.under_min_move,
        over_max_move: counters.over_max_move,
        low_volume: counters.low_volume,
        stale_quote: counters.stale_quote,
        cooldown: counters.cooldown
      },
      filtered_examples: filtered.slice(0, 12)
    }
  };
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

function normalizeHistoryEntries(rawHistory, maxEntries) {
  const history = Array.isArray(rawHistory) ? rawHistory : [];
  const normalized = history
    .map((item) => {
      const generatedAt = toIsoTimestamp(item?.generated_at);
      if (!generatedAt) {
        return null;
      }
      const signals = Array.isArray(item?.signals)
        ? item.signals
          .map((signal) => ({
            symbol: String(signal?.symbol || "").trim(),
            direction: String(signal?.direction || "").trim(),
            change_pct: parseNumber(signal?.change_pct, null)
          }))
          .filter((signal) => signal.symbol && signal.change_pct !== null)
        : [];

      return {
        generated_at: generatedAt,
        market_data_enabled: Boolean(item?.market_data_enabled),
        signals
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.generated_at.localeCompare(b.generated_at));

  if (normalized.length <= maxEntries) {
    return normalized;
  }
  return normalized.slice(normalized.length - maxEntries);
}

function buildHistoryEntry(report) {
  return {
    generated_at: toIsoTimestamp(report.generated_at),
    market_data_enabled: Boolean(report?.market_data?.enabled),
    signals: Array.isArray(report?.signals)
      ? report.signals.map((signal) => ({
        symbol: String(signal?.symbol || "").trim(),
        direction: String(signal?.direction || "").trim(),
        change_pct: parseNumber(signal?.change_pct, null)
      })).filter((signal) => signal.symbol && signal.change_pct !== null)
      : []
  };
}

function summarizePremiumWindow(entries, windowKey, windowType, generatedAt) {
  const signalBySymbol = new Map();
  let cyclesWithSignals = 0;
  let marketEnabledCycles = 0;
  let strongestSignal = null;

  entries.forEach((entry) => {
    if (entry.market_data_enabled) {
      marketEnabledCycles += 1;
    }
    if (!Array.isArray(entry.signals) || entry.signals.length === 0) {
      return;
    }
    cyclesWithSignals += 1;

    entry.signals.forEach((signal) => {
      const symbol = signal.symbol;
      if (!signalBySymbol.has(symbol)) {
        signalBySymbol.set(symbol, {
          symbol,
          count: 0,
          avg_abs_move_pct: 0,
          gross_abs_move_pct: 0
        });
      }
      const absMove = Math.abs(parseNumber(signal.change_pct, 0));
      const row = signalBySymbol.get(symbol);
      row.count += 1;
      row.gross_abs_move_pct += absMove;
      row.avg_abs_move_pct = row.gross_abs_move_pct / row.count;

      if (!strongestSignal || absMove > Math.abs(strongestSignal.change_pct)) {
        strongestSignal = {
          generated_at: entry.generated_at,
          symbol: signal.symbol,
          direction: signal.direction,
          change_pct: signal.change_pct
        };
      }
    });
  });

  const topSymbols = [...signalBySymbol.values()]
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return b.avg_abs_move_pct - a.avg_abs_move_pct;
    })
    .slice(0, 5)
    .map((row) => ({
      symbol: row.symbol,
      count: row.count,
      avg_abs_move_pct: Number(row.avg_abs_move_pct.toFixed(3))
    }));

  const latestSignals = [...entries]
    .reverse()
    .find((entry) => Array.isArray(entry.signals) && entry.signals.length > 0);

  return {
    window_type: windowType,
    window_key: windowKey,
    generated_at: generatedAt,
    cycles_total: entries.length,
    cycles_with_signals: cyclesWithSignals,
    market_enabled_cycles: marketEnabledCycles,
    signal_hit_rate_pct: entries.length > 0
      ? Number(((cyclesWithSignals / entries.length) * 100).toFixed(2))
      : 0,
    top_symbols: topSymbols,
    strongest_signal: strongestSignal,
    latest_signal_cycle: latestSignals
      ? {
        generated_at: latestSignals.generated_at,
        signals: latestSignals.signals
      }
      : null
  };
}

function toPremiumMarkdown(title, premiumSummary) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Generated: ${premiumSummary.generated_at}`);
  lines.push(`Window: ${premiumSummary.window_key}`);
  lines.push(`Cycles tracked: ${premiumSummary.cycles_total}`);
  lines.push(`Cycles with signals: ${premiumSummary.cycles_with_signals}`);
  lines.push(`Signal hit rate: ${formatNumber(premiumSummary.signal_hit_rate_pct, 2)}%`);
  lines.push(`Market feed-on cycles: ${premiumSummary.market_enabled_cycles}`);
  lines.push("");
  lines.push("## Top Symbols");
  if (!Array.isArray(premiumSummary.top_symbols) || premiumSummary.top_symbols.length === 0) {
    lines.push("- No qualified signal symbols yet.");
  } else {
    premiumSummary.top_symbols.forEach((row) => {
      lines.push(`- ${row.symbol}: ${row.count} signals, avg |move| ${formatNumber(row.avg_abs_move_pct, 2)}%`);
    });
  }
  lines.push("");
  lines.push("## Strongest Signal");
  if (!premiumSummary.strongest_signal) {
    lines.push("- No strongest signal recorded yet.");
  } else {
    const strongest = premiumSummary.strongest_signal;
    lines.push(`- ${strongest.generated_at}: ${strongest.symbol} ${strongest.direction} ${formatNumber(strongest.change_pct, 2)}%`);
  }
  lines.push("");
  lines.push("## Latest Signal Cycle");
  if (!premiumSummary.latest_signal_cycle) {
    lines.push("- No signal cycle recorded yet.");
  } else {
    lines.push(`- Time: ${premiumSummary.latest_signal_cycle.generated_at}`);
    premiumSummary.latest_signal_cycle.signals.forEach((signal) => {
      lines.push(`- ${signal.symbol} ${signal.direction} ${formatNumber(signal.change_pct, 2)}%`);
    });
  }

  return `${lines.join("\n")}\n`;
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
  lines.push("## Risk Filters");
  lines.push(`- Max alerts per cycle: ${report.signal_diagnostics?.filters?.max_alerts_per_cycle ?? "n/a"}`);
  lines.push(`- Max abs move %: ${report.signal_diagnostics?.filters?.max_abs_move_pct ?? "n/a"}`);
  lines.push(`- Min volume: ${report.signal_diagnostics?.filters?.min_volume ?? "n/a"}`);
  lines.push(`- Max quote age (minutes): ${report.signal_diagnostics?.filters?.max_quote_age_minutes ?? "n/a"}`);
  lines.push(`- Symbol cooldown (minutes): ${report.signal_diagnostics?.filters?.symbol_cooldown_minutes ?? "n/a"}`);
  lines.push(`- Candidates before cap: ${report.signal_diagnostics?.counts?.candidates_before_cap ?? 0}`);
  lines.push(`- Dropped by cap: ${report.signal_diagnostics?.counts?.dropped_by_cap ?? 0}`);
  lines.push(`- Filtered stale quotes: ${report.signal_diagnostics?.counts?.stale_quote ?? 0}`);
  lines.push("");
  lines.push("## Premium Windows");
  lines.push(`- Daily file: .autonomous/daily-premium.md (${report.premium?.daily?.window_key || "n/a"})`);
  lines.push(`- Daily hit rate: ${formatNumber(report.premium?.daily?.signal_hit_rate_pct, 2)}%`);
  lines.push(`- Weekly file: .autonomous/weekly-summary.md (${report.premium?.weekly?.window_key || "n/a"})`);
  lines.push(`- Weekly hit rate: ${formatNumber(report.premium?.weekly?.signal_hit_rate_pct, 2)}%`);
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
  const dailyHitRate = formatNumber(report?.premium?.daily?.signal_hit_rate_pct, 1);
  const weeklyHitRate = formatNumber(report?.premium?.weekly?.signal_hit_rate_pct, 1);
  const selectedSignals = report?.signal_diagnostics?.counts?.selected ?? report.signals.length;
  const droppedByCap = report?.signal_diagnostics?.counts?.dropped_by_cap ?? 0;

  const text = [
    `MARZARK Update (${new Date(report.generated_at).toISOString()})`,
    `Offer: ${report.business.offer} ($${report.business.price_usd_monthly}/mo)`,
    `Market feed: ${report.market_data.enabled ? "ON" : "OFF"} (${report.market_data.reason})`,
    `Signals: ${signalLine}`,
    `Risk filters: selected ${selectedSignals}, dropped by cap ${droppedByCap}`,
    `Premium hit-rate: day ${dailyHitRate}% | week ${weeklyHitRate}%`,
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
  run("git add .autonomous/latest-report.md .autonomous/latest-report.json .autonomous/state.json .autonomous/daily-premium.md .autonomous/daily-premium.json .autonomous/weekly-summary.md .autonomous/weekly-summary.json");
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
  const riskFilters = localConfig?.trading?.risk_filters || {};
  const sendOnNoChange = Boolean(localConfig?.updates?.send_on_no_change);
  const maxTelegramChars = Math.max(300, parseNumber(localConfig?.updates?.max_telegram_chars, 3500));
  const maxDiscordChars = Math.max(300, parseNumber(localConfig?.updates?.max_discord_chars, 1800));
  const writeOnNoChange = localConfig?.premium_reports?.write_on_no_change !== false;
  const premiumHistoryMaxEntries = Math.max(96, parseNumber(localConfig?.premium_reports?.history_max_entries, 1000));
  const generatedAt = new Date().toISOString();

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

  const signalBuildResult = buildSignals(quotes, minMovePct, riskFilters, previousState);
  const signals = signalBuildResult.signals;
  const signalDiagnostics = signalBuildResult.diagnostics;
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
      write_on_no_change: writeOnNoChange,
      max_telegram_chars: maxTelegramChars,
      max_discord_chars: maxDiscordChars,
      telegram_secret_names: telegramSecrets,
      discord_secret_name: discordSecretName,
      market_data_provider: marketProvider,
      market_data_secret: marketSecretName,
      databento_dataset: databentoDataset,
      databento_schema: databentoSchema,
      premium_history_max_entries: premiumHistoryMaxEntries
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
      change_pct: item.change_pct === null ? null : Number(item.change_pct.toFixed(2)),
      as_of: toIsoTimestamp(item.as_of)
    })),
    risk_filters: signalDiagnostics.filters,
    signal_diagnostics_counts: signalDiagnostics.counts,
    signals
  };

  const fingerprint = buildFingerprint(fingerprintPayload);
  const changed = previousState.fingerprint !== fingerprint;

  if (process.env.AUTO_DEBUG === "true") {
    console.log(`Autonomous: previous fingerprint=${previousState.fingerprint || "none"}`);
    console.log(`Autonomous: current fingerprint=${fingerprint}`);
  }

  if (!changed && !sendOnNoChange && !writeOnNoChange) {
    console.log("Autonomous: no meaningful change detected; skipping report/update cycle.");
    return;
  }

  const report = {
    generated_at: generatedAt,
    no_change_cycle: !changed,
    business: {
      name: String(localConfig?.business?.name || "MARZARK Trading Intelligence"),
      offer: String(localConfig?.business?.offer || "Risk-first market brief with premium alert candidates"),
      price_usd_monthly: parseNumber(localConfig?.business?.price_usd_monthly, 29)
    },
    trading: {
      symbols,
      min_price_move_pct_alert: minMovePct,
      risk_filters: signalDiagnostics.filters
    },
    market_data: marketDataStatus,
    quotes,
    signals,
    signal_diagnostics: signalDiagnostics,
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

  const historyBeforeRun = normalizeHistoryEntries(previousState?.history, premiumHistoryMaxEntries);
  const historyAfterRun = normalizeHistoryEntries(
    [...historyBeforeRun, buildHistoryEntry(report)],
    premiumHistoryMaxEntries
  );
  const dailyWindowKey = toUtcDayKey(report.generated_at) || "unknown-day";
  const weeklyWindowKey = toIsoWeekKey(report.generated_at) || "unknown-week";
  const dailyEntries = historyAfterRun.filter((entry) => toUtcDayKey(entry.generated_at) === dailyWindowKey);
  const weeklyEntries = historyAfterRun.filter((entry) => toIsoWeekKey(entry.generated_at) === weeklyWindowKey);
  const dailyPremium = summarizePremiumWindow(dailyEntries, dailyWindowKey, "daily", report.generated_at);
  const weeklyPremium = summarizePremiumWindow(weeklyEntries, weeklyWindowKey, "weekly", report.generated_at);

  report.premium = {
    daily: dailyPremium,
    weekly: weeklyPremium,
    history_entries: historyAfterRun.length
  };

  const shouldSendMessages = changed || sendOnNoChange;

  if (telegramConfigured) {
    const telegramMessage = buildUpdateMessage(report, maxTelegramChars);
    if (!shouldSendMessages) {
      report.telegram.reason = "No meaningful change; Telegram send skipped.";
    } else if (DRY_RUN) {
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
    if (!shouldSendMessages) {
      report.discord.reason = "No meaningful change; Discord send skipped.";
    } else if (DRY_RUN) {
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
  fs.writeFileSync(DAILY_PREMIUM_JSON, JSON.stringify(dailyPremium, null, 2));
  fs.writeFileSync(DAILY_PREMIUM_MD, toPremiumMarkdown("Daily Premium Report", dailyPremium));
  fs.writeFileSync(WEEKLY_SUMMARY_JSON, JSON.stringify(weeklyPremium, null, 2));
  fs.writeFileSync(WEEKLY_SUMMARY_MD, toPremiumMarkdown("Weekly Premium Summary", weeklyPremium));

  const recentSignalsInput = Array.isArray(previousState?.recent_signals)
    ? previousState.recent_signals
    : [];
  const recentSignalsMerged = [
    ...recentSignalsInput,
    ...signals.map((signal) => ({
      symbol: signal.symbol,
      ts: report.generated_at
    }))
  ]
    .map((item) => ({
      symbol: String(item?.symbol || "").trim(),
      ts: toIsoTimestamp(item?.ts)
    }))
    .filter((item) => item.symbol && item.ts);
  const recentSignalRetentionMinutes = Math.max(
    parseNumber(signalDiagnostics?.filters?.symbol_cooldown_minutes, 120) * 6,
    1440
  );
  const recentSignalCutoffMs = Date.now() - (recentSignalRetentionMinutes * 60000);
  const recentSignals = recentSignalsMerged
    .filter((item) => {
      const millis = new Date(item.ts).getTime();
      return Number.isFinite(millis) && millis >= recentSignalCutoffMs;
    })
    .slice(-500);

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        fingerprint,
        last_reported_at: report.generated_at,
        history: historyAfterRun,
        recent_signals: recentSignals,
        premium_windows: {
          daily_key: dailyWindowKey,
          weekly_key: weeklyWindowKey
        },
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
