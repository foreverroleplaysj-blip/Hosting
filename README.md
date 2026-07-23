# Notspayy's Hosting

Een echt werkend platform om Discord bots te hosten en beheren via een dashboard:
inloggen met je Discord-account, bots aan/uit zetten, en zelf slash-commands bouwen
(met vaste reactie óf eigen JavaScript-code).

Dit is **echte code** — geen mockup. Als je hem installeert en start, verbindt hij
écht met de Discord API, logt gebruikers écht in via OAuth2, en start écht een
Discord-bot-proces per bot die je toevoegt.

---

## 1. Wat je nodig hebt

- [Node.js](https://nodejs.org) versie 18 of hoger
- Een gratis Discord-account
- 5 minuten om een Discord-applicatie aan te maken

## 2. Discord-applicatie aanmaken (voor de login)

1. Ga naar https://discord.com/developers/applications → **New Application**.
2. Geef 'm een naam, bijv. "Notspayy's Hosting".
3. Ga naar **OAuth2 → General**. Kopieer de **Client ID** en **Client Secret**.
4. Klik bij **Redirects** op **Add Redirect** en vul exact in:
   `http://localhost:3000/auth/discord/callback`
   (pas de domeinnaam later aan als je live gaat, zie stap 6).
5. Sla op.

Dit is de applicatie waarmee gebruikers *inloggen* op Notspayy's Hosting zelf — dit is **niet**
dezelfde applicatie als de Discord bots die mensen later gaan toevoegen. Elke gebruiker
maakt zijn eigen bot-applicatie (met eigen token) aan, zoals uitgelegd in stap 5.

## 3. Installeren

```bash
cd botcloud
npm install
cp .env.example .env
```

Open `.env` en vul in:

```
DISCORD_CLIENT_ID=<jouw client id uit stap 2>
DISCORD_CLIENT_SECRET=<jouw client secret uit stap 2>
DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback
SESSION_SECRET=<verzin een lange willekeurige tekst>
TOKEN_ENCRYPTION_KEY=<verzin nog een lange willekeurige tekst, 32 tekens>
PORT=3000
```

Tip om willekeurige strings te genereren:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Starten

```bash
npm start
```

Ga naar `http://localhost:3000`. Log in met Discord, en je ziet je eigen dashboard.

## 5. Een bot toevoegen (voor je gebruikers)

Om een bot te kunnen hosten heb je een **bot-token** nodig:

1. Ga (opnieuw) naar https://discord.com/developers/applications → **New Application**.
   Dit keer is dit de applicatie die je wilt hosten, bijv. "RegelsBot".
2. Ga naar **Bot** in het linkermenu → **Reset Token** → kopieer het token.
3. Onder **Privileged Gateway Intents** hoef je voor de basis-functionaliteit
   (alleen slash-commands) niets aan te zetten.
4. Nodig de bot uit op je server via **OAuth2 → URL Generator**: vink `bot` en
   `applications.commands` aan, kies de rechten die je bot nodig heeft, en open
   de gegenereerde link.
5. Plak het token in Notspayy's Hosting via **"+ Bot toevoegen"** op het dashboard.
   Notspayy's Hosting controleert het token écht bij Discord en toont de botnaam — pas na
   klikken op **"Activeren"** wordt de token opgeslagen en de bot gestart.

## 6. Live zetten (echte hosting, 24/7)

Op je eigen computer stopt de bot zodra je `npm start` afsluit. Voor "altijd online"
zet je dit project op een server die continu aanstaat. Simpele opties:

- **Een VPS** (bijv. Hetzner, DigitalOcean, Contabo): installeer Node.js, zet dit
  project erop, en start het met een process manager zoals
  [`pm2`](https://pm2.keymetrics.io/) zodat het automatisch herstart:
  ```bash
  npm install -g pm2
  pm2 start server.js --name botcloud
  pm2 save
  ```
- **Railway / Render / Fly.io**: koppel je GitHub-repo, zet de `.env`-variabelen
  in hun dashboard, en deploy.

Vergeet niet de **Redirect URL** in je Discord-applicatie (stap 2.4) en
`DISCORD_CALLBACK_URL` in `.env` aan te passen naar je echte domeinnaam
(`https://botcloud.jouwdomein.nl/auth/discord/callback`).

## 7. Hoe het technisch werkt

```
botcloud/
├── server.js         Express-server: routing, sessies
├── discordApi.js      Praat met Discord's REST API (OAuth2, tokens verifiëren)
├── botManager.js       Start/stopt een apart Node-proces per bot (child_process.fork)
├── botProcess.js        Draait ECHT als losstaand proces: verbindt met discord.js,
│                        registreert slash-commands, voert ze uit
├── db.js               Opslag in data/db.json (tokens versleuteld met AES-256-GCM)
├── routes/
│   ├── auth.js         /auth/discord, /auth/discord/callback, /auth/me
│   ├── bots.js         /api/bots (lijst, verify, activate, start/stop/restart)
│   └── commands.js     /api/bots/:id/commands (command builder)
└── public/              Dashboard-frontend (praat met bovenstaande API's)
```

Elke bot die je activeert draait als een **eigen Node.js-proces**, gestart met
`child_process.fork`. Zo kan het uitvallen van de ene bot niet de andere bots of de
website zelf platleggen. Statusinformatie (online/RAM/uptime) stuurt elk bot-proces
elke 5 seconden terug naar de hoofdserver.

### Custom code-commands: belangrijke veiligheidsnotitie

Bij "Eigen code" in de Command Builder draait de ingevoerde JavaScript in Node's
ingebouwde `vm`-module met een timeout van 2 seconden. Dat is voldoende om per
ongeluk oneindige loops of foute code onschadelijk te maken, maar **is geen volledige
security-sandbox tegen moedwillig kwaadaardige code**. Als je dit platform openstelt
voor mensen die je niet vertrouwt, bouw dan een steviger isolatiemodel, bijvoorbeeld:

- elk bot-proces in een eigen Docker-container met beperkte resources en geen
  netwerktoegang behalve naar Discord;
- of een library als [`isolated-vm`](https://www.npmjs.com/package/isolated-vm)
  voor striktere JS-isolatie;
- resource-limieten (CPU/geheugen) per container via bijv. Docker's `--memory`/`--cpus`.

### Database

`db.js` gebruikt op dit moment een simpel JSON-bestand (`data/db.json`). Dat werkt
prima voor een klein aantal gebruikers. Bij groei vervang je dit door een echte
database (Postgres, MySQL) — de rest van de app hoeft dan niet te veranderen zolang
je dezelfde functienamen aanhoudt (`addBot`, `getBotsForUser`, enz.).

## 8. Nieuwe functies: modules, staff-rollen, tickets, giveaways, polls, moderatie

Op de **Beheren**-pagina (klik op ⚙ bij een bot) vind je nu vier tabbladen:

### Tab "Modules"
Zet losse functies aan/uit. Na een wijziging: **herstart de bot** zodat Discord de
nieuwe slash-commands registreert.

- **Auto /help** — bouwt automatisch een overzicht van alle commands (custom + ingebouwd).
- **Welkomstbericht** — kies een server + kanaal en typ een bericht met `{user}` erin.
  Vereist dat je in je Discord-developer-portaal onder **Bot → Privileged Gateway
  Intents** de **"Server Members Intent"** aanzet, anders ziet de bot geen nieuwe leden.
- **Ticket-systeem** — `/ticket` maakt een privé-kanaal aan (zichtbaar voor de opener +
  je staff-rollen), met een 🔒 sluit-knop.
- **Giveaways** — `/giveaway prijs:... duur:10m winnaars:1` post een giveaway met een
  meedoen-knop; na het verstrijken van de tijd kiest de bot automatisch winnaars.
- **Polls** — `/poll vraag:... opties:Ja,Nee,Misschien` post een stemming met knoppen
  en live bijgewerkte resultaten.
- **Moderatie-commands** — `/ban`, `/kick`, `/timeout`, `/giverole`, `/removerole`,
  `/allroles` — werken alleen voor wie een staff-rol heeft (of Administrator-rechten).
- **/reload** — herstart de bot vanuit Discord zelf (alleen server-admins).

### Tab "Staff & Toegang"
- Kies een server en vink de rollen aan die "staff" zijn — die rollen mogen
  moderatie-commands en tickets gebruiken.
- **Collaborators**: voeg iemand toe via zijn/haar **Discord ID** (rechtsklik op
  iemands naam in Discord → "ID kopiëren", vereist Developer Mode aan in Discord-
  instellingen). Die persoon kan daarna ook inloggen op Notspayy's Hosting en deze bot zien en
  beheren (starten/stoppen, commands, modules) — alleen de eigenaar kan de bot
  verwijderen of collaborators toevoegen/verwijderen.

### Tab "Logs"
- Kies een server + kanaal waar gebeurtenissen (zoals nieuwe tickets) naartoe gestuurd
  worden.
- Onderaan zie je de live console-output van het bot-proces sinds de laatste start.

### Commands bewerken
In de tab "Commands" kun je nu ook op **"Bewerken"** klikken bij een bestaand command
om het aan te passen, in plaats van alleen te kunnen verwijderen.

### Altijd online zolang de website online is
Zolang het `node server.js`-proces (of je Render-service) draait, blijft elke
geactiveerde bot online — crasht een bot-proces onverwacht, dan herstart Notspayy's Hosting 'm
automatisch na 2 seconden. Gebruik je `/reload` in Discord, dan herstart alleen die
ene bot binnen ~1 seconde.

### Ingelogd blijven
Je Discord-login wordt 30 dagen onthouden (cookie-sessie) — je hoeft dus niet elke
keer opnieuw in te loggen.

## 9. Nog meer nieuw: eigen naam, ticket-panelen, native polls, bot-profiel, super-admin

- **Naam veranderd** naar "Notspayy's Hosting" (overal in de website aangepast).
- **Watermark**: giveaway-, ticket- en /help-embeds tonen nu "Notspayy's Hosting" onderaan.
- **Ticket-paneel** (tab Modules → Ticket-systeem): stel een titel, omschrijving en
  meerdere categorieën in (bijv. "Vragen?", "Klachten", "Sollicitatie / Overstap",
  "Owner Vraag" — zoals bij bekende support-bots) en klik op **"Plaats paneel in
  kanaal"**. De bot post een embed met een knop per categorie; elke knop opent een
  eigen privé-ticket met die categorie in de titel.
- **Giveaways** ondersteunen nu ook een vereiste rol en een sponsor(-link), rechtstreeks
  als opties bij `/giveaway` in Discord.
- **Polls zijn nu Discord's eigen native poll-systeem** (niet meer knoppen die wij zelf
  bijhielden) — `/poll` gebruikt de ingebouwde Discord-stemfunctie, inclusief de
  duur-in-uren en "meerdere antwoorden toestaan"-opties.
- **Bot-profiel** (nieuwe tab): pas de echte Discord-naam, avatar en bio ("About Me")
  van je bot aan, direct vanuit de website. Let op: Discord staat maar een beperkt
  aantal naamswijzigingen per uur toe.
- **Extra utility-commands** (tab Modules): `/avatar` en `/serverinfo`.
- **Welkomstbericht-placeholders** uitgebreid: `{user}` (vermelding), `{username}`
  (naam zonder vermelding), `{server}` (servernaam), `{membercount}` (aantal leden).
- **Bugfix**: het gekozen kanaal voor het welkomstbericht (en de bijbehorende server)
  blijven nu correct staan na het herladen van de pagina.
- **Logkanaal meldt nu ook start/stop/herstart**: elke keer dat een bot online komt,
  gestopt wordt, crasht-en-herstart, of via `/reload` herstart, komt er een bericht in
  je logkanaal (als je er een hebt ingesteld).
- **Super-admin**: het Discord-ID `1179804729254105210` heeft op deze installatie
  altijd volledige toegang tot élke bot (ook van andere gebruikers) — kan starten,
  stoppen, verwijderen, collaborators beheren, alles. Wil je dit aanpassen of
  uitzetten? Zet in `.env` een regel `SUPER_ADMIN_IDS=jouw_id,nog_een_id` (of laat 'm
  leeg/weg voor het standaard-ID). **Let op:** geef dit alleen aan Discord-ID's die je
  volledig vertrouwt — deze persoon kan alles op je hele installatie beheren.

## 10. Weer nieuw: echte eigen code, opties/parameters, webhooks, profielmenu

- **Command-opties (parameters)**: bij elk custom command kun je nu parameters
  toevoegen (tekst, getal, aan/uit, gebruiker, kanaal, rol — verplicht of optioneel).
  Discord toont deze als invulvelden zodra iemand het command typt, bijv.
  `/kick gebruiker:@Piet reden:spam`.
- **Veel rijkere "Eigen code"-sandbox**: naast `interaction.reply()` kun je nu ook:
  - `interaction.options.getString("naam")` (ook getInteger/getNumber/getBoolean/getUser/getChannel/getRole)
  - `interaction.followUp()`, `.editReply()`, `.deferReply()`, `.deleteReply()`
  - `interaction.member` (rollen, isAdmin, isStaff), `interaction.guild`, `interaction.channel`
  - Nog steeds in een vm-sandbox met timeout — zie de veiligheidsnotitie verderop.
  - Als je vergeet de commandnaam ergens in je code te zetten, zet BotCloud er
    automatisch `// /jouwcommand` bovenaan bij (puur ter herinnering/overzicht).
- **Discord Webhook** (tab Logs): vul je eigen webhook-URL in en start/stop/herstart-
  meldingen komen daar ook binnen, naast (of in plaats van) het logkanaal. **Wij vullen
  dit nooit voor je in** — een webhook-URL is een geheime link, net als een wachtwoord;
  wie 'm heeft kan berichten in dat kanaal posten. Maak 'm aan via Server-instellingen →
  Integraties → Webhooks in Discord zelf, en plak 'm alleen in je eigen `.env`/dashboard.
- **Profielmenu**: klik rechtsboven op je naam/avatar voor een dropdown met je Discord-
  gegevens en de uitlog-knop (in plaats van een aparte knop).
- **"Iedereens bots" / "Alleen mijn bots"** schakelaar op het dashboard — alleen
  zichtbaar voor super-admins (zie sectie 9). Zo kun je zelf kiezen of je alles ziet of
  alleen je eigen bots.
- **Bot verwijderen** kan nu ook via een knop op het dashboard (alleen zichtbaar voor de
  eigenaar), met een bevestigingsvraag.
- **Embed-builder** voor custom commands (tab "Embed" in de Command Builder): bouw een
  embed met formuliervelden, of plak je eigen embed-JSON direct.

## 11. Admin-webhook: melding bij nieuwe gebruikers en nieuwe bots

Los van de per-bot webhook (tab Logs, hierboven) kun je ook een webhook instellen
voor **jezelf als eigenaar van deze installatie**. Die krijgt een melding bij:

- **Een nieuwe gebruiker** die voor het eerst inlogt via Discord (niet bij elke login
  — alleen de allereerste keer).
- **Een nieuwe bot** die iemand toevoegt en activeert.

Dit staat expres **niet** in de website zelf (dan zou elke gebruiker 'm kunnen zien of
aanpassen), maar in je `.env`-bestand:

```
ADMIN_WEBHOOK_URL=https://discord.com/api/webhooks/jouw-eigen-webhook
```

Maak de webhook aan via Server-instellingen → Integraties → Webhooks in je eigen
Discord-server, en plak de URL alleen in `.env` — nooit in code die je deelt of naar
GitHub upload (zet 'm net als je Client Secret nooit in een publieke repository).

## 12. Command Builder gebruiken

- **Simpele reactie**: vul een command-naam (`/regels`), beschrijving, cooldown en
  een vaste tekst in. De bot antwoordt exact met die tekst.
- **Eigen code**: schrijf JavaScript dat de variabele `interaction` gebruikt, bijv.:
  ```js
  interaction.reply({
    content: "Bekijk onze regels in #regels!"
  });
  ```
- Na het opslaan van een command: **herstart de bot** (knop op het dashboard) zodat
  het nieuwe command bij Discord geregistreerd wordt.

---

Veel plezier met Notspayy's Hosting. Vragen over uitbreidingen (bijv. betaalde abonnementen,
meerdere servers per bot, logs-pagina) — laat het weten.
