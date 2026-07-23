// adminWebhook.js
// Stuurt meldingen naar JOUW eigen Discord-webhook over platform-brede gebeurtenissen
// (nieuwe gebruikers, nieuwe bots) — los van de per-bot webhook die gebruikers zelf
// instellen via Beheren → Logs. Dit is een eigenaar/beheerder-instelling en staat
// daarom in .env, niet in de website zelf, zodat gewone gebruikers 'm niet kunnen zien
// of aanpassen.

async function notifyAdmin(text) {
  const url = process.env.ADMIN_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, username: "Notspayy's Hosting — Admin" }),
    });
  } catch {
    // best-effort; een mislukte melding mag niemands login of bot-toevoeging blokkeren
  }
}

module.exports = { notifyAdmin };
