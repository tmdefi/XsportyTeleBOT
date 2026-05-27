const token = required("BOT_TOKEN");
const publicUrl = required("PUBLIC_URL").replace(/\/$/, "");

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${publicUrl}/telegram/webhook`,
    allowed_updates: ["message", "callback_query"]
  })
});

const body = await response.json();
if (!response.ok || !body.ok) {
  console.error(body);
  process.exit(1);
}

console.log(body);

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
