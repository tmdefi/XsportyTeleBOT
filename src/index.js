import { createServer } from "node:http";

const config = {
  port: Number(process.env.PORT || 3000),
  botToken: required("BOT_TOKEN"),
  backendUrl: required("BACKEND_URL").replace(/\/$/, ""),
  backendBotApiKey: required("BACKEND_BOT_API_KEY"),
  txExplorerBaseUrl: (process.env.TX_EXPLORER_BASE_URL || "https://www.okx.com/web3/explorer/xlayer/tx/").replace(/\/$/, ""),
  expectedChainId: Number(process.env.EXPECTED_XLAYER_CHAIN_ID || 196),
  expectedUsdcAddress: (process.env.EXPECTED_USDC_ADDRESS || "0x74b7f16337b8972027f6196a17a631ac6de26d22").toLowerCase()
};

const marketCache = new Map();
const pendingOrders = new Map();
const pendingSearches = new Map();
const pendingWithdrawals = new Map();
let botUsernamePromise;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CHAT_CACHE_ITEMS = 250;
const MARKET_PAGE_SIZE = 10;
const NETWORK_LABEL = "X Layer mainnet";
const COLLATERAL_LABEL = `${NETWORK_LABEL} USDC`;
const HELP_TEXT = [
  "Xsporty commands:",
  "",
  "/markets - Browse World Cup markets",
  "/search team - Search by team name",
  "/wallet - Show your deposit wallet",
  "/positions - View your positions",
  "/claim - Claim redeemable winnings",
  "/settings - Support, social links, and wallet export",
  "/cancel - Cancel the current ticket",
  "/help - Show this menu"
].join("\n");

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { ok: true, service: "xsporty-telegram-bot" });
    }

    if (request.method === "POST" && request.url === "/telegram/webhook") {
      const update = await readJson(request);
      try {
        await handleUpdate(update);
      } catch (error) {
        console.error("Telegram update failed", error);
      }
      return json(response, 200, { ok: true });
    }

    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: "Internal server error" });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Telegram bot listening on :${config.port}`);
  void validateBackendNetwork();
});

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  if (!chatId) return;

  const text = (message.text || "").trim();
  if (!text) return;

  const orderKey = pendingOrderKey(chatId, message.from);
  const searchKey = pendingSearchKey(chatId, message.from);
  if (pendingOrders.has(orderKey) && !text.startsWith("/")) {
    return placePendingOrder(chatId, message.from, text);
  }
  if (pendingWithdrawals.has(chatId) && !text.startsWith("/")) {
    return handleWithdrawalInput(chatId, message.from, text);
  }
  if (pendingSearches.has(searchKey) && !text.startsWith("/")) {
    const pendingSearch = pendingSearches.get(searchKey);
    pendingSearches.delete(searchKey);
    return showMarkets(chatId, 0, text, pendingSearch?.promptMessageId ? { messageId: pendingSearch.promptMessageId } : undefined);
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split("@")[0];
  switch (command) {
    case "/start":
      if (!isPrivateChat(message.chat)) return promptPrivateChat(chatId, "Open me in private chat to create and manage your Xsporty wallet.");
      return start(chatId, message.from);
    case "/help":
      return sendMessage(chatId, HELP_TEXT, mainMenuButtons());
    case "/wallet":
      if (!isPrivateChat(message.chat)) return promptPrivateChat(chatId, "Open me in private chat to view your wallet.");
      return showWallet(chatId, message.from);
    case "/markets":
      return showMarkets(chatId);
    case "/search":
      if (args.length) return showMarkets(chatId, 0, args.join(" "));
      return promptMarketSearch(chatId, message.from);
    case "/positions":
      if (!isPrivateChat(message.chat)) return promptPrivateChat(chatId, "Open me in private chat to view your positions.");
      return showPositions(chatId, message.from);
    case "/claim":
      if (!isPrivateChat(message.chat)) return promptPrivateChat(chatId, "Open me in private chat to claim winnings.");
      return showClaims(chatId, message.from);
    case "/settings":
      if (!isPrivateChat(message.chat)) return promptPrivateChat(chatId, "Open me in private chat to use settings.");
      return showSettings(chatId);
    case "/cancel":
      pendingOrders.delete(orderKey);
      pendingWithdrawals.delete(chatId);
      return sendMessage(chatId, "Cancelled.");
    default:
      return sendMessage(chatId, HELP_TEXT, mainMenuButtons());
  }
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  if (!chatId) return;

  await answerCallback(callback.id);
  const data = callback.data || "";
  const messageId = callback.message?.message_id;
  const editTarget = messageId ? { messageId } : undefined;

  if (data === "markets") return showMarkets(chatId, 0, "", editTarget);
  if (data.startsWith("markets:")) return showMarkets(chatId, Number(data.slice("markets:".length)) || 0, "", editTarget);
  if (data === "search") {
    return promptMarketSearch(chatId, callback.from);
  }
  if (data.startsWith("search:")) {
    const [, searchKey, pageText] = data.split(":");
    const query = getCachedSearch(chatId, searchKey);
    if (!query) return sendMessage(chatId, "That search expired. Send /search team name again.");
    return showMarkets(chatId, Number(pageText) || 0, query, editTarget);
  }
  if (data === "wallet") {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to view your wallet.");
    return showWallet(chatId, callback.from);
  }
  if (data === "positions") {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to view your positions.");
    return showPositions(chatId, callback.from);
  }
  if (data === "claims") {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to claim winnings.");
    return showClaims(chatId, callback.from);
  }
  if (data.startsWith("claim:")) {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to claim winnings.");
    return claimWinnings(chatId, callback.from, data.slice(6));
  }
  if (data === "settings") {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to use settings.");
    return showSettings(chatId);
  }
  if (data === "withdraw") {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to withdraw USDC.");
    return startWithdrawal(chatId, callback.from);
  }
  if (data === "withdraw_cancel") {
    pendingWithdrawals.delete(chatId);
    return sendMessage(chatId, "Withdrawal cancelled.", mainMenuButtons());
  }
  if (data === "withdraw_confirm") {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to withdraw USDC.");
    return confirmWithdrawal(chatId, callback.from);
  }
  if (data === "export") {
    if (!isPrivateChat(callback.message?.chat)) return promptPrivateChat(chatId, "Open me in private chat to export your wallet.");
    return showExportLink(chatId, callback.from);
  }
  if (data === "cancel") {
    pendingOrders.delete(pendingOrderKey(chatId, callback.from));
    pendingWithdrawals.delete(chatId);
    return sendMessage(chatId, "Cancelled.", mainMenuButtons());
  }

  if (data.startsWith("m:")) {
    const cached = getCachedCard(chatId, data.slice(2));
    if (!cached) return sendMessage(chatId, "That market list expired. Send /markets again.");
    return showMarket(chatId, cached.card, cached.key, editTarget);
  }

  if (data.startsWith("buy:")) {
    const market = getCachedMarket(chatId, data.slice(4));
    if (!market) return sendMessage(chatId, "That market is no longer available. Send /markets again.");

    const orderKey = pendingOrderKey(chatId, callback.from);
    const promptText = `${userMention(callback.from)}\n\nAmount in USDC for:\n${market.title}\n\nOutcome: ${market.outcomeSide}\nPrice: ${market.price}c\n\nReply to this message with an amount like 1 or 5.50, or send /cancel.`;
    const prompt = await sendOrEditMessage(chatId, editTarget, promptText, {
      inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]]
    });
    pendingOrders.set(orderKey, {
      marketId: market.id,
      title: market.title,
      outcomeSide: market.outcomeSide,
      side: "BUY",
      price: market.price,
      promptMessageId: editTarget?.messageId || prompt?.result?.message_id
    });
    return prompt;
  }
}

async function start(chatId, from) {
  const wallet = await ensureWallet(from);
  return sendMessage(chatId, `Welcome to Xsporty.\n\nYour bot wallet deposit address:\n${wallet.address}\n\nFund it with ${COLLATERAL_LABEL} before placing predictions.`, {
    inline_keyboard: [
      [{ text: "World Cup Markets", callback_data: "markets" }],
      [{ text: "Wallet", callback_data: "wallet" }, { text: "Positions", callback_data: "positions" }],
      [{ text: "Claim Winnings", callback_data: "claims" }],
      [{ text: "Settings", callback_data: "settings" }]
    ]
  });
}

async function showWallet(chatId, from) {
  const wallet = await ensureWallet(from);
  const portfolio = await backendGet(`/portfolio/${wallet.address}`);
  const balance = usdcBalance(portfolio.collateral);
  return sendMessage(chatId, `Wallet address:\n${wallet.address}\n\nUSDC balance:\n${balance} USDC\n\nUse this address to deposit ${COLLATERAL_LABEL}.`, {
    inline_keyboard: [
      [{ text: "Withdraw USDC", callback_data: "withdraw" }]
    ]
  });
}

async function showMarkets(chatId, page = 0, searchQuery = "", editTarget) {
  const offset = Math.max(0, page) * MARKET_PAGE_SIZE;
  const query = searchQuery.trim();
  const searchParam = query ? `&q=${encodeURIComponent(query)}` : "";
  const data = await backendGet(`/markets/cards?sport=football&category=match&status=open&tradingStatus=open&competitionName=World%20Cup&limit=${MARKET_PAGE_SIZE}&offset=${offset}${searchParam}`);
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const total = Number(data.pagination?.total ?? data.total ?? offset + cards.length);
  const currentPage = Math.max(0, Math.floor(offset / MARKET_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(total / MARKET_PAGE_SIZE));
  const cache = chatMarketCache(chatId);
  pruneChatCache(cache);

  if (!cards.length) {
    return sendOrEditMessage(chatId, editTarget, query ? `No World Cup markets found for "${query}".` : "No open World Cup markets are available right now.", {
      inline_keyboard: [[{ text: "Search Team", callback_data: "search" }], [{ text: "World Cup Markets", callback_data: "markets" }]]
    });
  }

  const searchKey = query ? cacheSearch(cache, query) : "";
  return sendOrEditMessage(chatId, editTarget, `${query ? `Search: ${query}\n` : ""}World Cup markets (${currentPage + 1}/${totalPages}):`, {
    inline_keyboard: [
      ...cards.map((card, index) => {
      const key = cacheCard(cache, card, offset + index);
      return [{
      text: truncate(cardTitle(card, offset + index), 58),
      callback_data: `m:${key}`
      }];
      }),
      marketPaginationButtons(currentPage, totalPages, searchKey),
      [{ text: "Search Team", callback_data: "search" }]
    ].filter((row) => row.length)
  });
}

async function showMarket(chatId, card, cardKey, editTarget) {
  const cache = chatMarketCache(chatId);
  const cached = cardKey ? cache.cards.get(cardKey) : undefined;
  const index = cached?.index ?? 0;
  const title = cardTitle(card, index);
  const buttons = marketButtons(chatId, card, index);

  if (!buttons.length) {
    return sendOrEditMessage(chatId, editTarget, `${title}\n\nNo tradable markets are available for this match yet.`, {
      inline_keyboard: [[{ text: "World Cup Markets", callback_data: "markets" }]]
    });
  }

  return sendOrEditMessage(chatId, editTarget, title, {
    inline_keyboard: buttons.map((button) => [button])
  });
}

async function promptMarketSearch(chatId, from) {
  const key = pendingSearchKey(chatId, from);
  const prompt = await sendMessage(chatId, `${userMention(from)}\n\nReply with a team name to search World Cup markets.`, forceReply("Team name"));
  pendingSearches.set(key, {
    promptMessageId: prompt?.result?.message_id
  });
  return prompt;
}

async function placePendingOrder(chatId, from, amountText) {
  const key = pendingOrderKey(chatId, from);
  const pending = pendingOrders.get(key);
  if (!pending) return;

  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendMessage(chatId, "Send a valid USDC amount, like 1 or 5.50. Use /cancel to stop.");
  }

  const makerAmount = Math.max(1, Math.round(amount * 1_000_000)).toString();
  const takerAmount = Math.max(1, Math.round((amount / (pending.price / 100)) * 1_000_000)).toString();
  const editTarget = pending.promptMessageId ? { messageId: pending.promptMessageId } : undefined;

  await sendOrEditMessage(chatId, editTarget, "Placing order...");
  try {
    const result = await backendPost("/telegram/orders", {
      ...telegramUser(from),
      marketId: pending.marketId,
      outcomeSide: pending.outcomeSide,
      side: pending.side,
      makerAmount,
      takerAmount
    });

    pendingOrders.delete(key);
    const status = result.autoMatch?.matched ? "filled/matched" : "open";
    const hashes = orderHashLines(result, true);
    return sendOrEditMessage(
      chatId,
      editTarget,
      [
        htmlEscape("Order placed successfully."),
        "",
        htmlEscape(`Status: ${status}`),
        htmlEscape(pending.title),
        htmlEscape(`${pending.outcomeSide} at ${pending.price}c`),
        htmlEscape(`Amount: ${amount.toFixed(2)} USDC`),
        htmlEscape(`Order ID: ${result.order?.id || "pending"}`),
        ...hashes
      ].join("\n"),
      {
        inline_keyboard: [
          [{ text: "View Positions", callback_data: "positions" }],
          [{ text: "World Cup Markets", callback_data: "markets" }]
        ]
      },
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );
  } catch (error) {
    console.error("Telegram order failed", error);
    return sendOrEditMessage(
      chatId,
      editTarget,
      `Order was not placed.\n\nReason: ${orderFailureMessage(error)}\n\nYou can try another amount, fund your wallet, or cancel this ticket.`,
      {
        inline_keyboard: [
          [{ text: "Wallet", callback_data: "wallet" }],
          [{ text: "World Cup Markets", callback_data: "markets" }],
          [{ text: "Cancel Ticket", callback_data: "cancel" }]
        ]
      }
    );
  }
}

async function showPositions(chatId, from) {
  const wallet = await ensureWallet(from);
  const data = await backendGet(`/portfolio/${wallet.address}`);
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const balance = usdcBalance(data.collateral);
  if (!positions.length) return sendMessage(chatId, `USDC balance: ${balance} USDC\n\nNo positions yet.`);

  const lines = positions.slice(0, 10).map((position) => {
    const title = position.market?.title || position.title || position.marketId || "Market";
    const outcomes = Array.isArray(position.outcomes) ? position.outcomes : [];
    const held = outcomes.filter((outcome) => Number(outcome.balance || 0) > 0);
    const detail = held.map((outcome) => `${outcome.side || outcome.outcomeSide}: ${(Number(outcome.balance || 0) / 1_000_000).toFixed(2)}`).join(", ");
    return `${truncate(title, 60)}\n${detail || "No active balance"}`;
  });

  const hasRedeemable = redeemablePositions(positions).length > 0;
  return sendMessage(chatId, [`USDC balance: ${balance} USDC`, "", ...lines].join("\n\n"), hasRedeemable ? {
    inline_keyboard: [[{ text: "Claim Winnings", callback_data: "claims" }]]
  } : undefined);
}

async function showClaims(chatId, from) {
  const wallet = await ensureWallet(from);
  const data = await backendGet(`/portfolio/${wallet.address}`);
  const positions = redeemablePositions(Array.isArray(data.positions) ? data.positions : []);
  if (!positions.length) {
    return sendMessage(chatId, "No redeemable winnings yet.", mainMenuButtons());
  }

  const cache = chatMarketCache(chatId);
  pruneChatCache(cache);
  return sendMessage(chatId, "Redeemable winnings:", {
    inline_keyboard: positions.slice(0, 10).map((position) => {
      const key = cacheClaim(cache, {
        marketId: position.market?.id,
        title: position.market?.title || position.title || position.marketId || "Market"
      });
      return [{ text: truncate(position.market?.title || position.title || position.marketId || "Market", 58), callback_data: `claim:${key}` }];
    })
  });
}

async function claimWinnings(chatId, from, claimKey) {
  const claim = getCachedClaim(chatId, claimKey);
  if (!claim?.marketId) return sendMessage(chatId, "That claim expired. Send /claim again.");

  await sendMessage(chatId, "Claiming winnings...");
  try {
    const result = await backendPost("/telegram/claims", {
      ...telegramUser(from),
      marketId: claim.marketId
    });

    return sendMessage(
      chatId,
      [
        htmlEscape("Winnings claimed successfully."),
        "",
        htmlEscape(result.market?.title || claim.title || "Market"),
        hashLine("Transaction hash", result.transactionHash, true)
      ].join("\n"),
      {
        inline_keyboard: [
          [{ text: "View Positions", callback_data: "positions" }],
          [{ text: "World Cup Markets", callback_data: "markets" }]
        ]
      },
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );
  } catch (error) {
    console.error("Telegram claim failed", error);
    return sendMessage(chatId, `Winnings were not claimed.\n\nReason: ${orderFailureMessage(error)}`, {
      inline_keyboard: [
        [{ text: "View Positions", callback_data: "positions" }],
        [{ text: "Claim Winnings", callback_data: "claims" }]
      ]
    });
  }
}

async function startWithdrawal(chatId, from) {
  pendingOrders.delete(pendingOrderKey(chatId, from));
  const wallet = await ensureWallet(from);
  const portfolio = await backendGet(`/portfolio/${wallet.address}`);
  const balance = usdcBalance(portfolio.collateral);
  pendingWithdrawals.set(chatId, {
    step: "destination",
    balanceUnits: collateralUnits(portfolio.collateral)
  });
  return sendMessage(
    chatId,
    `USDC balance: ${balance} USDC\n\nSend the destination wallet address, or /cancel.`
  );
}

async function handleWithdrawalInput(chatId, from, text) {
  const pending = pendingWithdrawals.get(chatId);
  if (!pending) return;

  if (pending.step === "destination") {
    const destination = text.trim();
    if (!isAddress(destination)) {
      return sendMessage(chatId, "Send a valid EVM wallet address starting with 0x, or /cancel.");
    }
    pendingWithdrawals.set(chatId, {
      ...pending,
      step: "amount",
      destination
    });
    return sendMessage(chatId, `Destination:\n${destination}\n\nSend the amount of USDC to withdraw, or /cancel.`);
  }

  if (pending.step === "amount") {
    const amountUnits = parseUsdcAmount(text);
    if (!amountUnits || amountUnits <= 0n) {
      return sendMessage(chatId, "Send a valid USDC amount, like 1 or 5.50. Use /cancel to stop.");
    }
    if (pending.balanceUnits !== undefined && amountUnits > pending.balanceUnits) {
      return sendMessage(chatId, `Insufficient USDC balance. Available: ${formatUsdcUnits(pending.balanceUnits)} USDC.`);
    }

    pendingWithdrawals.set(chatId, {
      ...pending,
      step: "confirm",
      amountUnits,
      amountDisplay: formatUsdcUnits(amountUnits)
    });
    return sendMessage(
      chatId,
      [
        "Confirm withdrawal:",
        "",
        `Amount: ${formatUsdcUnits(amountUnits)} USDC`,
        `To: ${pending.destination}`,
        "",
        "This sends USDC from your Xsporty bot wallet."
      ].join("\n"),
      {
        inline_keyboard: [
          [{ text: "Confirm Withdrawal", callback_data: "withdraw_confirm" }],
          [{ text: "Cancel", callback_data: "withdraw_cancel" }]
        ]
      }
    );
  }
}

async function confirmWithdrawal(chatId, from) {
  const pending = pendingWithdrawals.get(chatId);
  if (!pending?.destination || !pending.amountUnits) {
    pendingWithdrawals.delete(chatId);
    return sendMessage(chatId, "That withdrawal expired. Open Wallet to start again.", {
      inline_keyboard: [[{ text: "Wallet", callback_data: "wallet" }]]
    });
  }

  await sendMessage(chatId, "Sending withdrawal...");
  try {
    const result = await backendPost("/telegram/withdrawals", {
      ...telegramUser(from),
      destination: pending.destination,
      amount: pending.amountUnits.toString()
    });
    pendingWithdrawals.delete(chatId);
    return sendMessage(
      chatId,
      [
        htmlEscape("Withdrawal sent successfully."),
        "",
        htmlEscape(`Amount: ${formatUsdcUnits(pending.amountUnits)} USDC`),
        htmlEscape(`To: ${result.destination || pending.destination}`),
        hashLine("Transaction hash", result.transactionHash, true)
      ].join("\n"),
      {
        inline_keyboard: [
          [{ text: "Wallet", callback_data: "wallet" }],
          [{ text: "View Positions", callback_data: "positions" }]
        ]
      },
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );
  } catch (error) {
    console.error("Telegram withdrawal failed", error);
    return sendMessage(chatId, `Withdrawal was not sent.\n\nReason: ${orderFailureMessage(error)}`, {
      inline_keyboard: [
        [{ text: "Wallet", callback_data: "wallet" }],
        [{ text: "Try Withdrawal Again", callback_data: "withdraw" }],
        [{ text: "Cancel", callback_data: "withdraw_cancel" }]
      ]
    });
  }
}

async function showExportLink(chatId, from) {
  const result = await backendPost("/telegram/export-link", telegramUser(from));
  const exportUrl = `${config.backendUrl}${result.exportPath}`;
  const minutes = Math.max(1, Math.floor(Number(result.expiresInSeconds || 300) / 60));
  return sendMessage(
    chatId,
    [
      "Private key export link created.",
      "",
      "Only open this on a trusted device. Anyone with the private key can control your wallet and move its funds.",
      "",
      `Wallet: ${result.wallet?.address || "your bot wallet"}`,
      `Expires in: ${minutes} minutes`
    ].join("\n"),
    {
      inline_keyboard: [[{ text: "Open Export Page", url: exportUrl }]]
    }
  );
}

async function showSettings(chatId) {
  return sendMessage(chatId, "Settings", {
    inline_keyboard: [
      [{ text: "Export Private Key", callback_data: "export" }],
      [{ text: "Support", url: "https://t.me/LocalDevNet" }],
      [{ text: "X (Twitter)", url: "https://x.com/XsportyApp" }]
    ]
  });
}

async function ensureWallet(from) {
  const body = await backendPost("/telegram/wallet", telegramUser(from));
  return body.wallet;
}

function telegramUser(from = {}) {
  return {
    telegramUserId: String(from.id),
    ...(from.username ? { username: from.username } : {}),
    ...(from.first_name ? { firstName: from.first_name } : {}),
    ...(from.last_name ? { lastName: from.last_name } : {})
  };
}

function pendingOrderKey(chatId, from = {}) {
  return `${chatId}:${from.id || "unknown"}`;
}

function pendingSearchKey(chatId, from = {}) {
  return `${chatId}:${from.id || "unknown"}`;
}

function userMention(from = {}) {
  const name = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" ");
  return name ? `${name},` : "Reply below.";
}

function forceReply(placeholder) {
  return {
    force_reply: true,
    selective: true,
    ...(placeholder ? { input_field_placeholder: placeholder } : {})
  };
}

async function backendGet(path) {
  const response = await fetch(`${config.backendUrl}${path}`, {
    headers: { "x-telegram-bot-api-key": config.backendBotApiKey }
  });
  return parseBackendResponse(response);
}

async function backendPost(path, body) {
  const response = await fetch(`${config.backendUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-key": config.backendBotApiKey
    },
    body: JSON.stringify(body)
  });
  return parseBackendResponse(response);
}

async function validateBackendNetwork() {
  try {
    const backendConfig = await backendGet("/wallet/config");
    const chainId = Number(backendConfig?.chain?.id);
    const collateralToken = String(backendConfig?.contracts?.collateralToken || "").toLowerCase();
    if (chainId !== config.expectedChainId || collateralToken !== config.expectedUsdcAddress) {
      console.error("Telegram bot backend network mismatch", {
        backendUrl: config.backendUrl,
        expectedChainId: config.expectedChainId,
        actualChainId: chainId || null,
        expectedUsdcAddress: config.expectedUsdcAddress,
        actualCollateralToken: collateralToken || null
      });
    }
  } catch (error) {
    console.error("Telegram bot could not verify backend network", error);
  }
}

async function parseBackendResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Backend request failed: ${response.status}`);
  }
  return body;
}

async function sendMessage(chatId, text, replyMarkup, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...options,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function editMessage(chatId, messageId, text, replyMarkup, options = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...options,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function sendOrEditMessage(chatId, editTarget, text, replyMarkup, options = {}) {
  if (editTarget?.messageId) {
    const edited = await editMessage(chatId, editTarget.messageId, text, replyMarkup, options);
    if (edited?.ok !== false) return edited;
  }
  return sendMessage(chatId, text, replyMarkup, options);
}

async function promptPrivateChat(chatId, text) {
  return sendMessage(chatId, text, await privateChatButtons());
}

async function privateChatButtons() {
  const username = await getBotUsername();
  return {
    inline_keyboard: [[{ text: "Open private chat", url: `https://t.me/${username}` }]]
  };
}

async function getBotUsername() {
  botUsernamePromise ??= telegram("getMe", {}).then((data) => {
    const username = data?.result?.username;
    if (!username) throw new Error("Telegram bot username unavailable");
    return username;
  });
  return botUsernamePromise;
}

function isPrivateChat(chat) {
  return chat?.type === "private";
}

async function answerCallback(callbackQueryId) {
  return telegram("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) console.error("Telegram API error", method, data);
  return data;
}

function hasOutcome(card, side) {
  const outcomes = card.outcomes || card.prices || card.options || [];
  if (Array.isArray(outcomes)) return outcomes.some((outcome) => String(outcome.side || outcome.outcomeSide || outcome.label).toUpperCase() === side);
  return Object.prototype.hasOwnProperty.call(outcomes, side);
}

function outcomePrice(card, side) {
  const outcomes = card.outcomes || card.prices || card.options || [];
  if (Array.isArray(outcomes)) {
    const outcome = outcomes.find((item) => String(item.side || item.outcomeSide || item.label).toUpperCase() === side);
    const price = Number(outcome?.price ?? outcome?.probability ?? outcome?.odds);
    if (Number.isFinite(price) && price > 0) return price <= 1 ? Math.round(price * 100) : Math.round(price);
  }
  const direct = Number(outcomes?.[side] ?? card[`${side.toLowerCase()}Price`]);
  if (Number.isFinite(direct) && direct > 0) return direct <= 1 ? Math.round(direct * 100) : Math.round(direct);
  return 50;
}

function cardTitle(card, index = 0) {
  if (card.title || card.marketTitle) return card.title || card.marketTitle;
  const fixture = card.fixture || card.summaries?.[0]?.fixture;
  if (fixture?.homeCompetitor && fixture?.awayCompetitor) {
    return `${fixture.homeCompetitor} vs ${fixture.awayCompetitor}`;
  }
  return card.summaries?.[0]?.market?.title || `Market ${index + 1}`;
}

function marketButtons(chatId, card, cardIndex) {
  const cache = chatMarketCache(chatId);
  const summaries = Array.isArray(card.summaries) ? card.summaries : [];
  if (!summaries.length) {
    return ["YES", "NO", "OVER", "UNDER"]
      .filter((side) => hasOutcome(card, side))
      .map((side) => {
        const price = outcomePrice(card, side);
        const key = cacheMarket(cache, {
          id: card.marketId || card.id,
          title: card.title || card.marketTitle || cardTitle(card, cardIndex),
          outcomeSide: side,
          price
        });
        return { text: oddsButtonLabel(side, price), callback_data: `buy:${key}` };
      });
  }

  return summaries
    .slice(0, 8)
    .flatMap((summary, marketIndex) => {
      const market = summary.market;
      if (!market?.id) return [];
      if (market.status !== "open" || market.tradingStatus !== "open" || !market.conditionId) return [];
      const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
      const prices = summary.summary?.prices || {};
      return outcomes
        .filter((outcome) => ["YES", "OVER"].includes(outcome.side))
        .map((outcome) => {
          const side = outcome.side;
          const price = priceForSummaryOutcome(prices, side);
          const key = cacheMarket(cache, {
            id: market.id,
            title: market.title,
            outcomeSide: side,
            price
          });
          return {
            text: oddsButtonLabel(buttonMarketLabel(market.title, outcome.label || side), price),
            callback_data: `buy:${key}`
          };
        });
    })
    .slice(0, 10);
}

function priceForSummaryOutcome(prices, side) {
  const data = prices?.[side];
  const value = data?.bestAsk ?? data?.midpoint ?? data?.lastTradePrice ?? data?.bestBid;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric <= 1 ? Math.round(numeric * 100) : Math.round(numeric);
  return 50;
}

function chatMarketCache(chatId) {
  const cache = marketCache.get(chatId) || { next: 0, cards: new Map(), markets: new Map(), searches: new Map(), claims: new Map() };
  marketCache.set(chatId, cache);
  return cache;
}

function cacheCard(cache, card, index) {
  const key = nextCacheKey(cache);
  cache.cards.set(key, { card, index, expiresAt: Date.now() + CACHE_TTL_MS });
  return key;
}

function cacheMarket(cache, market) {
  const key = nextCacheKey(cache);
  cache.markets.set(key, { ...market, expiresAt: Date.now() + CACHE_TTL_MS });
  return key;
}

function cacheSearch(cache, query) {
  for (const [key, cached] of cache.searches) {
    if (cached.query.toLowerCase() === query.toLowerCase() && cached.expiresAt >= Date.now()) return key;
  }
  const key = nextCacheKey(cache);
  cache.searches.set(key, { query, expiresAt: Date.now() + CACHE_TTL_MS });
  return key;
}

function cacheClaim(cache, claim) {
  const key = nextCacheKey(cache);
  cache.claims.set(key, { ...claim, expiresAt: Date.now() + CACHE_TTL_MS });
  return key;
}

function getCachedCard(chatId, key) {
  const cached = marketCache.get(chatId)?.cards.get(key);
  if (!cached || cached.expiresAt < Date.now()) return null;
  return { key, card: cached.card, index: cached.index };
}

function getCachedMarket(chatId, key) {
  const cached = marketCache.get(chatId)?.markets.get(key);
  if (!cached || cached.expiresAt < Date.now()) return null;
  return cached;
}

function getCachedSearch(chatId, key) {
  const cached = marketCache.get(chatId)?.searches.get(key);
  if (!cached || cached.expiresAt < Date.now()) return "";
  return cached.query;
}

function getCachedClaim(chatId, key) {
  const cached = marketCache.get(chatId)?.claims.get(key);
  if (!cached || cached.expiresAt < Date.now()) return null;
  return cached;
}

function nextCacheKey(cache) {
  cache.next += 1;
  return cache.next.toString(36);
}

function pruneChatCache(cache) {
  const now = Date.now();
  pruneMap(cache.cards, now);
  pruneMap(cache.markets, now);
  pruneMap(cache.searches, now);
  pruneMap(cache.claims, now);
}

function pruneMap(map, now) {
  for (const [key, value] of map) {
    if (value.expiresAt < now || map.size > MAX_CHAT_CACHE_ITEMS) map.delete(key);
  }
}

function buttonMarketLabel(title, outcomeLabel) {
  const label = compactMarketLabel(title, outcomeLabel);
  if (label) return label;
  if (!outcomeLabel || outcomeLabel === "Yes" || outcomeLabel === "No") return title;
  return `${title} - ${outcomeLabel}`;
}

function oddsButtonLabel(label, price) {
  const odds = ` [${price}c]`;
  return `${truncate(label, 64 - odds.length)}${odds}`;
}

function compactMarketLabel(title, outcomeLabel) {
  const text = String(title || "");
  const outcome = String(outcomeLabel || "");
  const teams = teamsFromTitle(text);
  const totalGoals = text.match(/-\s*Total Goals\s+(\d+(?:\.\d+)?)/i);
  if (totalGoals) return `${shortOutcome(outcome)}${totalGoals[1]}`;
  if (/Both Teams To Score/i.test(text)) return outcome && !isGenericYes(outcome) ? `BTTS ${shortOutcome(outcome)}` : "BTTS";
  if (/to end in a draw/i.test(text)) return "Draw";
  if (/to be tied at half time/i.test(text)) return "HT Draw";
  if (/to win the first half/i.test(text)) return `${shortTeam(text.replace(/ to win the first half/i, ""), teams)} HT`;
  if (/to score first/i.test(text)) return `${shortTeam(text.replace(/ to score first/i, ""), teams)} 1st Goal`;
  if (/ to beat /i.test(text)) return `${shortTeam(text.split(/ to beat /i)[0], teams)} to win`;
  return "";
}

function teamsFromTitle(title) {
  const [home, rest] = String(title || "").split(" vs ");
  if (!home || !rest) return [];
  const away = rest.split(/\s+-\s+|\s+to\s+/i)[0];
  return [home.trim(), away.trim()].filter(Boolean);
}

function shortOutcome(outcome) {
  if (/^over$/i.test(outcome)) return "O";
  if (/^under$/i.test(outcome)) return "U";
  if (/^yes$/i.test(outcome)) return "Yes";
  if (/^no$/i.test(outcome)) return "No";
  return outcome;
}

function isGenericYes(outcome) {
  return /^yes$/i.test(outcome) || /^no$/i.test(outcome);
}

function shortTeam(name, knownTeams = []) {
  const normalized = String(name || "").trim();
  if (!normalized) return "";
  const exact = knownTeams.find((team) => team.toLowerCase() === normalized.toLowerCase());
  const team = exact || normalized;
  const words = team.split(/\s+/).filter(Boolean);
  if (words.length === 1) return team.length > 12 ? team.slice(0, 3).toUpperCase() : team;
  return words.map((word) => word[0]).join("").toUpperCase();
}

function orderFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message) return "Order submission failed";
  if (message.includes("Privy wallet balance or exchange approval is not ready")) {
    return `Wallet balance or exchange approval is not ready. Fund the wallet with ${COLLATERAL_LABEL} and try again.`;
  }
  if (message.includes("Market not found")) return "This market is no longer available.";
  if (message.includes("Trading closed") || message.includes("Market closed")) return "Trading is closed for this market.";
  if (message.includes("Insufficient USDC balance")) return "Insufficient USDC balance.";
  if (message.includes("Withdrawal transaction failed")) return "Withdrawal transaction failed on-chain.";
  return message;
}

function redeemablePositions(positions) {
  return positions.filter((position) => {
    const outcomes = Array.isArray(position.outcomes) ? position.outcomes : [];
    return outcomes.some((outcome) => outcome.redeemable);
  });
}

function usdcBalance(collateral) {
  return formatUsdcUnits(collateralUnits(collateral));
}

function collateralUnits(collateral) {
  const raw = typeof collateral === "object" && collateral !== null ? collateral.balance : collateral;
  try {
    return BigInt(String(raw ?? "0"));
  } catch {
    return 0n;
  }
}

function formatUsdcUnits(value) {
  const units = BigInt(value || 0);
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseUsdcAmount(value) {
  const text = String(value || "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return 0n;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function orderHashLines(result, html = false) {
  const lines = [];
  const matchHash = result?.autoMatch?.result?.trade?.transactionHash;
  if (matchHash) lines.push(hashLine("Transaction hash", matchHash, html));
  if (result?.approvalHash) lines.push(hashLine("Approval hash", result.approvalHash, html));
  if (result?.order?.orderHash) lines.push(html ? htmlEscape(`Order hash: ${result.order.orderHash}`) : `Order hash: ${result.order.orderHash}`);
  return lines;
}

function hashLine(label, hash, html = false) {
  if (!html) return `${label}: ${hash}`;
  const escapedHash = htmlEscape(hash);
  return `${htmlEscape(label)}: <a href="${htmlEscape(txExplorerUrl(hash))}">${escapedHash}</a>`;
}

function txExplorerUrl(hash) {
  return `${config.txExplorerBaseUrl}/${encodeURIComponent(hash)}`;
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mainMenuButtons() {
  return {
    inline_keyboard: [
      [{ text: "World Cup Markets", callback_data: "markets" }],
      [{ text: "Wallet", callback_data: "wallet" }, { text: "Positions", callback_data: "positions" }],
      [{ text: "Claim Winnings", callback_data: "claims" }],
      [{ text: "Settings", callback_data: "settings" }]
    ]
  };
}

function marketPaginationButtons(currentPage, totalPages, searchKey = "") {
  const row = [];
  const dataForPage = (page) => searchKey ? `search:${searchKey}:${page}` : `markets:${page}`;
  if (currentPage > 0) row.push({ text: "Previous", callback_data: dataForPage(currentPage - 1) });
  if (currentPage + 1 < totalPages) row.push({ text: "Next", callback_data: dataForPage(currentPage + 1) });
  return row;
}

function truncate(value, length) {
  return String(value).length > length ? `${String(value).slice(0, length - 1)}...` : String(value);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolve(body ? JSON.parse(body) : {}));
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
