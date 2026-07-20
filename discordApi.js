// discordApi.js
// Kleine helper rond Discord's REST API. Geen extra library nodig, alleen fetch (Node 18+).

const API = "https://discord.com/api/v10";
const MANAGE_GUILD = 0x20;

function getAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_CALLBACK_URL,
    response_type: "code",
    scope: "identify guilds",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.DISCORD_CALLBACK_URL,
  });
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Discord token exchange mislukt: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, token_type, ... }
}

async function getCurrentUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Kon Discord-profiel niet ophalen.");
  return res.json();
}

async function getCurrentUserGuilds(accessToken) {
  const res = await fetch(`${API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Kon serverlijst niet ophalen.");
  const guilds = await res.json();
  return guilds.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    canManage: (BigInt(g.permissions) & BigInt(MANAGE_GUILD)) === BigInt(MANAGE_GUILD),
  }));
}

// Controleert een bot-token bij Discord en geeft het bot-profiel terug (naam, id, avatar).
async function verifyBotToken(token) {
  const res = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Ongeldig bot-token.");
    throw new Error(`Discord gaf een fout terug (${res.status}).`);
  }
  const user = await res.json();
  if (!user.bot) throw new Error("Dit token hoort niet bij een bot-account.");
  return { discordBotId: user.id, name: user.username, avatar: user.avatar };
}

// Servers waar de BOT zelf lid van is (met het bot-token, niet de gebruikerslogin).
async function getBotGuilds(token) {
  const res = await fetch(`${API}/users/@me/guilds`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error("Kon de servers van deze bot niet ophalen.");
  const guilds = await res.json();
  return guilds.map((g) => ({ id: g.id, name: g.name }));
}

// Tekstkanalen van één server, opgevraagd met het bot-token.
// type 0 = tekstkanaal, type 5 = aankondigingskanaal.
async function getGuildChannels(token, guildId) {
  const res = await fetch(`${API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error("Kon de kanalen van deze server niet ophalen.");
  const channels = await res.json();
  return channels
    .filter((c) => c.type === 0 || c.type === 5)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Kanaal-categorieën (de "mapjes" waar kanalen in gegroepeerd worden) van een server.
// type 4 = GuildCategory. Gebruikt om per ticket-categorie een eigen Discord-categorie
// te kunnen kiezen (zodat "Klachten"-tickets ergens anders komen dan "Sollicitatie"-tickets).
async function getGuildCategories(token, guildId) {
  const res = await fetch(`${API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error("Kon de categorieën van deze server niet ophalen.");
  const channels = await res.json();
  return channels
    .filter((c) => c.type === 4)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Rollen van een server, opgevraagd met het bot-token (voor de staff-rol-kiezer).
async function getGuildRoles(token, guildId) {
  const res = await fetch(`${API}/guilds/${guildId}/roles`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error("Kon de rollen van deze server niet ophalen.");
  const roles = await res.json();
  return roles
    .filter((r) => r.name !== "@everyone")
    .map((r) => ({ id: r.id, name: r.name, color: r.color }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Publiek profiel van een willekeurige Discord-gebruiker, opgevraagd met het bot-token.
// Gebruikt om een ingevoerd Discord ID te valideren bij het toevoegen van een collaborator.
async function getUserById(token, userId) {
  const res = await fetch(`${API}/users/${userId}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error("Geen Discord-gebruiker gevonden met dat ID.");
  const user = await res.json();
  return { id: user.id, username: user.username, avatar: user.avatar };
}

/* ---------------- bot-profiel (naam, avatar, bio) ---------------- */

async function getBotFullProfile(token) {
  const [userRes, appRes] = await Promise.all([
    fetch(`${API}/users/@me`, { headers: { Authorization: `Bot ${token}` } }),
    fetch(`${API}/applications/@me`, { headers: { Authorization: `Bot ${token}` } }),
  ]);
  if (!userRes.ok) throw new Error("Kon bot-profiel niet ophalen.");
  const user = await userRes.json();
  const app = appRes.ok ? await appRes.json() : {};
  return {
    username: user.username,
    avatar: user.avatar,
    avatarUrl: user.avatar ? `${"https://cdn.discordapp.com"}/avatars/${user.id}/${user.avatar}.png?size=256` : null,
    description: app.description || "",
  };
}

// updates: { username?, avatarDataUri? } — avatarDataUri bv. "data:image/png;base64,...."
async function updateBotUser(token, updates) {
  const body = {};
  if (updates.username) body.username = updates.username;
  if (updates.avatarDataUri) body.avatar = updates.avatarDataUri;
  if (!Object.keys(body).length) return null;
  const res = await fetch(`${API}/users/@me`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord weigerde de wijziging (${res.status}). Let op: username mag max. 2x per uur wijzigen.`);
  return res.json();
}

// updates: { description? }
async function updateBotApplication(token, updates) {
  const body = {};
  if (typeof updates.description === "string") body.description = updates.description;
  if (!Object.keys(body).length) return null;
  const res = await fetch(`${API}/applications/@me`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord weigerde de bio-wijziging (${res.status}).`);
  return res.json();
}

/* ---------------- ticket-paneel plaatsen ---------------- */

// Post een embed met een knop per categorie in het gekozen kanaal.
// customId-schema: ticket_open_<index> — botProcess.js leest de categorie op index terug.
async function postTicketPanel(token, channelId, { title, description, categories }) {
  const rows = [];
  const capped = categories.slice(0, 25);
  for (let i = 0; i < capped.length; i += 5) {
    rows.push({
      type: 1,
      components: capped.slice(i, i + 5).map((label, j) => ({
        type: 2,
        style: 1,
        label: label.slice(0, 80),
        custom_id: `ticket_open_${i + j}`,
      })),
    });
  }
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title,
          description,
          color: 0x7c8cf8,
          footer: { text: "Notspayy's Hosting" },
        },
      ],
      components: rows,
    }),
  });
  if (!res.ok) throw new Error(`Kon het paneel niet plaatsen (${res.status}). Heeft de bot rechten in dat kanaal?`);
  return res.json();
}

module.exports = {
  getAuthorizeUrl,
  exchangeCode,
  getCurrentUser,
  getCurrentUserGuilds,
  verifyBotToken,
  getBotGuilds,
  getGuildChannels,
  getGuildCategories,
  getGuildRoles,
  getUserById,
  getBotFullProfile,
  updateBotUser,
  updateBotApplication,
  postTicketPanel,
};
