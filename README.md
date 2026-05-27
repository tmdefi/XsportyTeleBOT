# XsportyTeleBOT

Standalone Telegram bot for Xsporty World Cup market discovery and bot-side order placement.

The bot is intentionally separate from the backend repo and Railway service. It calls the backend's protected Telegram routes:

```text
POST /telegram/wallet
POST /telegram/orders
POST /telegram/claims
POST /telegram/withdrawals
POST /telegram/export-link
GET /markets/cards
GET /portfolio/:account
```

## Env

```env
BOT_TOKEN=
BACKEND_URL=https://x-cup-backend-production.up.railway.app
BACKEND_BOT_API_KEY=
PUBLIC_URL=
```

`BACKEND_BOT_API_KEY` must match the backend `TELEGRAM_BOT_API_KEY`.

## Railway

1. Create a separate Railway project/service for this folder.
2. Set the env vars above.
3. Deploy the bot.
4. Generate a public Railway domain.
5. Set the Telegram webhook:

```sh
PUBLIC_URL=https://your-bot.up.railway.app npm run set-webhook
```

## Commands

```text
/start
/markets
/search team
/wallet
/positions
/claim
/settings
/cancel
/help
```
