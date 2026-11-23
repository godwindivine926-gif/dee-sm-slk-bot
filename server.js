require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

for (const [name, value] of [
  ["BOT_TOKEN", BOT_TOKEN],
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_KEY],
  ["TWELVE_DATA_API_KEY", TWELVE_DATA_API_KEY]
]) {
  if (!value) {
    console.warn(`Warning: Missing environment variable ${name}.`);
  }
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const WAT_OFFSET_MS = 60 * 60 * 1000;

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json"
};

const activeChecks = new Set();

// =====================================
// GENERAL HELPERS
// =====================================

function normalizeSymbol(input) {
  let symbol = String(input || "EUR/USD")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (/^[A-Z]{6}$/.test(symbol)) {
    symbol = `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  }

  return symbol;
}

function parseChatId(chatId) {
  const numeric = Number(chatId);
  if (!Number.isSafeInteger(numeric) || numeric === 0) {
    throw new Error("Invalid Telegram chat ID.");
  }
  return numeric;
}

function getWatNow(referenceDate = new Date()) {
  return new Date(referenceDate.getTime() + WAT_OFFSET_MS);
}

async function sendMessage(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN) {
    console.error("Telegram error: BOT_TOKEN is missing.");
    return;
  }

  try {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    await axios.post(`${TELEGRAM_API}/sendMessage`, payload, {
      timeout: 10000
    });
  } catch (error) {
    console.error("Telegram error:", error.response?.data || error.message);
  }
}

function buildStorylineInlineKeyboard(symbol) {
  const compactSymbol = normalizeSymbol(symbol).replace("/", "");

  return {
    inline_keyboard: [
      [
        { text: "Break tap", callback_data: `cb:break:${compactSymbol}` },
        { text: "3CR tap", callback_data: `cb:3cr:${compactSymbol}` }
      ],
      [
        { text: "Structure", callback_data: `cb:struct:${compactSymbol}` },
        { text: "Confirmation entry", callback_data: `cb:entry:${compactSymbol}` }
      ]
    ]
  };
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!BOT_TOKEN || !callbackQueryId) return;

  try {
    await axios.post(
      `${TELEGRAM_API}/answerCallbackQuery`,
      {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      },
      { timeout: 8000 }
    );
  } catch (error) {
    console.error("Callback answer error:", error.response?.data || error.message);
  }
}

async function databaseRequest(path, method = "GET", body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase configuration is missing.");
  }

  const response = await axios({
    method,
    url: `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${path}`,
    headers: {
      ...supabaseHeaders,
      Prefer: "return=representation"
    },
    data: body,
    timeout: 10000
  });

  return response.data;
}

async function getMarketCandles(symbol, interval, outputsize = 150) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing.");
  }

  const response = await axios.get(
    "https://api.twelvedata.com/time_series",
    {
      params: {
        symbol: normalizeSymbol(symbol),
        interval,
        outputsize,
        apikey: TWELVE_DATA_API_KEY
      },
      timeout: 15000
    }
  );

  if (response.data.status === "error" || !Array.isArray(response.data.values)) {
    throw new Error(response.data.message || "Market data unavailable.");
  }

  return response.data.values;
}

function isValidOhlcCandle(candle) {
  if (!candle || !candle.datetime) return false;
  const values = [
    Number(candle.open),
    Number(candle.high),
    Number(candle.low),
    Number(candle.close)
  ];
  return values.every(Number.isFinite);
}

function bodyTop(candle) {
  return Math.max(Number(candle.open), Number(candle.close));
}

function bodyBottom(candle) {
  return Math.min(Number(candle.open), Number(candle.close));
}

function candleColor(candle) {
  const open = Number(candle.open);
  const close = Number(candle.close);

  if (close > open) return "BULLISH";
  if (close < open) return "BEARISH";
  return "DOJI";
}
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
  
function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "Not formed";
  }
  return Number(value).toString();
}

function toTimestampMs(datetimeStr, endOfDay = false) {
  const raw = String(datetimeStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Date.parse(endOfDay ? `${raw}T23:59:59Z` : `${raw}T00:00:00Z`);
  }
  return Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
}

// =====================================
// MARKET DATA VALIDATION
// =====================================

function filterCompletedDailyCandles(rawCandles) {
  const watNow = getWatNow();
  const todayWAT = watNow.toISOString().slice(0, 10);

  const candles = [];
  const excludedWeekend = [];
  const excludedUnfinished = [];

  for (const candle of rawCandles) {
    if (!candle || !candle.datetime) continue;

    const date = String(candle.datetime).slice(0, 10);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();

    if (day === 0 || day === 6) {
      excludedWeekend.push(candle.datetime);
      continue;
    }

    if (date >= todayWAT) {
      excludedUnfinished.push(candle.datetime);
      continue;
    }

    if (!isValidOhlcCandle(candle)) continue;

    candles.push(candle);
  }

  candles.sort((a, b) => a.datetime.localeCompare(b.datetime));

  return {
    candles,
    excludedWeekend,
    excludedUnfinished
  };
}

// =====================================
// COMPLETED WEEKLY CANDLE FILTER
// =====================================
function getMondayUtcDate(dateStr) {
  const dt = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const day = dt.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diffToMonday);
  return dt.toISOString().slice(0, 10);
}

function filterCompletedWeeklyCandles(rawCandles) {
  const watNow = getWatNow();
  const todayWatStr = watNow.toISOString().slice(0, 10);
  const watDay = watNow.getUTCDay(); // 0 = Sun, 1 = Mon ... 5 = Fri, 6 = Sat

  // Current trading week started on Monday of this week
  const currentWeekMonday = getMondayUtcDate(todayWatStr);

  // If today is Mon (1) through Fri (5), the current Mon-Fri week is still developing.
  // Once Sat (6) or Sun (0) arrives, the Mon-Fri week has closed.
  const isCurrentWeekClosed = watDay === 0 || watDay === 6;

  const validCandles = (Array.isArray(rawCandles) ? rawCandles : [])
    .filter(isValidOhlcCandle)
    .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));

  const candles = validCandles.filter(candle => {
    const candleDate = String(candle.datetime).slice(0, 10);
    const candleWeekMonday = getMondayUtcDate(candleDate);

    if (candleWeekMonday < currentWeekMonday) return true;
    if (candleWeekMonday === currentWeekMonday && isCurrentWeekClosed) return true;
    return false;
  });

  const developing = validCandles.filter(candle => !candles.includes(candle));

  return {
    candles,
    developing,
    excludedUnfinished: developing.map(candle => candle.datetime)
  };
}

function buildWeeklyCandlesFromDaily(d1Candles = []) {
  if (!Array.isArray(d1Candles) || d1Candles.length === 0) return [];

  const groups = new Map();
  for (const candle of d1Candles) {
        if (
      !candle ||
      !candle.datetime ||
      ![candle.open, candle.high, candle.low, candle.close].every((v) =>
        Number.isFinite(Number(v))
      )
    ) {
      continue;
        }
        const dateStr = String(candle.datetime).slice(0, 10);
    const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    const weekStart = getMondayUtcDate(dateStr);

    if (!groups.has(weekStart)) {
      groups.set(weekStart, []);
    }
    groups.get(weekStart).push(candle);
  }

  const weekly = [];
  for (const [weekStart, days] of groups.entries()) {
    const sortedDays = [...days].sort((a, b) =>
      String(a.datetime).localeCompare(String(b.datetime))
    );
    const first = sortedDays[0];
    const last = sortedDays[sortedDays.length - 1];

    let high = -Infinity;
    let low = Infinity;
    for (const d of sortedDays) {
      high = Math.max(high, Number(d.high));
      low = Math.min(low, Number(d.low));
    }

    weekly.push({
      datetime: weekStart,
      open: String(first.open),
      high: String(high),
      low: String(low),
      close: String(last.close),
      source: "d1-fallback"
    });
  }

  return weekly.sort((a, b) => a.datetime.localeCompare(b.datetime));
}

function mergeWeeklyCandlesWithDailyFallback(w1Candles = [], d1Candles = []) {
  const base = Array.isArray(w1Candles) ? [...w1Candles] : [];
  const fallbackWeekly = buildWeeklyCandlesFromDaily(d1Candles);
  if (fallbackWeekly.length === 0) return base;

  const watNow = getWatNow();
  const todayWatStr = watNow.toISOString().slice(0, 10);
  const watDay = watNow.getUTCDay();
  const currentWeekMonday = getMondayUtcDate(todayWatStr);
  const isCurrentWeekClosed = watDay === 0 || watDay === 6;

  const lastW1Date = base.length > 0
    ? String(base[base.length - 1].datetime).slice(0, 10)
    : "";

  for (const weekCandle of fallbackWeekly) {
    const weekMonday = getMondayUtcDate(weekCandle.datetime);
    const isClosedWeek =
      weekMonday < currentWeekMonday ||
      (weekMonday === currentWeekMonday && isCurrentWeekClosed);

    if (isClosedWeek && weekCandle.datetime > lastW1Date) {
      base.push(weekCandle);
    }
  }

  return base.sort((a, b) =>
    String(a.datetime).localeCompare(String(b.datetime))
  );
}

function filterCompletedH4Candles(rawCandles) {
  const watNow = getWatNow();
  const nowIsoPrefix = watNow.toISOString().replace("T", " ").slice(0, 16);

  const valid = rawCandles
    .filter(candle => {
      if (!isValidOhlcCandle(candle)) return false;

      const dtStr = String(candle.datetime).trim();
      const datePart = dtStr.slice(0, 10);
      const day = new Date(`${datePart}T00:00:00Z`).getUTCDay();

      if (day === 0 || day === 6) return false;

      const comparable = dtStr.replace("T", " ").slice(0, 16);
      if (comparable >= nowIsoPrefix) return false;

      return true;
    })
    .sort((a, b) => a.datetime.localeCompare(b.datetime));

  return valid.length > 1 ? valid.slice(0, -1) : valid;
}

// =====================================
// W1 STORYLINE & WEEKLY KEY LEVELS
// =====================================

function detectWeeklyStoryline(candles) {
  if (!Array.isArray(candles) || candles.length < 2) {
    return {
      status: "INSUFFICIENT DATA",
      bias: "NONE",
      reason: "Not enough completed weekly candles."
    };
  }

  const previous = candles[candles.length - 2];
  const latest = candles[candles.length - 1];

  const previousHigh = Number(previous.high);
  const previousLow = Number(previous.low);
  const latestHigh = Number(latest.high);
  const latestLow = Number(latest.low);
  const latestClose = Number(latest.close);

  if (latestHigh > previousHigh && latestClose < previousHigh) {
    return {
      status: "DEVELOPING",
      bias: "BEARISH",
      formation: "PREVIOUS-WEEK-HIGH-SWEEP",
      reason: "Previous Weekly High swept and candle closed below it.",
      key_level: previousHigh,
      first_candle: previous.datetime,
      reaction_date: latest.datetime
    };
  }

  if (latestLow < previousLow && latestClose > previousLow) {
    return {
      status: "DEVELOPING",
      bias: "BULLISH",
      formation: "PREVIOUS-WEEK-LOW-SWEEP",
      reason: "Previous Weekly Low swept and candle closed above it.",
      key_level: previousLow,
      first_candle: previous.datetime,
      reaction_date: latest.datetime
    };
  }

  const previousColor = candleColor(previous);
  const latestColor = candleColor(latest);

  if (previousColor === "BULLISH" && latestColor === "BEARISH") {
    return {
      status: "DEVELOPING",
      bias: "BEARISH",
      formation: "A-SHAPE",
      reason: "Weekly A-shape formation detected.",
      key_level: Math.max(bodyTop(previous), bodyTop(latest)),
      first_candle: previous.datetime,
      reaction_date: latest.datetime
    };
  }

  if (previousColor === "BEARISH" && latestColor === "BULLISH") {
    return {
      status: "DEVELOPING",
      bias: "BULLISH",
      formation: "V-SHAPE",
      reason: "Weekly V-shape formation detected.",
      key_level: Math.min(bodyBottom(previous), bodyBottom(latest)),
      first_candle: previous.datetime,
      reaction_date: latest.datetime
    };
  }

  const firstClose = Number(previous.close);
  const secondOpen = Number(latest.open);

  if (
    firstClose !== secondOpen &&
    previousColor === "BULLISH" &&
    latestColor === "BULLISH"
  ) {
    return {
      status: "DEVELOPING",
      bias: "BULLISH",
      formation: "BULLISH-OPEN-CLOSE",
      reason: "Two consecutive bullish weekly candles formed an Open/Close gap.",
      key_level: {
        low: Math.min(firstClose, secondOpen),
        high: Math.max(firstClose, secondOpen)
      },
      first_candle: previous.datetime,
      reaction_date: latest.datetime
    };
  }

  if (
    firstClose !== secondOpen &&
    previousColor === "BEARISH" &&
    latestColor === "BEARISH"
  ) {
    return {
      status: "DEVELOPING",
      bias: "BEARISH",
      formation: "BEARISH-OPEN-CLOSE",
      reason: "Two consecutive bearish weekly candles formed an Open/Close gap.",
      key_level: {
        low: Math.min(firstClose, secondOpen),
        high: Math.max(firstClose, secondOpen)
      },
      first_candle: previous.datetime,
      reaction_date: latest.datetime
    };
  }

  return {
    status: "NO STORYLINE",
    bias: "NONE",
    reason: "No qualifying weekly reaction detected on the latest completed candle pair."
  };
}

function detectWeeklyKeyLevels(w1Candles) {
  const levels = [];

  for (let i = 1; i < w1Candles.length; i++) {
    const first = w1Candles[i - 1];
    const second = w1Candles[i];

    const firstColor = candleColor(first);
    const secondColor = candleColor(second);

    if (firstColor === "BULLISH" && secondColor === "BEARISH") {
      levels.push({
        type: "A-SHAPE",
        bias: "BEARISH",
        first_candle: first.datetime,
        second_candle: second.datetime,
        formation_index: i,
        low: Math.min(bodyTop(first), bodyTop(second)),
        high: Math.max(bodyTop(first), bodyTop(second))
      });
    }

    if (firstColor === "BEARISH" && secondColor === "BULLISH") {
      levels.push({
        type: "V-SHAPE",
        bias: "BULLISH",
        first_candle: first.datetime,
        second_candle: second.datetime,
        formation_index: i,
        low: Math.min(bodyBottom(first), bodyBottom(second)),
        high: Math.max(bodyBottom(first), bodyBottom(second))
      });
    }

    if (firstColor === secondColor && firstColor !== "DOJI") {
      const firstClose = Number(first.close);
      const secondOpen = Number(second.open);

      if (firstClose !== secondOpen) {
        levels.push({
          type: "OPEN-CLOSE",
          bias: firstColor === "BULLISH" ? "BULLISH" : "BEARISH",
          first_candle: first.datetime,
          second_candle: second.datetime,
          formation_index: i,
          low: Math.min(firstClose, secondOpen),
          high: Math.max(firstClose, secondOpen)
        });
      }
    }
  }

  return levels;
}

function detectWeeklyKeyLevelContacts(w1Candles, w1Levels) {
  const contacts = [];

  for (const level of w1Levels) {
    for (let i = level.formation_index + 1; i < w1Candles.length; i++) {
      const candle = w1Candles[i];
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);

      if (
        (level.bias === "BEARISH" && close > level.high) ||
        (level.bias === "BULLISH" && close < level.low)
      ) {
        break;
      }

      if (high >= level.low && low <= level.high) {
        contacts.push({
          type:
            level.bias === "BEARISH"
              ? "BEARISH_WEEKLY_KEY_LEVEL_CONTACT"
              : "BULLISH_WEEKLY_KEY_LEVEL_CONTACT",
          bias: level.bias,
          level_type: level.type,
          level_formed: level.second_candle,
          contact_date: candle.datetime,
          level_low: level.low,
          level_high: level.high
        });
        break;
      }
    }
  }

  return contacts.sort((a, b) => a.contact_date.localeCompare(b.contact_date));
}

// =====================================
// TWO-CANDLE SWING DETECTOR
// =====================================

function identifySwings(candles) {
  const swings = [];

  for (let i = 1; i < candles.length; i++) {
    const first = candles[i - 1];
    const second = candles[i];

    const firstColor = candleColor(first);
    const secondColor = candleColor(second);

    if (firstColor === "BULLISH" && secondColor === "BEARISH") {
      swings.push({
        type: "SWING_HIGH",
        date: second.datetime,
        first_candle: first.datetime,
        second_candle: second.datetime,
        index: i,
        level: Math.max(bodyTop(first), bodyTop(second))
      });
    }

    if (firstColor === "BEARISH" && secondColor === "BULLISH") {
      swings.push({
        type: "SWING_LOW",
        date: second.datetime,
        first_candle: first.datetime,
        second_candle: second.datetime,
        index: i,
        level: Math.min(bodyBottom(first), bodyBottom(second))
      });
    }
  }

  return swings;
}

// =====================================
// DAILY KEY-LEVEL DETECTOR & TRACKER
// =====================================

function detectDailyKeyLevels(candles) {
  const levels = [];

  for (let i = 1; i < candles.length; i++) {
    const first = candles[i - 1];
    const second = candles[i];

    const firstColor = candleColor(first);
    const secondColor = candleColor(second);

    if (firstColor === "BULLISH" && secondColor === "BEARISH") {
      levels.push({
        type: "A-SHAPE",
        bias: "BEARISH",
        first_candle: first.datetime,
        second_candle: second.datetime,
        formation_index: i,
        low: Math.min(bodyTop(first), bodyTop(second)),
        high: Math.max(bodyTop(first), bodyTop(second)),
        status: "FORMED"
      });
    }

    if (firstColor === "BEARISH" && secondColor === "BULLISH") {
      levels.push({
        type: "V-SHAPE",
        bias: "BULLISH",
        first_candle: first.datetime,
        second_candle: second.datetime,
        formation_index: i,
        low: Math.min(bodyBottom(first), bodyBottom(second)),
        high: Math.max(bodyBottom(first), bodyBottom(second)),
        status: "FORMED"
      });
    }

    if (firstColor === secondColor && firstColor !== "DOJI") {
      const firstClose = Number(first.close);
      const secondOpen = Number(second.open);

      if (firstClose !== secondOpen) {
        levels.push({
          type: "OPEN-CLOSE",
          bias: firstColor === "BULLISH" ? "BULLISH" : "BEARISH",
          first_candle: first.datetime,
          second_candle: second.datetime,
          formation_index: i,
          low: Math.min(firstClose, secondOpen),
          high: Math.max(firstClose, secondOpen),
          status: "FORMED"
        });
      }
    }
  }

  return levels;
}

function detectDailyKeyLevelReactions(candles, levels) {
  const reactions = [];
  const seen = new Set();

  for (const level of levels) {
    for (let i = level.formation_index + 1; i < candles.length; i++) {
      const candle = candles[i];
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);

      const touched = high >= level.low && low <= level.high;
      if (!touched) continue;

      let reaction = null;

      if (level.bias === "BEARISH" && close < level.low) {
        reaction = "BEARISH_KEY_LEVEL_REACTION";
      } else if (level.bias === "BULLISH" && close > level.high) {
        reaction = "BULLISH_KEY_LEVEL_REACTION";
      }

      if (!reaction) continue;

      const uniqueKey = `${level.type}-${level.first_candle}-${level.second_candle}-${candle.datetime}`;
      if (!seen.has(uniqueKey)) {
        seen.add(uniqueKey);
        reactions.push({
          type: reaction,
          level_type: level.type,
          level_formed: level.second_candle,
          date: candle.datetime,
          level_low: level.low,
          level_high: level.high,
          close
        });
      }

      break;
    }
  }

  return reactions.sort((a, b) => b.date.localeCompare(a.date));
}

function trackDailyKeyLevels(candles, levels) {
  return levels.map(level => {
    let status = "ACTIVE";
    let reaction = null;
    let invalidation = null;

    for (let i = level.formation_index + 1; i < candles.length; i++) {
      const candle = candles[i];
      const close = Number(candle.close);
      const high = Number(candle.high);
      const low = Number(candle.low);

      const touched = high >= level.low && low <= level.high;

      const invalidated =
        (level.bias === "BEARISH" && close > level.high) ||
        (level.bias === "BULLISH" && close < level.low);

      if (invalidated) {
        status = "INVALIDATED";
        invalidation = {
          date: candle.datetime,
          close
        };
        continue;
      }

      if (touched) {
        const bearishReaction = level.bias === "BEARISH" && close < level.low;
        const bullishReaction = level.bias === "BULLISH" && close > level.high;

        if (bearishReaction || bullishReaction) {
          status = "REACTED";
          reaction = {
            date: candle.datetime,
            close
          };
        }
      }
    }

    return {
      ...level,
      status,
      reaction,
      invalidation
    };
  });
}

// =====================================
// D1 STRUCTURE DETECTOR
// =====================================

function detectDailyStructure(candles) {
  const swings = identifySwings(candles);
  const keyLevels = detectDailyKeyLevels(candles);
  const trackedKeyLevels = trackDailyKeyLevels(candles, keyLevels);
  const keyLevelReactions = detectDailyKeyLevelReactions(candles, keyLevels);

  let latestSwingHigh = null;
  let latestSwingLow = null;

  let bearishLL = null;
  let bullishHH = null;

  let pendingLH = null;
  let pendingHL = null;

  let protectedLH = null;
  let protectedHL = null;

  let direction = "UNCONFIRMED";

  let bearishKeyLevelReached = false;
  let bullishKeyLevelReached = false;

  let bearishKeyLevelContact = null;
  let bullishKeyLevelContact = null;
  let bearishContactIndex = null;
  let lockedPreContactLH = null;

  const events = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const close = Number(candle.close);
    const high = Number(candle.high);
    const low = Number(candle.low);

    if (direction === "BULLISH" && !bullishKeyLevelReached) {
      const touchedLevel = keyLevels
        .filter(
          level =>
            level.bias === "BULLISH" &&
            level.formation_index < i &&
            high >= level.low &&
            low <= level.high
        )
        .sort((a, b) => b.formation_index - a.formation_index)[0];

      if (touchedLevel) {
        bullishKeyLevelReached = true;
        bullishKeyLevelContact = {
          date: candle.datetime,
          level_type: touchedLevel.type,
          level_formed: touchedLevel.second_candle,
          level_low: touchedLevel.low,
          level_high: touchedLevel.high,
          protected_hl: protectedHL ? { ...protectedHL } : null
        };

        events.push({
          type: "BULLISH_DAILY_KEY_LEVEL_CONTACT",
          ...bullishKeyLevelContact
        });
      }
    }

    if (direction === "BEARISH" && !bearishKeyLevelReached) {
      const touchedLevel = keyLevels
        .filter(
          level =>
            level.bias === "BEARISH" &&
            level.formation_index < i &&
            high >= level.low &&
            low <= level.high
        )
        .sort((a, b) => b.formation_index - a.formation_index)[0];

      if (touchedLevel) {
        bearishKeyLevelReached = true;
        bearishContactIndex = i;
        lockedPreContactLH = protectedLH ? { ...protectedLH } : null;

        bearishKeyLevelContact = {
          date: candle.datetime,
          level_type: touchedLevel.type,
          level_formed: touchedLevel.second_candle,
          level_low: touchedLevel.low,
          level_high: touchedLevel.high,
          protected_lh: lockedPreContactLH ? { ...lockedPreContactLH } : null
        };

        events.push({
          type: "BEARISH_DAILY_KEY_LEVEL_CONTACT",
          ...bearishKeyLevelContact
        });
      }
    }

    const formedSwings = swings.filter(swing => swing.index === i);

    for (const swing of formedSwings) {
      if (swing.type === "SWING_HIGH") {
        latestSwingHigh = swing;
        const afterBearishContact =
          bearishContactIndex !== null && swing.index > bearishContactIndex;

        if (direction === "BEARISH" && bearishLL && !afterBearishContact) {
          pendingLH = swing;
        }
      }

      if (swing.type === "SWING_LOW") {
        latestSwingLow = swing;
        if (direction === "BULLISH" && bullishHH) {
          pendingHL = swing;
        }
      }
    }

    const activeProtectedLH = lockedPreContactLH || bearishKeyLevelContact?.protected_lh || protectedLH;

    if (
      activeProtectedLH &&
      i > activeProtectedLH.index &&
      close > activeProtectedLH.level
    ) {
      events.push({
        type: "BEARISH_EBO",
        date: candle.datetime,
        close,
        broken_level: activeProtectedLH.level,
        protected_lh_date: activeProtectedLH.date
      });

      bearishKeyLevelReached = false;
      bearishKeyLevelContact = null;
      bearishContactIndex = null;
      lockedPreContactLH = null;
      protectedLH = null;
      pendingLH = null;
      protectedHL = null;
      pendingHL = null;
    }

    if (
      bullishKeyLevelReached &&
      bullishKeyLevelContact?.protected_hl &&
      i > bullishKeyLevelContact.protected_hl.index &&
      close < bullishKeyLevelContact.protected_hl.level
    ) {
      const targetHL = bullishKeyLevelContact.protected_hl;

      events.push({
        type: "BULLISH_EBO",
        date: candle.datetime,
        close,
        broken_level: targetHL.level,
        protected_hl_date: targetHL.date
      });

      bullishKeyLevelReached = false;
      bullishKeyLevelContact = null;
      protectedLH = null;
      pendingLH = null;
    }

    const canConfirmPostContactLH =
      bearishContactIndex === null || i <= bearishContactIndex;

    if (
      direction === "BEARISH" &&
      !bearishKeyLevelReached &&
      canConfirmPostContactLH &&
      bearishLL &&
      pendingLH &&
      i > pendingLH.index &&
      close < bearishLL.level
    ) {
      protectedLH = {
        date: pendingLH.date,
        index: pendingLH.index,
        level: pendingLH.level,
        confirmation_date: candle.datetime
      };

      pendingLH = null;

      events.push({
        type: "PROTECTED_LH_CONFIRMED",
        date: protectedLH.date,
        level: protectedLH.level,
        continuation_date: candle.datetime
      });
    }

    if (
      direction === "BULLISH" &&
      !bullishKeyLevelReached &&
      bullishHH &&
      pendingHL &&
      i > pendingHL.index &&
      close > bullishHH.level
    ) {
      protectedHL = {
        date: pendingHL.date,
        index: pendingHL.index,
        level: pendingHL.level,
        confirmation_date: candle.datetime
      };

      pendingHL = null;

      events.push({
        type: "PROTECTED_HL_CONFIRMED",
        date: protectedHL.date,
        level: protectedHL.level,
        continuation_date: candle.datetime
      });
    }

    if (
      latestSwingLow &&
      i > latestSwingLow.index &&
      close < latestSwingLow.level &&
      (!bearishLL || bearishLL.broken_swing_low !== latestSwingLow.level)
    ) {
      bearishLL = {
        date: candle.datetime,
        index: i,
        level: bodyBottom(candle),
        broken_swing_low: latestSwingLow.level
      };

      direction = "BEARISH";

      bullishHH = null;
      pendingHL = null;
      protectedHL = null;

      bullishKeyLevelReached = false;
      bullishKeyLevelContact = null;

      if (lockedPreContactLH) {
        protectedLH = { ...lockedPreContactLH };
        if (bearishKeyLevelContact) {
          bearishKeyLevelContact.protected_lh = { ...lockedPreContactLH };
        }
      } else {
        bearishKeyLevelReached = false;
        bearishKeyLevelContact = null;
      }

      events.push({
        type: "LL_CONFIRMED",
        date: candle.datetime,
        broken_swing_low: latestSwingLow.level,
        LL_body_bottom: bearishLL.level
      });
    }

    if (
      latestSwingHigh &&
      i > latestSwingHigh.index &&
      close > latestSwingHigh.level &&
      (!bullishHH || bullishHH.broken_swing_high !== latestSwingHigh.level)
    ) {
      bullishHH = {
        date: candle.datetime,
        index: i,
        level: bodyTop(candle),
        broken_swing_high: latestSwingHigh.level
      };

      direction = "BULLISH";

      bearishLL = null;
      pendingLH = null;
      protectedLH = null;
      lockedPreContactLH = null;
      bearishContactIndex = null;

      bearishKeyLevelReached = false;
      bearishKeyLevelContact = null;

      bullishKeyLevelReached = false;
      bullishKeyLevelContact = null;

      events.push({
        type: "HH_CONFIRMED",
        date: candle.datetime,
        broken_swing_high: latestSwingHigh.level,
        HH_body_top: bullishHH.level
      });
    }
  }

  return {
    direction,
    latestSwingHigh,
    latestSwingLow,
    bearishLL,
    bullishHH,
    pendingLH,
    pendingHL,
    protectedLH,
    protectedHL,
    bearishKeyLevelReached,
    bullishKeyLevelReached,
    bearishKeyLevelContact,
    bullishKeyLevelContact,
    swings,
    events,
    keyLevels,
    keyLevelReactions,
    trackedKeyLevels
  };
}

// =====================================
// STANDALONE H4 STRUCTURE & EBO DETECTOR
// =====================================

function detectH4Structure(h4Candles) {
  const swings = identifySwings(h4Candles);

  let latestSwingHigh = null;
  let latestSwingLow = null;

  let bullishHH = null;
  let bearishLL = null;

  let pendingHL = null;
  let pendingLH = null;

  let protectedHL = null;
  let protectedLH = null;

  let direction = "UNCONFIRMED";

  const events = [];

  for (let i = 0; i < h4Candles.length; i++) {
    const candle = h4Candles[i];
    const close = Number(candle.close);

    if (
      protectedLH &&
      i > protectedLH.index &&
      close > protectedLH.level
    ) {
      events.push({
        timeframe: "H4",
        type: "BULLISH_EBO",
        date: candle.datetime,
        close,
        broken_level: protectedLH.level,
        protected_lh_date: protectedLH.date
      });

      protectedLH = null;
      pendingLH = null;
    }

    if (
      protectedHL &&
      i > protectedHL.index &&
      close < protectedHL.level
    ) {
      events.push({
        timeframe: "H4",
        type: "BEARISH_EBO",
        date: candle.datetime,
        close,
        broken_level: protectedHL.level,
        protected_hl_date: protectedHL.date
      });

      protectedHL = null;
      pendingHL = null;
    }

    if (
      latestSwingLow &&
      i > latestSwingLow.index &&
      close < latestSwingLow.level &&
      (!bearishLL || bearishLL.broken_swing_low !== latestSwingLow.level)
    ) {
      if (direction === "BEARISH" && pendingLH && i > pendingLH.index) {
        protectedLH = {
          ...pendingLH,
          confirmation_date: candle.datetime
        };
        pendingLH = null;

        events.push({
          timeframe: "H4",
          type: "PROTECTED_LH_CONFIRMED",
          date: protectedLH.date,
          level: protectedLH.level,
          confirmation_date: candle.datetime
        });
      }

      bearishLL = {
        date: candle.datetime,
        index: i,
        level: bodyBottom(candle),
        broken_swing_low: latestSwingLow.level
      };

      direction = "BEARISH";
      bullishHH = null;
      pendingHL = null;

      events.push({
        timeframe: "H4",
        type: "LL_CONFIRMED",
        date: candle.datetime,
        level: bearishLL.level,
        broken_swing_low: latestSwingLow.level
      });
    }

    if (
      latestSwingHigh &&
      i > latestSwingHigh.index &&
      close > latestSwingHigh.level &&
      (!bullishHH || bullishHH.broken_swing_high !== latestSwingHigh.level)
    ) {
      if (direction === "BULLISH" && pendingHL && i > pendingHL.index) {
        protectedHL = {
          ...pendingHL,
          confirmation_date: candle.datetime
        };
        pendingHL = null;

        events.push({
          timeframe: "H4",
          type: "PROTECTED_HL_CONFIRMED",
          date: protectedHL.date,
          level: protectedHL.level,
          confirmation_date: candle.datetime
        });
      }

      bullishHH = {
        date: candle.datetime,
        index: i,
        level: bodyTop(candle),
        broken_swing_high: latestSwingHigh.level
      };

      direction = "BULLISH";
      bearishLL = null;
      pendingLH = null;

      events.push({
        timeframe: "H4",
        type: "HH_CONFIRMED",
        date: candle.datetime,
        level: bullishHH.level,
        broken_swing_high: latestSwingHigh.level
      });
    }

    const formedSwings = swings.filter(swing => swing.index === i);

    for (const swing of formedSwings) {
      if (swing.type === "SWING_HIGH") {
        latestSwingHigh = swing;
        if (direction === "BEARISH" && bearishLL) {
          pendingLH = swing;
        }
      }

      if (swing.type === "SWING_LOW") {
        latestSwingLow = swing;
        if (direction === "BULLISH" && bullishHH) {
          pendingHL = swing;
        }
      }
    }
  }

  return {
    timeframe: "H4",
    direction,
    latestSwingHigh,
    latestSwingLow,
    bullishHH,
    bearishLL,
    pendingHL,
    pendingLH,
    protectedHL,
    protectedLH,
    events
  };
}

// =====================================
// MULTI-TIMEFRAME PULLBACK-BREAK EBO ENGINE
// (W1 -> D1 and D1 -> H4)
// =====================================

function detectLowerTimeframePullbackBreak({
  higherTimeframe,
  lowerTimeframe,
  contactEvent,
  lowerCandles
}) {
    
  const lowerSwings = identifySwings(lowerCandles);
  const contactCutoffMs = toTimestampMs(contactEvent.contact_date, true);

  const requiredPullbackType =
    contactEvent.bias === "BEARISH" ? "SWING_LOW" : "SWING_HIGH";

  const postContactPullbacks = lowerSwings.filter(
    swing =>
      swing.type === requiredPullbackType &&
      toTimestampMs(swing.date, false) >= contactCutoffMs
  );

  const fallbackPullbacks = lowerSwings.filter(
    swing =>
      swing.type === requiredPullbackType &&
      toTimestampMs(swing.date, false) <= contactCutoffMs
  );

  const candidatePullbacks =
    postContactPullbacks.length > 0 ? postContactPullbacks : fallbackPullbacks;

  if (!candidatePullbacks.length) {
    return {
      higher_timeframe: higherTimeframe,
      lower_timeframe: lowerTimeframe,
      htf_bias: contactEvent.bias,
      htf_level_type: contactEvent.level_type,
      htf_level_formed: contactEvent.level_formed,
      htf_contact_date: contactEvent.contact_date,
      htf_zone: {
        low: contactEvent.level_low,
        high: contactEvent.level_high
      },
      status: "NO_PULLBACK_FOUND",
      pullback: null,
      ebo: null
    };
  }

  let confirmedEbo = null;
  let activePullback = candidatePullbacks[candidatePullbacks.length - 1];

  for (let p = candidatePullbacks.length - 1; p >= 0; p--) {
    const pullback = candidatePullbacks[p];
    let matchedEbo = null;

    for (let i = pullback.index + 1; i < lowerCandles.length; i++) {
      const candle = lowerCandles[i];
      const close = Number(candle.close);

      if (contactEvent.bias === "BEARISH" && close < pullback.level) {
        matchedEbo = {
          type: `BEARISH_${lowerTimeframe}_EBO`,
          date: candle.datetime,
          close,
          broken_pullback_level: pullback.level,
          pullback_date: pullback.date
        };
        break;
      }

      if (contactEvent.bias === "BULLISH" && close > pullback.level) {
        matchedEbo = {
          type: `BULLISH_${lowerTimeframe}_EBO`,
          date: candle.datetime,
          close,
          broken_pullback_level: pullback.level,
          pullback_date: pullback.date
        };
        break;
      }
    }

    if (matchedEbo) {
      confirmedEbo = matchedEbo;
      activePullback = pullback;
      break;
    }
  }
  return {
    higher_timeframe: higherTimeframe,
    lower_timeframe: lowerTimeframe,
    htf_bias: contactEvent.bias,
    htf_level_type: contactEvent.level_type,
    htf_level_formed: contactEvent.level_formed,
    htf_contact_date: contactEvent.contact_date,
    htf_zone: {
      low: contactEvent.level_low,
      high: contactEvent.level_high
    },
    status: confirmedEbo ? "EBO_CONFIRMED" : "WAITING_FOR_PULLBACK_BREAK",
    pullback: {
        type: activePullback.type,
        date: activePullback.date,
        level: activePullback.level
      },
      ebo: confirmedEbo
    };
}

function detectWeeklyToDailyEbo(w1Candles, d1Candles) {
  const w1Levels = detectWeeklyKeyLevels(w1Candles);
  const w1Contacts = detectWeeklyKeyLevelContacts(w1Candles, w1Levels);

  if (!w1Contacts.length) {
    return {
      status: "NO_WEEKLY_KEY_LEVEL_CONTACT",
      latest_contact: null,
      all_setups: []
    };
  }

  const setups = w1Contacts.map(contact =>
    detectLowerTimeframePullbackBreak({
      higherTimeframe: "W1",
      lowerTimeframe: "D1",
      contactEvent: contact,
      lowerCandles: d1Candles
    })
  );

  return {
    status: "OK",
    latest_setup: setups[setups.length - 1],
    all_setups: setups
  };
}

function detectDailyToH4Ebo(d1Candles, h4Candles) {
  const d1Levels = detectDailyKeyLevels(d1Candles);
  const d1Contacts = [];

  for (const level of d1Levels) {
    for (let i = level.formation_index + 1; i < d1Candles.length; i++) {
      const candle = d1Candles[i];
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);

      if (
        (level.bias === "BEARISH" && close > level.high) ||
        (level.bias === "BULLISH" && close < level.low)
      ) {
        break;
      }

      if (high >= level.low && low <= level.high) {
        d1Contacts.push({
          bias: level.bias,
          level_type: level.type,
          level_formed: level.second_candle,
          contact_date: candle.datetime,
          level_low: level.low,
          level_high: level.high
        });
        break;
      }
    }
  }

  d1Contacts.sort((a, b) => a.contact_date.localeCompare(b.contact_date));

  if (!d1Contacts.length) {
    return {
      status: "NO_DAILY_KEY_LEVEL_CONTACT",
      latest_setup: null,
      all_setups: []
    };
  }

  const setups = d1Contacts.map(contact =>
    detectLowerTimeframePullbackBreak({
      higherTimeframe: "D1",
      lowerTimeframe: "H4",
      contactEvent: contact,
      lowerCandles: h4Candles
    })
  );

  return {
    status: "OK",
    latest_setup: setups[setups.length - 1],
    all_setups: setups
  };
}
function prepareStorylineCandles(rawCandles, { excludeWeekends = true } = {}) {
  if (!Array.isArray(rawCandles)) return [];

  return rawCandles
    .filter(candle => {
      if (!isValidOhlcCandle(candle)) return false;
      if (!excludeWeekends) return true;

      const datePart = String(candle.datetime).trim().slice(0, 10);
      const day = new Date(`${datePart}T00:00:00Z`).getUTCDay();
      return day !== 0 && day !== 6;
    })
    .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
}

function detectH4TapAndM30Breakout(
  h4Candles,
  m30Candles,
  bias = "BULLISH",
  { isH4Active = false, d1TapDatetime = null, maxH4AgeCandles = 20 } = {}
) {
  const normalizedBias = bias === "BULLISH" || bias === "BEARISH" ? bias : null;

  if (!isH4Active || !normalizedBias) {
    return {
      h4Ebo: null,
      h4Tap: null,
      m30Breakout: null,
      status: "H4_NOT_ACTIVE"
    };
  }

  const safeH4 = prepareStorylineCandles(h4Candles, { excludeWeekends: true });
  const safeM30 = prepareStorylineCandles(m30Candles, { excludeWeekends: true });

  if (safeH4.length < 3) {
    return {
      h4Ebo: null,
      h4Tap: null,
      m30Breakout: null,
      status: "INSUFFICIENT_H4_DATA"
    };
  }

  const isBull = normalizedBias === "BULLISH";
  const d1TapTs = d1TapDatetime ? toTimestampMs(d1TapDatetime, false) : null;
  const minAllowedH4Index = Math.max(0, safeH4.length - maxH4AgeCandles);

  // 1. Find H4 external body breakout at or after D1 tap
  const h4BodySwings = [];
  for (let i = 1; i < safeH4.length - 1; i++) {
    const prevTop = bodyTop(safeH4[i - 1]);
    const currTop = bodyTop(safeH4[i]);
    const nextTop = bodyTop(safeH4[i + 1]);

    const prevBot = bodyBottom(safeH4[i - 1]);
    const currBot = bodyBottom(safeH4[i]);
    const nextBot = bodyBottom(safeH4[i + 1]);

    if (isBull && currTop >= prevTop && currTop >= nextTop) {
      h4BodySwings.push({ type: "BODY_HIGH", index: i, level: currTop, date: safeH4[i].datetime });
    }
    if (!isBull && currBot <= prevBot && currBot <= nextBot) {
      h4BodySwings.push({ type: "BODY_LOW", index: i, level: currBot, date: safeH4[i].datetime });
    }
  }

  let h4Ebo = null;
  let h4EboIndex = -1;

  for (let i = minAllowedH4Index; i < safeH4.length; i++) {
    const c = safeH4[i];
    const cTs = toTimestampMs(c.datetime, false);
    if (Number.isFinite(d1TapTs) && Number.isFinite(cTs) && cTs < d1TapTs) {
      continue;
    }

    const priorSwings = h4BodySwings.filter(sw => sw.index < i);
    if (!priorSwings.length) continue;

    const targetSwing = priorSwings[priorSwings.length - 1];
    const close = Number(c.close);
    const brokeExternal = isBull ? close > targetSwing.level : close < targetSwing.level;

    if (brokeExternal) {
      h4Ebo = {
        type: `${normalizedBias}_H4_EBO`,
        broken_level: targetSwing.level,
        close,
        date: c.datetime
      };
      h4EboIndex = i;
      break;
    }
  }

  if (!h4Ebo || h4EboIndex < 0) {
    return {
      h4Ebo: null,
      h4Tap: null,
      m30Breakout: null,
      status: "WAITING_H4_EBO"
    };
  }

  // 2. Find H4 tap into the broken external body level or H4 key level at/after H4 EBO
  const h4KeyLevels = detectDailyKeyLevels(safeH4);
  const candidateH4Levels = [
    {
      label: "H4 EBO BODY LEVEL",
      low: Number(h4Ebo.broken_level),
      high: Number(h4Ebo.broken_level),
      price: Number(h4Ebo.broken_level)
    },
    {
      label: "H4 BREAK CLOSE",
      low: Number(h4Ebo.close),
      high: Number(h4Ebo.close),
      price: Number(h4Ebo.close)
    }
  ];

  for (const kl of h4KeyLevels) {
    if (kl.formation_index <= h4EboIndex && kl.bias === normalizedBias) {
      const low = Math.min(Number(kl.low), Number(kl.high));
      const high = Math.max(Number(kl.low), Number(kl.high));
      if (Number.isFinite(low) && Number.isFinite(high)) {
        candidateH4Levels.push({
          label: `${kl.type} KEY LEVEL`,
          low,
          high,
          price: isBull ? low : high
        });
      }
    }
  }

  let h4Tap = null;
  for (let i = h4EboIndex; i < safeH4.length; i++) {
    const c = safeH4[i];
    const high = Number(c.high);
    const low = Number(c.low);
    const matched = candidateH4Levels.find(kl => low <= kl.high && high >= kl.low);
    if (matched) {
      h4Tap = {
        label: matched.label,
        price: matched.price,
        datetime: c.datetime,
        index: i
      };
      break;
    }
  }

  if (!h4Tap) {
    return {
      h4Ebo,
      h4Tap: null,
      m30Breakout: null,
      status: "WAITING_H4_KEY_LEVEL_TAP"
    };
  }

  // 3. Find 30M body-close breakout after H4 tap in the storyline bias
  const tapTs = toTimestampMs(h4Tap.datetime, false);
  const postTapM30 = safeM30.filter(c => toTimestampMs(c.datetime, false) >= tapTs);

  let m30Breakout = null;
  if (postTapM30.length >= 3) {
    const m30BodySwings = [];
    for (let i = 1; i < postTapM30.length - 1; i++) {
      const prevTop = bodyTop(postTapM30[i - 1]);
      const currTop = bodyTop(postTapM30[i]);
      const nextTop = bodyTop(postTapM30[i + 1]);

      const prevBot = bodyBottom(postTapM30[i - 1]);
      const currBot = bodyBottom(postTapM30[i]);
      const nextBot = bodyBottom(postTapM30[i + 1]);

      if (isBull && currTop >= prevTop && currTop >= nextTop) {
        m30BodySwings.push({ index: i, level: currTop });
      }
      if (!isBull && currBot <= prevBot && currBot <= nextBot) {
        m30BodySwings.push({ index: i, level: currBot });
      }
    }

    for (let i = 1; i < postTapM30.length; i++) {
      const prior = m30BodySwings.filter(sw => sw.index < i);
      if (!prior.length) continue;

      const refLevel = prior[prior.length - 1].level;
      const close = Number(postTapM30[i].close);
      const broke30m = isBull ? close > refLevel : close < refLevel;

      if (broke30m) {
        m30Breakout = {
          direction: normalizedBias,
          level: refLevel,
          close,
          datetime: postTapM30[i].datetime
        };
        break;
      }
    }
  }

  return {
    h4Ebo,
    h4Tap,
    m30Breakout,
    status: m30Breakout ? "M30_BREAKOUT_CONFIRMED" : "WAITING_M30_BREAKOUT"
  };
    }
                              
function formatBreakDate12h(rawDate) {
  if (!rawDate) return "N/A";
  const str = String(rawDate).trim();

  // Date-only strings (e.g., 2026-11-16) stay as date strings
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  const parsedMs = toTimestampMs(str, false);
  if (!Number.isFinite(parsedMs)) return str;

  const watDate = new Date(parsedMs + WAT_OFFSET_MS);
  const datePart = watDate.toISOString().slice(0, 10);
  let hour = watDate.getUTCHours();
  const minutePart = String(watDate.getUTCMinutes()).padStart(2, "0");
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  const hourPart = String(hour).padStart(2, "0");

  return `${datePart} ${hourPart}:${minutePart} ${ampm} WAT`;
}

function evaluateTfStoryline(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { ebo: null, ibo: null, retestTap: null, latestBreak: null, hasBreak: false };
  }

  const { bias, preTapSwing, pullbackSwing, keyLevels = [] } = opts;
  let ebo = null;
  let ibo = null;
  let retestTap = null;

  if (preTapSwing && Number.isFinite(Number(preTapSwing.level))) {
    const startIdx = Math.max(0, Number(preTapSwing.index ?? 0) + 1);
    const lvl = Number(preTapSwing.level);

    for (let i = startIdx; i < candles.length; i++) {
      const close = Number(candles[i].close);
      if (Number.isNaN(close)) continue;

      const broke = (bias === "BULLISH" && close < lvl) || (bias === "BEARISH" && close > lvl);
      if (broke) {
        ebo = {
          type: "EBO",
          level: lvl,
          close,
          datetime: candles[i].datetime || candles[i].date,
          index: i
        };
        break;
      }
    }
  }

    if (!ibo && (bias === "BULLISH" || bias === "BEARISH") && candles.length >= 3) {
    const swings = identifySwings(candles);
    const requiredSwingType = bias === "BEARISH" ? "SWING_LOW" : "SWING_HIGH";
    const minIndex = ebo ? ebo.index + 1 : 1;

    const candidateSwings = swings.filter(
      sw => sw.type === requiredSwingType && sw.index < candles.length - 1
    );

    for (let p = candidateSwings.length - 1; p >= 0; p--) {
      const sw = candidateSwings[p];
      const startIdx = Math.max(minIndex, sw.index + 1);
      let matchedIbo = null;

      for (let i = startIdx; i < candles.length; i++) {
        const close = Number(candles[i].close);
        if (Number.isNaN(close)) continue;

        const broke =
          (bias === "BULLISH" && close > sw.level) ||
          (bias === "BEARISH" && close < sw.level);

        if (broke) {
          matchedIbo = {
            type: "IBO",
            level: sw.level,
            close,
            datetime: candles[i].datetime || candles[i].date,
            index: i
          };
          break;
        }
      }

      if (matchedIbo) {
        ibo = matchedIbo;
        break;
      }
    }
    }
  
  const latestBreak =
    ebo && ibo ? (ibo.index >= ebo.index ? ibo : ebo) : ibo || ebo || null;

  const candidateLevels = [];
  if (Array.isArray(keyLevels)) {
    for (const kl of keyLevels) {
      if (!kl) continue;
      const low = Number(kl.low ?? kl.level);
      const high = Number(kl.high ?? kl.level);
      if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
            candidateLevels.push({
        label: kl.type || "KEY LEVEL",
        bias: kl.bias || null,
        low: Math.min(low, high),
        high: Math.max(low, high),
        price: Number(kl.level ?? kl.high ?? kl.low),
        formedIndex: Number.isFinite(Number(kl.formation_index)) ? Number(kl.formation_index) : -1
      });
    }
  }

  if (ebo && Number.isFinite(Number(ebo.level))) {
    candidateLevels.push({
      label: "EXTERNAL BO",
      low: Number(ebo.level),
      high: Number(ebo.level),
      price: Number(ebo.level),
      formedIndex: ebo.index
    });
  }

  if (ibo && Number.isFinite(Number(ibo.level))) {
    candidateLevels.push({
      label: "INTERNAL BO",
      low: Number(ibo.level),
      high: Number(ibo.level),
      price: Number(ibo.level),
      formedIndex: ibo.index
    });
  }

  if (latestBreak && candidateLevels.length > 0) {
    for (let i = latestBreak.index + 1; i < candles.length; i++) {
      const high = Number(candles[i].high);
      const low = Number(candles[i].low);
      if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

            const matchingLevels = candidateLevels.filter(
        kl =>
          kl.formedIndex < i &&
          low <= kl.high &&
          high >= kl.low &&
          (!kl.bias || !bias || bias === "NEUTRAL" || kl.bias === bias)
      );

      const tappedLevel = matchingLevels[matchingLevels.length - 1] || null;
      
  if (tappedLevel) {
        retestTap = {
          label: tappedLevel.label,
          level: tappedLevel.price,
          datetime: candles[i].datetime || candles[i].date,
          index: i
        };
        break;
      }
    }
  }

  return {
    ebo,
    ibo,
    retestTap,
    latestBreak,
    hasBreak: Boolean(latestBreak)
  };
}

const reportCache = new Map();
const REPORT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getCachedStorylineReport(rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol || "GBPUSD");
  const cached = reportCache.get(symbol);

  if (cached && Date.now() - cached.timestamp < REPORT_CACHE_TTL_MS) {
    return cached.report;
  }

  const report = await buildStorylineReport(symbol);
  reportCache.set(symbol, { report, timestamp: Date.now() });
  return report;
}
function computeWeeklyTarget(w1Candles, direction, currentPrice) {
  if (!Array.isArray(w1Candles) || w1Candles.length < 3 || !direction || direction === "NONE" || direction === "UNCLEAR") {
    return null;
  }

  const completed = w1Candles.slice(0, -1);
  const price = Number(currentPrice ?? w1Candles[w1Candles.length - 1]?.close);

  if (direction === "BULLISH") {
    let bestHigh = null;
    for (let i = 1; i < completed.length - 1; i++) {
      const prev = completed[i - 1];
      const curr = completed[i];
      const next = completed[i + 1];
      const isSwingHigh = curr.high >= prev.high && curr.high >= next.high;
      if (isSwingHigh && (!Number.isFinite(price) || curr.high > price)) {
        bestHigh = {
          price: curr.high,
          date: curr.datetime || curr.date || null,
          label: "W1 ERL High"
        };
      }
    }
    if (bestHigh) return bestHigh;

    const prevWeek = completed[completed.length - 1];
    return prevWeek ? {
      price: prevWeek.high,
      date: prevWeek.datetime || prevWeek.date || null,
      label: "Prev W1 High"
    } : null;
  }

  if (direction === "BEARISH") {
    let bestLow = null;
    for (let i = 1; i < completed.length - 1; i++) {
      const prev = completed[i - 1];
      const curr = completed[i];
      const next = completed[i + 1];
      const isSwingLow = curr.low <= prev.low && curr.low <= next.low;
      if (isSwingLow && (!Number.isFinite(price) || curr.low < price)) {
        bestLow = {
          price: curr.low,
          date: curr.datetime || curr.date || null,
          label: "W1 ERL Low"
        };
      }
    }
    if (bestLow) return bestLow;

    const prevWeek = completed[completed.length - 1];
    return prevWeek ? {
      price: prevWeek.low,
      date: prevWeek.datetime || prevWeek.date || null,
      label: "Prev W1 Low"
    } : null;
  }

  return null;
}

function computeDailyIntradayTarget(d1Candles, direction, currentPrice) {
  if (!Array.isArray(d1Candles) || d1Candles.length < 4 || !direction || direction === "NONE" || direction === "UNCLEAR") {
    return null;
  }

  const completed = d1Candles.slice(0, -1);
  const price = Number(currentPrice ?? d1Candles[d1Candles.length - 1]?.close);

  if (direction === "BEARISH") {
    for (let i = completed.length - 1; i >= 2; i--) {
      const curr = completed[i];
      const priorLow = Math.min(completed[i - 1].low, completed[i - 2].low);
      const brokeDownBody = curr.close < priorLow;
      if (brokeDownBody && (!Number.isFinite(price) || priorLow < price)) {
        return {
          price: priorLow,
          date: completed[i - 1].datetime || completed[i - 1].date || null,
          label: "Last D1 Breakout Low"
        };
      }
    }
    const fallbackLow = Math.min(...completed.slice(-3).map(c => c.low));
    return Number.isFinite(fallbackLow) ? {
      price: fallbackLow,
      date: null,
      label: "D1 Swing Low"
    } : null;
  }

  if (direction === "BULLISH") {
    for (let i = completed.length - 1; i >= 2; i--) {
      const curr = completed[i];
      const priorHigh = Math.max(completed[i - 1].high, completed[i - 2].high);
      const brokeUpBody = curr.close > priorHigh;
      if (brokeUpBody && (!Number.isFinite(price) || priorHigh > price)) {
        return {
          price: priorHigh,
          date: completed[i - 1].datetime || completed[i - 1].date || null,
          label: "Last D1 Breakout High"
        };
      }
    }
    const fallbackHigh = Math.max(...completed.slice(-3).map(c => c.high));
    return Number.isFinite(fallbackHigh) ? {
      price: fallbackHigh,
      date: null,
      label: "D1 Swing High"
    } : null;
  }

  return null;
}
function buildLiveD1CandlesWithDeveloping(rawD1, completedD1Candles) {
  const base = Array.isArray(completedD1Candles) ? [...completedD1Candles] : [];
  if (!Array.isArray(rawD1)) return base;

  const lastCompletedDt = base.length
    ? String(base[base.length - 1].datetime).slice(0, 10)
    : "";

  const extra = rawD1
    .filter(c => {
      if (!isValidOhlcCandle(c)) return false;
      const dateStr = String(c.datetime).slice(0, 10);
      const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
      if (day === 0 || day === 6) return false;
      return dateStr > lastCompletedDt;
    })
    .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));

  return [...base, ...extra];
}

function detectDevelopingD1TapAfterBreak(liveD1Candles, d1State, bias) {
  if (!d1State?.latestBreak || !Array.isArray(liveD1Candles) || liveD1Candles.length < 2) {
    return null;
  }

  const latestBreak = d1State.latestBreak;
  const breakIdx = Number.isFinite(Number(latestBreak.index))
    ? Number(latestBreak.index)
    : -1;
  const breakLevel = Number(latestBreak.level ?? latestBreak.price);
  const breakClose = Number(latestBreak.close);
  const breakCandle =
    breakIdx >= 0 && breakIdx < liveD1Candles.length ? liveD1Candles[breakIdx] : null;

  // Focus specifically on the developing D1 candle (the last bar in liveD1Candles)
  const devIndex = liveD1Candles.length - 1;
  if (breakIdx >= 0 && devIndex <= breakIdx) return null;

  const devCandle = liveD1Candles[devIndex];
  const devHigh = Number(devCandle?.high);
  const devLow = Number(devCandle?.low);
  if (!Number.isFinite(devHigh) || !Number.isFinite(devLow)) return null;

  const candidateLevels = [];

  // 1. Most recent breakout level
  if (Number.isFinite(breakLevel)) {
    candidateLevels.push({
      label: latestBreak.type === "IBO" ? "INTERNAL BO" : "EXTERNAL BO",
      low: breakLevel,
      high: breakLevel,
      price: breakLevel,
      formedIndex: breakIdx
    });
  }

  // 2. Most recent breakout candle open / close levels
  if (Number.isFinite(breakClose)) {
    candidateLevels.push({
      label: "RECENT BO CLOSE",
      low: breakClose,
      high: breakClose,
      price: breakClose,
      formedIndex: breakIdx
    });
  }
  if (breakCandle) {
    const bOpen = Number(breakCandle.open);
    const bClose = Number(breakCandle.close);
    if (Number.isFinite(bOpen)) {
      candidateLevels.push({
        label: "RECENT BO OPEN",
        low: bOpen,
        high: bOpen,
        price: bOpen,
        formedIndex: breakIdx
      });
    }
    if (Number.isFinite(bClose)) {
      candidateLevels.push({
        label: "RECENT BO CLOSE",
        low: bClose,
        high: bClose,
        price: bClose,
        formedIndex: breakIdx
      });
    }
  }

  // 3. Most recent A-shape / V-shape / open-close key level tied to the latest move
  const recentKeyLevels = Array.isArray(d1State.keyLevels)
    ? d1State.keyLevels
        .filter(kl => {
          if (!kl) return false;
          const fIdx = Number(kl.formation_index);
          if (!Number.isFinite(fIdx) || fIdx >= devIndex) return false;
          const biasOk = !bias || bias === "NEUTRAL" || !kl.bias || kl.bias === bias;
          const nearLatestBreak = breakIdx < 0 || fIdx >= Math.max(0, breakIdx - 3);
          return biasOk && nearLatestBreak;
        })
        .slice(-2)
    : [];

  for (const kl of recentKeyLevels) {
    const kLow = Math.min(Number(kl.low), Number(kl.high));
    const kHigh = Math.max(Number(kl.low), Number(kl.high));
    if (Number.isFinite(kLow) && Number.isFinite(kHigh)) {
      candidateLevels.push({
        label: kl.type || "RECENT KEY LEVEL",
        low: kLow,
        high: kHigh,
        price: bias === "BEARISH" ? kHigh : kLow,
        formedIndex: Number(kl.formation_index)
      });
    }
  }

  // Check from most specific/recent level backward
  for (let k = candidateLevels.length - 1; k >= 0; k--) {
    const kl = candidateLevels[k];
    if (kl.formedIndex >= 0 && kl.formedIndex >= devIndex) continue;

    // Require actual physical reach into the level from the pullback side
    const physicalTouch =
      bias === "BULLISH"
        ? devLow <= kl.high && devHigh >= kl.low
        : bias === "BEARISH"
          ? devHigh >= kl.low && devLow <= kl.high
          : devLow <= kl.high && devHigh >= kl.low;

    if (physicalTouch) {
      return {
        label: kl.label,
        level: kl.price,
        price: kl.price,
        datetime: devCandle.datetime || devCandle.date,
        index: devIndex,
        isDeveloping: true
      };
    }
  }

  return null;
}

function findH4BreakAfterTap(h4Candles, bias, afterTs = null) {
  const afterMs = afterTs === null || afterTs === undefined ? NaN : toTimestampMs(afterTs, false);
  if (!Number.isFinite(afterMs) || !Array.isArray(h4Candles) || h4Candles.length < 3) {
    return null;
    console.log("findH4BreakAfterTap check:", {
    bias,
    afterMs,
    recentCandles: h4Candles.slice(-3).map((c) => {
      const dt = c.datetime || c.date;
      return {
        dt,
        cTs: dt ? toTimestampMs(dt, false) : NaN,
        close: Number(c.close),
        bot: bodyBottom(c)
      };
    })
  });
  }

  const isBull = bias === "BULLISH";
  const isBear = bias === "BEARISH";
  if (!isBull && !isBear) return null;

  const bodySwings = [];
  for (let i = 1; i < h4Candles.length - 1; i++) {
    const prev = h4Candles[i - 1];
    const curr = h4Candles[i];
    const next = h4Candles[i + 1];
    const dt = curr.datetime || curr.date;

    const prevTop = bodyTop(prev);
    const currTop = bodyTop(curr);
    const nextTop = bodyTop(next);
    const prevBot = bodyBottom(prev);
    const currBot = bodyBottom(curr);
    const nextBot = bodyBottom(next);

    if (isBull && currTop >= prevTop && currTop >= nextTop) {
      bodySwings.push({ index: i, level: currTop, date: dt });
    }
    if (isBear && currBot <= prevBot && currBot <= nextBot) {
      bodySwings.push({ index: i, level: currBot, date: dt });
    }
  }

  for (let i = 1; i < h4Candles.length; i++) {
    const c = h4Candles[i];
    const dt = c.datetime || c.date;
    const cTs = dt ? toTimestampMs(dt, false) : NaN;
    if (!Number.isFinite(cTs) || cTs < afterMs) continue;

    const close = Number(c.close);
    if (!Number.isFinite(close)) continue;

    const priorSwings = bodySwings.filter(sw => sw.index < i);
    if (!priorSwings.length) continue;

    const target = priorSwings[priorSwings.length - 1];
    const brokeExternal = isBull ? close > target.level : close < target.level;
    if (brokeExternal) {
      return {
        type: "H4 EBO",
        kind: "EXTERNAL_BO",
        price: close,
        level: target.level,
        datetime: dt
      };
    }
  }

  const swings = identifySwings(h4Candles);
  const reqSwingType = isBear ? "SWING_LOW" : "SWING_HIGH";
  const intSwings = swings.filter(sw => sw.type === reqSwingType);

  for (let i = 1; i < h4Candles.length; i++) {
    const c = h4Candles[i];
    const dt = c.datetime || c.date;
    const cTs = dt ? toTimestampMs(dt, false) : NaN;
    if (!Number.isFinite(cTs) || cTs < afterMs) continue;

    const close = Number(c.close);
    if (!Number.isFinite(close)) continue;

    const prior = intSwings.filter(sw => sw.index < i);
    if (!prior.length) continue;

    const target = prior[prior.length - 1];
    const brokeInternal = isBull ? close > target.level : close < target.level;
    if (brokeInternal) {
      return {
        type: "H4 IBO",
        kind: "INTERNAL_BO",
        price: close,
        level: target.level,
        datetime: dt
      };
    }
  }

  return null;
}
  
async function buildStorylineReport(rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol || "GBPUSD");
  
  const rawW1 = await getMarketCandles(symbol, "1week", 100);
  await new Promise(resolve => setTimeout(resolve, 8500));
  const rawD1 = await getMarketCandles(symbol, "1day", 150);
  await new Promise(resolve => setTimeout(resolve, 8500));
  const rawH4 = await getMarketCandles(symbol, "4h", 150);

    const d1Candles = filterCompletedDailyCandles(rawD1).candles;
  const h4Candles = filterCompletedH4Candles(rawH4);
  const mergedW1 = mergeWeeklyCandlesWithDailyFallback(
    filterCompletedWeeklyCandles(rawW1).candles,
    d1Candles
  );
  const w1Candles = prepareStorylineCandles(mergedW1, { excludeWeekends: false });
  
  const w1Storyline = w1Candles.length >= 2 ? detectWeeklyStoryline(w1Candles) : null;
  const d1Structure = d1Candles.length >= 5 ? detectDailyStructure(d1Candles) : null;
  const h4Structure = h4Candles.length >= 5 ? detectH4Structure(h4Candles) : null;
  const w1ToD1 = w1Candles.length >= 3 && d1Candles.length >= 5
    ? detectWeeklyToDailyEbo(w1Candles, d1Candles)
    : null;
  const d1ToH4 = d1Candles.length >= 5 && h4Candles.length >= 5
    ? detectDailyToH4Ebo(d1Candles, h4Candles)
    : null;

  const w1Bias = w1Storyline?.bias && w1Storyline.bias !== "NONE" ? w1Storyline.bias : "NEUTRAL";
  const d1Bias = d1Structure?.direction && d1Structure.direction !== "UNCONFIRMED"
    ? d1Structure.direction
    : w1Bias;
  const h4Bias = h4Structure?.direction && h4Structure.direction !== "UNCONFIRMED"
    ? h4Structure.direction
    : d1Bias;

    const activeBias = d1Bias || w1Bias;
  const latestPrice = h4Candles?.[h4Candles.length - 1]?.close
    ?? d1Candles?.[d1Candles.length - 1]?.close
    ?? latestW1?.close;

  const weeklyTarget = computeWeeklyTarget(w1Candles, activeBias, latestPrice);
  const dailyTarget = computeDailyIntradayTarget(d1Candles, activeBias, latestPrice);

  const weeklyTargetLine = weeklyTarget
    ? `🎯 <b>Weekly Target (${weeklyTarget.label}):</b> ${weeklyTarget.price}`
    : `🎯 <b>Weekly Target:</b> —`;

  const dailyTargetLine = dailyTarget
    ? `📍 <b>Daily Intraday Target (${dailyTarget.label}):</b> ${dailyTarget.price}`
    : `📍 <b>Daily Intraday Target:</b> —`;
  
  const latestW1 = w1Candles?.[w1Candles.length - 1];
  const w1Summary = w1Storyline?.formation
    ? `W1: ${w1Storyline.formation} (${w1Storyline.bias || "NEUTRAL"}) · ${formatBreakDate12h(w1Storyline.reaction_date || latestW1?.datetime)}`
    : `W1: ${w1Bias} · ${latestW1 ? formatBreakDate12h(latestW1.datetime) : "N/A"}`;

  const w1d1Setup = w1ToD1?.latest_setup || null;
  const d1h4Setup = d1ToH4?.latest_setup || null;

  const d1PreTapSwing =
    d1Bias === "BULLISH"
      ? d1Structure?.bullishKeyLevelContact?.protected_hl || d1Structure?.protectedHL || null
      : d1Structure?.bearishKeyLevelContact?.protected_lh || d1Structure?.protectedLH || null;

  const d1PullbackSwing =
    w1d1Setup?.pullback && Number.isFinite(Number(w1d1Setup.pullback.level))
      ? {
          level: Number(w1d1Setup.pullback.level),
          index: Math.max(
            0,
            d1Candles.findIndex(c => String(c.datetime) === String(w1d1Setup.pullback.date))
          )
        }
      : null;

  const d1State = evaluateTfStoryline(d1Candles, {
    bias: d1Bias,
    preTapSwing: d1PreTapSwing,
    pullbackSwing: d1PullbackSwing,
    keyLevels: d1Structure?.keyLevels || []
  });   
  const breakTs = d1State?.latestBreak?.datetime
    ? toTimestampMs(d1State.latestBreak.datetime, false)
    : null;
  const rawTapTs = d1State?.retestTap?.datetime
    ? toTimestampMs(d1State.retestTap.datetime, false)
    : null;
  const tapPrice = Number(d1State?.retestTap?.price);
  const breakLevel = Number(d1State?.latestBreak?.level ?? d1State?.latestBreak?.price);

  const tapMatchesBreakDirection = !d1State?.retestTap
    ? false
    : (Number.isFinite(breakTs) && Number.isFinite(rawTapTs) ? rawTapTs >= breakTs : true) &&
      (d1Bias === "BEARISH"
        ? (!Number.isFinite(tapPrice) || !Number.isFinite(breakLevel) || tapPrice >= breakLevel)
        : d1Bias === "BULLISH"
          ? (!Number.isFinite(tapPrice) || !Number.isFinite(breakLevel) || tapPrice <= breakLevel)
          : true);

  const validRetestTap = tapMatchesBreakDirection ? d1State.retestTap : null;
    const liveD1Candles = buildLiveD1CandlesWithDeveloping(rawD1, d1Candles);
  const developingTap = !validRetestTap
    ? detectDevelopingD1TapAfterBreak(liveD1Candles, d1State, d1Bias)
    : null;

  const activeRetestTap = validRetestTap || developingTap;
  const effectiveTapTs = activeRetestTap?.datetime
    ? toTimestampMs(activeRetestTap.datetime, false)
    : null;

   const tapTs = validRetestTap?.datetime
    ? toTimestampMs(validRetestTap.datetime, false)
    : null;
  
const isAtOrAfterTap = evDate => {
   if (!tapTs || !evDate) return true;
    const evTs = toTimestampMs(evDate, false);
    return Number.isFinite(evTs) ? evTs >= tapTs : true;
  };

    const bodyTapDateStr = validRetestTap?.datetime
    ? String(validRetestTap.datetime).slice(0, 10)
    : null;
  const bodyTapTs = validRetestTap?.datetime
    ? toTimestampMs(validRetestTap.datetime, false)
    : null;
  
  const isAfterBodyTap = evDate => {
    if (!bodyTapTs || !evDate) return true;
    const evTs = toTimestampMs(evDate, false);
    return Number.isFinite(evTs) ? evTs >= bodyTapTs : true;
  };

  function findLatestBodyBreakAfterTap(candles, bias, afterTs = null) {
      const afterMs = afterTs === null || afterTs === undefined ? NaN : toTimestampMs(afterTs, false);
  if (!Number.isFinite(afterMs)) return null;
    const isBull = bias === "BULLISH";
    const isBear = bias === "BEARISH";
    if (!isBull && !isBear) return null;

    const bodySwings = [];
    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const curr = candles[i];
      const next = candles[i + 1];
      const dt = curr.datetime || curr.date;

      const prevTop = Math.max(Number(prev.open), Number(prev.close));
      const currTop = Math.max(Number(curr.open), Number(curr.close));
      const nextTop = Math.max(Number(next.open), Number(next.close));

      const prevBot = Math.min(Number(prev.open), Number(prev.close));
      const currBot = Math.min(Number(curr.open), Number(curr.close));
      const nextBot = Math.min(Number(next.open), Number(next.close));

      if (
        isBull &&
        Number.isFinite(prevTop) &&
        Number.isFinite(currTop) &&
        Number.isFinite(nextTop) &&
        currTop >= prevTop &&
        currTop >= nextTop
      ) {
        bodySwings.push({ type: "BODY_HIGH", index: i, level: currTop, date: dt });
      }

      if (
        isBear &&
        Number.isFinite(prevBot) &&
        Number.isFinite(currBot) &&
        Number.isFinite(nextBot) &&
        currBot <= prevBot &&
        currBot <= nextBot
      ) {
        bodySwings.push({ type: "BODY_LOW", index: i, level: currBot, date: dt });
      }
    }

    if (bodySwings.length === 0) return null;

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const dt = c.datetime || c.date;
          const cTs = dt ? toTimestampMs(dt, false) : NaN;
    if (!Number.isFinite(cTs) || cTs < afterMs) continue;

      const close = Number(c.close);
      if (!Number.isFinite(close)) continue;

      const priorSwings = bodySwings.filter(sw => sw.index < i);
      if (priorSwings.length === 0) continue;

      const latestPriorSwing = priorSwings[priorSwings.length - 1];
      const brokeBody = isBull
        ? close > latestPriorSwing.level
        : close < latestPriorSwing.level;

      if (brokeBody) {
        return {
          type: "H4 EBO",
          kind: "EXTERNAL_BO",
          price: close,
          level: latestPriorSwing.level,
          swingDate: latestPriorSwing.date,
          datetime: dt
        };
      }
    }

    return null;
  }

  let h4Confirmed = null;
if (d1State.hasBreak && activeRetestTap && Array.isArray(h4Candles)) {
  const afterTapBreak = Number.isFinite(effectiveTapTs)
    ? findH4BreakAfterTap(h4Candles, d1Bias, effectiveTapTs)
    : null;

  const fallbackH4Break =
    !afterTapBreak && typeof evaluateH4BreakoutInDirection === "function"
      ? evaluateH4BreakoutInDirection(h4Candles, d1Bias, null)
      : null;

  h4Confirmed =
    afterTapBreak ||
    (fallbackH4Break
      ? {
          type: "H4 BO",
          price: fallbackH4Break.close,
          datetime: fallbackH4Break.datetime,
          label: fallbackH4Break.summary
        }
      : null);
}
  
    console.log("NZD/CAD H4 debug:", {
    d1Bias,
    effectiveTapTs,
    lastH4: h4Candles?.slice(-4),
    h4Confirmed
  });
  
  const storylineEmoji = d1Bias === "BULLISH" ? "🟢" : d1Bias === "BEARISH" ? "🔴" : "⚪";
  const storylineDir = d1Bias === "BULLISH" ? "BULLISH" : d1Bias === "BEARISH" ? "BEARISH" : "NEUTRAL";

  const d1BreakLine = d1State.latestBreak
    ? `D1 ${d1State.latestBreak.type} @ <b>${formatPrice(d1State.latestBreak.close)}</b> · ${formatBreakDate12h(d1State.latestBreak.datetime)}`
    : `D1 break: <i>None confirmed yet</i>`;

    const d1TapLine = activeRetestTap
    ? `D1 tap (${activeRetestTap.label}) @ <b>${formatPrice(activeRetestTap.price)}</b> · ${formatBreakDate12h(activeRetestTap.datetime)}${activeRetestTap.isDeveloping ? " <i>(developing D1)</i>" : ""}`
    : d1State.latestBreak
    ? `D1 tap: <i>Waiting for tap into D1 key level (open/close, external BO, or internal BO)</i>`
    : `D1 tap: <i>Pending D1 break</i>`;
  
    const h4BreakLine =
    d1State.hasBreak && activeRetestTap
      ? h4Confirmed
        ? `${h4Confirmed.type} @ <b>${formatPrice(h4Confirmed.price)}</b> · ${formatBreakDate12h(h4Confirmed.datetime)}`
        : `H4 break: <i>Watching for H4 breakout (external BO preferred)</i>`
      : `H4 break: <i>Locked until D1 breaks & taps a key level</i>`;
  
  const sequenceStatus = h4Confirmed
    ? `<b>Status: H4 breakout confirmed — look for entries</b>`
    : `<b>Status: Waiting on full W1 > D1 > H4 sequence</b>`;

  const fullMessage =
    `${storylineEmoji} <b>${storylineDir} STORYLINE —</b>\n` +
    `<b>${symbol} · W1 > D1 > H4</b>\n\n` +
    `${w1Summary}\n` +
    `${d1BreakLine}\n` +
    `${d1TapLine}\n` +
    `${h4BreakLine}\n\n` +
        `${sequenceStatus}\n\n` +
      `${weeklyTargetLine}\n` +
      `${dailyTargetLine}\n\n` +
      `Sent ${formatWatTimestamp()}\n\n` +
     `Not an entry signal — bias context only.`;

    const stageText = h4Confirmed
    ? "H4 BO confirmed"
    : activeRetestTap
    ? "D1 tapped · watching H4"
    : d1State.latestBreak
    ? `D1 ${d1State.latestBreak.type} · awaiting tap`
    : "Awaiting D1 break";
  
  const compactLine = `${storylineEmoji} <b>${symbol}</b> · W1: <code>${w1Bias}</code> · D1: <code>${d1Bias}</code> · H4: <code>${h4Bias}</code> (${stageText})`;

    return { symbol, w1Bias, d1Bias, h4Bias, weeklyTarget, dailyTarget, fullMessage, compactLine };
}

// =====================================
// HOME & TELEGRAM WEBHOOK (PART 1)
// =====================================

app.get("/", (req, res) => {
  res.send("DEE SM SLK BOT is running.");
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  let chatId = null;

  try {
    const callbackQuery = req.body?.callback_query;
    if (callbackQuery && callbackQuery.data) {
      chatId = parseChatId(callbackQuery.message.chat.id);
      const [, action, rawSym] = String(callbackQuery.data).split(":");
      const symbol = normalizeSymbol(rawSym);

      await answerCallbackQuery(callbackQuery.id, `${symbol} · ${action}`);

      if (action === "break") {
        await sendMessage(
          chatId,
          `<b>${symbol} — BREAK TAP DETAILS</b>\nTap a key level and wait for a completed candle-body close breaking the prior pullback.`
        );
        return;
      }

      if (action === "3cr") {
        await sendMessage(
          chatId,
          `<b>${symbol} — 3CR TAP</b>\nCross-check reaction candle closes and zone boundaries on your chart.`
        );
        return;
      }

      if (action === "struct") {
        const rawD1 = await getMarketCandles(symbol, "1day", 150);
        const d1Candles = filterCompletedDailyCandles(rawD1).candles;
        const d1 = detectDailyStructure(d1Candles);
        await sendMessage(
          chatId,
          `<b>${symbol} — D1 STRUCTURE SNAPSHOT</b>\n` +
            `Bias: <b>${d1.direction}</b>\n` +
            `LL: ${d1.bearishLL ? `${d1.bearishLL.date} @ ${formatPrice(d1.bearishLL.level)}` : "Not confirmed"}\n` +
            `Protected LH: ${d1.protectedLH ? `${d1.protectedLH.date} @ ${formatPrice(d1.protectedLH.level)}` : "Not formed"}`
        );
        return;
      }

       if (action === "entry") {
  const [storylineReport, rawH4, rawM30] = await Promise.all([
    getCachedStorylineReport(symbol),
    getMarketCandles(symbol, "4h", 150),
    getMarketCandles(symbol, "30min", 150)
  ]);

  const activeBias =
    storylineReport?.d1Bias && storylineReport.d1Bias !== "NEUTRAL"
      ? storylineReport.d1Bias
      : storylineReport?.w1Bias && storylineReport.w1Bias !== "NEUTRAL"
      ? storylineReport.w1Bias
      : null;

  const fullMsg = storylineReport?.fullMessage || "";
  const hasD1Tap = fullMsg.includes("D1 tap (");

  const tapMatch = fullMsg.match(/D1 tap \([^)]+\) @ .*? · ([^\n<]+)/);
  let d1TapDate = null;
  if (tapMatch) {
    const rawTapStr = tapMatch[1].replace(/\(developing D1\)/i, "").trim();
    const dateOnlyMatch = rawTapStr.match(/^(\d{4}-\d{2}-\d{2})/);
    d1TapDate = dateOnlyMatch ? dateOnlyMatch[1] : rawTapStr;
  }

  const entryCheck = detectH4TapAndM30Breakout(rawH4, rawM30, activeBias, {
    isH4Active: hasD1Tap,
    d1TapDatetime: d1TapDate,
    maxH4AgeCandles: 40
  });

  if (entryCheck.status === "H4_NOT_ACTIVE") {
    await sendMessage(
      chatId,
      `<b>${symbol} — CONFIRMATION ENTRY (30M)</b>\n\n` +
        `🔒 <i>H4 is not active yet — waiting for D1 break & key-level tap first.</i>`
    );
    return;
  }

  const h4EboText = entryCheck.h4Ebo
    ? `✅ H4 External BO (${activeBias}) @ <b>${formatPrice(entryCheck.h4Ebo.close)}</b> · ${formatBreakDate12h(entryCheck.h4Ebo.date)}`
    : `⏳ H4 External BO (${activeBias}): <i>Waiting for H4 body close beyond prior swing after D1 tap</i>`;

  const h4TapText = entryCheck.h4Tap
    ? `✅ H4 Tap (${entryCheck.h4Tap.label}) @ <b>${formatPrice(entryCheck.h4Tap.price)}</b> · ${formatBreakDate12h(entryCheck.h4Tap.datetime)}`
    : entryCheck.h4Ebo
    ? `⏳ H4 Tap: <i>Waiting for tap into H4 EBO / key level</i>`
    : `🔒 H4 Tap: <i>Locked until H4 external BO</i>`;

  const m30Text = entryCheck.m30Breakout
    ? `✅ <b>30M Breakout (${entryCheck.m30Breakout.direction})</b> broke <b>${formatPrice(entryCheck.m30Breakout.level)}</b> · closed <b>${formatPrice(entryCheck.m30Breakout.close)}</b> (${formatBreakDate12h(entryCheck.m30Breakout.datetime)})`
    : entryCheck.h4Tap
    ? `⏳ <b>30M Breakout (${activeBias}):</b> <i>Watching 30m body closes after H4 tap</i>`
    : `🔒 <b>30M Breakout:</b> <i>Available once H4 external BO & H4 tap occur</i>`;

  const targetSummaryLines = [
    storylineReport?.weeklyTarget
      ? `🎯 <b>Weekly Target (${storylineReport.weeklyTarget.label}):</b> ${formatPrice(storylineReport.weeklyTarget.price)}`
      : null,
    storylineReport?.dailyTarget
      ? `📍 <b>Daily Intraday Target (${storylineReport.dailyTarget.label}):</b> ${formatPrice(storylineReport.dailyTarget.price)}`
      : null
  ].filter(Boolean);

  const targetBlock = targetSummaryLines.length
    ? `\n\n${targetSummaryLines.join("\n")}`
    : "";

  await sendMessage(
    chatId,
    `<b>${symbol} - CONFIRMATION ENTRY (30M)</b>\n\n` +
      `${h4EboText}\n` +
      `${h4TapText}\n` +
      `${m30Text}${targetBlock}\n\n` +
      `<i>Not an entry signal - verify candle close & risk on chart.</i>`
  );
          return;
      }
    }
    
    const message = req.body?.message;
    if (!message || !message.text) return;

    chatId = parseChatId(message.chat.id);
    const parts = message.text.trim().split(/\s+/);

    let command = parts[0].split("@")[0].toLowerCase();
let argument = parts[1];
    
            if (command === "/start") {
      await sendMessage(
        chatId,
        `<b>Welcome to DEE SM SLK BOT — what's on your radar?</b>\n\n` +
          `- <b>Weekly focus</b> – use <code>/weekly</code> to see last week's saved events.\n` +
          `- <b>Market reads</b> – use <code>/check GBPUSD</code> for W1, D1 & H4 structure, key levels, and EBOs.\n` +
          `- <b>Watchlist</b> – use <code>/add</code>, <code>/remove</code>, or <code>/watchlist</code> to manage your pairs.\n` +
          `- <b>Monitor control</b> – use <code>/pause</code> or <code>/resume</code> to toggle automated scans.\n\n` +
        `- <b>Find pairs now</b> – use <code>/scan</code> to scan markets for W1 + D1 breakout setups.\n` +
          `<i>BIAS ≠ ENTRY — market context only, not an entry signal.</i>\n\n` +
        `Type <code>/help</code> anytime to see all commands or run <code>/check GBPUSD</code> to start.`
      );
      return;
            }
    
    if (command === "/help") {
  await sendMessage(
    chatId,
    `<b>BOT COMMANDS</b>\n\n` +
      `/add GBPUSD - Add pair\n` +
      `/remove GBPUSD - Remove pair\n` +
      `/watchlist - View pairs\n` +
      `/check GBPUSD - Check W1/D1/H4 & EBOs\n` +
      `/pause - Pause monitoring\n` +
      `/resume - Resume monitoring\n` +
      `/weekly - Previous week's events\n` +
      `/scan - Scan pairs for W1 + D1 setups`
  );
  return;
    }
    
    if (command === "/status") {
  const uptimeMins = Math.floor(process.uptime() / 60);
  await sendMessage(
    chatId,
    `🟢 <b>DEE SM SLK BOT — ONLINE</b>\n\n` +
      `• Uptime: <code>${uptimeMins} mins</code>`
  );
  return;
}

    if (command === "/scan") {
  if (isMarketScannerRunning) {
    await sendMessage(
      chatId,
      "⏳ A market scan is already in progress. Please wait a moment for the results."
    );
    return;
  }

  await sendMessage(
    chatId,
    `🔍 <b>Starting Market Scan...</b>\n` +
      `Scanning for W1 close/key-level setups with aligned D1 breakouts.\n` +
      `<i>This runs paced to protect API limits—matching pairs will arrive one by one.</i>`
  );

  runPacedMarketScan({
    targetCount: MARKET_SCAN_TARGET_COUNT,
    paceMs: MARKET_SCAN_PAIR_DELAY_MS,
    chatIds: [chatId],
    triggerLabel: "MARKET SCAN"
  }).catch(err => {
    console.error("Manual /scan error:", err.message);
  });

  return;
    }
    
if (command === "/bias" || command === "/bais") {
  if (argument) {
    const symbol = normalizeSymbol(argument);
    await sendMessage(chatId, `Checking <b>${symbol}</b> W1, D1 & H4 structure...`);
    const report = await buildStorylineReport(symbol);
    await sendMessage(chatId, report.fullMessage, buildStorylineInlineKeyboard(symbol));
    return;
  }

  const activePairs = await databaseRequest(
    `watchlist?chat_id=eq.${chatId}&is_active=eq.true`
  );

  if (!activePairs || activePairs.length === 0) {
    await sendMessage(chatId, "Your watchlist is empty. Add a pair first with <code>/add GBPUSD</code>.");
    return;
  }

  await sendMessage(
    chatId,
    `📊 <b>Scanning Bias (${activePairs.length} active pair${activePairs.length > 1 ? "s" : ""})...</b>`
  );

  const lines = [];
  for (const item of activePairs) {
    const sym = normalizeSymbol(item.symbol);
    try {
      const report = await buildStorylineReport(sym);
      lines.push(report.compactLine);
    } catch (err) {
      lines.push(`⚠️ <b>${sym}</b> · <i>Data error (${err.message})</i>`);
    }
    await new Promise(resolve => setTimeout(resolve, 600));
  }

  await sendMessage(
    chatId,
    `<b>WATCHLIST BIAS SUMMARY</b>\n\n` +
      `${lines.join("\n")}\n\n` +
      `<i>Not an entry signal — bias context only.</i>`
  );
  return;
}
    
        if (command === "/add") {
      if (!argument) {
        await sendMessage(chatId, "Example: /add GBPUSD");
        return;
      }

      const symbol = normalizeSymbol(argument);

      const existing = await databaseRequest(
        `watchlist?chat_id=eq.${chatId}&symbol=eq.${encodeURIComponent(symbol)}`
      );

      if (existing.length) {
        await sendMessage(chatId, `${symbol} is already on your watchlist.`);
        return;
      }

      await databaseRequest("watchlist", "POST", {
        chat_id: chatId,
        symbol,
        is_active: true
      });

      await sendMessage(chatId, `${symbol} added.`);
      return;
        }
    

    if (command === "/remove") {
      if (!argument) {
        await sendMessage(chatId, "Example: /remove GBPUSD");
        return;
      }

      const symbol = normalizeSymbol(argument);

      await databaseRequest(
        `watchlist?chat_id=eq.${chatId}&symbol=eq.${encodeURIComponent(symbol)}`,
        "DELETE"
      );

      await sendMessage(chatId, `${symbol} removed.`);
      return;
    }

        if (command === "/watchlist") {
      const pairs = await databaseRequest(
        `watchlist?chat_id=eq.${chatId}&select=symbol,is_active`
      );

      if (!pairs.length) {
        await sendMessage(chatId, "Your watchlist is empty.");
        return;
      }

      const list = pairs
        .map(pair => `${pair.is_active ? "🟢" : "⏸"} ${pair.symbol}`)
        .join("\n");

      await sendMessage(chatId, `<b>YOUR WATCHLIST</b>\n\n${list}`);
      return;
        }

        if (command === "/pause" || command === "/resume") {
      const is_active = command === "/resume";

      await databaseRequest(
        `watchlist?chat_id=eq.${chatId}`,
        "PATCH",
        { is_active }
      );

      await sendMessage(
        chatId,
        is_active ? "Monitoring resumed." : "Monitoring paused."
      );
      return;
        }
    
if (command === "/check") {
  const symbol = normalizeSymbol(argument || "GBPUSD");
  await sendMessage(chatId, `Checking <b>${symbol}</b> W1, D1 & H4 structure...`);
  const report = await getCachedStorylineReport(symbol);
  await sendMessage(chatId, report.fullMessage, buildStorylineInlineKeyboard(symbol));
  return;
}
       
    if (command === "/weekly") {
  const now = new Date();
  const watNow = typeof getWatNow === "function" ? (getWatNow(now) || now) : now;
  const watDay = watNow.getUTCDay(); // 0 = Sun, 1 = Mon ... 5 = Fri, 6 = Sat

  // Monday of the current week in WAT (00:00:00 WAT)
  const currentWeekMondayWat = new Date(watNow);
  const diffToMonday = watDay === 0 ? -6 : 1 - watDay;
  currentWeekMondayWat.setUTCDate(watNow.getUTCDate() + diffToMonday);
  currentWeekMondayWat.setUTCHours(0, 0, 0, 0);

  // If today is Saturday (6) or Sunday (0), the most recently completed Mon-Fri week
  // is this week's Mon-Fri. Otherwise (Mon-Fri), it is the prior week's Mon-Fri.
  const targetWeekMondayWat = new Date(currentWeekMondayWat);
  if (watDay !== 0 && watDay !== 6) {
    targetWeekMondayWat.setUTCDate(targetWeekMondayWat.getUTCDate() - 7);
  }

  // Friday 23:59:59.999 WAT of that target week (Monday + 4 days)
  const targetWeekFridayEndWat = new Date(targetWeekMondayWat);
  targetWeekFridayEndWat.setUTCDate(targetWeekMondayWat.getUTCDate() + 4);
  targetWeekFridayEndWat.setUTCHours(23, 59, 59, 999);

  const offsetMs = typeof WAT_OFFSET_MS === "number" ? WAT_OFFSET_MS : 0;

  // Convert WAT boundaries back to UTC ISO strings for Supabase created_at
  const from = new Date(targetWeekMondayWat.getTime() - offsetMs).toISOString();
  const to = new Date(targetWeekFridayEndWat.getTime() - offsetMs).toISOString();

  const events = await databaseRequest(
    `storyline_events?chat_id=eq.${chatId}` +
      `&created_at=gte.${encodeURIComponent(from)}` +
      `&created_at=lte.${encodeURIComponent(to)}` +
      `&order=created_at.asc`
  );

  if (!events.length) {
    await sendMessage(chatId, "No saved events found for last week (Mon–Fri).");
    return;
  }

  const report = events
    .map(
      event =>
        `• ${event.symbol || "Market"} — ${event.event_type || event.event || "Event"}`
    )
    .join("\n");

  await sendMessage(chatId, `<b>LAST WEEK'S EVENTS (MON–FRI)</b>\n\n${report}`);
  return;
    }
    
        const lowerText = String(message?.text || req.body?.message?.text || "")
      .trim()
      .toLowerCase();

    if (
      !lowerText.startsWith("/") &&
      (lowerText.includes("new week") || lowerText.includes("ready for the week"))
    ) {
      const newWeekMsg =
        `<b>🔥 New-week active — what’s on your radar?</b>\n\n` +
        `- <b>Weekly focus</b> – use <code>/weekly</code> to see confirmed setups.\n` +
        `- <b>Watchlist</b> – use <code>/add</code>, <code>/remove</code>, or <code>/watchlist</code> to manage monitored markets.\n` +
        `- <b>Market reads</b> – use <code>/check [PAIR]</code> for snapshot, bias, and breakout status.\n\n` +
        `Let me know which pair you’d like a read on, or add more pairs to your watchlist.`;

      await sendMessage(chatId, newWeekMsg, buildStorylineInlineKeyboard("GBPUSD"));
      return;
    }
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);

    if (chatId) {
      await sendMessage(chatId, "Something went wrong processing that command.");
    }
  }
});

// =====================================
// TEST ENDPOINTS
// =====================================

app.get("/test-market-data", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const data = {};

    for (const timeframe of ["1week", "1day", "4h"]) {
      data[timeframe] = await getMarketCandles(symbol, timeframe, 10);
    }

    res.json({
      success: true,
      symbol,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/test-w1-storyline", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const raw = await getMarketCandles(symbol, "1week", 100);
    const filtered = filterCompletedWeeklyCandles(raw);
    const storyline = detectWeeklyStoryline(filtered.candles);

    res.json({
      success: true,
      symbol,
      timeframe: "W1",
      storyline,
      latest_completed_candle: filtered.candles[filtered.candles.length - 1] || null,
      developing: filtered.developing
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/test-w1-d1-ebo", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol || "GBPUSD");

    const [rawW1, rawD1] = await Promise.all([
      getMarketCandles(symbol, "1week", 100),
      getMarketCandles(symbol, "1day", 150)
    ]);

    const w1Candles = filterCompletedWeeklyCandles(rawW1).candles;
    const d1Candles = filterCompletedDailyCandles(rawD1).candles;

    const cascade = detectWeeklyToDailyEbo(w1Candles, d1Candles);

    res.json({
      success: true,
      symbol,
      cascade: "W1 -> D1",
      ...cascade
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/test-d1-ebo", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const raw = await getMarketCandles(symbol, "1day", 150);
    const filtered = filterCompletedDailyCandles(raw);
    const candles = filtered.candles;

    if (candles.length < 5) {
      return res.json({
        success: false,
        symbol,
        message: "Not enough completed D1 candles."
      });
    }

    const result = detectDailyStructure(candles);

    res.json({
      success: true,
      symbol,
      timeframe: "D1",
      latest_completed_candle: candles[candles.length - 1].datetime,
      latest_swing_high: result.latestSwingHigh,
      latest_swing_low: result.latestSwingLow,
      bearish_structure: {
        LL: result.bearishLL,
        pending_LH: result.pendingLH,
        protected_LH: result.protectedLH
      },
      bullish_structure: {
        HH: result.bullishHH,
        pending_HL: result.pendingHL,
        protected_HL: result.protectedHL
      },
      events: result.events
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/test-d1-h4-ebo", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol || "GBPUSD");

    const [rawD1, rawH4] = await Promise.all([
      getMarketCandles(symbol, "1day", 150),
      getMarketCandles(symbol, "4h", 150)
    ]);

    const d1Candles = filterCompletedDailyCandles(rawD1).candles;
    const h4Candles = filterCompletedH4Candles(rawH4);

    const cascade = detectDailyToH4Ebo(d1Candles, h4Candles);

    res.json({
      success: true,
      symbol,
      cascade: "D1 -> H4",
      ...cascade
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/test-h4-ebo", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol || "GBPUSD");
    const raw = await getMarketCandles(symbol, "4h", 150);
    const candles = filterCompletedH4Candles(raw);
    const result = detectH4Structure(candles);

    res.json({
      success: true,
      symbol,
      timeframe: "H4",
      latestCandle: candles[candles.length - 1] || null,
      ...result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================
// AUTOMATIC WATCHLIST MONITOR (EVERY 30 MIN)
// =====================================

const MONITOR_INTERVAL_MS = 30 * 60 * 1000;
const sentAlertKeys = new Set();
let isMonitorRunning = false;
let hasCompletedInitialSeed = false;

function isWeekdayInWat(referenceDate = new Date()) {
  const watNow = getWatNow(referenceDate);
  const day = watNow.getUTCDay();
  return day !== 0 && day !== 6;
}

function formatWatTimestamp(referenceDate = new Date()) {
  const watNow = getWatNow(referenceDate);
  if (!(watNow instanceof Date) || Number.isNaN(watNow.getTime())) {
    return String(referenceDate || "");
  }

  const year = watNow.getUTCFullYear();
  const month = String(watNow.getUTCMonth() + 1).padStart(2, "0");
  const day = String(watNow.getUTCDate()).padStart(2, "0");

  const hours24 = watNow.getUTCHours();
  const minutes = String(watNow.getUTCMinutes()).padStart(2, "0");
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = String(hours24 % 12 || 12).padStart(2, "0");

  return `${year}-${month}-${day} ${hours12}:${minutes} ${period} WAT`;
}

function buildCascadeAlertMessage(symbol, cascadeLabel, setup, context = {}) {
  const isBullish = setup.ebo.type.startsWith("BULLISH");
  const badge = isBullish ? "🟢" : "🔴";
  const directionWord = isBullish ? "BULLISH" : "BEARISH";
  const breakoutKind =
    setup.breakout_kind ||
    (String(setup.ebo.type).includes("INT") ? "INTERNAL BREAKOUT" : "EXTERNAL BREAKOUT");

  const htfTimeframe = cascadeLabel.split(">")[0]?.trim() || "HTF";
  const ltfTimeframe = cascadeLabel.split(">")[1]?.trim() || "LTF";
  const levelLabel = `${String(setup.htf_level_type || "LEVEL").toLowerCase()} level`;

  const rejectionLine =
    setup.rejection_price !== undefined && setup.rejection_price !== null
      ? `${htfTimeframe} ${levelLabel} @ <b>${formatPrice(setup.rejection_price)}</b>\n`
      : `${htfTimeframe} ${levelLabel} (${formatPrice(setup.htf_zone.low)} – ${formatPrice(setup.htf_zone.high)})\n`;

  const breakoutLine =
    `<b>${ltfTimeframe} breakout</b> broke pullback @ <b>${formatPrice(setup.ebo.broken_pullback_level)}</b> ` +
    `· closed <b>${setup.ebo.date}</b> (Close: <b>${formatPrice(setup.ebo.close)}</b>)`;

  const metaLines = [
    `Cause level formed ${setup.htf_level_formed} · tapped ${setup.htf_contact_date}`,
    setup.pullback
      ? `Pullback level formed ${setup.pullback.date} @ ${formatPrice(setup.pullback.level)}`
      : null
  ]
    .filter(Boolean)
    .map(line => `<i>${line}</i>`)
    .join("\n");

  const alignmentLine =
    context.w1Bias && context.d1Bias
      ? `\n\nW1 ${context.w1Bias} · D1 ${context.d1Bias} — ` +
        `${context.w1Bias === context.d1Bias ? "W/D ALIGNED · CONTINUATION" : "W/D CONFLICTING · REVERSAL"}`
      : "";

  const nextDayRuleLine = context.nextDayRule
    ? `\nNEXT DAY RULE: ${context.nextDayRule}`
    : "";

  return (
    `<b>${badge} ${directionWord} STORYLINE CONFIRMED — ${symbol} · ${cascadeLabel}</b>\n` +
    `<b>${breakoutKind}</b>\n\n` +
    `${rejectionLine}` +
    `${breakoutLine}\n\n` +
    `${metaLines}` +
    `${alignmentLine}` +
    `${nextDayRuleLine}\n` +
    `Sent ${formatWatTimestamp()}\n\n` +
    `Not an entry signal — bias context only.`
  );
}

async function recordStorylineEvent(chatId, symbol, cascade, ebo, { suppressAlert = false } = {}) {
  const eventKey = `${chatId}:${symbol}:${cascade}:${ebo.type}:${ebo.date}`;
  if (sentAlertKeys.has(eventKey)) {
    return false;
  }

  try {
    const existing = await databaseRequest(
      `storyline_events?chat_id=eq.${chatId}` +
        `&symbol=eq.${encodeURIComponent(symbol)}` +
        `&event_type=eq.${encodeURIComponent(ebo.type)}` +
        `&limit=5`
    );

    if (
      Array.isArray(existing) &&
      existing.some(row => String(row.event_date || row.date || "") === String(ebo.date))
    ) {
      sentAlertKeys.add(eventKey);
      return false;
    }
  } catch (err) {
    // Fallback gracefully if table/columns differ
  }

  sentAlertKeys.add(eventKey);

  try {
    await databaseRequest("storyline_events", "POST", {
      chat_id: chatId,
      symbol,
      event_type: ebo.type,
      event_date: ebo.date
    });
  } catch (err) {
    console.warn("storyline_events insert skipped:", err.response?.data || err.message);
  }

  return !suppressAlert;
}

async function scanWatchlistOnce() {
  if (isMonitorRunning) return;
  if (!isWeekdayInWat()) return;

  isMonitorRunning = true;
  const isInitialSeedRun = !hasCompletedInitialSeed;

  try {
    const activeRows = await databaseRequest(
      "watchlist?is_active=eq.true&select=chat_id,symbol"
    );
    
    if (!Array.isArray(activeRows) || !activeRows.length) {
      hasCompletedInitialSeed = true;
      return;
    }

    const symbols = [...new Set(activeRows.map(r => normalizeSymbol(r.symbol)))];
    const marketCache = new Map();

    for (const symbol of symbols) {
      try {
        const rawW1 = await getMarketCandles(symbol, "1week", 100);
await new Promise(resolve => setTimeout(resolve, 8500));
const rawD1 = await getMarketCandles(symbol, "1day", 150);
await new Promise(resolve => setTimeout(resolve, 8500));
const rawH4 = await getMarketCandles(symbol, "4h", 150);
        

        const w1Candles = filterCompletedWeeklyCandles(rawW1).candles;
        const d1Candles = filterCompletedDailyCandles(rawD1).candles;
        const h4Candles = filterCompletedH4Candles(rawH4);

        const w1ToD1 =
          w1Candles.length >= 3 && d1Candles.length >= 5
            ? detectWeeklyToDailyEbo(w1Candles, d1Candles)
            : null;

        const d1ToH4 =
          d1Candles.length >= 5 && h4Candles.length >= 5
            ? detectDailyToH4Ebo(d1Candles, h4Candles)
            : null;
        const w1Storyline = w1Candles.length >= 2 ? detectWeeklyStoryline(w1Candles) : null;
        const d1Structure = d1Candles.length >= 5 ? detectDailyStructure(d1Candles) : null;

        const w1Bias =
          w1Storyline && w1Storyline.bias && w1Storyline.bias !== "NONE"
            ? w1Storyline.bias
            : null;

        const d1Bias =
          d1Structure && d1Structure.direction && d1Structure.direction !== "UNCONFIRMED"
            ? d1Structure.direction
            : null;

        const latestD1Date = d1Candles.length
          ? String(d1Candles[d1Candles.length - 1].datetime).slice(0, 10)
          : null;
        const todayWatDate = getWatNow().toISOString().slice(0, 10);
        const nextDayRule =
          latestD1Date && latestD1Date < todayWatDate ? "✅" : "⏳";
        const activeBias = d1Bias || w1Bias || null;
        const d1StateForMonitor =
          d1Candles.length >= 5 && activeBias
            ? evaluateTfStoryline(d1Candles, {
                bias: activeBias,
                keyLevels: d1Structure?.keyLevels || []
              })
            : null;

        const d1BreakForMonitor = d1StateForMonitor?.latestBreak || null;
        const liveD1Candles = buildLiveD1CandlesWithDeveloping(rawD1, d1Candles);
        const activeTapForMonitor = d1BreakForMonitor
          ? d1StateForMonitor?.retestTap ||
            detectDevelopingD1TapAfterBreak(liveD1Candles, d1StateForMonitor, activeBias)
          : null;

        const activeTapTs = activeTapForMonitor?.datetime
          ? toTimestampMs(activeTapForMonitor.datetime, false)
          : null;

        const liveTapH4Break =
          d1BreakForMonitor &&
          activeTapForMonitor &&
          activeBias &&
          Number.isFinite(activeTapTs)
            ? findH4BreakAfterTap(h4Candles, activeBias, activeTapTs)
            : null;
        
                   marketCache.set(symbol, {
          w1ToD1,
          d1ToH4,
          w1Bias,
          d1Bias,
          nextDayRule,
          activeBias,
          d1Break: d1BreakForMonitor,
          activeTap: activeTapForMonitor,
          liveTapH4Break
        });
              } catch (err) {
        console.error(`Monitor fetch error for ${symbol}:`, err.message);
      }

            await new Promise(resolve => setTimeout(resolve, 8500));
    }

    for (const row of activeRows) {
      const chatId = parseChatId(row.chat_id);
      const symbol = normalizeSymbol(row.symbol);
      const data = marketCache.get(symbol);
      if (!data) continue;

      const w1D1Confirmed = (data.w1ToD1?.all_setups || []).filter(s => s.ebo);
      for (const setup of w1D1Confirmed) {
        const shouldAlert = await recordStorylineEvent(
          chatId,
          symbol,
          "W1 > D1",
          setup.ebo,
          { suppressAlert: isInitialSeedRun }
        );
        if (shouldAlert) {
          await sendMessage(
            chatId,
                      buildCascadeAlertMessage(symbol, "W1 > D1", setup, {
            w1Bias: data.w1Bias,
            d1Bias: data.d1Bias,
            nextDayRule: data.nextDayRule
          }),
            buildStorylineInlineKeyboard(symbol)
          );
        }
      }

      const d1H4Confirmed = (data.d1ToH4?.all_setups || []).filter(s => s.ebo);
      for (const setup of d1H4Confirmed) {
        const shouldAlert = await recordStorylineEvent(
          chatId,
          symbol,
          "D1 > H4",
          setup.ebo,
          { suppressAlert: isInitialSeedRun }
        );
        if (shouldAlert) {
          await sendMessage(
            chatId,
                    buildCascadeAlertMessage(symbol, "D1 > H4", setup, {
            w1Bias: data.w1Bias,
            d1Bias: data.d1Bias,
            nextDayRule: data.nextDayRule
          }),
             buildStorylineInlineKeyboard(symbol)
          );
        }
      }
    }
      if (data.liveTapH4Break && data.d1Break && data.activeTap && data.activeBias) {
        const liveKey = `${chatId}:${symbol}:LIVE_D1_TAP_H4_BO:${data.d1Break.datetime}:${data.activeTap.datetime}:${data.liveTapH4Break.datetime}`;
        if (!sentAlertKeys.has(liveKey)) {
          sentAlertKeys.add(liveKey);
          if (!isInitialSeedRun) {
            const badge = data.activeBias === "BULLISH" ? "🟢" : "🔴";
            await sendMessage(
              chatId,
              `<b>${badge} ${data.activeBias} H4 BREAKOUT AFTER D1 TAP — ${symbol}</b>\n` +
                `<b>${data.liveTapH4Break.kind === "INTERNAL_BO" ? "INTERNAL BREAKOUT" : "EXTERNAL BREAKOUT"}</b>\n\n` +
                `D1 ${data.d1Break.type} @ <b>${formatPrice(data.d1Break.close)}</b> · ${formatBreakDate12h(data.d1Break.datetime)}\n` +
                `D1 tap (${data.activeTap.label}) @ <b>${formatPrice(data.activeTap.price)}</b> · ${formatBreakDate12h(data.activeTap.datetime)}${data.activeTap.isDeveloping ? " <i>(developing D1)</i>" : ""}\n` +
                `<b>${data.liveTapH4Break.type}</b> @ <b>${formatPrice(data.liveTapH4Break.price)}</b> · ${formatBreakDate12h(data.liveTapH4Break.datetime)}\n\n` +
                `Sent ${formatWatTimestamp()}\n\n` +
                `<i>Not an entry signal — bias context only.</i>`,
              buildStorylineInlineKeyboard(symbol)
            );
          }
        }
      }
    
    hasCompletedInitialSeed = true;
  } catch (err) {
    console.error("Watchlist scan error:", err.response?.data || err.message);
  } finally {
    isMonitorRunning = false;
  }
}

const BASE_MARKET_UNIVERSE = [
  // Crypto (2)
  "BTC/USD", "ETH/USD",

  // Metals (2)
  "XAU/USD", "XAG/USD",

  // Indices (4)
  "NDX", "DJI", "DAX", "N225",

  // Forex Majors (7)
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD", "NZD/USD",

  // Forex Minors / Crosses (21)
  "EUR/GBP", "EUR/JPY", "EUR/CHF", "EUR/AUD", "EUR/CAD", "EUR/NZD",
  "GBP/JPY", "GBP/CHF", "GBP/AUD", "GBP/CAD", "GBP/NZD",
  "AUD/JPY", "AUD/CHF", "AUD/CAD", "AUD/NZD",
  "NZD/JPY", "NZD/CHF", "NZD/CAD",
  "CAD/JPY", "CAD/CHF",
  "CHF/JPY"
];

function shuffleMarketUniverse(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const MARKET_SCAN_TARGET_COUNT = 15;
const MARKET_SCAN_PAIR_DELAY_MS = 65000;

let isMarketScannerRunning = false;
let lastWeeklyAutoScanKey = null;
const deliveredWeeklySetups = new Set();

function evaluateLastWeekCloseSetup(w1Candles, d1KeyLevels = []) {
  if (!Array.isArray(w1Candles) || w1Candles.length < 3) return null;

  const prevWeek = w1Candles[w1Candles.length - 2];
  const lastWeek = w1Candles[w1Candles.length - 1];

  const prevHigh = Number(prevWeek.high);
  const prevLow = Number(prevWeek.low);
  const lastOpen = Number(lastWeek.open);
  const lastHigh = Number(lastWeek.high);
  const lastLow = Number(lastWeek.low);
  const lastClose = Number(lastWeek.close);

  if (![prevHigh, prevLow, lastOpen, lastHigh, lastLow, lastClose].every(Number.isFinite)) {
    return null;
  }

  // Bearish: swept prior weekly high and last week closed below prior weekly high
  if (lastHigh > prevHigh && lastClose < prevHigh) {
    return {
      bias: "BEARISH",
      reason: `Last W1 Close Below Prior High (${formatPrice(lastClose)} < ${formatPrice(prevHigh)})`,
      weekDate: lastWeek.datetime,
      lastWeek
    };
  }

  // Bullish: swept prior weekly low and last week closed above prior weekly low
  if (lastLow < prevLow && lastClose > prevLow) {
    return {
      bias: "BULLISH",
      reason: `Last W1 Close Above Prior Low (${formatPrice(lastClose)} > ${formatPrice(prevLow)})`,
      weekDate: lastWeek.datetime,
      lastWeek
    };
  }

  // Check if last week's close respected/reacted at a relevant key level
  const matchingKeyLevel = Array.isArray(d1KeyLevels)
    ? [...d1KeyLevels]
        .reverse()
        .find(kl => {
          if (!kl) return false;
          const kLow = Math.min(Number(kl.low), Number(kl.high));
          const kHigh = Math.max(Number(kl.low), Number(kl.high));
          if (!Number.isFinite(kLow) || !Number.isFinite(kHigh)) return false;
          const pad = Math.max((kHigh - kLow) * 0.15, kHigh * 0.0005);
          return lastClose >= kLow - pad && lastClose <= kHigh + pad;
        })
    : null;

  if (matchingKeyLevel) {
    const inferredBias =
      matchingKeyLevel.bias === "BULLISH" || matchingKeyLevel.bias === "BEARISH"
        ? matchingKeyLevel.bias
        : lastClose >= lastOpen
          ? "BULLISH"
          : "BEARISH";

    return {
      bias: inferredBias,
      reason: `Last W1 Close @ Key Level (${formatPrice(lastClose)})`,
      weekDate: lastWeek.datetime,
      lastWeek
    };
  }

  return null;
}

function isBreakInsideLastWeekCandle(latestBreak, lastWeek, d1Candles) {
  if (!latestBreak || !lastWeek) return false;

  const breakDateStr = latestBreak.datetime ? String(latestBreak.datetime).slice(0, 10) : "";
  const lastWeekDateStr = lastWeek.datetime ? String(lastWeek.datetime).slice(0, 10) : "";

  if (!breakDateStr || !lastWeekDateStr) return false;

  const breakMs = Date.parse(`${breakDateStr}T00:00:00Z`);
  const weekStartMs = Date.parse(`${lastWeekDateStr}T00:00:00Z`);
  // Standard weekly candle spans 7 days from its weekly open date
  const weekEndMs = weekStartMs + 7 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(breakMs) || !Number.isFinite(weekStartMs)) return false;

  const inWeekWindow = breakMs >= weekStartMs && breakMs <= weekEndMs;
  if (!inWeekWindow) return false;

  // Also ensure the breakout price itself stays within last week's high/low range
  const breakLevel = Number(latestBreak.level ?? latestBreak.price);
  const breakClose = Number(latestBreak.close);
  const wHigh = Number(lastWeek.high);
  const wLow = Number(lastWeek.low);

  if (Number.isFinite(wHigh) && Number.isFinite(wLow)) {
    const pad = (wHigh - wLow) * 0.02;
    if (Number.isFinite(breakClose) && (breakClose > wHigh + pad || breakClose < wLow - pad)) {
      return false;
    }
    if (Number.isFinite(breakLevel) && (breakLevel > wHigh + pad || breakLevel < wLow - pad)) {
      return false;
    }
  }

  return Array.isArray(d1Candles) && d1Candles.length >= 2;
                 }

async function getActiveTargetChatIds() {
  try {
    const rows = await databaseRequest("watchlist?is_active=eq.true&select=chat_id");
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.map(r => parseChatId(r.chat_id)).filter(Boolean))];
  } catch (err) {
    console.warn("Could not load target chat IDs for market scan:", err.message);
    return [];
  }
}

async function runPacedMarketScan({
  targetCount = MARKET_SCAN_TARGET_COUNT,
  paceMs = MARKET_SCAN_PAIR_DELAY_MS,
  chatIds = null,
  triggerLabel = "WEEKLY MARKET SCAN"
} = {}) {
  if (isMarketScannerRunning) return;
  if (!isWeekdayInWat()) return;

  isMarketScannerRunning = true;
  let matchedCount = 0;
  const sentPairs = [];

  try {
    const recipients = Array.isArray(chatIds) && chatIds.length > 0
      ? chatIds
      : await getActiveTargetChatIds();

    if (!recipients.length) return;

    const scanList = shuffleMarketUniverse(BASE_MARKET_UNIVERSE);

    for (let i = 0; i < scanList.length; i++) {
      if (matchedCount >= targetCount) break;

      const symbol = normalizeSymbol(scanList[i]);

      try {
        const rawW1 = await getMarketCandles(symbol, "1week", 100);
        await new Promise(resolve => setTimeout(resolve, 8500));
        const rawD1 = await getMarketCandles(symbol, "1day", 150);
        

        const d1Candles = filterCompletedDailyCandles(rawD1).candles;
        const mergedW1 = mergeWeeklyCandlesWithDailyFallback(
          filterCompletedWeeklyCandles(rawW1).candles,
          d1Candles
        );
        const w1Candles = prepareStorylineCandles(mergedW1, { excludeWeekends: false });

                if (d1Candles.length >= 5) {
          const d1Structure = detectDailyStructure(d1Candles);
          const w1Setup = evaluateLastWeekCloseSetup(w1Candles, d1Structure?.keyLevels || []);

          if (w1Setup) {
            const d1State = evaluateTfStoryline(d1Candles, {
              bias: w1Setup.bias,
              keyLevels: d1Structure?.keyLevels || []
            });

            const latestBreak = d1State?.latestBreak;
            const breakMatchesBias =
              Boolean(latestBreak) &&
              (!d1Structure?.direction ||
                d1Structure.direction === "UNCONFIRMED" ||
                d1Structure.direction === w1Setup.bias);

            const insideLastWeek = isBreakInsideLastWeekCandle(
              latestBreak,
              w1Setup.lastWeek,
              d1Candles
            );

            if (breakMatchesBias && insideLastWeek) {
  const newChatsForSetup = recipients.filter(recipientChatId => {
    const perChatSetupKey = `${recipientChatId}:${symbol}:${w1Setup.weekDate}:${w1Setup.bias}:${latestBreak.type}:${latestBreak.datetime}`;
    return !deliveredWeeklySetups.has(perChatSetupKey);
  });

  if (newChatsForSetup.length > 0) {
    for (const recipientChatId of newChatsForSetup) {
      const perChatSetupKey = `${recipientChatId}:${symbol}:${w1Setup.weekDate}:${w1Setup.bias}:${latestBreak.type}:${latestBreak.datetime}`;
      deliveredWeeklySetups.add(perChatSetupKey);
    }

    matchedCount += 1;

    const emoji = w1Setup.bias === "BULLISH" ? "🟢" : "🔴";
    const msg =
      `${emoji} <b>${triggerLabel} (${matchedCount}/${targetCount}) — ${symbol}</b>\n\n` +
      `W1: <b>${w1Setup.reason}</b> · ${formatBreakDate12h(w1Setup.weekDate)}\n` +
      `D1: <b>${latestBreak.type}</b> @ <b>${formatPrice(latestBreak.close)}</b> · ${formatBreakDate12h(latestBreak.datetime)}\n` +
      `Next: Watch for D1 tap & H4 ${w1Setup.bias} breakout\n\n` +
      `Sent ${formatWatTimestamp()}\n\n` +
      `<i>Not an entry signal — bias context only.</i>`;

    for (const recipientChatId of newChatsForSetup) {
      await sendMessage(recipientChatId, msg, buildStorylineInlineKeyboard(symbol));
    }

    sentPairs.push(
      `${matchedCount}. ${emoji} <b>${symbol}</b> · ${w1Setup.bias} (${latestBreak.type} @ ${formatPrice(latestBreak.close)})`
    );
  }
            }
          }
        }
      } catch (err) {
        console.error(`Market scan failed for ${symbol}:`, err.message);
      }
      
      if (matchedCount < targetCount && i < scanList.length - 1) {
        await new Promise(resolve => setTimeout(resolve, paceMs));
      }
    }

    const summaryText = sentPairs.length > 0
      ? `<b>📋 ${triggerLabel} — SENT PAIRS LIST (${sentPairs.length})</b>\n\n` +
        `${sentPairs.join("\n")}\n\n` +
        `Sent ${formatWatTimestamp()}`
      : `<b>📋 ${triggerLabel} — SENT PAIRS LIST (0)</b>\n\n` +
        `No qualifying W1 sweep/rejection + aligned D1 breakout pairs matched in this pass.\n\n` +
        `Sent ${formatWatTimestamp()}`;

    for (const chatId of recipients) {
      await sendMessage(chatId, summaryText);
    }
  } finally {
    isMarketScannerRunning = false;
  }
}

const dailySummaryStateByPair = new Map();
const deliveredH4Confirmations = new Set();

function buildDailyBreakoutRange(d1Candles, recentD1Break) {
  if (!Array.isArray(d1Candles) || d1Candles.length < 2 || !recentD1Break) {
    return null;
  }

  const breakPrice = Number(recentD1Break.level ?? recentD1Break.close ?? recentD1Break.price);
  if (!Number.isFinite(breakPrice)) return null;

  const breakIdx =
    Number.isInteger(recentD1Break.index) &&
    recentD1Break.index >= 0 &&
    recentD1Break.index < d1Candles.length
      ? recentD1Break.index
      : d1Candles.length - 1;

  const preBreakIdx = Math.max(0, breakIdx - 1);
  const preBreakCandle = d1Candles[preBreakIdx];

  const candidatePrices = [
    breakPrice,
    Number(preBreakCandle?.open),
    Number(preBreakCandle?.close)
  ].filter(Number.isFinite);

  if (candidatePrices.length < 2) return null;

  const rangeLow = Math.min(...candidatePrices);
  const rangeHigh = Math.max(...candidatePrices);

  return {
    rangeLow,
    rangeHigh,
    breakPrice,
    breakIdx
  };
}

function evaluateDailySummaryInBreakoutRange(
  d1Candles,
  storylineBias,
  d1KeyLevels = [],
  recentD1Break = null
) {
  if (!Array.isArray(d1Candles) || d1Candles.length < 3) return null;
  if (storylineBias !== "BULLISH" && storylineBias !== "BEARISH") return null;

  const breakoutRange = buildDailyBreakoutRange(d1Candles, recentD1Break);
  if (!breakoutRange || !Array.isArray(d1KeyLevels) || d1KeyLevels.length === 0) {
    return null;
  }

  // Last completed daily candle (previous day)
  const prevDay = d1Candles[d1Candles.length - 1];
  const open = Number(prevDay.open);
  const high = Number(prevDay.high);
  const low = Number(prevDay.low);
  const close = Number(prevDay.close);
  if (![open, high, low, close].every(Number.isFinite)) return null;

  // Direction of the daily close must match the storyline bias
  const closedInBiasDirection =
    storylineBias === "BULLISH" ? close > open : close < open;
  if (!closedInBiasDirection) return null;

  const rangePad = Math.max(
    (breakoutRange.rangeHigh - breakoutRange.rangeLow) * 0.1,
    breakoutRange.rangeHigh * 0.0005
  );

  for (let i = d1KeyLevels.length - 1; i >= 0; i--) {
    const kl = d1KeyLevels[i];
    if (!kl) continue;

    const kLow = Math.min(Number(kl.low), Number(kl.high));
    const kHigh = Math.max(Number(kl.low), Number(kl.high));
    if (!Number.isFinite(kLow) || !Number.isFinite(kHigh)) continue;

    // Key level must sit inside (or right on the edge of) the daily breakout range
    const insideRange =
      kHigh >= breakoutRange.rangeLow - rangePad &&
      kLow <= breakoutRange.rangeHigh + rangePad;
    if (!insideRange) continue;

    const tapPad = Math.max((kHigh - kLow) * 0.2, kHigh * 0.0005);
    const tappedKeyLevel = low <= kHigh + tapPad && high >= kLow - tapPad;
    if (!tappedKeyLevel) continue;

    const closedOnOrThroughLevel =
      storylineBias === "BULLISH"
        ? close >= kLow - tapPad
        : close <= kHigh + tapPad;

    if (closedOnOrThroughLevel) {
      return {
        bias: storylineBias,
        rangeLow: breakoutRange.rangeLow,
        rangeHigh: breakoutRange.rangeHigh,
        keyLevelLow: kLow,
        keyLevelHigh: kHigh,
        prevDayDate: prevDay.datetime,
        prevDayClose: close,
        reason: `D1 tapped & closed ${storylineBias.toLowerCase()} at key level (${formatPrice(kLow)}–${formatPrice(kHigh)}) inside breakout range (${formatPrice(breakoutRange.rangeLow)}–${formatPrice(breakoutRange.rangeHigh)})`
      };
    }
  }

  return null;
}

function isWeeklyTargetStillActive(w1Candles, bias) {
  if (!Array.isArray(w1Candles) || w1Candles.length < 3) return true;
  const lastClosedWeek = w1Candles[w1Candles.length - 1];
  const lastPrice = Number(lastClosedWeek?.close);
  if (!Number.isFinite(lastPrice)) return true;

  const lookback = w1Candles.slice(Math.max(0, w1Candles.length - 8), w1Candles.length - 1);
  if (!lookback.length) return true;

  if (bias === "BULLISH") {
    const targetHigh = Math.max(...lookback.map(c => Number(c.high)).filter(Number.isFinite));
    return Number.isFinite(targetHigh) ? lastPrice < targetHigh : true;
  }

  if (bias === "BEARISH") {
    const targetLow = Math.min(...lookback.map(c => Number(c.low)).filter(Number.isFinite));
    return Number.isFinite(targetLow) ? lastPrice > targetLow : true;
  }

  return true;
}

function evaluateH4BreakoutInDirection(
  h4Candles,
  bias,
  sinceTimestamp,
  minTimestamp = null
) {
  if (!Array.isArray(h4Candles) || h4Candles.length < 3) return null;
  if (bias !== "BULLISH" && bias !== "BEARISH") return null;

  const sinceMs = sinceTimestamp ? Date.parse(String(sinceTimestamp)) : NaN;
  const minMs = minTimestamp ? Date.parse(String(minTimestamp)) : NaN;
  const swings = typeof identifySwings === "function" ? identifySwings(h4Candles) : [];

  for (let idx = h4Candles.length - 1; idx >= 2; idx--) {
    const candle = h4Candles[idx];
    const close = Number(candle.close);
    if (!Number.isFinite(close)) continue;

    if (candle.datetime) {
      const cMs = Date.parse(String(candle.datetime));
      if (Number.isFinite(sinceMs) && Number.isFinite(cMs) && cMs < sinceMs) break;
      // Skip H4 candles at or before a developing D1 tap timestamp
      if (Number.isFinite(minMs) && Number.isFinite(cMs) && cMs <= minMs) continue;
    }
    
    if (bias === "BULLISH") {
      const priorHighs = swings
        .filter(s => s.type === "SWING_HIGH" && s.index < idx)
        .map(s => Number(s.level))
        .filter(Number.isFinite);

      const recentCandleHighs = h4Candles
        .slice(Math.max(0, idx - 6), idx)
        .map(c => Number(c.high))
        .filter(Number.isFinite);

      const targetHigh = priorHighs.length
        ? priorHighs[priorHighs.length - 1]
        : (recentCandleHighs.length ? Math.max(...recentCandleHighs) : NaN);

      if (Number.isFinite(targetHigh) && close > targetHigh) {
        return {
          bias: "BULLISH",
          confirmed: true,
          brokenLevel: targetHigh,
          close,
          datetime: candle.datetime,
          summary: `H4 BULLISH breakout confirmed above ${formatPrice(targetHigh)} (Close ${formatPrice(close)})`
        };
      }
    }

    if (bias === "BEARISH") {
      const priorLows = swings
        .filter(s => s.type === "SWING_LOW" && s.index < idx)
        .map(s => Number(s.level))
        .filter(Number.isFinite);

      const recentCandleLows = h4Candles
        .slice(Math.max(0, idx - 6), idx)
        .map(c => Number(c.low))
        .filter(Number.isFinite);

      const targetLow = priorLows.length
        ? priorLows[priorLows.length - 1]
        : (recentCandleLows.length ? Math.min(...recentCandleLows) : NaN);

      if (Number.isFinite(targetLow) && close < targetLow) {
        return {
          bias: "BEARISH",
          confirmed: true,
          brokenLevel: targetLow,
          close,
          datetime: candle.datetime,
          summary: `H4 BEARISH breakout confirmed below ${formatPrice(targetLow)} (Close ${formatPrice(close)})`
        };
      }
    }
  }

  return null;
}

function evaluateH4BreakoutConfirmation(h4Candles, dailySummarySetup) {
  if (!dailySummarySetup || !Array.isArray(h4Candles) || h4Candles.length === 0) {
    return null;
  }

  // Filter out unclosed candles when a closed flag is present
  const closedCandles = h4Candles.filter((c) => {
    if (!c || typeof c !== "object") return false;
    if (typeof c.isClosed === "boolean") return c.isClosed;
    if (typeof c.closed === "boolean") return c.closed;
    if (typeof c.is_final === "boolean") return c.is_final;
    return true;
  });

  if (closedCandles.length === 0) return null;

    const developingTapTime =
    dailySummarySetup.developingTapTime ??
    dailySummarySetup.d1TapTime ??
    dailySummarySetup.tapTime ??
    null;

    return evaluateH4BreakoutInDirection(
    closedCandles,
    dailySummarySetup.bias,
    dailySummarySetup.prevDayDate,
    developingTapTime
  );
}

async function runWatchlistDailySummaryAndH4Monitor(chatIds = null) {
  const rows = await databaseRequest("watchlist?is_active=eq.true&select=symbol,chat_id");
    if (!Array.isArray(rows) || rows.length === 0) return;

  const groupedBySymbol = new Map();
  for (const row of rows) {
    const symbol = normalizeSymbol(row.symbol);
    if (!symbol) continue;

    if (!groupedBySymbol.has(symbol)) {
      groupedBySymbol.set(symbol, {
        symbol,
        bias: row.bias ? String(row.bias).toUpperCase() : null,
        chatIds: new Set()
      });
    }

    const entry = groupedBySymbol.get(symbol);
    if (!entry.bias && row.bias) {
      entry.bias = String(row.bias).toUpperCase();
    }
    const parsedChat = parseChatId(row.chat_id);
    if (parsedChat) entry.chatIds.add(parsedChat);
  }

  for (const [symbol, item] of groupedBySymbol.entries()) {
    const recipients =
      Array.isArray(chatIds) && chatIds.length > 0
        ? chatIds
        : [...item.chatIds];
    if (!recipients.length) continue;

    try {
      const rawD1 = await getMarketCandles(symbol, "1day", 150);
      const d1Candles = filterCompletedDailyCandles(rawD1).candles;
      if (d1Candles.length < 5) continue;

      const d1Structure = detectDailyStructure(d1Candles);
      const d1State = evaluateTfStoryline(d1Candles, {
        bias: item.bias,
        keyLevels: d1Structure?.keyLevels || []
      });

      const activeBias =
        item.bias === "BULLISH" || item.bias === "BEARISH"
          ? item.bias
          : d1State?.bias;

      if (activeBias !== "BULLISH" && activeBias !== "BEARISH") continue;

      await new Promise(resolve => setTimeout(resolve, 8500));
      const rawW1 = await getMarketCandles(symbol, "1week", 60);
      const w1Candles = prepareStorylineCandles(
        mergeWeeklyCandlesWithDailyFallback(
          filterCompletedWeeklyCandles(rawW1).candles,
          d1Candles
        ),
        { excludeWeekends: false }
      );

      if (!isWeeklyTargetStillActive(w1Candles, activeBias)) continue;

      const recentD1Break = d1State?.latestBreak || null;
      if (!recentD1Break) continue;

      const dailySummary = evaluateDailySummaryInBreakoutRange(
        d1Candles,
        activeBias,
        d1Structure?.keyLevels || [],
        recentD1Break
      );

      if (dailySummary) {
        const summaryKey = `${symbol}:${dailySummary.prevDayDate}:${dailySummary.bias}`;
        const prevState = dailySummaryStateByPair.get(symbol);

        if (!prevState || prevState.summaryKey !== summaryKey) {
          dailySummaryStateByPair.set(symbol, {
            summaryKey,
            setup: dailySummary,
            d1CountAtSummary: d1Candles.length
          });

          const emoji = dailySummary.bias === "BULLISH" ? "🟢" : "🔴";
          const summaryMsg =
            `${emoji} <b>DAILY SUMMARY — ${symbol}</b>\n\n` +
            `Bias: <b>${dailySummary.bias}</b> (Weekly target still active)\n` +
            `D1: <b>${dailySummary.reason}</b>\n` +
            `Next: Checking for <b>H4 ${dailySummary.bias} breakout</b> (from prev close or developing D1 candle)\n\n` +
            `Sent ${formatWatTimestamp()}`;

          for (const chatId of recipients) {
            await sendMessage(chatId, summaryMsg, buildStorylineInlineKeyboard(symbol));
          }
        }
      }

      const activeSummaryEntry = dailySummaryStateByPair.get(symbol);
      if (activeSummaryEntry && activeSummaryEntry.setup?.bias === activeBias) {
        await new Promise(resolve => setTimeout(resolve, 8500));
        const rawH4 = await getMarketCandles(symbol, "4h", 120);
        const h4Candles = Array.isArray(rawH4) ? rawH4 : [];

        const h4Break = evaluateH4BreakoutConfirmation(h4Candles, activeSummaryEntry.setup);
        if (h4Break) {
          const confirmKey = `${symbol}:${activeSummaryEntry.summaryKey}:${h4Break.datetime}:${h4Break.bias}`;
          if (!deliveredH4Confirmations.has(confirmKey)) {
            deliveredH4Confirmations.add(confirmKey);

            const isDevelopingCandleStage = d1Candles.length > activeSummaryEntry.d1CountAtSummary;
            const stageLabel = isDevelopingCandleStage
              ? "Developing D1 candle"
              : "Post-prev-D1 close";

            const emoji = h4Break.bias === "BULLISH" ? "🟢" : "🔴";
            const confirmMsg =
              `✅ ${emoji} <b>H4 BREAKOUT CONFIRMED — ${symbol}</b>\n\n` +
              `Bias: <b>${h4Break.bias}</b> (${stageLabel})\n` +
              `H4: <b>${h4Break.summary}</b>\n` +
              `Prev D1 Close: ${formatBreakDate12h(activeSummaryEntry.setup.prevDayDate)}\n\n` +
              `Sent ${formatWatTimestamp()}`;

            for (const chatId of recipients) {
              await sendMessage(chatId, confirmMsg, buildStorylineInlineKeyboard(symbol));
            }
          }
        }
      }
    } catch (err) {
      console.error(`Watchlist daily summary / H4 monitor failed for ${symbol}:`, err.message);
    }
  }
        }
                                       
function maybeRunStartOfWeekScan() {
  const watNow = getWatNow();
  const watDay = watNow.getUTCDay(); // 1 = Monday
  const watHour = watNow.getUTCHours();
  const weekKey = getMondayUtcDate(watNow.toISOString().slice(0, 10));

  if (watDay === 1 && watHour >= 6 && watHour < 12 && lastWeeklyAutoScanKey !== weekKey) {
    lastWeeklyAutoScanKey = weekKey;
    runPacedMarketScan({
      targetCount: MARKET_SCAN_TARGET_COUNT,
      paceMs: MARKET_SCAN_PAIR_DELAY_MS,
      triggerLabel: "NEW WEEK MARKET SCAN"
    });
  }
  }
      
function startWatchlistMonitor() {
  maybeRunStartOfWeekScan();
  runWatchlistDailySummaryAndH4Monitor().catch(err =>
    console.error("Watchlist daily summary / H4 monitor startup error:", err.message)
  );

  setInterval(() => {
    maybeRunStartOfWeekScan();
    scanWatchlistOnce();
    runWatchlistDailySummaryAndH4Monitor().catch(err =>
      console.error("Watchlist daily summary / H4 monitor interval error:", err.message)
    );
  }, MONITOR_INTERVAL_MS);
}


// =====================================
// SERVER START
// =====================================

app.listen(PORT, () => {
  console.log(`DEE SM SLK BOT running on port ${PORT}`);
  startWatchlistMonitor();
});
