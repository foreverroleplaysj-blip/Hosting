require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const authRoutes = require("./routes/auth");
const botRoutes = require("./routes/bots");
const commandRoutes = require("./routes/commands");

const app = express();

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "insecure_dev_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 dagen — je blijft ingelogd
  })
);

app.use("/auth", authRoutes);
app.use("/api/bots", botRoutes);
app.use("/api/bots", commandRoutes); // /api/bots/:botId/commands

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Notspayy's Hosting draait op http://localhost:${PORT}\n`);
  if (!process.env.DISCORD_CLIENT_ID) {
    console.log("  ⚠  Geen .env gevonden of DISCORD_CLIENT_ID ontbreekt.");
    console.log("     Kopieer .env.example naar .env en vul je Discord-app-gegevens in.\n");
  }
});
