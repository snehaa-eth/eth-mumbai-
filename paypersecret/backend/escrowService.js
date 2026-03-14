/**
 * Escrow Service – manages fund locking and release via BitGo MPC wallet
 *
 * Flow:
 *   1. Buyer pays → funds land in BitGo escrow wallet (via x402)
 *   2. Secret verified → escrow releases to seller's stealth address
 *   3. Secret fake → escrow refunds to buyer
 *
 * The BitGo MPC wallet IS the escrow. No smart contract needed.
 * On-chain it looks like normal wallet-to-wallet transfers.
 */

const bitgo = require("./bitgoService");
const { Secret } = require("./fileverseStore");

// ETH uses 18 decimals (wei)
const ETH_DECIMALS = 18;

/**
 * Convert human-readable amount to base units (wei).
 */
function toBaseUnits(amount) {
  const parts = String(amount).split(".");
  const whole = parts[0];
  const frac = (parts[1] || "").padEnd(ETH_DECIMALS, "0").slice(0, ETH_DECIMALS);
  return (BigInt(whole) * BigInt(10 ** ETH_DECIMALS) + BigInt(frac)).toString();
}

/**
 * Record that buyer's x402 payment has landed in the escrow wallet.
 * (x402 sends funds directly to the BitGo wallet address)
 *
 * @param {string} secretId – MongoDB Secret ID
 * @param {string} txHash – x402 payment transaction hash (from PAYMENT-RESPONSE header)
 */
async function recordEscrowDeposit(secretId, txHash) {
  await Secret.findByIdAndUpdate(secretId, {
    status: "purchased",
    escrow_tx_hash: txHash,
  });
  console.log(`[Escrow] Deposit recorded for secret ${secretId}: ${txHash}`);
}

/**
 * Release escrowed funds to the seller's stealth address.
 * Called after AI verification passes.
 *
 * This triggers BitGo MPC signing:
 *   🧩A (your server's key piece) + 🧩B (BitGo's key piece) → one signature
 *
 * @param {string} secretId – MongoDB Secret ID
 * @returns {{ txHash: string }}
 */
async function releaseToSeller(secretId) {
  const secret = await Secret.findById(secretId);
  if (!secret) throw new Error(`Secret ${secretId} not found`);
  if (!secret.seller_stealth_address) {
    // ZK Privacy mode: no seller address stored — mark as released without BitGo transfer
    console.log(`[Escrow] ZK mode: no seller address stored (privacy). Marking as released.`);
    await Secret.findByIdAndUpdate(secretId, { status: "released" });
    return { txHash: "zk-privacy-release-" + secretId.slice(0, 8) };
  }

  const amountBase = toBaseUnits(secret.price);

  // BitGo MPC signing happens inside sendTransaction
  const result = await bitgo.sendTransaction(
    secret.seller_stealth_address,
    amountBase,
    `PayPerSecret release – secret ${secretId}`
  );

  await Secret.findByIdAndUpdate(secretId, {
    status: "released",
    release_tx_hash: result.txid,
  });

  console.log(`[Escrow] Released ${secret.price} to seller for secret ${secretId}: ${result.txid}`);
  return { txHash: result.txid };
}

/**
 * Refund escrowed funds to the buyer.
 * Called when AI verification fails or secret is fake.
 *
 * @param {string} secretId – MongoDB Secret ID
 * @param {string} buyerAddress – buyer's wallet address for refund
 * @returns {{ txHash: string }}
 */
async function refundToBuyer(secretId, buyerAddress) {
  const secret = await Secret.findById(secretId);
  if (!secret) throw new Error(`Secret ${secretId} not found`);

  const amountBase = toBaseUnits(secret.price);

  const result = await bitgo.sendTransaction(
    buyerAddress,
    amountBase,
    `PayPerSecret refund – secret ${secretId}`
  );

  await Secret.findByIdAndUpdate(secretId, {
    status: "refunded",
    refund_tx_hash: result.txid,
  });

  console.log(`[Escrow] Refunded ${secret.price} to buyer for secret ${secretId}: ${result.txid}`);
  return { txHash: result.txid };
}

/**
 * Get escrow wallet balance.
 */
async function getEscrowBalance() {
  return bitgo.getWalletBalance();
}

module.exports = {
  recordEscrowDeposit,
  releaseToSeller,
  refundToBuyer,
  getEscrowBalance,
  toBaseUnits,
};
