require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const DATABASE_API = `${SUPABASE_URL}/rest/v1/watchlist`;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing required environment variables.");
}

async function sendMessage(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error("Failed to send Telegram message:", err.response?.data || err.message);
  }
}

async function databaseRequest(method, params = {}, data = null, headers = {}) {
  return axios({
    method,
    url: DATABASE_API,
    params,
    data,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

app.get("/", (req, res) => {
  res.send("DEE SM SLK BOT is running.");
});

app.post("/webhook", async (req, res) => {
  // Always reply 200 quickly to Telegram
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id.toString();
    const input = message.text.trim();
    const parts = input.split(/\s+/);

    const command = parts[0].split("@")[0].toLowerCase();
    const symbol = (parts[1] || "").toUpperCase();

    // ==================== /start ====================
    if (command === "/start") {
      return await sendMessage(
        chatId,
        "Welcome to DEE SM SLK BOT! 📊\n\n" +
          "Your personal market monitoring assistant.\n\n" +
          "Structure | Liquidity | Key Levels\n\n" +
          "BIAS ≠ ENTRY.\n" +
          "This bot provides market context, not entry signals.\n\n" +
          "Type /help to see available commands."
      );
    }

    // ==================== /help ====================
    if (command === "/help") {
      return await sendMessage(
        chatId,
        "DEE SM SLK COMMANDS 📊\n\n" +
          "/add GBPUSD - Add a pair\n" +
          "/remove GBPUSD - Remove a pair\n" +
          "/watchlist - View your pairs\n" +
          "/pause GBPUSD - Pause a pair\n" +
          "/resume GBPUSD - Resume a pair\n" +
          "/check GBPUSD - Check a pair"
      );
    }

    // ==================== /watchlist ====================
    if (command === "/watchlist") {
      try {
        const result = await databaseRequest("get", {
          chat_id: `eq.${chatId}`,
          order: "created_at.asc",
        });

        if (!result.data || result.data.length === 0) {
          return await sendMessage(
            chatId,
            "Your watchlist is empty.\n\nUse /add GBPUSD to add a pair."
          );
        }

        const list = result.data
          .map((pair) => `${pair.is_active ? "🟢" : "⏸"} ${pair.symbol}`)
          .join("\n");

        return await sendMessage(chatId, "YOUR SLK WATCHLIST 📊\n\n" + list);
      } catch (err) {
        console.error("Watchlist error:", err.response?.data || err.message);
        return await sendMessage(chatId, "❌ Failed to load watchlist. Please try again.");
      }
    }

    // Commands that require a symbol
    if (["/add", "/remove", "/pause", "/resume", "/check"].includes(command)) {
      if (!symbol) {
        return await sendMessage(
          chatId,
          "Please include a trading pair.\n\nExample: /add GBPUSD"
        );
      }
    }

    // ==================== /add ====================
    if (command === "/add") {
      try {
        await databaseRequest(
          "post",
          { on_conflict: "chat_id,symbol" },
          {
            chat_id: chatId,
            symbol,
            is_active: true,
          },
          {
            Prefer: "resolution=merge-duplicates,return=minimal",
          }
        );

        return await sendMessage(chatId, `✅ ${symbol} added to your watchlist.`);
      } catch (err) {
        console.error("Add error:", err.response?.data || err.message);
        return await sendMessage(
          chatId,
          `❌ Failed to add ${symbol}.\n\nMake sure the table has a unique constraint on (chat_id, symbol).`
        );
      }
    }

    // ==================== /remove ====================
    if (command === "/remove") {
      try {
        await databaseRequest("delete", {
          chat_id: `eq.${chatId}`,
          symbol: `eq.${symbol}`,
        });

        return await sendMessage(chatId, `🗑 ${symbol} removed from your watchlist.`);
      } catch (err) {
        console.error("Remove error:", err.response?.data || err.message);
        return await sendMessage(chatId, `❌ Failed to remove ${symbol}.`);
      }
    }

    // ==================== /pause & /resume ====================
    if (command === "/pause" || command === "/resume") {
      try {
        const active = command === "/resume";

        const result = await databaseRequest(
          "patch",
          {
            chat_id: `eq.${chatId}`,
            symbol: `eq.${symbol}`,
          },
          {
            is_active: active,
          },
          {
            Prefer: "return=representation",
          }
        );

        if (!result.data || result.data.length === 0) {
          return await sendMessage(chatId, `${symbol} was not found in your watchlist.`);
        }

        return await sendMessage(
          chatId,
          active
            ? `▶️ Monitoring resumed for ${symbol}.`
            : `⏸ Monitoring paused for ${symbol}.`
        );
      } catch (err) {
        console.error("Pause/Resume error:", err.response?.data || err.message);
        return await sendMessage(chatId, `❌ Failed to update ${symbol}.`);
      }
    }

    // ==================== /check ====================
    if (command === "/weekly") {
  const now = new Date();

  // Calculate previous Sunday to Saturday in WAT
  const watNow = new Date(now.getTime() + 60 * 60 * 1000);
  const day = watNow.getUTCDay();

  const thisSunday = new Date(watNow);
  thisSunday.setUTCDate(watNow.getUTCDate() - day);
  thisSunday.setUTCHours(0, 0, 0, 0);

  const previousSunday = new Date(thisSunday);
  previousSunday.setUTCDate(thisSunday.getUTCDate() - 7);

  const start = new Date(previousSunday.getTime() - 60 * 60 * 1000);
  const end = new Date(thisSunday.getTime() - 60 * 60 * 1000);

  const result = await axios.get(
  `${SUPABASE_URL}/rest/v1/storyline_events`,
  {
    params: {
      select: "*",
      chat_id: `eq.${chatId}`,
      event_time: `gte.${start.toISOString()}`,
      and: `(event_time.lt.${end.toISOString()})`,
      order: "event_time.asc"
    },
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  }
);

  if (result.data.length === 0) {
    return await sendMessage(
      chatId,
      "📊 PREVIOUS WEEKLY REPORT\n\nNo storyline events were recorded last week (Sunday–Saturday)."
    );
  }

  const groups = {
    confirmed: "🟢 CONFIRMED STORYLINES",
    developing: "🟡 DEVELOPING STORYLINES",
    invalidated: "🔴 INVALIDATED STORYLINES"
  };

  let report = "📊 PREVIOUS WEEKLY REPORT\nSunday – Saturday\n";

  for (const [status, heading] of Object.entries(groups)) {
    const events = result.data.filter(
      event => event.status.toLowerCase() === status
    );

    report += `\n${heading}\n`;

    if (events.length === 0) {
      report += "None recorded.\n";
      continue;
    }

    for (const event of events) {
      report += `\n${event.symbol} — ${event.direction}\n`;
      report += `Timeframe: ${event.timeframe}\n`;
      report += `Breakout: ${event.breakout_type || "Not specified"}\n`;
      report += `${JSON.stringify(event.details)}\n`;
    }
  }

  return await sendMessage(chatId, report);
    }
    if (command === "/check") {
      return await sendMessage(
        chatId,
        `📊 ${symbol}\n\nOn-demand SLK market analysis is not active yet.\n\nBIAS ≠ ENTRY.`
      );
    }

    // Unknown command
    return await sendMessage(
      chatId,
      "Command not recognised. Type /help to see available commands."
    );
  } catch (error) {
    console.error("Bot error:", error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.get("/test-market-data", async (req, res) => {
  try {
    const timeframes = [
      { name: "W1", interval: "1week" },
      { name: "D1", interval: "1day" },
      { name: "H4", interval: "4h" }
    ];

    const results = {};

    for (const timeframe of timeframes) {
      const response = await axios.get(
        "https://api.twelvedata.com/time_series",
        {
          params: {
            symbol: "EUR/USD",
            interval: timeframe.interval,
            outputsize: 1,
            apikey: process.env.TWELVE_DATA_API_KEY
          }
        }
      );

      if (response.data.status === "error") {
        results[timeframe.name] = {
          success: false,
          message: response.data.message
        };
      } else {
        results[timeframe.name] = {
          success: true,
          candle: response.data.values[0]
        };
      }
    }

    res.json({
      symbol: "EUR/USD",
      timeframe_results: results
    });

  } catch (error) {
    console.error("Market data test failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Market data test failed."
    });
  }
});
app.listen(PORT, () => {
  console.log(`DEE SM SLK BOT running on port ${PORT}`);
});
