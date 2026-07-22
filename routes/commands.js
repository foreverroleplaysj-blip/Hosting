const express = require("express");
const router = express.Router();
const db = require("../db");

// Namen die al door ingebouwde modules gebruikt worden — mogen niet overschreven worden.
const RESERVED_NAMES = ["help", "ticket", "giveaway", "poll", "ban", "kick", "timeout", "giverole", "removerole", "allroles", "reload"];

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Niet ingelogd." });
  next();
}

function accessibleBot(req, botId) {
  const bot = db.getBot(botId);
  return db.userHasAccess(bot, req.session.user.id) ? bot : null;
}

// Gebruiker typt alleen een naam (bv. "regels" of "/regels" of "Regels") — hier maken
// we daar een geldige Discord-commandnaam van: kleine letters, cijfers, - en _, 1-32 tekens.
function normalizeName(raw) {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

function validateAndNormalize(body) {
  const bare = normalizeName(body.name);
  if (!bare) return { error: "Geef je command een naam, bijv. \"regels\"." };
  if (bare.length > 32) return { error: "Command-naam mag maximaal 32 tekens zijn." };
  if (RESERVED_NAMES.includes(bare)) {
    return { error: `"${bare}" is al een ingebouwd command (zie tab Modules) en kan niet als custom command gebruikt worden.` };
  }
  let embed = null;
  if (body.embed && typeof body.embed === "object") {
    if (JSON.stringify(body.embed).length > 5800) {
      return { error: "De embed is te groot (Discord staat max. ~6000 tekens toe)." };
    }
    if (!body.embed.title && !body.embed.description && !(body.embed.fields || []).length) {
      return { error: "Vul minstens een titel, omschrijving of veld in voor de embed." };
    }
    embed = body.embed;
  }
  if (!body.response && !body.code && !embed) {
    return { error: "Vul in wat de bot moet doen (reactie, eigen code, of een embed)." };
  }
  return {
    name: bare,
    description: (body.description || "").slice(0, 100),
    response: body.response || null,
    code: body.code || null,
    embed,
    cooldown: Number(body.cooldown) || 0,
    adminOnly: !!body.adminOnly,
  };
}

router.get("/:botId/commands", requireAuth, (req, res) => {
  if (!accessibleBot(req, req.params.botId)) return res.status(404).json({ error: "Bot niet gevonden." });
  res.json({ commands: db.getCommands(req.params.botId) });
});

router.post("/:botId/commands", requireAuth, (req, res) => {
  if (!accessibleBot(req, req.params.botId)) return res.status(404).json({ error: "Bot niet gevonden." });
  const result = validateAndNormalize(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const entry = db.addCommand(req.params.botId, result);
  res.json({ ok: true, command: entry });
});

// Bewerken van een bestaand custom command
router.put("/:botId/commands/:commandId", requireAuth, (req, res) => {
  if (!accessibleBot(req, req.params.botId)) return res.status(404).json({ error: "Bot niet gevonden." });
  const result = validateAndNormalize(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const updated = db.updateCommand(req.params.botId, req.params.commandId, result);
  if (!updated) return res.status(404).json({ error: "Command niet gevonden." });
  res.json({ ok: true, command: updated });
});

router.delete("/:botId/commands/:commandId", requireAuth, (req, res) => {
  if (!accessibleBot(req, req.params.botId)) return res.status(404).json({ error: "Bot niet gevonden." });
  db.deleteCommand(req.params.botId, req.params.commandId);
  res.json({ ok: true });
});

module.exports = router;
