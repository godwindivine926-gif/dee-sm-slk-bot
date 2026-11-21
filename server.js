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
// COMPLETED WEEKLY CANDLE FILTER
// =====================================

function filterCompletedWeeklyCandles(rawCandles) {
  const watNow = new Date(Date.now() + 60 * 60 * 1000);

  const currentWeekStart = new Date(watNow);
  currentWeekStart.setUTCHours(0, 0, 0, 0);
  currentWeekStart.setUTCDate(
    currentWeekStart.getUTCDate() - currentWeekStart.getUTCDay()
  );

  const currentWeekDate = currentWeekStart.toISOString().slice(0, 10);

  const candles = rawCandles.filter(candle => {
    if (!candle.datetime) return false;

    const values = [
      Number(candle.open),
      Number(candle.high),
      Number(candle.low),
      Number(candle.close)
    ];

    return (
      candle.datetime < currentWeekDate &&
      values.every(Number.isFinite)
    );
  });

  candles.sort((a, b) =>
    a.datetime.localeCompare(b.datetime)
  );

  return {
    candles,
    developing: rawCandles.filter(candle =>
      candle.datetime >= currentWeekDate
    ),
    excludedUnfinished: rawCandles
      .filter(candle => candle.datetime >= currentWeekDate)
      .map(candle => candle.datetime)
  };
}

// =====================================
// W1 STORYLINE DETECTOR
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
// DAILY KEY-LEVEL DETECTOR
// =====================================

function detectDailyKeyLevels(candles) {
  const levels = [];

  for (let i = 1; i < candles.length; i++) {
    const first = candles[i - 1];
    const second = candles[i];

    const firstColor = candleColor(first);
    const secondColor = candleColor(second);

    // A-SHAPE: Bullish followed by bearish.
    if (
      firstColor === "BULLISH" &&
      secondColor === "BEARISH"
    ) {
      levels.push({
        type: "A-SHAPE",
        bias: "BEARISH",
        first_candle: first.datetime,
        second_candle: second.datetime,
        formation_index: i,
        low: Math.min(
          bodyTop(first),
          bodyTop(second)
        ),
        high: Math.max(
          bodyTop(first),
          bodyTop(second)
        ),
        status: "FORMED"
      });
    }

    // V-SHAPE: Bearish followed by bullish.
    if (
      firstColor === "BEARISH" &&
      secondColor === "BULLISH"
    ) {
      levels.push({
        type: "V-SHAPE",
        bias: "BULLISH",
        first_candle: first.datetime,
        second_candle: second.datetime,
        formation_index: i,
        low: Math.min(
          bodyBottom(first),
          bodyBottom(second)
        ),
        high: Math.max(
          bodyBottom(first),
          bodyBottom(second)
        ),
        status: "FORMED"
      });
    }

    // OPEN/CLOSE: Two consecutive candles of the same colour.
    if (
      firstColor === secondColor &&
      firstColor !== "DOJI"
    ) {
      const firstClose = Number(first.close);
      const secondOpen = Number(second.open);

      if (firstClose !== secondOpen) {
        levels.push({
          type: "OPEN-CLOSE",
          bias: firstColor === "BULLISH"
            ? "BULLISH"
            : "BEARISH",
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

// =====================================
// DAILY KEY-LEVEL REACTION DETECTOR
// =====================================

function detectDailyKeyLevelReactions(candles, levels) {
  const reactions = [];
  const seen = new Set();

  for (const level of levels) {
    for (
      let i = level.formation_index + 1;
      i < candles.length;
      i++
    ) {
      const candle = candles[i];

      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);

      const touched =
        high >= level.low && low <= level.high;

      if (!touched) continue;

      let reaction = null;

      if (
        level.bias === "BEARISH" &&
        close < level.low
      ) {
        reaction = "BEARISH_KEY_LEVEL_REACTION";
      }

      if (
        level.bias === "BULLISH" &&
        close > level.high
      ) {
        reaction = "BULLISH_KEY_LEVEL_REACTION";
      }

      if (!reaction) continue;

      const uniqueKey =
        `${level.type}-${level.first_candle}-${level.second_candle}-${candle.datetime}`;

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

      // First confirmed reaction for this level.
      break;
    }
  }

  return reactions.sort((a, b) =>
    b.date.localeCompare(a.date)
  );
}

// =====================================
// DAILY KEY-LEVEL STATUS TRACKER
// =====================================

function trackDailyKeyLevels(candles, levels) {
  return levels.map(level => {
    let status = "ACTIVE";
    let reaction = null;
    let invalidation = null;

    for (
      let i = level.formation_index + 1;
      i < candles.length;
      i++
    ) {
      const candle = candles[i];
      const close = Number(candle.close);
      const high = Number(candle.high);
      const low = Number(candle.low);

      const touched =
        high >= level.low && low <= level.high;

      // Check for invalidation.
      const invalidated =
        (level.bias === "BEARISH" && close > level.high) ||
        (level.bias === "BULLISH" && close < level.low);

      if (invalidated) {
        status = "INVALIDATED";
        invalidation = {
          date: candle.datetime,
          close
        };
        reaction = null;
        continue;
      }

      // Check for confirmed reaction.
      if (touched) {
        const bearishReaction =
          level.bias === "BEARISH" && close < level.low;

        const bullishReaction =
          level.bias === "BULLISH" && close > level.high;

        if (bearishReaction || bullishReaction) {
          status = "REACTED";
          reaction = {
            date: candle.datetime,
            close
          };
          invalidation = null;
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
// REBUILT D1 STRUCTURE DETECTOR
// =====================================

function detectDailyStructure(candles) {
  const swings = identifySwings(candles);
  const keyLevels = detectDailyKeyLevels(candles);
  const trackedKeyLevels = trackDailyKeyLevels(candles, keyLevels);

const keyLevelReactions =
  detectDailyKeyLevelReactions(candles, keyLevels);

  let latestSwingHigh = null;
  let latestSwingLow = null;

  let bearishLL = null;
  let bullishHH = null;

  let pendingLH = null;
  let pendingHL = null;

  let protectedLH = null;
  let protectedHL = null;

  let direction = "UNCONFIRMED";

  const events = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const close = Number(candle.close);

    const formedSwings = swings.filter(
      swing => swing.index === i
    );

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

    // =====================================
    // BEARISH EBO
    // =====================================

    if (
      protectedHL &&
      i > protectedHL.index &&
      close < protectedHL.level
    ) {
      events.push({
        type: "BEARISH_EBO",
        date: candle.datetime,
        close,
        broken_level: protectedHL.level,
        protected_hl_date: protectedHL.date
      });

      protectedHL = null;
      pendingHL = null;
    }

    // =====================================
    // BULLISH EBO
    // =====================================

    if (
      protectedLH &&
      i > protectedLH.index &&
      close > protectedLH.level
    ) {
      events.push({
        type: "BULLISH_EBO",
        date: candle.datetime,
        close,
        broken_level: protectedLH.level,
        protected_lh_date: protectedLH.date
      });

      protectedLH = null;
      pendingLH = null;
    }

    // =====================================
    // BEARISH STRUCTURE
    // =====================================

    if (
      direction === "BEARISH" &&
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

    // =====================================
    // BULLISH STRUCTURE
    // =====================================

    if (
      direction === "BULLISH" &&
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

    // =====================================
    // CONFIRM NEW LL
    // =====================================

    if (
      latestSwingLow &&
      i > latestSwingLow.index &&
      close < latestSwingLow.level &&
      (!bearishLL ||
        bearishLL.broken_swing_low !== latestSwingLow.level)
    ) {
      bearishLL = {
        date: candle.datetime,
        index: i,
        level: bodyBottom(candle),
        broken_swing_low: latestSwingLow.level
      };

      direction = "BEARISH";

      // Invalidate the previous bullish structure.
      bullishHH = null;
      pendingHL = null;
      protectedHL = null;

      // A new LL requires a fresh LH formation.
      pendingLH = null;
      protectedLH = null;

      events.push({
        type: "LL_CONFIRMED",
        date: candle.datetime,
        broken_swing_low: latestSwingLow.level,
        LL_body_bottom: bearishLL.level
      });
    }

    // =====================================
    // CONFIRM NEW HH
    // =====================================

    if (
      latestSwingHigh &&
      i > latestSwingHigh.index &&
      close > latestSwingHigh.level &&
      (!bullishHH ||
        bullishHH.broken_swing_high !== latestSwingHigh.level)
    ) {
      bullishHH = {
        date: candle.datetime,
        index: i,
        level: bodyTop(candle),
        broken_swing_high: latestSwingHigh.level
      };

      direction = "BULLISH";

      // Invalidate the previous bearish structure.
      bearishLL = null;
      pendingLH = null;
      protectedLH = null;

      // A new HH requires a fresh HL formation.
      pendingHL = null;
      protectedHL = null;

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
    swings,
    events,
    keyLevels,
keyLevelReactions,
trackedKeyLevels,
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

      await sendMessage(chatId, `Checking ${symbol} D1 structure...`);

      const raw = await getMarketCandles(symbol, "1day", 100);
      const filtered = filterCompletedDailyCandles(raw);
      const candles = filtered.candles;

      if (candles.length < 5) {
        await sendMessage(chatId, "Not enough completed D1 candles.");
        return;
      }

      const result = detectDailyStructure(candles);
        const statusText = ["ACTIVE", "REACTED", "INVALIDATED"]
  .map(status => {
    const levels = result.trackedKeyLevels
      .filter(level => level.status === status)
      .slice(-10);

    const details = levels.length
      ? levels.map(level =>
          `• ${level.type}\n` +
          `  Bias: ${level.bias} | Formed: ${level.second_candle}\n` +
          `  Zone: ${level.low} – ${level.high}`
        ).join("\n")
      : "None";

    return `<b>${status} LEVELS</b>\n${details}`;
  })
  .join("\n\n");
        const reactionText = result.keyLevelReactions.length
  ? result.keyLevelReactions.slice(-10).map(reaction =>
      `• ${reaction.type} — ${reaction.date}\n` +
      `  Level: ${reaction.level_type} | Formed: ${reaction.level_formed}\n` +
`  Close: ${reaction.close}`
    ).join("\n")
  : "No confirmed key-level reactions.";
      const latestCandle = candles[candles.length - 1];

      const price = value =>
        value === null || value === undefined
          ? "Not formed"
          : Number(value).toString();

      const describeSwing = swing =>
        swing
          ? `${swing.date} | Level: ${price(swing.level)}`
          : "Not formed";

      const describeStructure = (item, label) =>
        item
          ? `${label}: ${item.date} | Body level: ${price(item.level)}`
          : `${label}: Not confirmed`;

      const recentEvents = result.events.slice(-10);

      const eventText = recentEvents.length
        ? recentEvents.map(event => {
            if (event.type === "LL_CONFIRMED")
              return `• LL confirmed — ${event.date}`;

            if (event.type === "HH_CONFIRMED")
              return `• HH confirmed — ${event.date}`;

            if (event.type === "PROTECTED_LH_CONFIRMED")
              return `• Protected LH — ${event.date}`;

            if (event.type === "PROTECTED_HL_CONFIRMED")
              return `• Protected HL — ${event.date}`;

            if (event.type === "BULLISH_EBO")
              return `• Bullish EBO — ${event.date}`;

            if (event.type === "BEARISH_EBO")
              return `• Bearish EBO — ${event.date}`;

            return `• ${event.type} — ${event.date}`;
          }).join("\n")
        : "No confirmed structure events found.";

      const report =
        `<b>${symbol} — D1 STRUCTURE</b>\n` +
        `Latest completed candle: ${latestCandle.datetime}\n\n` +
        `<b>SWINGS</b>\n` +
        `Swing High: ${describeSwing(result.latestSwingHigh)}\n` +
        `Swing Low: ${describeSwing(result.latestSwingLow)}\n\n` +
        `<b>BEARISH STRUCTURE</b>\n` +
        `${describeStructure(result.bearishLL, "LL")}\n` +
        `Pending LH: ${describeSwing(result.pendingLH)}\n` +
        `Protected LH: ${describeSwing(result.protectedLH)}\n\n` +
        `<b>BULLISH STRUCTURE</b>\n` +
        `${describeStructure(result.bullishHH, "HH")}\n` +
        `Pending HL: ${describeSwing(result.pendingHL)}\n` +
        `Protected HL: ${describeSwing(result.protectedHL)}\n\n` +
        `<b>DAILY KEY-LEVEL STATUS</b>\n${statusText}\n\n` +
        `<b>DAILY KEY-LEVEL REACTIONS</b>\n${reactionText}\n\n` +
        `<b>RECENT EVENTS</b>\n${eventText}\n\n` +
        `<i>Structure uses candle bodies. Key-level contact recognises wick or body interaction; confirmation requires a close beyond the zone.</i>`;

      await sendMessage(chatId, report);
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
    const filtered = filterCompletedWeeklyCandles(raw);
    const candles = filtered.candles;
    const developing = filtered.developing;

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
      status: developing.length > 0 ? "DEVELOPING" : "NO DEVELOPING CANDLE",
      developing,
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
    const filtered = filterCompletedWeeklyCandles(raw);
    const candles = filtered.candles;
    const developing = filtered.developing;

    const formations = [];

    for (let i = 1; i < candles.length; i++) {
      const first = candles[i - 1];
      const second = candles[i];

      const firstColor = candleColor(first);
      const secondColor = candleColor(second);

      const firstClose = Number(first.close);
      const secondOpen = Number(second.open);

      // Actual gap required; exact equality does not count.
      if (firstClose === secondOpen) continue;

      if (
        firstColor === "BULLISH" &&
        secondColor === "BULLISH"
      ) {
        formations.push({
          type: "BULLISH-OPEN-CLOSE",
          first_candle: first.datetime,
          second_candle: second.datetime,
          first_close: firstClose,
          second_open: secondOpen,
          gap: secondOpen - firstClose
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
          first_close: firstClose,
          second_open: secondOpen,
          gap: secondOpen - firstClose
        });
      }
    }

    res.json({
      success: true,
      symbol,
      timeframe: "W1",
      status: developing.length > 0 ? "DEVELOPING" : "NO DEVELOPING CANDLE",
      developing,
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
// W1 STORYLINE TEST
// =====================================

app.get("/test-w1-storyline", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const raw = await getMarketCandles(symbol, "1week", 100);
    const filtered = filterCompletedWeeklyCandles(raw);
    const candles = filtered.candles;

    const storyline = detectWeeklyStoryline(candles);

    res.json({
      success: true,
      symbol,
      timeframe: "W1",
      storyline,
      latest_completed_candle: candles[candles.length - 1] || null,
      developing: filtered.developing
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
// D1 KEY-LEVEL TEST
// =====================================

app.get("/test-d1-key-levels", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    const raw = await getMarketCandles(symbol, "1day", 100);
    const filtered = filterCompletedDailyCandles(raw);
    const candles = filtered.candles;

    const levels = detectDailyKeyLevels(candles);

    res.json({
      success: true,
      symbol,
      timeframe: "D1",
      latest_completed_candle: candles[candles.length - 1]?.datetime,
      total_levels: levels.length,
      key_levels: levels,
      excluded_weekend_dates: filtered.excludedWeekend,
      excluded_unfinished_dates: filtered.excludedUnfinished
    });
  } catch (error) {
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
