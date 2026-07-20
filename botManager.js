// botManager.js
// Leeft in het hoofd-serverproces. Start/stopt/herstart een apart Node-proces
// (botProcess.js) per Discord bot, en houdt de live status bij voor het dashboard.
//
// Zolang dit hoofdproces (de website/server) online is, blijven bots online:
// - crasht een bot-proces onverwacht? Wordt automatisch opnieuw gestart.
// - gebruikt iemand /reload in Discord? Het bot-proces herstart zichzelf via een
//   speciale exit-code (50), die hier wordt opgevangen.
//
// Alle start/stop/herstart-gebeurtenissen worden ook naar het ingestelde logkanaal
// gestuurd (via een directe Discord REST-call, los van het bot-proces zelf — zo werkt
// dit ook nog als de bot net offline is).

const { fork } = require("child_process");
const path = require("path");
const db = require("./db");

const RELOAD_EXIT_CODE = 50;
const MAX_LOG_LINES = 40;
const DISCORD_API = "https://discord.com/api/v10";

// botId -> { child, status, startedAt, lastStats, log[], manualStop, discordTag }
const runtime = new Map();

function getStatus(botId) {
  const r = runtime.get(botId);
  if (!r) return { status: "offline", uptimeMs: 0, ramBytes: 0, discordTag: null, log: [] };
  return {
    status: r.status,
    uptimeMs: r.lastStats?.uptimeMs || (r.status === "online" ? Date.now() - r.startedAt : 0),
    ramBytes: r.lastStats?.ramBytes || 0,
    discordTag: r.discordTag || null,
    log: r.log.slice(-20),
  };
}

function pushLog(entry, message) {
  entry.log.push(`[${new Date().toLocaleTimeString("nl-NL")}] ${message}`);
  if (entry.log.length > MAX_LOG_LINES) entry.log.shift();
}

// Stuurt een bericht naar het ingestelde logkanaal van deze bot (indien ingesteld).
// Werkt onafhankelijk van of het bot-proces zelf online is.
async function notifyLogChannel(botId, text) {
  try {
    const bot = db.getBot(botId);
    if (!bot?.logChannelId) return;
    const token = db.getBotToken(botId);
    await fetch(`${DISCORD_API}/channels/${bot.logChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  } catch {
    // logkanaal-melding is best-effort; een mislukte melding mag de bot niet blokkeren
  }
}

function startBot(botId) {
  const existing = runtime.get(botId);
  if (existing && existing.status !== "offline") {
    return { ok: false, error: "Bot draait al." };
  }
  const token = db.getBotToken(botId);
  if (!token) return { ok: false, error: "Bot niet gevonden." };

  const child = fork(path.join(__dirname, "botProcess.js"), [], {
    env: { ...process.env, BOTCLOUD_BOT_ID: botId, BOTCLOUD_BOT_TOKEN: token },
    silent: true,
  });

  const entry = existing || { log: [] };
  entry.child = child;
  entry.status = "starting";
  entry.startedAt = Date.now();
  entry.lastStats = null;
  entry.manualStop = false;
  entry.discordTag = null;
  runtime.set(botId, entry);

  child.on("message", (msg) => {
    if (msg.type === "ready") {
      entry.status = "online";
      entry.discordTag = msg.username;
      pushLog(entry, `Online als ${msg.username}`);
      notifyLogChannel(botId, `🟢 **${msg.username}** is online.`);
    } else if (msg.type === "stats") {
      entry.lastStats = msg;
    } else if (msg.type === "log") {
      pushLog(entry, msg.message);
    } else if (msg.type === "error") {
      pushLog(entry, `Fout: ${msg.message}`);
    }
  });

  child.stdout?.on("data", (d) => pushLog(entry, d.toString().trim()));
  child.stderr?.on("data", (d) => pushLog(entry, "ERR: " + d.toString().trim()));

  child.on("exit", (code) => {
    entry.status = "offline";
    if (code === RELOAD_EXIT_CODE) {
      pushLog(entry, "Herstart aangevraagd via /reload…");
      notifyLogChannel(botId, "🔄 Bot herstart via `/reload`…");
      setTimeout(() => startBot(botId), 700);
      return;
    }
    if (!entry.manualStop && code !== 0) {
      pushLog(entry, `Proces onverwacht gestopt (code ${code}). Automatisch herstarten…`);
      notifyLogChannel(botId, `⚠️ Bot is onverwacht gestopt (code ${code}). Wordt automatisch herstart…`);
      setTimeout(() => startBot(botId), 2000);
      return;
    }
    pushLog(entry, `Proces gestopt (code ${code}).`);
  });

  return { ok: true };
}

function stopBot(botId) {
  const entry = runtime.get(botId);
  if (!entry || entry.status === "offline") return { ok: false, error: "Bot draait niet." };
  entry.manualStop = true;
  entry.child.kill("SIGTERM");
  entry.status = "offline";
  notifyLogChannel(botId, "⏹️ Bot is gestopt.");
  return { ok: true };
}

function restartBot(botId) {
  const entry = runtime.get(botId);
  if (entry && entry.status !== "offline") {
    entry.manualStop = true; // voorkom dubbele auto-restart naast onze eigen herstart hieronder
    entry.child.kill("SIGTERM");
  }
  notifyLogChannel(botId, "🔄 Bot wordt herstart…");
  setTimeout(() => startBot(botId), 800);
  return { ok: true };
}

module.exports = { startBot, stopBot, restartBot, getStatus };
