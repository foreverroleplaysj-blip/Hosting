// botProcess.js
// Dit bestand draait als een APART proces (via child_process.fork) per bot.
// Het maakt een echte verbinding met Discord via discord.js, registreert alle
// commands (custom + ingebouwde modules), en handelt ze allemaal live af.

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const vm = require("node:vm");
const db = require("./db");

const botId = process.env.BOTCLOUD_BOT_ID;
const token = process.env.BOTCLOUD_BOT_TOKEN;

if (!botId || !token) {
  console.error("Ontbrekende BOTCLOUD_BOT_ID of BOTCLOUD_BOT_TOKEN");
  process.exit(1);
}

const RELOAD_EXIT_CODE = 50;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // nodig voor welkomstberichten (privileged intent!)
  ],
});

const cooldowns = new Map(); // `${commandName}:${userId}` -> timestamp
const giveaways = new Map(); // messageId -> { prize, winners, entries:Set, endsAt, requiredRoleId }

function send(msg) {
  if (process.send) process.send(msg);
}
function freshBot() {
  return db.getBot(botId);
}
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;
}
function isStaff(interaction) {
  if (isAdmin(interaction)) return true;
  const bot = freshBot();
  const staffRoles = bot?.staffRoleIds || [];
  if (!staffRoles.length) return false;
  return interaction.member?.roles?.cache?.some((r) => staffRoles.includes(r.id)) || false;
}
function parseDuration(text) {
  const m = /^(\d+)\s*(s|m|u|h|d)$/i.exec((text || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = { s: 1000, m: 60000, u: 3600000, h: 3600000, d: 86400000 }[unit];
  return n * mult;
}

/* ==================== COMMAND REGISTRATIE ==================== */

function buildCommandList() {
  const bot = freshBot();
  const mods = bot?.modules || {};
  const customCommands = db.getCommands(botId);
  const builders = [];

  // custom commands van de gebruiker (namen worden al zonder / opgeslagen)
  for (const c of customCommands) {
    const b = new SlashCommandBuilder()
      .setName(c.name)
      .setDescription((c.description || "Aangepast command").slice(0, 100));
    const sortedOptions = [...(c.options || [])].sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
    for (const opt of sortedOptions) {
      const applyBase = (o) => o.setName(opt.name).setDescription(opt.description || "Optie").setRequired(!!opt.required);
      switch (opt.type) {
        case "integer": b.addIntegerOption((o) => applyBase(o)); break;
        case "number": b.addNumberOption((o) => applyBase(o)); break;
        case "boolean": b.addBooleanOption((o) => applyBase(o)); break;
        case "user": b.addUserOption((o) => applyBase(o)); break;
        case "channel": b.addChannelOption((o) => applyBase(o)); break;
        case "role": b.addRoleOption((o) => applyBase(o)); break;
        default: b.addStringOption((o) => applyBase(o));
      }
    }
    builders.push(b.toJSON());
  }

  if (mods.help?.enabled) {
    builders.push(new SlashCommandBuilder().setName("help").setDescription("Toont alle beschikbare commands").toJSON());
  }

  if (mods.tickets?.enabled) {
    builders.push(new SlashCommandBuilder().setName("ticket").setDescription("Open een privé-ticket voor ondersteuning").toJSON());
  }

  if (mods.giveaway?.enabled) {
    builders.push(
      new SlashCommandBuilder()
        .setName("giveaway")
        .setDescription("Start een giveaway")
        .addStringOption((o) => o.setName("prijs").setDescription("Wat er te winnen valt").setRequired(true))
        .addStringOption((o) => o.setName("duur").setDescription("Bijv. 10m, 1u, 2d").setRequired(true))
        .addIntegerOption((o) => o.setName("winnaars").setDescription("Aantal winnaars").setMinValue(1).setMaxValue(20))
        .addRoleOption((o) => o.setName("vereiste-rol").setDescription("Alleen leden met deze rol mogen meedoen"))
        .addStringOption((o) => o.setName("sponsor").setDescription("Naam van de sponsor (optioneel)"))
        .addStringOption((o) => o.setName("sponsor-link").setDescription("Link naar de sponsor (optioneel)"))
        .toJSON()
    );
  }

  if (mods.polls?.enabled) {
    builders.push(
      new SlashCommandBuilder()
        .setName("poll")
        .setDescription("Start een native Discord-poll")
        .addStringOption((o) => o.setName("vraag").setDescription("De vraag").setRequired(true))
        .addStringOption((o) => o.setName("opties").setDescription("Opties, gescheiden door komma's (max 10)").setRequired(true))
        .addIntegerOption((o) => o.setName("duur-uren").setDescription("Hoe lang de poll open staat (uren, max 168)").setMinValue(1).setMaxValue(168))
        .addBooleanOption((o) => o.setName("meerdere-antwoorden").setDescription("Mogen mensen meerdere opties kiezen?"))
        .toJSON()
    );
  }

  if (mods.moderation?.enabled) {
    builders.push(
      new SlashCommandBuilder().setName("ban").setDescription("Ban een gebruiker (staff)")
        .addUserOption((o) => o.setName("gebruiker").setDescription("Wie").setRequired(true))
        .addStringOption((o) => o.setName("reden").setDescription("Reden")).toJSON(),
      new SlashCommandBuilder().setName("kick").setDescription("Kick een gebruiker (staff)")
        .addUserOption((o) => o.setName("gebruiker").setDescription("Wie").setRequired(true))
        .addStringOption((o) => o.setName("reden").setDescription("Reden")).toJSON(),
      new SlashCommandBuilder().setName("timeout").setDescription("Timeout een gebruiker (staff)")
        .addUserOption((o) => o.setName("gebruiker").setDescription("Wie").setRequired(true))
        .addIntegerOption((o) => o.setName("minuten").setDescription("Duur in minuten").setRequired(true).setMinValue(1).setMaxValue(40320))
        .addStringOption((o) => o.setName("reden").setDescription("Reden")).toJSON(),
      new SlashCommandBuilder().setName("giverole").setDescription("Geef een rol aan iemand (staff)")
        .addUserOption((o) => o.setName("gebruiker").setDescription("Wie").setRequired(true))
        .addRoleOption((o) => o.setName("rol").setDescription("Welke rol").setRequired(true)).toJSON(),
      new SlashCommandBuilder().setName("removerole").setDescription("Haal een rol weg bij iemand (staff)")
        .addUserOption((o) => o.setName("gebruiker").setDescription("Wie").setRequired(true))
        .addRoleOption((o) => o.setName("rol").setDescription("Welke rol").setRequired(true)).toJSON(),
      new SlashCommandBuilder().setName("allroles").setDescription("Geef of haal een rol bij iedereen (staff)")
        .addStringOption((o) => o.setName("actie").setDescription("add of remove").setRequired(true)
          .addChoices({ name: "Toevoegen", value: "add" }, { name: "Verwijderen", value: "remove" }))
        .addRoleOption((o) => o.setName("rol").setDescription("Welke rol").setRequired(true)).toJSON()
    );
  }

  if (mods.utility?.enabled) {
    builders.push(
      new SlashCommandBuilder().setName("avatar").setDescription("Toont iemands profielfoto")
        .addUserOption((o) => o.setName("gebruiker").setDescription("Wie (standaard: jijzelf)")).toJSON(),
      new SlashCommandBuilder().setName("serverinfo").setDescription("Toont info over deze server").toJSON()
    );
  }

  if (mods.reload?.enabled) {
    builders.push(new SlashCommandBuilder().setName("reload").setDescription("Herstart de bot (admin)").toJSON());
  }

  return builders;
}

async function registerCommands() {
  const builders = buildCommandList();
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: builders });
    send({ type: "log", message: `${builders.length} command(s) geregistreerd bij Discord.` });
  } catch (err) {
    send({ type: "log", message: `Kon commands niet registreren: ${err.message}` });
  }
}

client.once("clientReady", async () => {
  send({ type: "ready", username: client.user.tag, discordId: client.user.id });
  await registerCommands();
});

/* ==================== WELKOMSTBERICHTEN ==================== */

client.on("guildMemberAdd", async (member) => {
  const bot = freshBot();
  const w = bot?.modules?.welcome;
  if (!w?.enabled || !w.channelId) return;
  try {
    const channel = await member.guild.channels.fetch(w.channelId);
    const text = (w.message || "Welkom {user}!")
      .replace(/{user}/g, `${member}`)
      .replace(/{username}/g, member.user.username)
      .replace(/{server}/g, member.guild.name)
      .replace(/{membercount}/g, member.guild.memberCount);
    await channel.send({ content: text });
  } catch (err) {
    send({ type: "log", message: `Welkomstbericht mislukt: ${err.message}` });
  }
});

/* ==================== SLASH COMMANDS ==================== */

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) return handleSlash(interaction);
  if (interaction.isButton()) return handleButton(interaction);
});

async function handleSlash(interaction) {
  const name = interaction.commandName;
  const bot = freshBot();

  try {
    switch (name) {
      case "help":
        return await cmdHelp(interaction, bot);
      case "ticket":
        return await cmdTicket(interaction, bot);
      case "giveaway":
        return await cmdGiveaway(interaction);
      case "poll":
        return await cmdPoll(interaction);
      case "ban":
      case "kick":
      case "timeout":
      case "giverole":
      case "removerole":
      case "allroles":
        return await cmdModeration(interaction, name);
      case "reload":
        return await cmdReload(interaction);
      case "avatar":
        return await cmdAvatar(interaction);
      case "serverinfo":
        return await cmdServerInfo(interaction);
      default:
        return await cmdCustom(interaction, name);
    }
  } catch (err) {
    send({ type: "log", message: `Fout in /${name}: ${err.message}` });
    const payload = { content: "Er ging iets mis bij het uitvoeren van dit command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}

/* ---- /help ---- */
async function cmdHelp(interaction, bot) {
  const custom = db.getCommands(botId);
  const mods = bot?.modules || {};
  const lines = [];
  for (const c of custom) lines.push(`**/${c.name}** — ${c.description || "Aangepast command"}`);
  if (mods.tickets?.enabled) lines.push("**/ticket** — Open een privé-ticket");
  if (mods.giveaway?.enabled) lines.push("**/giveaway** — Start een giveaway");
  if (mods.polls?.enabled) lines.push("**/poll** — Start een poll");
  if (mods.moderation?.enabled) {
    lines.push("**/ban, /kick, /timeout** — Moderatie (staff)");
    lines.push("**/giverole, /removerole, /allroles** — Rollen beheren (staff)");
  }
  if (mods.utility?.enabled) lines.push("**/avatar, /serverinfo** — Handige info-commands");
  if (mods.reload?.enabled) lines.push("**/reload** — Herstart de bot (admin)");

  const embed = new EmbedBuilder()
    .setTitle("📖 Beschikbare commands")
    .setColor(0x7c8cf8)
    .setDescription(lines.length ? lines.join("\n") : "Nog geen commands ingesteld.")
    .setFooter({ text: "Notspayy's Hosting" });
  await interaction.reply({ embeds: [embed] });
}

/* ---- /ticket + ticket-paneel knoppen ---- */
async function cmdTicket(interaction, bot) {
  const categories = bot?.modules?.tickets?.categories || [];
  const first = categories[0];
  return createTicket(interaction, first?.label || "Algemeen", first?.parentId || null);
}

async function createTicket(interaction, categoryLabel, parentId) {
  await interaction.deferReply({ ephemeral: true });
  const bot = freshBot();
  const guild = interaction.guild;
  const staffRoles = bot?.staffRoleIds || [];

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ...staffRoles.map((rid) => ({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] })),
  ];

  // Gebruik de expliciet ingestelde Discord-categorie voor déze ticket-categorie.
  // Is er niets ingesteld? Val terug op een kanaal-categorie met "ticket" in de naam,
  // zodat dit ook zonder configuratie meteen werkt.
  let parent = parentId;
  if (!parent) {
    const fallback = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && /ticket/i.test(c.name));
    parent = fallback?.id || undefined;
  }

  const channel = await guild.channels.create({
    name: `ticket-${interaction.user.username}`.toLowerCase().slice(0, 90),
    type: ChannelType.GuildText,
    parent,
    permissionOverwrites: overwrites,
  });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Sluiten").setStyle(ButtonStyle.Danger).setEmoji("🔒")
  );
  const welcomeEmbed = new EmbedBuilder()
    .setTitle(`🎫 Ticket — ${categoryLabel}`)
    .setDescription(`${interaction.user} — welkom bij je ticket! Beschrijf hier je vraag zo duidelijk mogelijk, staff helpt je zo snel mogelijk.`)
    .setColor(0x7c8cf8)
    .setFooter({ text: "Notspayy's Hosting" });
  await channel.send({ embeds: [welcomeEmbed], components: [closeRow] });

  await interaction.editReply({ content: `Je ticket is aangemaakt: ${channel}` });

  if (bot?.logChannelId) {
    try {
      const logCh = await guild.channels.fetch(bot.logChannelId);
      await logCh.send({ content: `🎫 Nieuw ticket (**${categoryLabel}**) geopend door ${interaction.user.tag}: ${channel}` });
    } catch {}
  }
}

/* ---- /giveaway ---- */
async function cmdGiveaway(interaction) {
  const prize = interaction.options.getString("prijs");
  const durationText = interaction.options.getString("duur");
  const winnersCount = interaction.options.getInteger("winnaars") || 1;
  const requiredRole = interaction.options.getRole("vereiste-rol");
  const sponsor = interaction.options.getString("sponsor");
  const sponsorLink = interaction.options.getString("sponsor-link");
  const durationMs = parseDuration(durationText);

  if (!durationMs) {
    return interaction.reply({ content: "Ongeldige duur. Gebruik bijv. `10m`, `1u` of `2d`.", ephemeral: true });
  }

  const endsAt = Date.now() + durationMs;
  const descLines = [`**Prijs:** ${prize}`, `**Winnaars:** ${winnersCount}`, `**Eindigt:** <t:${Math.floor(endsAt / 1000)}:R>`];
  if (requiredRole) descLines.push(`**Vereiste rol:** ${requiredRole}`);
  if (sponsor) descLines.push(`**Sponsor:** ${sponsorLink ? `[${sponsor}](${sponsorLink})` : sponsor}`);

  const embed = new EmbedBuilder()
    .setTitle("🎉 Giveaway!")
    .setColor(0x43e6a0)
    .setDescription(descLines.join("\n"))
    .setFooter({ text: "Klik op de knop om mee te doen! · Notspayy's Hosting" });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("giveaway_join").setLabel("🎉 Doe mee!").setStyle(ButtonStyle.Success)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
  const message = await interaction.fetchReply();
  giveaways.set(message.id, {
    prize,
    winnersCount,
    entries: new Set(),
    endsAt,
    channelId: message.channelId,
    requiredRoleId: requiredRole?.id || null,
  });

  setTimeout(() => endGiveaway(message.id), durationMs);
}

async function endGiveaway(messageId) {
  const g = giveaways.get(messageId);
  if (!g) return;
  giveaways.delete(messageId);
  try {
    const channel = await client.channels.fetch(g.channelId);
    const message = await channel.messages.fetch(messageId);
    const entrants = [...g.entries];
    const winners = [];
    const pool = [...entrants];
    for (let i = 0; i < g.winnersCount && pool.length; i++) {
      winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    const endedEmbed = EmbedBuilder.from(message.embeds[0]).setDescription(
      `**Prijs:** ${g.prize}\n**Status:** Afgelopen — ${entrants.length} deelnemer(s)`
    );
    await message.edit({ embeds: [endedEmbed], components: [] });
    if (winners.length) {
      await channel.send({ content: `🎉 Gefeliciteerd ${winners.map((w) => `<@${w}>`).join(", ")}! Je hebt **${g.prize}** gewonnen!` });
    } else {
      await channel.send({ content: `Niemand heeft meegedaan aan de giveaway voor **${g.prize}**.` });
    }
  } catch (err) {
    send({ type: "log", message: `Giveaway afronden mislukt: ${err.message}` });
  }
}

/* ---- /poll (native Discord poll) ---- */
async function cmdPoll(interaction) {
  const question = interaction.options.getString("vraag");
  const options = interaction.options
    .getString("opties")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  const durationHours = interaction.options.getInteger("duur-uren") || 24;
  const allowMultiselect = interaction.options.getBoolean("meerdere-antwoorden") || false;

  if (options.length < 2) {
    return interaction.reply({ content: "Geef minstens 2 opties op, gescheiden door komma's.", ephemeral: true });
  }

  await interaction.reply({
    poll: {
      question: { text: question },
      answers: options.map((text) => ({ text })),
      duration: durationHours,
      allowMultiselect,
    },
  });
}

/* ---- moderatie ---- */
async function cmdModeration(interaction, name) {
  if (!isStaff(interaction)) {
    return interaction.reply({ content: "Alleen staff mag dit command gebruiken.", ephemeral: true });
  }
  const guild = interaction.guild;

  if (name === "ban" || name === "kick" || name === "timeout") {
    const user = interaction.options.getUser("gebruiker");
    const reason = interaction.options.getString("reden") || "Geen reden opgegeven";
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: "Kon dit lid niet vinden op de server.", ephemeral: true });

    if (name === "ban") {
      await member.ban({ reason });
      await interaction.reply({ content: `🔨 ${user.tag} is verbannen. Reden: ${reason}` });
    } else if (name === "kick") {
      await member.kick(reason);
      await interaction.reply({ content: `👢 ${user.tag} is gekickt. Reden: ${reason}` });
    } else {
      const minutes = interaction.options.getInteger("minuten");
      await member.timeout(minutes * 60 * 1000, reason);
      await interaction.reply({ content: `⏱️ ${user.tag} heeft ${minutes} minuten timeout. Reden: ${reason}` });
    }
    return;
  }

  if (name === "giverole" || name === "removerole") {
    const user = interaction.options.getUser("gebruiker");
    const role = interaction.options.getRole("rol");
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply({ content: "Kon dit lid niet vinden.", ephemeral: true });
    if (name === "giverole") await member.roles.add(role.id);
    else await member.roles.remove(role.id);
    return interaction.reply({ content: `${name === "giverole" ? "✅ Rol gegeven aan" : "❌ Rol verwijderd bij"} ${user.tag}: **${role.name}**` });
  }

  if (name === "allroles") {
    const action = interaction.options.getString("actie");
    const role = interaction.options.getRole("rol");
    await interaction.deferReply();
    const members = await guild.members.fetch();
    let count = 0;
    for (const member of members.values()) {
      try {
        if (action === "add" && !member.roles.cache.has(role.id)) {
          await member.roles.add(role.id);
          count++;
        } else if (action === "remove" && member.roles.cache.has(role.id)) {
          await member.roles.remove(role.id);
          count++;
        }
      } catch {
        // negeer individuele fouten (bijv. rol-hiërarchie) en ga door met de rest
      }
    }
    return interaction.editReply({
      content: `${action === "add" ? "✅ Rol toegevoegd" : "❌ Rol verwijderd"} bij **${count}** leden: ${role.name}`,
    });
  }
}

/* ---- /reload ---- */
async function cmdReload(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Alleen server-admins mogen de bot herstarten.", ephemeral: true });
  }
  await interaction.reply({ content: "🔄 Bot wordt herstart…" });
  send({ type: "log", message: `Herstart aangevraagd door ${interaction.user.tag} via /reload` });
  setTimeout(() => process.exit(RELOAD_EXIT_CODE), 500);
}

/* ---- /avatar, /serverinfo ---- */
async function cmdAvatar(interaction) {
  const user = interaction.options.getUser("gebruiker") || interaction.user;
  const embed = new EmbedBuilder()
    .setTitle(`Profielfoto van ${user.username}`)
    .setImage(user.displayAvatarURL({ size: 512 }))
    .setColor(0x7c8cf8)
    .setFooter({ text: "Notspayy's Hosting" });
  await interaction.reply({ embeds: [embed] });
}

async function cmdServerInfo(interaction) {
  const guild = interaction.guild;
  const embed = new EmbedBuilder()
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL() || null)
    .addFields(
      { name: "Leden", value: `${guild.memberCount}`, inline: true },
      { name: "Server-ID", value: guild.id, inline: true },
      { name: "Aangemaakt", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true }
    )
    .setColor(0x7c8cf8)
    .setFooter({ text: "Notspayy's Hosting" });
  await interaction.reply({ embeds: [embed] });
}

/* ---- custom commands (Command Builder) ---- */
async function cmdCustom(interaction, name) {
  const commands = db.getCommands(botId);
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) return;

  const key = `${cmd.name}:${interaction.user.id}`;
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  const cooldownMs = (cmd.cooldown || 0) * 1000;
  if (now - last < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - (now - last)) / 1000);
    return interaction.reply({ content: `Rustig aan! Wacht nog ${remaining}s.`, ephemeral: true });
  }
  cooldowns.set(key, now);

  if (cmd.adminOnly && !isAdmin(interaction)) {
    return interaction.reply({ content: "Alleen admins mogen dit command gebruiken.", ephemeral: true });
  }

  if (cmd.embed) {
    try {
      const e = buildEmbedFromSpec(cmd.embed);
      await interaction.reply({ content: cmd.response || undefined, embeds: [e] });
    } catch (err) {
      send({ type: "log", message: `Embed-fout in /${cmd.name}: ${err.message}` });
      await interaction.reply({ content: "Er ging iets mis bij het opbouwen van de embed. Check de instellingen bij dit command.", ephemeral: true });
    }
  } else if (cmd.code) {
    // Ruimere VM-sandbox met timeout. Zie README voor veiligheidsnotitie: dit is
    // geen volledige isolatie tegen moedwillig kwaadaardige code — bedoeld voor je
    // EIGEN commands, niet voor het draaien van code van mensen die je niet vertrouwt.
    const sandbox = {
      interaction: {
        reply: (opts) => interaction.reply(opts),
        followUp: (opts) => interaction.followUp(opts),
        editReply: (opts) => interaction.editReply(opts),
        deferReply: (opts) => interaction.deferReply(opts),
        deleteReply: () => interaction.deleteReply(),
        commandName: interaction.commandName,
        user: {
          id: interaction.user.id,
          username: interaction.user.username,
          tag: interaction.user.tag,
          avatarUrl: interaction.user.displayAvatarURL(),
        },
        member: interaction.member
          ? {
              nickname: interaction.member.nickname,
              roleIds: [...interaction.member.roles.cache.keys()],
              isAdmin: isAdmin(interaction),
              isStaff: isStaff(interaction),
            }
          : null,
        guild: interaction.guild
          ? { id: interaction.guild.id, name: interaction.guild.name, memberCount: interaction.guild.memberCount }
          : null,
        channel: interaction.channel ? { id: interaction.channel.id, name: interaction.channel.name } : null,
        options: {
          getString: (n) => interaction.options.getString(n),
          getInteger: (n) => interaction.options.getInteger(n),
          getNumber: (n) => interaction.options.getNumber(n),
          getBoolean: (n) => interaction.options.getBoolean(n),
          getUser: (n) => {
            const u = interaction.options.getUser(n);
            return u ? { id: u.id, username: u.username, tag: u.tag, avatarUrl: u.displayAvatarURL() } : null;
          },
          getChannel: (n) => {
            const c = interaction.options.getChannel(n);
            return c ? { id: c.id, name: c.name } : null;
          },
          getRole: (n) => {
            const r = interaction.options.getRole(n);
            return r ? { id: r.id, name: r.name } : null;
          },
        },
      },
      console: { log: (...args) => send({ type: "log", message: args.join(" ") }) },
    };
    const context = vm.createContext(sandbox);
    const script = new vm.Script(cmd.code, { timeout: 2000 });
    await script.runInContext(context, { timeout: 2000 });
  } else {
    await interaction.reply({ content: cmd.response || "..." });
  }
}

// Zet een door de gebruiker opgeslagen embed-spec (via de website gebouwd, of als
// eigen JSON geplakt — zelfde vorm als een normale Discord-embed) om naar een echte
// EmbedBuilder die discord.js kan versturen.
function buildEmbedFromSpec(spec) {
  const e = new EmbedBuilder();
  if (spec.title) e.setTitle(String(spec.title).slice(0, 256));
  if (spec.description) e.setDescription(String(spec.description).slice(0, 4096));
  if (spec.color) e.setColor(spec.color);
  if (spec.url) e.setURL(spec.url);
  if (spec.image?.url) e.setImage(spec.image.url);
  if (spec.thumbnail?.url) e.setThumbnail(spec.thumbnail.url);
  if (spec.author?.name) e.setAuthor({ name: String(spec.author.name).slice(0, 256), iconURL: spec.author.icon_url || spec.author.iconURL });
  if (spec.footer?.text) e.setFooter({ text: String(spec.footer.text).slice(0, 2048), iconURL: spec.footer.icon_url || spec.footer.iconURL });
  if (Array.isArray(spec.fields) && spec.fields.length) {
    e.addFields(
      spec.fields.slice(0, 25).map((f) => ({
        name: String(f.name || "\u200b").slice(0, 256),
        value: String(f.value || "\u200b").slice(0, 1024),
        inline: !!f.inline,
      }))
    );
  }
  return e;
}

/* ==================== BUTTON INTERACTIES ==================== */

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === "ticket_close") {
    const canClose = interaction.channel.name.includes(interaction.user.username.toLowerCase().slice(0, 20)) || isStaff(interaction);
    if (!canClose) return interaction.reply({ content: "Alleen de opener of staff mag dit ticket sluiten.", ephemeral: true });
    await interaction.reply({ content: "Ticket wordt over 5 seconden gesloten…" });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return;
  }

  if (id.startsWith("ticket_open_")) {
    const index = parseInt(id.replace("ticket_open_", ""), 10);
    const bot = freshBot();
    const categories = bot?.modules?.tickets?.categories || [];
    const entry = categories[index];
    const label = entry?.label || entry || "Algemeen";
    const parentId = entry?.parentId || null;
    return createTicket(interaction, label, parentId);
  }

  if (id === "giveaway_join") {
    const g = giveaways.get(interaction.message.id);
    if (!g) return interaction.reply({ content: "Deze giveaway is niet meer actief.", ephemeral: true });
    if (g.requiredRoleId && !interaction.member?.roles?.cache?.has(g.requiredRoleId)) {
      return interaction.reply({ content: `Je hebt de vereiste rol <@&${g.requiredRoleId}> niet om mee te doen.`, ephemeral: true });
    }
    if (g.entries.has(interaction.user.id)) {
      return interaction.reply({ content: "Je doet al mee! 🎉", ephemeral: true });
    }
    g.entries.add(interaction.user.id);
    return interaction.reply({ content: "Je doet mee met de giveaway! Succes 🍀", ephemeral: true });
  }
}

/* ==================== STATUSRAPPORTAGE ==================== */

const startedAt = Date.now();
setInterval(() => {
  send({ type: "stats", uptimeMs: Date.now() - startedAt, ramBytes: process.memoryUsage().rss, cpu: process.cpuUsage() });
}, 5000);

client.login(token).catch((err) => {
  send({ type: "error", message: err.message });
  process.exit(1);
});

process.on("SIGTERM", () => {
  client.destroy();
  process.exit(0);
});
