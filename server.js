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

// =====================================
// GENERAL HELPERS
// =====================================

function normalizeSymbol(input) {
  let symbol = String(input || "EUR/USD")
    .trim()
    .toUpperCase()
    .replace(/\s/g, "");

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
    console.error("Telegram error:", error.message);
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

  const response = await axios.get(
    "https://api.twelvedata.com/time_series",
    {
      params: {
        symbol: normalizeSymbol(symbol),
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

// =====================================
// MARKET DATA VALIDATION
// =====================================

function filterCompletedDailyCandles(rawCandles) {
  const watNow = new Date(Date.now() + 60 * 60 * 1000);
  const todayWAT = watNow.toISOString().slice(0, 10);

  const candles = [];
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

    const values = [
      Number(candle.open),
      Number(candle.high),
      Number(candle.low),
      Number(candle.close)
    ];

    if (!values.every(Number.isFinite)) continue;

    candles.push(candle);
  }

  candles.sort((a, b) =>
    a.datetime.localeCompare(b.datetime)
  );

  return {
    candles,
    excludedWeekend,
    excludedUnfinished
  };
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

    // Bullish followed by bearish = Swing High.
    if (
      firstColor === "BULLISH" &&
      secondColor === "BEARISH"
    ) {
      swings.push({
        type: "SWING_HIGH",
        date: second.datetime,
        first_candle: first.datetime,
        second_candle: second.datetime,
        index: i,
        level: Math.max(
          bodyTop(first),
          bodyTop(second)
        )
      });
    }

    // Bearish followed by bullish = Swing Low.
    if (
      firstColor === "BEARISH" &&
      secondColor === "BULLISH"
    ) {
      swings.push({
        type: "SWING_LOW",
        date: second.datetime,
        first_candle: first.datetime,
        second_candle: second.datetime,
        index: i,
        level: Math.min(
          bodyBottom(first),
          bodyBottom(second)
        )
      });
    }
  }

  return swings;
}

// =====================================
// REBUILT D1 STRUCTURE DETECTOR
// =====================================

function detectDailyStructure(candles) {
  const swings = identifySwings(candles);

  let latestSwingHigh = null;
  let latestSwingLow = null;

  let bearishLL = null;
  let bullishHH = null;

  let pendingLH = null;
  let pendingHL = null;

  let protectedLH = null;
  let protectedHL = null;

  const events = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const close = Number(candle.close);

    // Register swing formations completed on this candle.
    const formedSwings = swings.filter(
      swing => swing.index === i
    );

    for (const swing of formedSwings) {
      if (swing.type === "SWING_HIGH") {
        latestSwingHigh = swing;

        // A swing high after a confirmed LL is a possible LH.
        if (bearishLL && i > bearishLL.index) {
          pendingLH = swing;
        }
      }

      if (swing.type === "SWING_LOW") {
        latestSwingLow = swing;

        // A swing low after a confirmed HH is a possible HL.
        if (bullishHH && i > bullishHH.index) {
          pendingHL = swing;
        }
      }
    }

    // ---------------------------------
    // BEARISH STRUCTURE
    // ---------------------------------

    // A completed candle body closes below the previous swing low.
    if (
      latestSwingLow &&
      i > latestSwingLow.index &&
      close < latestSwingLow.level
    ) {
      bearishLL = {
        date: candle.datetime,
        index: i,
        level: bodyBottom(candle),
        broken_swing_low: latestSwingLow.level
      };

      protectedLH = null;

      events.push({
        type: "LL_CONFIRMED",
        date: candle.datetime,
        broken_swing_low: latestSwingLow.level,
        LL_body_bottom: bearishLL.level
      });
    }

    // A subsequent close below the LL confirms the retracement LH.
    if (
      bearishLL &&
      pendingLH &&
      pendingLH.index < i &&
      close < bearishLL.level
    ) {
      protectedLH = {
        date: pendingLH.date,
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

    // Bullish EBO: body closes above protected LH.
    if (
      protectedLH &&
      i > bearishLL.index &&
      close > protectedLH.level
    ) {
      events.push({
        type: "BULLISH_EBO",
        date: candle.datetime,
        close,
        broken_level: protectedLH.level
      });

      protectedLH = null;
      pendingLH = null;
    }

    // ---------------------------------
    // BULLISH STRUCTURE
    // ---------------------------------

    // A completed candle body closes above the previous swing high.
    if (
      latestSwingHigh &&
      i > latestSwingHigh.index &&
      close > latestSwingHigh.level
    ) {
      bullishHH = {
        date: candle.datetime,
        index: i,
        level: bodyTop(candle),
        broken_swing_high: latestSwingHigh.level
      };

      protectedHL = null;

      events.push({
        type: "HH_CONFIRMED",
        date: candle.datetime,
        broken_swing_high: latestSwingHigh.level,
        HH_body_top: bullishHH.level
      });
    }

    // A subsequent close above the HH confirms the retracement HL.
    if (
      bullishHH &&
      pendingHL &&
      pendingHL.index < i &&
      close > bullishHH.level
    ) {
      protectedHL = {
        date: pendingHL.date,
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

    // Bearish EBO: body closes below protected HL.
    if (
      protectedHL &&
      i > bullishHH.index &&
      close < protectedHL.level
    ) {
      events.push({
        type: "BEARISH_EBO",
        date: candle.datetime,
        close,
        broken_level: protectedHL.level
      });

      protectedHL = null;
      pendingHL = null;
    }
  }

  return {
    latestSwingHigh,
    latestSwingLow,
    bearishLL,
    bullishHH,
    pendingLH,
    pendingHL,
    protectedLH,
    protectedHL,
    swings,
    events
  };
}

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {
  res.send("DEE SM SLK BOT is running.");
});

// =====================================
// TELEGRAM WEBHOOK
// =====================================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const parts = message.text.trim().split(/\s+/);

    const command = parts[0].split("@")[0].toLowerCase();
    const argument = parts[1];

    if (command === "/start") {
      await sendMessage(
        chatId,
        `<b>DEE SM SLK BOT</b>\n\n` +
        `/help - View commands\n` +
        `/add GBPUSD - Add pair\n` +
        `/remove GBPUSD - Remove pair\n` +
        `/watchlist - View pairs\n` +
        `/check GBPUSD - Check pair\n` +
        `/pause - Pause monitoring\n` +
        `/resume - Resume monitoring\n` +
        `/weekly - Previous week's events`
      );
      return;
    }

    if (command === "/help") {
      await sendMessage(
        chatId,
        `<b>BOT COMMANDS</b>\n\n` +
        `/add GBPUSD\n` +
        `/remove GBPUSD\n` +
        `/watchlist\n` +
        `/check GBPUSD\n` +
        `/pause\n` +
        `/resume\n` +
        `/weekly`
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
        active: true
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
        `watchlist?chat_id=eq.${chatId}&select=symbol,active`
      );

      if (!pairs.length) {
        await sendMessage(chatId, "Your watchlist is empty.");
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
        active ? "Monitoring resumed." : "Monitoring paused."
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
        `${symbol} received. Full Telegram SLK analysis is not connected yet.`
      );
      return;
    }

    if (command === "/weekly") {
      const now = new Date();
      const watOffset = 60 * 60 * 1000;
      const watNow = new Date(now.getTime() + watOffset);

      const thisSunday = new Date(watNow);
      thisSunday.setUTCDate(
        watNow.getUTCDate() - watNow.getUTCDay()
      );
      thisSunday.setUTCHours(0, 0, 0, 0);

      const previousSunday = new Date(thisSunday);
      previousSunday.setUTCDate(previousSunday.getUTCDate() - 7);

      const previousSaturday = new Date(thisSunday);
      previousSaturday.setUTCMilliseconds(-1);

      const from = new Date(
        previousSunday.getTime() - watOffset
      ).toISOString();

      const to = new Date(
        previousSaturday.getTime() - watOffset
      ).toISOString();

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

      const report = events.map(event =>
        `• ${event.symbol || "Market"} — ${event.event_type || event.event || "Event"}`
      ).join("\n");

      await sendMessage(chatId, `<b>LAST WEEK'S EVENTS</b>\n\n${report}`);
      return;
    }

  } catch (error) {
    console.error(
      "Webhook error:",
      error.response?.data || error.message
    );

    if (req.body.message?.chat?.id) {
      await sendMessage(
        req.body.message.chat.id,
        "Something went wrong processing that command."
      );
    }
  }
});

// =====================================
// MARKET DATA TEST
// =====================================

app.get("/test-market-data", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const data = {};

    for (const timeframe of ["1week", "1day", "4h"]) {
      data[timeframe] = await getMarketCandles(
        symbol,
        timeframe,
        10
      );
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

// =====================================
// WEEKLY A/V
// =====================================

app.get("/test-w1-av", async (req, res) => {
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

      if (firstColor === "BULLISH" && secondColor === "BEARISH") {
        formations.push({
          type: "A-SHAPE",
          first_candle: first.datetime,
          second_candle: second.datetime,
          zone: {
            low: Math.min(bodyTop(first), bodyTop(second)),
            high: Math.max(bodyTop(first), bodyTop(second))
          }
        });
      }

      if (firstColor === "BEARISH" && secondColor === "BULLISH") {
        formations.push({
          type: "V-SHAPE",
          first_candle: first.datetime,
          second_candle: second.datetime,
          zone: {
            low: Math.min(bodyBottom(first), bodyBottom(second)),
            high: Math.max(bodyBottom(first), bodyBottom(second))
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

// =====================================
// WEEKLY OPEN/CLOSE
// =====================================

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

// =====================================
// D1 CANDLE TEST
// =====================================

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

// =====================================
// NEW D1 STRUCTURE TEST
// =====================================

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

    const result = detectDailyStructure(candles);

    res.json({
      success: true,
      symbol,
      timeframe: "D1",

      latest_completed_candle:
        candles[candles.length - 1].datetime,

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

      events: result.events,

      excluded_weekend_dates: filtered.excludedWeekend,
      excluded_unfinished_dates: filtered.excludedUnfinished,

      note:
        "Swing levels use consecutive two-candle formations and candle bodies. EBO requires a completed candle body close beyond the protected swing."
    });

  } catch (error) {
    console.error("D1 detector error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =====================================
// H4 CANDLE TEST
// =====================================

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

// =====================================
// SERVER START
// =====================================

app.listen(PORT, () => {
  console.log(`DEE SM SLK BOT running on port ${PORT}`);
});
