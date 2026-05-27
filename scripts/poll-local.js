process.env.PORT = process.env.BOT_LOCAL_PORT || "3001";

const token = required("BOT_TOKEN");
const webhookUrl = `http://127.0.0.1:${process.env.PORT}/telegram/webhook`;
let offset = Number(process.env.TELEGRAM_UPDATE_OFFSET || 0);

await import("../src/index.js");

console.log(`Local Telegram polling enabled. Bot webhook: ${webhookUrl}`);

while (true) {
  try {
    const updates = await telegram("getUpdates", {
      offset: offset || undefined,
      limit: 20,
      timeout: 25,
      allowed_updates: ["message", "callback_query"]
    });

    for (const update of updates.result || []) {
      offset = update.update_id + 1;
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error("Local webhook failed", response.status, body);
      }
    }
  } catch (error) {
    console.error("Local polling failed", error);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `${method} failed`);
  }
  return data;
}

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
