require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}

app.get("/", (req, res) => {
  res.send("DEE SM SLK BOT is running.");
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    let reply = "";

    if (text === "/start") {
      reply =
        "Welcome to DEE SM SLK BOT! 📊\n\n" +
        "Your personal market monitoring assistant.\n\n" +
        "Structure | Liquidity | Key Levels\n\n" +
        "BIAS ≠ ENTRY.\n" +
        "This bot monitors market structure and bias. It does not provide entry signals.";
    } else if (text === "/help") {
      reply =
        "AVAILABLE COMMANDS\n\n" +
        "/watchlist - View your pairs\n" +
        "/add PAIR - Add a pair\n" +
        "/remove PAIR - Remove a pair\n" +
        "/pause PAIR - Pause monitoring\n" +
        "/resume PAIR - Resume monitoring\n" +
        "/check PAIR - Check a pair";
    } else {
      reply =
        "Your command has been received. The market monitoring features are being built. 🔧";
    }

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: reply
    });

  } catch (error) {
    console.error("Telegram error:", error.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`DEE SM SLK BOT running on port ${PORT}`);
});
