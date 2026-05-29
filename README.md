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
TX_EXPLORER_BASE_URL=https://www.okx.com/web3/explorer/xlayer/tx
EXPECTED_XLAYER_CHAIN_ID=196
EXPECTED_USDC_ADDRESS=0x74b7f16337b8972027f6196a17a631ac6de26d22
```

`BACKEND_BOT_API_KEY` must match the backend `TELEGRAM_BOT_API_KEY`.
The bot expects the backend to report X Layer mainnet (`196`) and mainnet USDC at `0x74b7f16337b8972027f6196a17a631ac6de26d22`.

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
