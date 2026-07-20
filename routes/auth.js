const express = require("express");
const router = express.Router();
const discord = require("../discordApi");
const db = require("../db");

router.get("/discord", (req, res) => {
  res.redirect(discord.getAuthorizeUrl());
});

router.get("/discord/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=geen_code");
  try {
    const tokenData = await discord.exchangeCode(code);
    const profile = await discord.getCurrentUser(tokenData.access_token);
    const guilds = await discord.getCurrentUserGuilds(tokenData.access_token);

    db.upsertUser({
      id: profile.id,
      username: profile.username,
      discriminator: profile.discriminator,
      avatar: profile.avatar,
    });

    req.session.user = {
      id: profile.id,
      username: profile.username,
      discriminator: profile.discriminator,
      avatar: profile.avatar,
    };
    req.session.guilds = guilds;

    res.redirect("/dashboard.html");
  } catch (err) {
    console.error(err);
    res.redirect("/?error=" + encodeURIComponent(err.message));
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Niet ingelogd." });
  res.json({ user: req.session.user, guilds: req.session.guilds || [] });
});

module.exports = router;
