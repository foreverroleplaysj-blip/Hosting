// db.js
// Lichte JSON-bestand-database. Prima voor kleine/persoonlijke installaties.
// Voor productie met meerdere gebruikers: vervang dit door Postgres/MySQL/MongoDB,
// maar de rest van de app blijft dan hetzelfde werken zolang je dezelfde functies exporteert.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.join(__dirname, "data", "db.json");
const ALGO = "aes-256-gcm";

const DEFAULT_MODULES = {
  help: { enabled: true },
  welcome: { enabled: false, guildId: null, channelId: null, message: "Welkom {user} op {server}! 🎉" },
  tickets: {
    enabled: false,
    categories: [
      { label: "Vragen?", parentId: null },
      { label: "Klachten", parentId: null },
      { label: "Sollicitatie / Overstap", parentId: null },
      { label: "Owner Vraag", parentId: null },
    ],
    panelTitle: "Support & Vragen",
    panelDescription: "Heb je een vraag, een probleem of wil je ergens over rapporteren? Open dan een ticket via een knop hieronder.",
  },
  giveaway: { enabled: false },
  polls: { enabled: false },
  moderation: { enabled: false }, // ban/kick/timeout/rollen
  utility: { enabled: false }, // /avatar, /serverinfo
  reload: { enabled: true }, // /reload, alleen admins
};

// Discord-gebruikers die op DEZE installatie altijd overal bij mogen (alle bots,
// ook die van anderen). Zet je eigen Discord ID in .env als SUPER_ADMIN_IDS
// (komma-gescheiden) als je dat wilt aanpassen.
function getSuperAdminIds() {
  const fromEnv = (process.env.SUPER_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : ["1179804729254105210"];
}
function isSuperAdmin(userId) {
  return getSuperAdminIds().includes(userId);
}

function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || "insecure_default_key_32_chars!!";
  return crypto.createHash("sha256").update(raw).digest(); // altijd 32 bytes
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function loadRaw() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { users: {}, bots: {}, commands: {} };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* ---------------- users ---------------- */
function upsertUser(user) {
  const data = loadRaw();
  data.users[user.id] = { ...(data.users[user.id] || {}), ...user };
  save(data);
  return data.users[user.id];
}
function getUser(id) {
  return loadRaw().users[id] || null;
}

/* ---------------- bots ---------------- */
// bot = { id, ownerId, collaborators[], name, avatarInitials, color, tokenEncrypted,
//         logGuildId, logChannelId, staffGuildId, staffRoleIds[], modules{}, createdAt }
function addBot(bot) {
  const data = loadRaw();
  const id = crypto.randomUUID();
  data.bots[id] = {
    id,
    ownerId: bot.ownerId,
    collaborators: [],
    name: bot.name,
    discordBotId: bot.discordBotId,
    avatarInitials: bot.avatarInitials,
    color: bot.color,
    tokenEncrypted: encrypt(bot.token),
    logGuildId: null,
    logChannelId: null,
    staffGuildId: null,
    staffRoleIds: [],
    modules: JSON.parse(JSON.stringify(DEFAULT_MODULES)),
    createdAt: Date.now(),
  };
  data.commands[id] = data.commands[id] || [];
  save(data);
  return data.bots[id];
}
function getBotsForUser(userId) {
  const data = loadRaw();
  if (isSuperAdmin(userId)) return Object.values(data.bots);
  return Object.values(data.bots).filter(
    (b) => b.ownerId === userId || (b.collaborators || []).includes(userId)
  );
}
function getBot(id) {
  const bot = loadRaw().bots[id];
  if (!bot) return null;
  // vul ontbrekende velden aan voor bots die aangemaakt zijn vóór een update
  bot.collaborators = bot.collaborators || [];
  bot.staffRoleIds = bot.staffRoleIds || [];
  bot.modules = { ...JSON.parse(JSON.stringify(DEFAULT_MODULES)), ...(bot.modules || {}) };
  // oudere installaties sloegen categorieën op als platte strings — normaliseren
  if (bot.modules.tickets?.categories) {
    bot.modules.tickets.categories = bot.modules.tickets.categories.map((c) =>
      typeof c === "string" ? { label: c, parentId: null } : c
    );
  }
  return bot;
}
function userHasAccess(bot, userId) {
  if (isSuperAdmin(userId)) return true;
  return !!bot && (bot.ownerId === userId || (bot.collaborators || []).includes(userId));
}
function isOwnerOrSuperAdmin(bot, userId) {
  return !!bot && (bot.ownerId === userId || isSuperAdmin(userId));
}
function getBotToken(id) {
  const bot = getBot(id);
  if (!bot) return null;
  return decrypt(bot.tokenEncrypted);
}
function deleteBot(id) {
  const data = loadRaw();
  delete data.bots[id];
  delete data.commands[id];
  save(data);
}

function setLogChannel(id, { guildId, channelId }) {
  const data = loadRaw();
  if (!data.bots[id]) return null;
  data.bots[id].logGuildId = guildId || null;
  data.bots[id].logChannelId = channelId || null;
  save(data);
  return data.bots[id];
}

function setStaffRoles(id, { guildId, roleIds }) {
  const data = loadRaw();
  if (!data.bots[id]) return null;
  data.bots[id].staffGuildId = guildId || null;
  data.bots[id].staffRoleIds = Array.isArray(roleIds) ? roleIds : [];
  save(data);
  return data.bots[id];
}

function setModules(id, modules) {
  const data = loadRaw();
  if (!data.bots[id]) return null;
  data.bots[id].modules = { ...DEFAULT_MODULES, ...(data.bots[id].modules || {}), ...modules };
  save(data);
  return data.bots[id];
}

function addCollaborator(id, userId) {
  const data = loadRaw();
  if (!data.bots[id]) return null;
  const list = new Set(data.bots[id].collaborators || []);
  list.add(userId);
  data.bots[id].collaborators = [...list];
  save(data);
  return data.bots[id];
}
function removeCollaborator(id, userId) {
  const data = loadRaw();
  if (!data.bots[id]) return null;
  data.bots[id].collaborators = (data.bots[id].collaborators || []).filter((u) => u !== userId);
  save(data);
  return data.bots[id];
}

/* ---------------- commands ---------------- */
// command = { id, name, description, response, code, cooldown, adminOnly }
function getCommands(botId) {
  return loadRaw().commands[botId] || [];
}
function addCommand(botId, command) {
  const data = loadRaw();
  if (!data.commands[botId]) data.commands[botId] = [];
  const entry = { id: crypto.randomUUID(), ...command };
  data.commands[botId].push(entry);
  save(data);
  return entry;
}
function updateCommand(botId, commandId, updates) {
  const data = loadRaw();
  const list = data.commands[botId] || [];
  const idx = list.findIndex((c) => c.id === commandId);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...updates, id: commandId };
  save(data);
  return list[idx];
}
function deleteCommand(botId, commandId) {
  const data = loadRaw();
  data.commands[botId] = (data.commands[botId] || []).filter((c) => c.id !== commandId);
  save(data);
}

module.exports = {
  upsertUser,
  getUser,
  addBot,
  getBotsForUser,
  getBot,
  userHasAccess,
  isOwnerOrSuperAdmin,
  isSuperAdmin,
  getBotToken,
  deleteBot,
  setLogChannel,
  setStaffRoles,
  setModules,
  addCollaborator,
  removeCollaborator,
  getCommands,
  addCommand,
  updateCommand,
  deleteCommand,
  DEFAULT_MODULES,
};
