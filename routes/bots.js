const express = require("express");
const router = express.Router();
const db = require("../db");
const discord = require("../discordApi");
const botManager = require("../botManager");

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Niet ingelogd." });
  next();
}

// Geeft de bot terug als de ingelogde gebruiker eigenaar OF collaborator is, anders null.
function accessibleBot(req, botId) {
  const bot = db.getBot(botId);
  return db.userHasAccess(bot, req.session.user.id) ? bot : null;
}

const COLORS = ["#5865F2", "#EB459E", "#43B581", "#FAA61A", "#F04747"];
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % COLORS.length;
  return COLORS[hash];
}
function initialsFor(name) {
  return name.slice(0, 2).toUpperCase();
}

/* ---------------- lijst & basis CRUD ---------------- */

router.get("/", requireAuth, (req, res) => {
  const bots = db.getBotsForUser(req.session.user.id).map((b) => ({
    id: b.id,
    name: b.name,
    color: b.color,
    avatarInitials: b.avatarInitials,
    isOwner: b.ownerId === req.session.user.id,
    ...botManager.getStatus(b.id),
  }));
  res.json({ bots });
});

router.get("/:id", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  res.json({
    id: bot.id,
    name: bot.name,
    color: bot.color,
    avatarInitials: bot.avatarInitials,
    isOwner: bot.ownerId === req.session.user.id,
    logGuildId: bot.logGuildId,
    logChannelId: bot.logChannelId,
    staffGuildId: bot.staffGuildId,
    staffRoleIds: bot.staffRoleIds,
    modules: bot.modules,
    collaborators: bot.collaborators,
    ...botManager.getStatus(bot.id),
  });
});

// Stap 1: token controleren bij Discord (nog niets opslaan)
router.post("/verify", requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Vul een bot-token in." });
  }
  try {
    const profile = await discord.verifyBotToken(token.trim());
    res.json({
      ok: true,
      name: profile.name,
      discordBotId: profile.discordBotId,
      avatarInitials: initialsFor(profile.name),
      color: colorFor(profile.discordBotId),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stap 2: pas na akkoord van de gebruiker echt opslaan + activeren
router.post("/activate", requireAuth, async (req, res) => {
  const { token, name, discordBotId } = req.body;
  if (!token || !name || !discordBotId) {
    return res.status(400).json({ error: "Onvolledige gegevens." });
  }
  const bot = db.addBot({
    ownerId: req.session.user.id,
    name,
    discordBotId,
    token,
    avatarInitials: initialsFor(name),
    color: colorFor(discordBotId),
  });
  const result = botManager.startBot(bot.id);
  res.json({ ok: true, bot: { id: bot.id, name: bot.name }, started: result.ok });
});

router.post("/:id/start", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  res.json(botManager.startBot(bot.id));
});

router.post("/:id/stop", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  res.json(botManager.stopBot(bot.id));
});

router.post("/:id/restart", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  res.json(botManager.restartBot(bot.id));
});

router.delete("/:id", requireAuth, (req, res) => {
  const bot = db.getBot(req.params.id);
  if (!bot || !db.isOwnerOrSuperAdmin(bot, req.session.user.id)) {
    return res.status(404).json({ error: "Alleen de eigenaar mag een bot verwijderen." });
  }
  botManager.stopBot(bot.id);
  db.deleteBot(bot.id);
  res.json({ ok: true });
});

/* ---------------- servers / kanalen / rollen (voor instel-pagina's) ---------------- */

router.get("/:id/guilds", requireAuth, async (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  try {
    const guilds = await discord.getBotGuilds(db.getBotToken(bot.id));
    res.json({ guilds });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id/guilds/:guildId/channels", requireAuth, async (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  try {
    const channels = await discord.getGuildChannels(db.getBotToken(bot.id), req.params.guildId);
    res.json({ channels });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id/guilds/:guildId/categories", requireAuth, async (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  try {
    const categories = await discord.getGuildCategories(db.getBotToken(bot.id), req.params.guildId);
    res.json({ categories });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id/guilds/:guildId/roles", requireAuth, async (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  try {
    const roles = await discord.getGuildRoles(db.getBotToken(bot.id), req.params.guildId);
    res.json({ roles });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------- logkanaal ---------------- */

router.post("/:id/log-channel", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  const { guildId, channelId } = req.body;
  const updated = db.setLogChannel(bot.id, { guildId, channelId });
  res.json({ ok: true, logGuildId: updated.logGuildId, logChannelId: updated.logChannelId });
});

/* ---------------- staff-rollen ---------------- */

router.post("/:id/staff-roles", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  const { guildId, roleIds } = req.body;
  const updated = db.setStaffRoles(bot.id, { guildId, roleIds });
  res.json({ ok: true, staffGuildId: updated.staffGuildId, staffRoleIds: updated.staffRoleIds });
});

/* ---------------- modules ---------------- */

router.post("/:id/modules", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  const updated = db.setModules(bot.id, req.body || {});
  res.json({ ok: true, modules: updated.modules });
});

/* ---------------- collaborators (mensen toegang geven via Discord ID) ---------------- */

router.get("/:id/collaborators", requireAuth, (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  res.json({ collaborators: bot.collaborators, ownerId: bot.ownerId });
});

router.post("/:id/collaborators", requireAuth, async (req, res) => {
  const bot = db.getBot(req.params.id);
  if (!bot || !db.isOwnerOrSuperAdmin(bot, req.session.user.id)) {
    return res.status(404).json({ error: "Alleen de eigenaar mag collaborators toevoegen." });
  }
  const { userId } = req.body;
  if (!userId || !/^\d{15,25}$/.test(userId)) {
    return res.status(400).json({ error: "Vul een geldig Discord ID in (alleen cijfers)." });
  }
  try {
    const profile = await discord.getUserById(db.getBotToken(bot.id), userId);
    db.addCollaborator(bot.id, userId);
    res.json({ ok: true, user: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id/collaborators/:userId", requireAuth, (req, res) => {
  const bot = db.getBot(req.params.id);
  if (!bot || !db.isOwnerOrSuperAdmin(bot, req.session.user.id)) {
    return res.status(404).json({ error: "Alleen de eigenaar mag collaborators verwijderen." });
  }
  db.removeCollaborator(bot.id, req.params.userId);
  res.json({ ok: true });
});

/* ---------------- bot-profiel (naam, avatar, bio) ---------------- */

router.get("/:id/profile", requireAuth, async (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  try {
    const profile = await discord.getBotFullProfile(db.getBotToken(bot.id));
    res.json(profile);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:id/profile", requireAuth, async (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  const { username, description, avatarDataUri } = req.body;
  try {
    const token = db.getBotToken(bot.id);
    if (username || avatarDataUri) await discord.updateBotUser(token, { username, avatarDataUri });
    if (typeof description === "string") await discord.updateBotApplication(token, { description });
    const profile = await discord.getBotFullProfile(token);
    res.json({ ok: true, profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------- ticket-paneel plaatsen ---------------- */

router.post("/:id/ticket-panel", requireAuth, async (req, res) => {
  const bot = accessibleBot(req, req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot niet gevonden." });
  const { channelId, title, description, categories } = req.body;
  const cleanCategories = (categories || [])
    .map((c) => ({ label: (c.label || "").trim(), parentId: c.parentId || null }))
    .filter((c) => c.label);
  if (!channelId) return res.status(400).json({ error: "Kies een kanaal." });
  if (cleanCategories.length < 1) return res.status(400).json({ error: "Voeg minstens 1 categorie toe." });

  try {
    db.setModules(bot.id, {
      tickets: { ...bot.modules.tickets, enabled: true, categories: cleanCategories, panelTitle: title, panelDescription: description },
    });
    await discord.postTicketPanel(db.getBotToken(bot.id), channelId, {
      title: title || "Support & Vragen",
      description: description || "Open een ticket via een knop hieronder.",
      categories: cleanCategories.map((c) => c.label),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
