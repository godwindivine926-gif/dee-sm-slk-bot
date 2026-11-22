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

function filterCompletedWeeklyCandles(rawCandles) {
  const watNow = getWatNow();

  const currentWeekStart = new Date(watNow);
  currentWeekStart.setUTCHours(0, 0, 0, 0);
  currentWeekStart.setUTCDate(
    currentWeekStart.getUTCDate() - currentWeekStart.getUTCDay()
  );

  const currentWeekDate = currentWeekStart.toISOString().slice(0, 10);

  const validCandles = rawCandles
    .filter(isValidOhlcCandle)
    .sort((a, b) => a.datetime.localeCompare(b.datetime));

  const candles = validCandles.filter(
    candle => String(candle.datetime).slice(0, 10) < currentWeekDate
  );

  const developing = validCandles.filter(
    candle => String(candle.datetime).slice(0, 10) >= currentWeekDate
  );

  return {
    candles,
    developing,
    excludedUnfinished: developing.map(candle => candle.datetime)
  };
}

function getMondayUtcDate(dateStr) {
  const dt = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const day = dt.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diffToMonday);
  return dt.toISOString().slice(0, 10);
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

  const lastW1Date = base.length > 0
    ? String(base[base.length - 1].datetime).slice(0, 10)
    : "";

  for (const weekCandle of fallbackWeekly) {
    if (weekCandle.datetime > lastW1Date) {
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
  bias = "BEARISH",
  { isH4Active = true, maxH4AgeCandles = 12 } = {}
) {
  if (!isH4Active) {
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

  const h4Struct = detectH4Structure(safeH4);
  const h4KeyLevels = detectDailyKeyLevels(safeH4);

  const minAllowedH4Index = Math.max(0, safeH4.length - maxH4AgeCandles);

  const h4EboEvent = Array.isArray(h4Struct?.events)
    ? [...h4Struct.events]
        .reverse()
        .find(ev => {
          if (ev.type !== "BULLISH_EBO" && ev.type !== "BEARISH_EBO") return false;
          const idx = safeH4.findIndex(c => String(c.datetime) === String(ev.date));
          return idx >= minAllowedH4Index;
        })
    : null;

  if (!h4EboEvent) {
    return {
      h4Ebo: null,
      h4Tap: null,
      m30Breakout: null,
      status: "WAITING_H4_EBO"
    };
  }

  const h4EboIndex = safeH4.findIndex(c => String(c.datetime) === String(h4EboEvent.date));
  const startH4Idx = h4EboIndex >= 0 ? h4EboIndex + 1 : 1;

  const h4Swings = identifySwings(safeH4);
  const effectiveBias =
    h4EboEvent.type === "BULLISH_EBO"
      ? "BULLISH"
      : h4EboEvent.type === "BEARISH_EBO"
      ? "BEARISH"
      : bias;

  const candidateH4Levels = [];

  if (Number.isFinite(Number(h4EboEvent.broken_level))) {
    const lvl = Number(h4EboEvent.broken_level);
    candidateH4Levels.push({ label: "H4 EBO LEVEL", low: lvl, high: lvl, price: lvl });
  }

  if (Number.isFinite(Number(h4EboEvent.close))) {
    const cls = Number(h4EboEvent.close);
    candidateH4Levels.push({ label: "H4 BREAK CLOSE", low: cls, high: cls, price: cls });
  }

  for (const kl of h4KeyLevels) {
    if (kl.formation_index <= (h4EboIndex >= 0 ? h4EboIndex : safeH4.length - 1)) {
      const low = Math.min(Number(kl.low), Number(kl.high));
      const high = Math.max(Number(kl.low), Number(kl.high));
      if (Number.isFinite(low) && Number.isFinite(high)) {
        candidateH4Levels.push({
          label: kl.type === "A-SHAPE" || kl.type === "V-SHAPE" ? `${kl.type} KEY LEVEL` : kl.type,
          low,
          high,
          price: effectiveBias === "BEARISH" ? high : low
        });
      }
    }
  }

  for (const sw of h4Swings) {
    if (sw.index <= (h4EboIndex >= 0 ? h4EboIndex : safeH4.length - 1) && Number.isFinite(Number(sw.level))) {
      const lvl = Number(sw.level);
      candidateH4Levels.push({
        label: sw.type === "SWING_HIGH" ? "H4 SWING HIGH / IBO" : "H4 SWING LOW / IBO",
        low: lvl,
        high: lvl,
        price: lvl
      });
    }
  }

  let h4Tap = null;
  for (let i = startH4Idx; i < safeH4.length; i++) {
    const c = safeH4[i];
    const high = Number(c.high);
    const low = Number(c.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

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
      h4Ebo: h4EboEvent,
      h4Tap: null,
      m30Breakout: null,
      status: "WAITING_H4_KEY_LEVEL_TAP"
    };
  }

  const tapTs = toTimestampMs(h4Tap.datetime, false);
  const postTapM30 = safeM30.filter(c => toTimestampMs(c.datetime, false) >= tapTs);

  let m30Breakout = null;
  if (postTapM30.length >= 2) {
    let referenceLevel = null;
    if (effectiveBias === "BEARISH") {
      const m30SwingsLow = identifySwings(postTapM30).filter(s => s.type === "SWING_LOW");
      referenceLevel = m30SwingsLow.length
        ? Number(m30SwingsLow[m30SwingsLow.length - 1].level)
        : Number(postTapM30[0].low);

      for (let i = 1; i < postTapM30.length; i++) {
        const close = Number(postTapM30[i].close);
        if (Number.isFinite(referenceLevel) && Number.isFinite(close) && close < referenceLevel) {
          m30Breakout = {
            direction: "BEARISH",
            level: referenceLevel,
            close,
            datetime: postTapM30[i].datetime
          };
          break;
        }
      }
    } else {
      const m30SwingsHigh = identifySwings(postTapM30).filter(s => s.type === "SWING_HIGH");
      referenceLevel = m30SwingsHigh.length
        ? Number(m30SwingsHigh[m30SwingsHigh.length - 1].level)
        : Number(postTapM30[0].high);

      for (let i = 1; i < postTapM30.length; i++) {
        const close = Number(postTapM30[i].close);
        if (Number.isFinite(referenceLevel) && Number.isFinite(close) && close > referenceLevel) {
          m30Breakout = {
            direction: "BULLISH",
            level: referenceLevel,
            close,
            datetime: postTapM30[i].datetime
          };
          break;
        }
      }
    }
  }

  return {
    h4Ebo: h4EboEvent,
    h4Tap,
    m30Breakout,
    status: m30Breakout ? "M30_BREAKOUT_CONFIRMED" : "WAITING_M30_BREAKOUT"
  };
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
        const [rawD1, rawH4, rawM30] = await Promise.all([
          getMarketCandles(symbol, "1day", 150),
          getMarketCandles(symbol, "4h", 150),
          getMarketCandles(symbol, "30min", 150)
        ]);

        const d1Candles = prepareStorylineCandles(rawD1, { excludeWeekends: true });
        const d1Struct = d1Candles.length >= 5 ? detectDailyStructure(d1Candles) : null;
        const hasD1KeyLevelTap = Boolean(
          d1Struct?.bearishKeyLevelContact || d1Struct?.bullishKeyLevelContact
        );

        const entryCheck = detectH4TapAndM30Breakout(rawH4, rawM30, "BEARISH", {
          isH4Active: hasD1KeyLevelTap,
          maxH4AgeCandles: 12
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
          ? `✅ H4 External BO @ <b>${formatPrice(entryCheck.h4Ebo.close ?? entryCheck.h4Ebo.broken_level)}</b> · ${entryCheck.h4Ebo.date}`
          : `⏳ H4 External BO: <i>No recent H4 external BO confirmed</i>`;

        const h4TapText = entryCheck.h4Tap
          ? `✅ H4 Tap (${entryCheck.h4Tap.label}) @ <b>${formatPrice(entryCheck.h4Tap.price)}</b> · ${entryCheck.h4Tap.datetime}`
          : entryCheck.h4Ebo
          ? `⏳ H4 Tap: <i>Waiting for tap into H4 breakout / A-shape key level / IBO</i>`
          : `🔒 H4 Tap: <i>Locked until recent H4 external BO</i>`;

        const m30Text = entryCheck.m30Breakout
          ? `✅ <b>30M Breakout (${entryCheck.m30Breakout.direction})</b> broke <b>${formatPrice(entryCheck.m30Breakout.level)}</b> · closed <b>${formatPrice(entryCheck.m30Breakout.close)}</b> (${entryCheck.m30Breakout.datetime})`
          : entryCheck.h4Tap
          ? `⏳ <b>30M Breakout:</b> <i>Watching 30m candles after H4 tap for breakout</i>`
          : `🔒 <b>30M Breakout:</b> <i>Available once H4 external BO & H4 key-level tap occur</i>`;

        await sendMessage(
          chatId,
          `<b>${symbol} — CONFIRMATION ENTRY (30M)</b>\n\n` +
            `${h4EboText}\n` +
            `${h4TapText}\n` +
            `${m30Text}\n\n` +
            `<i>Not an entry signal — verify candle close & risk on chart.</i>`
        );
        return;
          }
    }
    const message = req.body?.message;
    if (!message || !message.text) return;

    chatId = parseChatId(message.chat.id);
    const parts = message.text.trim().split(/\s+/);

    const command = parts[0].split("@")[0].toLowerCase();
    const argument = parts[1];

            if (command === "/start") {
      await sendMessage(
        chatId,
        `<b>Welcome to DEE SM SLK BOT — what's on your radar?</b>\n\n` +
          `- <b>Weekly focus</b> – use <code>/weekly</code> to see last week's saved events.\n` +
          `- <b>Market reads</b> – use <code>/check GBPUSD</code> for W1, D1 & H4 structure, key levels, and EBOs.\n` +
          `- <b>Watchlist</b> – use <code>/add</code>, <code>/remove</code>, or <code>/watchlist</code> to manage your pairs.\n` +
          `- <b>Monitor control</b> – use <code>/pause</code> or <code>/resume</code> to toggle automated scans.\n\n` +
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
          `/weekly - Previous week's events`
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
  const rawText = message?.text || req.body?.message?.text || "";
  const parts = String(rawText).trim().split(/\s+/);
  const symbol = normalizeSymbol(parts[1] || "GBPUSD");
  await sendMessage(chatId, `Checking <b>${symbol}</b> W1, D1 & H4 structure...`);

  const [rawW1, rawD1, rawH4] = await Promise.all([
    getMarketCandles(symbol, "1week", 100),
    getMarketCandles(symbol, "1day", 150),
    getMarketCandles(symbol, "4h", 150)
  ]);

  const d1Candles = prepareStorylineCandles(rawD1, { excludeWeekends: true });
  const h4Candles = prepareStorylineCandles(rawH4, { excludeWeekends: true });
  const mergedW1 = mergeWeeklyCandlesWithDailyFallback(
    prepareStorylineCandles(rawW1, { excludeWeekends: false }),
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

  const formatBreakDate12h = (rawDate) => {
    if (!rawDate) return "N/A";
    const str = String(rawDate).trim();
    const match = str.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}):(\d{2})(?::\d{2})?/);
    if (!match) return str;

    const [, datePart, hourRaw, minutePart] = match;
    let hour = Number(hourRaw);
    const ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12;
    if (hour === 0) hour = 12;

    return `${datePart} ${hour}:${minutePart} ${ampm} WAT`;
  };

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

  const evaluateTfStoryline = (candles, opts = {}) => {
    if (!Array.isArray(candles) || candles.length === 0) {
      return { ebo: null, ibo: null, retestTap: null, latestBreak: null, hasBreak: false };
    }

    const { bias, preTapSwing, pullbackSwing, keyLevels = [] } = opts;
    let ebo = null;
    let ibo = null;
    let retestTap = null;

    // 1. External break (EBO)
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

    // 2. Internal break (IBO)
    if (pullbackSwing && Number.isFinite(Number(pullbackSwing.level))) {
      const startIdx = Math.max(ebo ? ebo.index + 1 : 0, Number(pullbackSwing.index ?? 0) + 1);
      const lvl = Number(pullbackSwing.level);

      for (let i = startIdx; i < candles.length; i++) {
        const close = Number(candles[i].close);
        if (Number.isNaN(close)) continue;

        const broke = (bias === "BULLISH" && close > lvl) || (bias === "BEARISH" && close < lvl);
        if (broke) {
          ibo = {
            type: "IBO",
            level: lvl,
            close,
            datetime: candles[i].datetime || candles[i].date,
            index: i
          };
          break;
        }
      }
    }

    const latestBreak =
      ebo && ibo ? (ibo.index >= ebo.index ? ibo : ebo) : ibo || ebo || null;

    // 3. Tap into ANY qualifying key level (open/close, external BO, or internal BO) after the break
    const candidateLevels = [];
    if (Array.isArray(keyLevels)) {
      for (const kl of keyLevels) {
        if (!kl) continue;
        const low = Number(kl.low ?? kl.level);
        const high = Number(kl.high ?? kl.level);
        if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
        candidateLevels.push({
          label: kl.type || "KEY LEVEL",
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

        const tappedLevel = candidateLevels.find(
          kl => kl.formedIndex < i && low <= kl.high && high >= kl.low
        );

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
  };

  const d1State = evaluateTfStoryline(d1Candles, {
    bias: d1Bias,
    preTapSwing: d1PreTapSwing,
    pullbackSwing: d1PullbackSwing,
    keyLevels: d1Structure?.keyLevels || []
  });

  // Check H4 breakout once D1 has broken and tapped a qualifying Daily key level
  const h4ExternalEvent = Array.isArray(h4Structure?.events)
    ? [...h4Structure.events]
        .reverse()
        .find(ev => ev.type === "BULLISH_EBO" || ev.type === "BEARISH_EBO")
    : null;

  const h4Confirmed =
    d1State.hasBreak && d1State.retestTap
      ? h4ExternalEvent
        ? {
            type: "H4 EBO",
            price: h4ExternalEvent.close ?? h4ExternalEvent.broken_level,
            datetime: h4ExternalEvent.date
          }
        : d1h4Setup?.ebo
        ? {
            type: String(d1h4Setup.ebo.type || "H4 EBO").replace("_", " "),
            price: d1h4Setup.ebo.close ?? d1h4Setup.ebo.broken_pullback_level,
            datetime: d1h4Setup.ebo.date
          }
        : null
      : null;

  const storylineEmoji = d1Bias === "BULLISH" ? "🟢" : d1Bias === "BEARISH" ? "🔴" : "⚪";
  const storylineDir = d1Bias === "BULLISH" ? "BULLISH" : d1Bias === "BEARISH" ? "BEARISH" : "NEUTRAL";

  const d1BreakLine = d1State.latestBreak
    ? `D1 ${d1State.latestBreak.type} @ <b>${formatPrice(d1State.latestBreak.close)}</b> · ${formatBreakDate12h(d1State.latestBreak.datetime)}`
    : `D1 break: <i>None confirmed yet</i>`;

  const d1TapLine = d1State.retestTap
    ? `D1 tap (${d1State.retestTap.label}) @ <b>${formatPrice(d1State.retestTap.level)}</b> · ${formatBreakDate12h(d1State.retestTap.datetime)}`
    : d1State.latestBreak
    ? `D1 tap: <i>Waiting for tap into D1 key level (open/close, external BO, or internal BO)</i>`
    : `D1 tap: <i>Pending D1 break</i>`;

  const h4BreakLine =
    d1State.hasBreak && d1State.retestTap
      ? h4Confirmed
        ? `${h4Confirmed.type} @ <b>${formatPrice(h4Confirmed.price)}</b> · ${formatBreakDate12h(h4Confirmed.datetime)}`
        : `H4 break: <i>Watching for H4 breakout (external BO preferred)</i>`
      : `H4 break: <i>Locked until D1 breaks & taps a key level</i>`;

  const sequenceStatus = h4Confirmed
    ? `<b>Status: H4 breakout confirmed — look for entries</b>`
    : `<b>Status: Waiting on full W1 > D1 > H4 sequence</b>`;

  const msg =
    `${storylineEmoji} <b>${storylineDir} STORYLINE —</b>\n` +
    `<b>${symbol} · W1 > D1 > H4</b>\n\n` +
    `${w1Summary}\n` +
    `${d1BreakLine}\n` +
    `${d1TapLine}\n` +
    `${h4BreakLine}\n\n` +
    `${sequenceStatus}\n\n` +
    `Sent ${formatWatTimestamp()}\n\n` +
    `Not an entry signal — bias context only.`;

  await sendMessage(chatId, msg, buildStorylineInlineKeyboard(symbol));
  return;
}
    
    if (command === "/weekly") {
      const now = new Date();
      const watNow = getWatNow(now);

      const thisSunday = new Date(watNow);
      thisSunday.setUTCDate(watNow.getUTCDate() - watNow.getUTCDay());
      thisSunday.setUTCHours(0, 0, 0, 0);

      const previousSunday = new Date(thisSunday);
      previousSunday.setUTCDate(previousSunday.getUTCDate() - 7);

      const previousSaturdayEnd = new Date(thisSunday.getTime() - 1);

      const from = new Date(previousSunday.getTime() - WAT_OFFSET_MS).toISOString();
      const to = new Date(previousSaturdayEnd.getTime() - WAT_OFFSET_MS).toISOString();

      const events = await databaseRequest(
        `storyline_events?chat_id=eq.${chatId}` +
          `&created_at=gte.${encodeURIComponent(from)}` +
          `&created_at=lte.${encodeURIComponent(to)}` +
          `&order=created_at.asc`
      );

      if (!events.length) {
        await sendMessage(chatId, "No saved events found for last week.");
        return;
      }

      const report = events
        .map(
          event =>
            `• ${event.symbol || "Market"} — ${event.event_type || event.event || "Event"}`
        )
        .join("\n");

      await sendMessage(chatId, `<b>LAST WEEK'S EVENTS</b>\n\n${report}`);
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
  return watNow.toISOString().replace("T", " ").slice(0, 16) + " WAT";
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
        const [rawW1, rawD1, rawH4] = await Promise.all([
          getMarketCandles(symbol, "1week", 100),
          getMarketCandles(symbol, "1day", 150),
          getMarketCandles(symbol, "4h", 150)
        ]);

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

        marketCache.set(symbol, { w1ToD1, d1ToH4, w1Bias, d1Bias, nextDayRule });
      } catch (err) {
        console.error(`Monitor fetch error for ${symbol}:`, err.message);
      }

      await new Promise(resolve => setTimeout(resolve, 1200));
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

    hasCompletedInitialSeed = true;
  } catch (err) {
    console.error("Watchlist scan error:", err.response?.data || err.message);
  } finally {
    isMonitorRunning = false;
  }
}

function startWatchlistMonitor() {
  setInterval(() => {
    scanWatchlistOnce();
  }, MONITOR_INTERVAL_MS);
}

// =====================================
// SERVER START
// =====================================

app.listen(PORT, () => {
  console.log(`DEE SM SLK BOT running on port ${PORT}`);
  startWatchlistMonitor();
});
