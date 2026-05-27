const token = required("BOT_TOKEN");

const commands = [
  { command: "start", description: "Start the bot and show your wallet" },
  { command: "markets", description: "Browse World Cup markets" },
  { command: "search", description: "Search markets by team name" },
  { command: "wallet", description: "Show your deposit wallet" },
  { command: "positions", description: "View your positions" },
  { command: "claim", description: "Claim redeemable winnings" },
  { command: "withdraw", description: "Withdraw USDC to another wallet" },
  { command: "export", description: "Export your wallet private key" },
  { command: "cancel", description: "Cancel the current ticket" },
  { command: "help", description: "Show available commands" }
];

const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ commands })
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
