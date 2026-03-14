/**
 * BitGo Service – pure SDK approach
 * Uses the BitGo JS SDK for all wallet operations.
 */

const BitGoJS = require("bitgo");

let coin;
let bitgoSdk;
let sdkCoin;

// ── Initialise ───────────────────────────────────────────
function initBitGo() {
  const env = process.env.BITGO_ENVIRONMENT === "prod" ? "prod" : "test";
  coin = process.env.BITGO_COIN || "hteth";

  bitgoSdk = new BitGoJS.BitGo({
    env,
    accessToken: process.env.BITGO_ACCESS_TOKEN,
  });

  sdkCoin = bitgoSdk.coin(coin);

  console.log(`[BitGo] Initialised (env=${env}, coin=${coin})`);
}

// ── Treasury wallet ──────────────────────────────────────
let cachedWallet = null;

async function getTreasuryWallet() {
  if (cachedWallet) return cachedWallet;

  const walletId = process.env.BITGO_WALLET_ID;
  if (!walletId || walletId === "your_treasury_wallet_id") {
    throw new Error("BITGO_WALLET_ID not set – create a wallet first");
  }

  cachedWallet = await sdkCoin.wallets().get({ id: walletId });
  console.log(`[BitGo] Treasury wallet loaded: ${cachedWallet.id()}`);
  return cachedWallet;
}

/**
 * Create a brand-new treasury wallet.
 * Wallet is created on the base coin (hteth for testnet).
 */
async function createTreasuryWallet(label = "GhostPay Treasury") {
  const baseCoin = process.env.BITGO_BASE_COIN || "hteth";
  console.log(`[BitGo] Creating wallet on coin: ${baseCoin}`);

  const createCoin = bitgoSdk.coin(baseCoin);
  const walletResult = await createCoin.wallets().generateWallet({
    label,
    passphrase: process.env.BITGO_WALLET_PASSPHRASE,
    enterprise: process.env.BITGO_ENTERPRISE_ID || undefined,
    multisigType: "onchain",
    type: "hot",
  });

  const wallet = walletResult.wallet;
  const walletId = wallet.id();
  const receiveAddress =
    wallet.receiveAddress() ||
    wallet.coinSpecific()?.baseAddress;

  console.log("[BitGo] Treasury wallet created:", walletId);
  console.log("[BitGo] Receive address:", receiveAddress);
  console.log("[BitGo] *** Save the wallet ID in your .env as BITGO_WALLET_ID ***");

  return {
    wallet: {
      id: walletId,
      receiveAddress: { address: receiveAddress },
    },
  };
}

// ── Address generation ───────────────────────────────────
async function generateRelayAddress(paymentId) {
  const wallet = await getTreasuryWallet();
  const address = await wallet.createAddress({ label: `relay-${paymentId}` });

  console.log(`[BitGo] Relay address created: ${address.address} (payment ${paymentId})`);
  return address;
}

// ── Transactions ─────────────────────────────────────────
async function sendTransaction(destinationAddress, amount, memo) {
  const wallet = await getTreasuryWallet();

  const params = {
    walletPassphrase: process.env.BITGO_WALLET_PASSPHRASE,
    recipients: [{ address: destinationAddress, amount: String(amount) }],
    type: "transfer",
  };

  if (memo) {
    params.comment = memo;
  }

  const result = await wallet.sendMany(params);

  console.log(`[BitGo] Transaction sent: ${result.txid} -> ${destinationAddress}`);
  return result;
}

async function sendToRelay(relayAddress, amount) {
  return sendTransaction(relayAddress, amount, "GhostPay relay funding");
}

async function sendFromRelayToRecipient(recipientAddress, amount) {
  return sendTransaction(recipientAddress, amount, "GhostPay payout");
}

// ── Webhooks ─────────────────────────────────────────────
async function registerWebhook(callbackUrl) {
  const wallet = await getTreasuryWallet();
  const webhook = await wallet.addWebhook({
    type: "transfer",
    url: callbackUrl,
    numConfirmations: 1,
  });

  console.log(`[BitGo] Webhook registered -> ${callbackUrl}`);
  return webhook;
}

// ── Wallet balance ───────────────────────────────────────
async function getWalletBalance() {
  const wallet = await getTreasuryWallet();
  return {
    balance: wallet.balanceString(),
    confirmedBalance: wallet.confirmedBalanceString(),
    spendableBalance: wallet.spendableBalanceString(),
  };
}

module.exports = {
  initBitGo,
  getTreasuryWallet,
  createTreasuryWallet,
  generateRelayAddress,
  sendTransaction,
  sendToRelay,
  sendFromRelayToRecipient,
  registerWebhook,
  getWalletBalance,
};
