import { createServer } from "node:http";

const config = {
  port: Number(process.env.PORT || 3000),
  botToken: required("BOT_TOKEN"),
  backendUrl: required("BACKEND_URL").replace(/\/$/, ""),
  backendBotApiKey: required("BACKEND_BOT_API_KEY"),
  txExplorerBaseUrl: (process.env.TX_EXPLORER_BASE_URL || "https://www.oklink.com/x-layer-testnet/tx/").replace(/\/$/, "")
};

const marketCache = new Map();
const pendingOrders = new Map();
const pendingSearches = new Set();
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CHAT_CACHE_ITEMS = 250;
const MARKET_PAGE_SIZE = 10;
const HELP_TEXT = [
  "X Cup Markets commands:",
  "",
  "/markets - Browse World Cup markets",
  "/search team - Search by team name",
  "/wallet - Show your deposit wallet",
  "/positions - View your positions",
  "/claim - Claim redeemable winnings",
  "/export - Export your wallet private key",
  "/cancel - Cancel the current ticket",
  "/help - Show this menu"
].join("\n");

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { ok: true, service: "x-cup-telegram-bot" });
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

  if (pendingOrders.has(chatId) && !text.startsWith("/")) {
    return placePendingOrder(chatId, message.from, text);
  }
  if (pendingSearches.has(chatId) && !text.startsWith("/")) {
    pendingSearches.delete(chatId);
    return showMarkets(chatId, 0, text);
  }

  const [command, ...args] = text.split(/\s+/);
  switch (command) {
    case "/start":
      return start(chatId, message.from);
    case "/help":
      return sendMessage(chatId, HELP_TEXT, mainMenuButtons());
    case "/wallet":
      return showWallet(chatId, message.from);
    case "/markets":
      return showMarkets(chatId);
    case "/search":
      if (args.length) return showMarkets(chatId, 0, args.join(" "));
      pendingSearches.add(chatId);
      return sendMessage(chatId, "Send a team name to search World Cup markets.");
    case "/positions":
      return showPositions(chatId, message.from);
    case "/claim":
      return showClaims(chatId, message.from);
    case "/export":
      return showExportLink(chatId, message.from);
    case "/cancel":
      pendingOrders.delete(chatId);
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

  if (data === "markets") return showMarkets(chatId);
  if (data.startsWith("markets:")) return showMarkets(chatId, Number(data.slice("markets:".length)) || 0);
  if (data === "search") {
    pendingSearches.add(chatId);
    return sendMessage(chatId, "Send a team name to search World Cup markets.");
  }
  if (data.startsWith("search:")) {
    const [, searchKey, pageText] = data.split(":");
    const query = getCachedSearch(chatId, searchKey);
    if (!query) return sendMessage(chatId, "That search expired. Send /search team name again.");
    return showMarkets(chatId, Number(pageText) || 0, query);
  }
  if (data === "wallet") return showWallet(chatId, callback.from);
  if (data === "positions") return showPositions(chatId, callback.from);
  if (data === "claims") return showClaims(chatId, callback.from);
  if (data.startsWith("claim:")) return claimWinnings(chatId, callback.from, data.slice(6));
  if (data === "export") return showExportLink(chatId, callback.from);
  if (data === "cancel") {
    pendingOrders.delete(chatId);
    return sendMessage(chatId, "Cancelled.", mainMenuButtons());
  }

  if (data.startsWith("m:")) {
    const cached = getCachedCard(chatId, data.slice(2));
    if (!cached) return sendMessage(chatId, "That market list expired. Send /markets again.");
    return showMarket(chatId, cached.card, cached.key);
  }

  if (data.startsWith("buy:")) {
    const market = getCachedMarket(chatId, data.slice(4));
    if (!market) return sendMessage(chatId, "That market is no longer available. Send /markets again.");

    pendingOrders.set(chatId, {
      marketId: market.id,
      title: market.title,
      outcomeSide: market.outcomeSide,
      side: "BUY",
      price: market.price
    });

    return sendMessage(chatId, `Amount in USDC for:\n${market.title}\n\nOutcome: ${market.outcomeSide}\nPrice: ${market.price}c\n\nSend an amount like 1 or 5.50, or /cancel.`);
  }
}

async function start(chatId, from) {
  const wallet = await ensureWallet(from);
  return sendMessage(chatId, `Welcome to X Cup Markets.\n\nYour bot wallet deposit address:\n${wallet.address}\n\nFund it with X Layer testnet USDC before placing predictions.`, {
    inline_keyboard: [
      [{ text: "World Cup Markets", callback_data: "markets" }],
      [{ text: "Wallet", callback_data: "wallet" }, { text: "Positions", callback_data: "positions" }],
      [{ text: "Claim Winnings", callback_data: "claims" }]
    ]
  });
}

async function showWallet(chatId, from) {
  const wallet = await ensureWallet(from);
  const portfolio = await backendGet(`/portfolio/${wallet.address}`);
  const balance = usdcBalance(portfolio.collateral);
  return sendMessage(chatId, `Wallet address:\n${wallet.address}\n\nUSDC balance:\n${balance} USDC\n\nUse this address to deposit X Layer testnet USDC.`, {
    inline_keyboard: [[{ text: "Export Private Key", callback_data: "export" }]]
  });
}

async function showMarkets(chatId, page = 0, searchQuery = "") {
  const offset = Math.max(0, page) * MARKET_PAGE_SIZE;
  const query = searchQuery.trim();
  const searchParam = query ? `&q=${encodeURIComponent(query)}` : "";
  const data = await backendGet(`/markets/cards?sport=football&status=open&tradingStatus=open&competitionName=World%20Cup&limit=${MARKET_PAGE_SIZE}&offset=${offset}${searchParam}`);
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const total = Number(data.pagination?.total ?? data.total ?? offset + cards.length);
  const currentPage = Math.max(0, Math.floor(offset / MARKET_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(total / MARKET_PAGE_SIZE));
  const cache = chatMarketCache(chatId);
  pruneChatCache(cache);

  if (!cards.length) {
    return sendMessage(chatId, query ? `No World Cup markets found for "${query}".` : "No open World Cup markets are available right now.", {
      inline_keyboard: [[{ text: "Search Team", callback_data: "search" }], [{ text: "World Cup Markets", callback_data: "markets" }]]
    });
  }

  const searchKey = query ? cacheSearch(cache, query) : "";
  return sendMessage(chatId, `${query ? `Search: ${query}\n` : ""}World Cup markets (${currentPage + 1}/${totalPages}):`, {
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

async function showMarket(chatId, card, cardKey) {
  const cache = chatMarketCache(chatId);
  const cached = cardKey ? cache.cards.get(cardKey) : undefined;
  const index = cached?.index ?? 0;
  const title = cardTitle(card, index);
  const buttons = marketButtons(chatId, card, index);

  if (!buttons.length) {
    return sendMessage(chatId, `${title}\n\nNo tradable markets are available for this match yet.`, {
      inline_keyboard: [[{ text: "World Cup Markets", callback_data: "markets" }]]
    });
  }

  return sendMessage(chatId, title, {
    inline_keyboard: buttons.map((button) => [button])
  });
}

async function placePendingOrder(chatId, from, amountText) {
  const pending = pendingOrders.get(chatId);
  if (!pending) return;

  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendMessage(chatId, "Send a valid USDC amount, like 1 or 5.50. Use /cancel to stop.");
  }

  const makerAmount = Math.max(1, Math.round(amount * 1_000_000)).toString();
  const takerAmount = Math.max(1, Math.round((amount / (pending.price / 100)) * 1_000_000)).toString();

  await sendMessage(chatId, "Placing order...");
  try {
    const result = await backendPost("/telegram/orders", {
      ...telegramUser(from),
      marketId: pending.marketId,
      outcomeSide: pending.outcomeSide,
      side: pending.side,
      makerAmount,
      takerAmount
    });

    pendingOrders.delete(chatId);
    const status = result.autoMatch?.matched ? "filled/matched" : "open";
    const hashes = orderHashLines(result, true);
    return sendMessage(
      chatId,
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
    return sendMessage(
      chatId,
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
    return "Wallet balance or exchange approval is not ready. Fund the wallet with X Layer testnet USDC and try again.";
  }
  if (message.includes("Market not found")) return "This market is no longer available.";
  if (message.includes("Trading closed") || message.includes("Market closed")) return "Trading is closed for this market.";
  return message;
}

function redeemablePositions(positions) {
  return positions.filter((position) => {
    const outcomes = Array.isArray(position.outcomes) ? position.outcomes : [];
    return outcomes.some((outcome) => outcome.redeemable);
  });
}

function usdcBalance(collateral) {
  const raw = typeof collateral === "object" && collateral !== null ? collateral.balance : collateral;
  try {
    const value = BigInt(String(raw ?? "0"));
    const whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction.slice(0, 2)}` : whole.toString();
  } catch {
    return "0";
  }
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
      [{ text: "Export Private Key", callback_data: "export" }]
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
