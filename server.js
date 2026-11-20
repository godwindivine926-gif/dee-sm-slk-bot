require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json"
};

// ==================== GENERAL HELPERS ====================

function normalizeSymbol(input) {
  let symbol = String(input || "EUR/USD")
    .trim()
    .toUpperCase()
    .replace(/\s/g, "");

  // Convert common six-letter symbols into provider format.
  if (/^[A-Z]{6}$/.test(symbol)) {
    symbol = `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  }

  return symbol;
}

async function sendMessage(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    });
  } catch (error) {
    console.error(
      "Telegram message error:",
      error.response?.data || error.message
    );
  }
}

async function databaseRequest(path, method = "GET", body = null) {
  const response = await axios({
    method,
    url: `${SUPABASE_URL}/rest/v1/${path}`,
    headers: {
      ...supabaseHeaders,
      Prefer: "return=representation"
    },
    data: body
  });

  return response.data;
}

async function getMarketCandles(symbol, interval, outputsize = 100) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing.");
  }

  const normalizedSymbol = normalizeSymbol(symbol);

  const response = await axios.get(
    "https://api.twelvedata.com/time_series",
    {
      params: {
        symbol: normalizedSymbol,
        interval,
        outputsize,
        apikey: TWELVE_DATA_API_KEY
      }
    }
  );

  if (response.data.status === "error" || !response.data.values) {
    throw new Error(
      response.data.message || "Market data unavailable."
    );
  }

  return response.data.values;
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

// ==================== HOME ====================

app.get("/", (req, res) => {
  res.send("DEE SM SLK BOT is running.");
});

// ==================== TELEGRAM WEBHOOK ====================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();
    const parts = text.split(/\s+/);

    const command = parts[0].split("@")[0].toLowerCase();
    const argument = parts[1];

    if (command === "/start") {
      await sendMessage(
        chatId,
        `Welcome to <b>DEE SM SLK BOT</b>.\n\n` +
        `Your market monitoring assistant.\n\n` +
        `/help - View commands\n` +
        `/add GBPUSD - Add a pair\n` +
        `/remove GBPUSD - Remove a pair\n` +
        `/watchlist - View your pairs\n` +
        `/check GBPUSD - Check a pair\n` +
        `/weekly - View last week's events`
      );
      return;
    }

    if (command === "/help") {
      await sendMessage(
        chatId,
        `<b>DEE SM SLK BOT COMMANDS</b>\n\n` +
        `/add GBPUSD - Add a pair\n` +
        `/remove GBPUSD - Remove a pair\n` +
        `/watchlist - View your watchlist\n` +
        `/pause - Pause monitoring\n` +
        `/resume - Resume monitoring\n` +
        `/check GBPUSD - Check a pair\n` +
        `/weekly - View last week's events`
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

      if (existing.length > 0) {
        await sendMessage(chatId, `${symbol} is already on your watchlist.`);
        return;
      }

      await databaseRequest("watchlist", "POST", {
        chat_id: chatId,
        symbol,
        active: true
      });

      await sendMessage(chatId, `${symbol} added to your watchlist.`);
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

      await sendMessage(chatId, `${symbol} removed from your watchlist.`);
      return;
    }

    if (command === "/watchlist") {
      const pairs = await databaseRequest(
        `watchlist?chat_id=eq.${chatId}&select=symbol,active`
      );

      if (!pairs.length) {
        await sendMessage(chatId, "Your watchlist is empty. Use /add GBPUSD.");
        return;
      }

      const list = pairs.map(pair =>
        `${pair.active ? "🟢" : "⏸"} ${pair.symbol}`
      ).join("\n");

      await sendMessage(chatId, `<b>YOUR WATCHLIST</b>\n\n${list}`);
      return;
    }

    if (command === "/pause" || command === "/resume") {
      const active = command === "/resume";

      await databaseRequest(
        `watchlist?chat_id=eq.${chatId}`,
        "PATCH",
        { active }
      );

      await sendMessage(
        chatId,
        active
          ? "Monitoring resumed."
          : "Monitoring paused."
      );
      return;
    }

    if (command === "/check") {
      if (!argument) {
        await sendMessage(chatId, "Example: /check GBPUSD");
        return;
      }

      const symbol = normalizeSymbol(argument);

      await sendMessage(
        chatId,
        `${symbol} received.\n\nOn-demand SLK analysis is not connected to the Telegram command yet.`
      );
      return;
    }

    if (command === "/weekly") {
      const now = new Date();

      // Previous Sunday to Saturday in West Africa Time.
      const watOffset = 60 * 60 * 1000;
      const watNow = new Date(now.getTime() + watOffset);

      const day = watNow.getUTCDay();
      const daysSinceSunday = day;

      const thisSunday = new Date(watNow);
      thisSunday.setUTCDate(watNow.getUTCDate() - daysSinceSunday);
      thisSunday.setUTCHours(0, 0, 0, 0);

      const previousSunday = new Date(thisSunday);
      previousSunday.setUTCDate(previousSunday.getUTCDate() - 7);

      const previousSaturday = new Date(thisSunday);
      previousSaturday.setUTCMilliseconds(-1);

      const from = new Date(previousSunday.getTime() - watOffset).toISOString();
      const to = new Date(previousSaturday.getTime() - watOffset).toISOString();

      const events = await databaseRequest(
        `storyline_events?chat_id=eq.${chatId}` +
        `&created_at=gte.${encodeURIComponent(from)}` +
        `&created_at=lte.${encodeURIComponent(to)}` +
        `&order=created_at.asc`
      );

      if (!events.length) {
        await sendMessage(chatId, "No saved storyline events found for last week.");
        return;
      }

      const report = events.map(event =>
        `• ${event.symbol || "Market"} — ${event.event_type || event.event || "Event"}`
      ).join("\n");

      await sendMessage(chatId, `<b>LAST WEEK'S EVENTS</b>\n\n${report}`);
      return;
    }

  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);

    if (req.body.message?.chat?.id) {
      await sendMessage(
        req.body.message.chat.id,
        "Something went wrong while processing that command."
      );
    }
  }
});

// ==================== MARKET DATA TEST ====================

app.get("/test-market-data", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const results = {};

    for (const timeframe of ["1week", "1day", "4h"]) {
      results[timeframe] = await getMarketCandles(
        symbol,
        timeframe,
        10
      );
    }

    res.json({
      success: true,
      symbol,
      data: results
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==================== WEEKLY A/V DETECTOR ====================

app.get("/test-w1-av", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const raw = await getMarketCandles(symbol, "1week", 100);

    // Exclude the newest potentially unfinished weekly candle.
    const candles = raw.slice(1).reverse();

    const formations = [];

    for (let i = 1; i < candles.length; i++) {
      const first = candles[i - 1];
      const second = candles[i];

      const firstColor = candleColor(first);
      const secondColor = candleColor(second);

      if (firstColor === "BULLISH" && secondColor === "BEARISH") {
        formations.push({
          type: "A-SHAPE",
          first_candle: first.datetime,
          second_candle: second.datetime,
          zone: {
            low: bodyTop(second),
            high: bodyTop(first)
          }
        });
      }

      if (firstColor === "BEARISH" && secondColor === "BULLISH") {
        formations.push({
          type: "V-SHAPE",
          first_candle: first.datetime,
          second_candle: second.datetime,
          zone: {
            low: bodyBottom(first),
            high: bodyBottom(second)
          }
        });
      }
    }

    res.json({
      success: true,
      symbol,
      timeframe: "W1",
      formations
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==================== WEEKLY OPEN/CLOSE DETECTOR ====================

app.get("/test-w1-open-close", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const raw = await getMarketCandles(symbol, "1week", 100);
    const candles = raw.slice(1).reverse();

    const formations = [];

    for (let i = 1; i < candles.length; i++) {
      const first = candles[i - 1];
      const second = candles[i];

      const firstColor = candleColor(first);
      const secondColor = candleColor(second);

      if (
        firstColor === "BULLISH" &&
        secondColor === "BULLISH"
      ) {
        formations.push({
          type: "BULLISH-OPEN-CLOSE",
          first_candle: first.datetime,
          second_candle: second.datetime,
          level: Number(second.open),
          first_close: Number(first.close),
          second_open: Number(second.open)
        });
      }

      if (
        firstColor === "BEARISH" &&
        secondColor === "BEARISH"
      ) {
        formations.push({
          type: "BEARISH-OPEN-CLOSE",
          first_candle: first.datetime,
          second_candle: second.datetime,
          level: Number(second.open),
          first_close: Number(first.close),
          second_open: Number(second.open)
        });
      }
    }

    res.json({
      success: true,
      symbol,
      timeframe: "W1",
      formations
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==================== D1 CANDLE FILTER ====================

function filterCompletedDailyCandles(rawCandles) {
  const watNow = new Date(Date.now() + 60 * 60 * 1000);
  const todayWAT = watNow.toISOString().slice(0, 10);

  const valid = [];
  const excludedWeekend = [];
  const excludedUnfinished = [];

  for (const candle of rawCandles) {
    const date = candle.datetime;

    if (!date) continue;

    const day = new Date(`${date}T00:00:00Z`).getUTCDay();

    if (day === 0 || day === 6) {
      excludedWeekend.push(date);
      continue;
    }

    if (date >= todayWAT) {
      excludedUnfinished.push(date);
      continue;
    }

    const open = Number(candle.open);
    const close = Number(candle.close);

    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;

    valid.push(candle);
  }

  valid.sort((a, b) => a.datetime.localeCompare(b.datetime));

  return {
    candles: valid,
    excludedWeekend,
    excludedUnfinished
  };
}

// ==================== D1 CANDLE TEST ====================

app.get("/test-d1-candles", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const raw = await getMarketCandles(symbol, "1day", 100);
    const filtered = filterCompletedDailyCandles(raw);

    res.json({
      success: true,
      symbol,
      timeframe: "D1",
      raw_latest_dates: raw.slice(0, 10).map(c => c.datetime),
      used_dates: filtered.candles.slice(-10).map(c => c.datetime),
      excluded_weekend_dates: filtered.excludedWeekend,
      excluded_unfinished_dates: filtered.excludedUnfinished,
      candles: filtered.candles.slice(-10)
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==================== D1 STRUCTURE / EBO TEST ====================

app.get("/test-d1-ebo", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const raw = await getMarketCandles(symbol, "1day", 100);
    const filtered = filterCompletedDailyCandles(raw);
    const candles = filtered.candles;

    if (candles.length < 5) {
      return res.json({
        success: false,
        symbol,
        message: "Not enough completed D1 candles."
      });
    }

    let bearish = {
      candidateLL: {
        date: candles[0].datetime,
        body_bottom: bodyBottom(candles[0])
      },
      pullbackStarted: false,
      pullbackHigh: null,
      protectedLH: null,
      activeLL: null
    };

    let bullish = {
      candidateHH: {
        date: candles[0].datetime,
        body_top: bodyTop(candles[0])
      },
      pullbackStarted: false,
      pullbackLow: null,
      protectedHL: null,
      activeHH: null
    };

    const events = [];

    for (let i = 1; i < candles.length; i++) {
      const candle = candles[i];
      const previous = candles[i - 1];

      const close = Number(candle.close);
      const top = bodyTop(candle);
      const bottom = bodyBottom(candle);

      const previousTop = bodyTop(previous);
      const previousBottom = bodyBottom(previous);

      // Bearish sequence: provisional LL, pullback, continuation.
      if (!bearish.pullbackStarted && !bearish.protectedLH) {
        if (bottom < bearish.candidateLL.body_bottom) {
          bearish.candidateLL = {
            date: candle.datetime,
            body_bottom: bottom
          };
        }

        if (close > previousTop) {
          bearish.pullbackStarted = true;
          bearish.pullbackHigh = {
            date: candle.datetime,
            body_top: top
          };
        }

      } else if (bearish.pullbackStarted) {
        if (top > bearish.pullbackHigh.body_top) {
          bearish.pullbackHigh = {
            date: candle.datetime,
            body_top: top
          };
        }

        if (close < bearish.candidateLL.body_bottom) {
          bearish.protectedLH = {
            date: bearish.pullbackHigh.date,
            body_top: bearish.pullbackHigh.body_top
          };

          bearish.activeLL = {
            date: candle.datetime,
            body_bottom: bottom
          };

          events.push({
            type: "PROTECTED_LH_CONFIRMED",
            date: bearish.protectedLH.date,
            level: bearish.protectedLH.body_top,
            continuation_date: candle.datetime
          });

          bearish.candidateLL = {
            date: candle.datetime,
            body_bottom: bottom
          };

          bearish.pullbackStarted = false;
          bearish.pullbackHigh = null;
        }
      }

      if (
        bearish.protectedLH &&
        close > bearish.protectedLH.body_top
      ) {
        events.push({
          type: "BULLISH_EBO",
          date: candle.datetime,
          close,
          broken_level: bearish.protectedLH.body_top
        });

        bearish.protectedLH = null;
      }

      // Bullish sequence: provisional HH, pullback, continuation.
      if (!bullish.pullbackStarted && !bullish.protectedHL) {
        if (top > bullish.candidateHH.body_top) {
          bullish.candidateHH = {
            date: candle.datetime,
            body_top: top
          };
        }

        if (close < previousBottom) {
          bullish.pullbackStarted = true;
          bullish.pullbackLow = {
            date: candle.datetime,
            body_bottom: bottom
          };
        }

      } else if (bullish.pullbackStarted) {
        if (bottom < bullish.pullbackLow.body_bottom) {
          bullish.pullbackLow = {
            date: candle.datetime,
            body_bottom: bottom
          };
        }

        if (close > bullish.candidateHH.body_top) {
          bullish.protectedHL = {
            date: bullish.pullbackLow.date,
            body_bottom: bullish.pullbackLow.body_bottom
          };

          bullish.activeHH = {
            date: candle.datetime,
            body_top: top
          };

          events.push({
            type: "PROTECTED_HL_CONFIRMED",
            date: bullish.protectedHL.date,
            level: bullish.protectedHL.body_bottom,
            continuation_date: candle.datetime
          });

          bullish.candidateHH = {
            date: candle.datetime,
            body_top: top
          };

          bullish.pullbackStarted = false;
          bullish.pullbackLow = null;
        }
      }

      if (
        bullish.protectedHL &&
        close < bullish.protectedHL.body_bottom
      ) {
        events.push({
          type: "BEARISH_EBO",
          date: candle.datetime,
          close,
          broken_level: bullish.protectedHL.body_bottom
        });

        bullish.protectedHL = null;
      }
    }

    res.json({
      success: true,
      symbol,
      timeframe: "D1",
      latest_completed_candle: candles[candles.length - 1].datetime,

      bearish_structure: {
        active_LL: bearish.activeLL,
        candidate_LL: bearish.candidateLL,
        pullback_in_progress: bearish.pullbackStarted,
        latest_protected_LH: bearish.protectedLH
      },

      bullish_structure: {
        active_HH: bullish.activeHH,
        candidate_HH: bullish.candidateHH,
        pullback_in_progress: bullish.pullbackStarted,
        latest_protected_HL: bullish.protectedHL
      },

      events,

      excluded_weekend_dates: filtered.excludedWeekend,
      excluded_unfinished_dates: filtered.excludedUnfinished,

      note:
        "Experimental sequential body-based detector. Initial reference swings are provisional. Validate swing structure and key-level context on the chart before relying on results."
    });

  } catch (error) {
    console.error("D1 structure error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==================== H4 CANDLE TEST ====================

app.get("/test-h4-candles", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const raw = await getMarketCandles(symbol, "4h", 100);
    const candles = raw.slice(1).reverse();

    res.json({
      success: true,
      symbol,
      timeframe: "H4",
      candles: candles.slice(-10)
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==================== START SERVER ====================

app.listen(PORT,
