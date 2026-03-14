/**
 * Telegram Bot Service – PayPerSecret
 *
 * Commands:
 *   /start              – welcome message
 *   /register <wallet>  – link wallet to Telegram
 *   /sell               – list a new secret for sale
 *   /browse             – browse available secrets
 *   /peek <id>          – peek at secret metadata
 *   /buy <id>           – purchase a secret (x402 payment)
 *   /decrypt <id>       – get secret after purchase + verification
 *   /mysales            – view your listed secrets
 *   /mypurchases        – view your purchases
 *   /status             – check your account
 *   /myid               – get your chat ID
 *   /me                 – profile & balances
 */

const TelegramBot = require("node-telegram-bot-api");
const { ethers } = require("ethers");
const crypto = require("crypto");
const { User, Secret } = require("./fileverseStore");
const ens = require("./ensService");
const fileverse = require("./fileverseService");

// USDC contract on Base Sepolia
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

let bot;

function initTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set – bot disabled");
    return;
  }

  bot = new TelegramBot(token, { polling: true });

  // ── /start ─────────────────────────────────────────────
  bot.onText(/\/start/, (msg) => {
    console.log(`[Bot] /start from chat ${msg.chat.id}`);
    bot.sendMessage(
      msg.chat.id,
      `*Welcome to PayPerSecret*\n\n` +
        `Anonymous information marketplace.\n` +
        `Powered by x402 + Fileverse + BitGo MPC.\n\n` +
        `*Seller Commands:*\n` +
        `/sell <price> <description> – list a secret (min $0.50 USDC)\n` +
        `/mysales – view your listings\n\n` +
        `*Buyer Commands:*\n` +
        `/browse – see available secrets\n` +
        `/peek <id> – peek at details\n` +
        `/buy <id> – purchase via x402\n` +
        `/decrypt <id> – get secret content\n` +
        `/mypurchases – view purchases\n\n` +
        `*Account:*\n` +
        `/register <wallet or ENS> – link your wallet\n` +
        `/me – your profile & stats\n` +
        `/myid – get your chat ID`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /register ──────────────────────────────────────────
  bot.onText(/\/register (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const input = match[1].trim();

    try {
      const walletAddress = await ens.resolveENS(input);
      const ensName = input.endsWith(".eth") ? input : null;

      let user = await User.findOne({ telegram_chat_id: chatId });
      if (user) {
        user.wallet_address = walletAddress;
        user.ens_name = ensName;
      } else {
        user = await User.create({
          wallet_address: walletAddress,
          ens_name: ensName,
          telegram_chat_id: chatId,
          label: msg.from.first_name || input,
        });
      }

      bot.sendMessage(
        chatId,
        `*Registered!*\n\nWallet: \`${walletAddress}\`${ensName ? `\nENS: \`${ensName}\`` : ""}\n\nYou can now sell and buy secrets.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      bot.sendMessage(chatId, `Failed to register: ${err.message}`);
    }
  });

  // ── /sell <price> <description> ────────────────────────
  const sellPending = new Map();

  bot.onText(/\/sell (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const parts = match[1].trim().split(/\s+/);

    if (parts.length < 2) {
      bot.sendMessage(chatId, "Usage: `/sell <price_in_USDC> <short description>`\nExample: `/sell 5 Whale dumping TOKEN_X`\nMinimum price: $0.50 USDC", { parse_mode: "Markdown" });
      return;
    }

    const price = parseFloat(parts[0]);
    if (isNaN(price) || price < 0.5) {
      bot.sendMessage(chatId, "Invalid price. Minimum is $0.50 USDC.\nExample: `/sell 2.50 My secret alpha`", { parse_mode: "Markdown" });
      return;
    }

    const description = parts.slice(1).join(" ");
    sellPending.set(chatId, { price, description });

    bot.sendMessage(
      chatId,
      `*Listing Secret*\n\nPrice: $${price} USDC\nDescription: "${description}"\n\nNow send me the *actual secret content* as your next message.\nThis will be encrypted by Fileverse and stored on IPFS + Gnosis chain.`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /browse ────────────────────────────────────────────
  bot.onText(/\/browse/, async (msg) => {
    const chatId = String(msg.chat.id);

    try {
      const secrets = await Secret.find({ status: "listed" })
        .select("description category token_mentioned price createdAt")
        .sort({ createdAt: -1 })
        .limit(10);

      if (secrets.length === 0) {
        bot.sendMessage(chatId, "No secrets available right now.");
        return;
      }

      let text = "*Available Secrets*\n\n";
      for (const s of secrets) {
        text += `*ID:* \`${s._id}\`\n`;
        text += `${s.category || "General"} | ${s.description}\n`;
        text += `Price: $${s.price} USDC\n\n`;
      }
      text += `Use /peek <id> for details\nUse /buy <id> to purchase via x402`;

      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ── /peek <id> ─────────────────────────────────────────
  bot.onText(/\/peek (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const secretId = match[1].trim();

    try {
      const secret = await Secret.findById(secretId)
        .select("description price status");

      if (!secret) { bot.sendMessage(chatId, "Secret not found."); return; }
      if (secret.status !== "listed") { bot.sendMessage(chatId, `Secret is ${secret.status}.`); return; }

      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const peekUrl = `${baseUrl}/peek-pay/${secretId}`;

      bot.sendMessage(
        chatId,
        `*Peek at Secret*\n\n` +
          `Secret: \`${secretId}\`\n` +
          `Description: ${secret.description}\n` +
          `Cost: $0.50 USDC via x402\n\n` +
          `[Click to Peek via x402](${peekUrl})\n\n` +
          `Pay $0.50 to see full metadata (category, token, hash, AI verdict).`,
        { parse_mode: "Markdown", disable_web_page_preview: true }
      );
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ── /buy <id> ──────────────────────────────────────────
  bot.onText(/\/buy (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const secretId = match[1].trim();

    try {
      const secret = await Secret.findById(secretId);
      if (!secret) { bot.sendMessage(chatId, "Secret not found."); return; }
      if (secret.status !== "listed") { bot.sendMessage(chatId, `Secret is ${secret.status}, cannot buy.`); return; }

      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const payUrl = `${baseUrl}/pay/${secretId}?chat=${chatId}`;

      bot.sendMessage(
        chatId,
        `*Buy Secret via x402*\n\n` +
          `Secret: \`${secretId}\`\n` +
          `Description: ${secret.description}\n` +
          `Price: $${secret.price} USDC (Base Sepolia)\n` +
          `Storage: Fileverse (IPFS + Gnosis)\n\n` +
          `[Click to Pay via x402](${payUrl})\n\n` +
          `Connect your wallet to pay. You'll be notified when complete.`,
        { parse_mode: "Markdown", disable_web_page_preview: true }
      );
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ── /decrypt <id> ──────────────────────────────────────
  bot.onText(/\/decrypt (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const secretId = match[1].trim();

    try {
      const secret = await Secret.findById(secretId);
      if (!secret) { bot.sendMessage(chatId, "Secret not found."); return; }
      if (secret.buyer_telegram_id !== chatId) { bot.sendMessage(chatId, "You are not the buyer."); return; }
      if (!["verified", "released"].includes(secret.status)) {
        bot.sendMessage(chatId, `Secret is ${secret.status}. Wait for AI verification.`);
        return;
      }

      // Share the secret content directly
      let text = `*Secret Revealed*\n\n`;
      text += `*Content:*\n${secret.secret_content}\n\n`;
      text += `*Content Hash:* \`${secret.content_hash}\`\n`;
      text += `_Verify: SHA-256 of content = hash above_\n`;

      // If Fileverse link available, share it too
      if (secret.fileverse_link) {
        text += `\n*Fileverse Document:* [Open on ddocs.new](${secret.fileverse_link})\n_(Encrypted on IPFS + Gnosis chain)_\n`;
      } else if (secret.fileverse_ddoc_id) {
        const link = await fileverse.waitForLink(secret.fileverse_ddoc_id, 3);
        if (link) {
          await Secret.findByIdAndUpdate(secretId, { fileverse_link: link });
          text += `\n*Fileverse Document:* [Open on ddocs.new](${link})\n_(Encrypted on IPFS + Gnosis chain)_\n`;
        }
      }

      bot.sendMessage(chatId, text, { parse_mode: "Markdown", disable_web_page_preview: true });
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ── /mysales ───────────────────────────────────────────
  bot.onText(/\/mysales/, async (msg) => {
    const chatId = String(msg.chat.id);

    try {
      const secrets = await Secret.find({ seller_telegram_id: chatId })
        .select("description price status ai_verdict createdAt")
        .sort({ createdAt: -1 })
        .limit(10);

      if (secrets.length === 0) {
        bot.sendMessage(chatId, "You haven't listed any secrets. Use /sell to list one.");
        return;
      }

      let text = "*Your Listings*\n\n";
      for (const s of secrets) {
        text += `\`${s._id}\`\n${s.description} | $${s.price} USDC | ${s.status}\n\n`;
      }
      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ── /mypurchases ───────────────────────────────────────
  bot.onText(/\/mypurchases/, async (msg) => {
    const chatId = String(msg.chat.id);

    try {
      const secrets = await Secret.find({ buyer_telegram_id: chatId })
        .select("description price status ai_verdict createdAt")
        .sort({ createdAt: -1 })
        .limit(10);

      if (secrets.length === 0) {
        bot.sendMessage(chatId, "You haven't purchased any secrets. Use /browse to find one.");
        return;
      }

      let text = "*Your Purchases*\n\n";
      for (const s of secrets) {
        text += `\`${s._id}\`\n${s.description} | $${s.price} USDC | ${s.status} | AI: ${s.ai_verdict || "pending"}\n\n`;
      }
      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ── /status ────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = await User.findOne({ telegram_chat_id: chatId });

    if (!user) {
      bot.sendMessage(chatId, "Not registered. Use /register <wallet_or_ens>");
      return;
    }

    const salesCount = await Secret.countDocuments({ seller_telegram_id: chatId });
    const purchaseCount = await Secret.countDocuments({ buyer_telegram_id: chatId });

    bot.sendMessage(
      chatId,
      `*Your Account*\n\n` +
        `Wallet: \`${user.wallet_address}\`\n` +
        `ENS: ${user.ens_name || "not set"}\n` +
        `Secrets listed: ${salesCount}\n` +
        `Secrets purchased: ${purchaseCount}`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /myid ──────────────────────────────────────────────
  bot.onText(/\/myid/, (msg) => {
    bot.sendMessage(msg.chat.id, `Your chat ID: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
  });

  // ── /me ────────────────────────────────────────────────
  bot.onText(/\/me/, async (msg) => {
    const chatId = String(msg.chat.id);
    const esc = (s) => s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

    try {
      const user = await User.findOne({ telegram_chat_id: chatId });
      const salesCount = await Secret.countDocuments({ seller_telegram_id: chatId });
      const purchaseCount = await Secret.countDocuments({ buyer_telegram_id: chatId });

      const firstName = esc(msg.from.first_name || "");
      const lastName = msg.from.last_name ? " " + esc(msg.from.last_name) : "";
      const username = msg.from.username ? "@" + esc(msg.from.username) : "not set";

      let text = `*Your Profile*\n\n`;
      text += `*Telegram:* ${firstName}${lastName}\n`;
      text += `*Username:* ${username}\n`;
      text += `*Chat ID:* \`${chatId}\`\n\n`;

      if (user) {
        text += `*Wallet:* \`${user.wallet_address}\`\n`;
        text += `*ENS:* ${user.ens_name || "not set"}\n\n`;

        try {
          const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
          const ethBal = await provider.getBalance(user.wallet_address);
          const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
          const usdcBal = await usdcContract.balanceOf(user.wallet_address);

          text += `*Balances (Base Sepolia):*\n`;
          text += `  ETH: ${parseFloat(ethers.formatEther(ethBal)).toFixed(4)}\n`;
          text += `  USDC: ${parseFloat(ethers.formatUnits(usdcBal, 6)).toFixed(2)}\n\n`;
        } catch {
          text += `*Balances:* could not fetch\n\n`;
        }
      } else {
        text += `*Wallet:* not registered (use /register)\n\n`;
      }

      text += `*Stats:*\n`;
      text += `  Secrets listed: ${salesCount}\n`;
      text += `  Secrets purchased: ${purchaseCount}\n`;
      text += `\n*Storage:* Fileverse (IPFS + Gnosis chain)`;

      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // ── Handle secret content (after /sell) ────────────────
  bot.on("text", async (msg) => {
    if (msg.text.startsWith("/")) return;

    const chatId = String(msg.chat.id);
    const pending = sellPending.get(chatId);
    if (!pending) return;

    sellPending.delete(chatId);
    const content = msg.text;
    const { price, description } = pending;

    try {
      // Hash for tamper-proof commitment
      const contentHash = crypto.createHash("sha256").update(content).digest("hex");

      // Extract token mentions
      const tokenRegex = /\b[A-Z]{2,10}\b/g;
      const tokens = content.match(tokenRegex) || [];
      const skipWords = new Set(["THE", "AND", "FOR", "NOT", "ARE", "BUT", "HAS", "WAS", "ALL", "CAN"]);
      const tokenMentioned = tokens.find(t => !skipWords.has(t)) || null;

      const user = await User.findOne({ telegram_chat_id: chatId });
      const sellerAddress = user?.wallet_address || process.env.BITGO_TREASURY_ADDRESS;

      // Create secret → stored on Fileverse (IPFS + Gnosis chain)
      const secret = await Secret.create({
        content,
        seller_telegram_id: chatId,
        seller_stealth_address: sellerAddress,
        content_hash: contentHash,
        category: "General",
        token_mentioned: tokenMentioned,
        description,
        price,
      });

      console.log(`[Bot] Secret listed: ${secret._id} | $${price} USDC | Fileverse: ${secret.fileverse_ddoc_id || "pending"}`);

      const storageInfo = secret.fileverse_ddoc_id
        ? `\n*Storage:* Fileverse (IPFS + Gnosis chain)`
        : `\n*Storage:* In-memory (Fileverse sync pending)`;

      bot.sendMessage(
        chatId,
        `*Secret Listed!*\n\n` +
          `*ID:* \`${secret._id}\`\n` +
          `*Description:* ${description}\n` +
          `*Price:* $${price} USDC\n` +
          `*Hash:* \`${contentHash.slice(0, 16)}...\`${storageInfo}\n\n` +
          `Your secret is encrypted on Fileverse and stored on IPFS.\n` +
          `Buyers pay via x402 protocol. You'll be notified on purchase.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error(`[Bot] Failed to list secret: ${err.message}`);
      bot.sendMessage(chatId, `Failed to list secret: ${err.message}`);
    }
  });

  console.log("[Telegram] PayPerSecret bot initialised (polling mode)");
}

// ── Notification helpers ─────────────────────────────────

async function sendNotification(chatId, text) {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", disable_web_page_preview: true });
  } catch (err) {
    console.error(`[Telegram] Notification failed:`, err.message);
  }
}

function getBot() {
  return bot;
}

module.exports = {
  initTelegram,
  sendNotification,
  getBot,
};
