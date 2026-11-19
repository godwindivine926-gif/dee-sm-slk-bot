require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const DATABASE_API = `${SUPABASE_URL.trim().replace(/\/+$/, "")}/rest/v1/watchlist`;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing required environment variables.");
}

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text
  });
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
      ...headers
    }
  });
}

app.get("/", (req, res) => {
  res.send("DEE SM SLK BOT is running.");
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.text) return;

    const chatId = message.chat.id.toString();
    const input = message.text.trim();
    const parts = input.split(/\s+/);

    const command = parts[0].split("@")[0].toLowerCase();
    const symbol = (parts[1] || "").toUpperCase();

    if (command === "/start") {
      return await sendMessage(chatId,
        "Welcome to DEE SM SLK BOT! 📊\n\n" +
        "Your personal market monitoring assistant.\n\n" +
        "Structure | Liquidity | Key Levels\n\n" +
        "BIAS ≠ ENTRY.\n" +
        "This bot provides market context, not entry signals.\n\n" +
        "Type /help to see available commands."
      );
    }

    if (command === "/help") {
      return await sendMessage(chatId,
        "DEE SM SLK COMMANDS 📊\n\n" +
        "/add GBPUSD - Add a pair\n" +
        "/remove GBPUSD - Remove a pair\n" +
        "/watchlist - View your pairs\n" +
        "/pause GBPUSD - Pause a pair\n" +
        "/resume GBPUSD - Resume a pair\n" +
        "/check GBPUSD - Check a pair"
      );
    }

    if (command === "/watchlist") {
      const result = await databaseRequest("get", {
        chat_id: `eq.${chatId}`,
        order: "created_at.asc"
      });

      if (result.data.length === 0) {
        return await sendMessage(chatId,
          "Your watchlist is empty.\n\nUse /add GBPUSD to add a pair."
        );
      }

      const list = result.data.map(pair =>
        `${pair.is_active ? "🟢" : "⏸"} ${pair.symbol}`
      ).join("\n");

      return await sendMessage(chatId,
        "YOUR SLK WATCHLIST 📊\n\n" + list
      );
    }

    if (["/add", "/remove", "/pause", "/resume", "/check"].includes(command)) {
      if (!symbol) {
        return await sendMessage(chatId,
          "Please include a trading pair.\n\nExample: /add GBPUSD"
        );
      }
    }

    if (command === "/add") {
  try {
    await databaseRequest(
      "post",
      { on_conflict: "chat_id,symbol" },
      {
        chat_id: chatId,
        symbol,
        is_active: true
      },
      {
        Prefer: "resolution=merge-duplicates,return=minimal"
      }
    );

    return await sendMessage(chatId, `✅ ${symbol} added to your watchlist.`);
  } catch (err) {
    console.error("Add error:", err.response?.data || err.message);
    return await sendMessage(
      chatId,
      `❌ Failed to add ${symbol}.\n\nCheck server logs or table constraints.`
    ):
    }

    if (command === "/remove") {
      await databaseRequest("delete", {
        chat_id: `eq.${chatId}`,
        symbol: `eq.${symbol}`
      });

      return await sendMessage(chatId,
        `🗑 ${symbol} removed from your watchlist.`
      );
    }

    if (command === "/pause" || command === "/resume") {
      const active = command === "/resume";

      const result = await databaseRequest("patch", {
        chat_id: `eq.${chatId}`,
        symbol: `eq.${symbol}`
      }, {
        is_active: active
      }, {
        Prefer: "return=representation"
      });

      if (result.data.length === 0) {
        return await sendMessage(chatId,
          `${symbol} was not found in your watchlist.`
        );
      }

      return await sendMessage(chatId,
        active
          ? `▶️ Monitoring resumed for ${symbol}.`
          : `⏸ Monitoring paused for ${symbol}.`
      );
    }

    if (command === "/check") {
      return await sendMessage(chatId,
        `📊 ${symbol}\n\nOn-demand SLK market analysis is not active yet.\n\nBIAS ≠ ENTRY.`
      );
    }

    return await sendMessage(chatId,
      "Command not recognised. Type /help to see available commands."
    );

  } catch (error) {
    console.error("Bot error:", error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`DEE SM SLK BOT running on port ${PORT}`);
});
