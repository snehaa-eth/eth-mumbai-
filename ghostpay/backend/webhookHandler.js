/**
 * BitGo Webhook Handler – PayPerSecret
 *
 * Listens for transfer events from BitGo and matches them to:
 *   1. Escrow deposits (buyer paid for a secret)
 *   2. Escrow releases (payment sent to seller)
 *   3. Refunds (payment returned to buyer)
 */

const { Secret } = require("./fileverseStore");
const telegram = require("./telegramService");

/**
 * Process an incoming BitGo webhook payload.
 */
async function handleBitGoWebhook(payload) {
  console.log("[Webhook] Received BitGo event:", JSON.stringify(payload).slice(0, 300));

  const { type, hash } = payload;

  if (type !== "transfer") {
    console.log(`[Webhook] Ignoring event type: ${type}`);
    return { status: "ignored", reason: "not a transfer event" };
  }

  // Check if this tx matches an escrow release
  const releasedSecret = await Secret.findOne({
    release_tx_hash: hash,
    status: "released",
  });

  if (releasedSecret) {
    console.log(`[Webhook] Escrow release confirmed for secret ${releasedSecret._id}: ${hash}`);

    // Notify seller that payment has confirmed on-chain
    if (releasedSecret.seller_telegram_id && releasedSecret.seller_telegram_id !== "api") {
      await telegram.sendNotification(
        releasedSecret.seller_telegram_id,
        `*Payment Confirmed!*\n\nYour payment of ${releasedSecret.price} ETH for secret \`${releasedSecret._id}\` has been confirmed on-chain.\nTX: \`${hash}\``
      );
    }

    return { status: "release_confirmed", secretId: releasedSecret._id, txHash: hash };
  }

  // Check if this tx matches a refund
  const refundedSecret = await Secret.findOne({
    refund_tx_hash: hash,
    status: "refunded",
  });

  if (refundedSecret) {
    console.log(`[Webhook] Refund confirmed for secret ${refundedSecret._id}: ${hash}`);

    if (refundedSecret.buyer_telegram_id) {
      await telegram.sendNotification(
        refundedSecret.buyer_telegram_id,
        `*Refund Confirmed!*\n\nYour refund of ${refundedSecret.price} ETH for secret \`${refundedSecret._id}\` has been confirmed on-chain.\nTX: \`${hash}\``
      );
    }

    return { status: "refund_confirmed", secretId: refundedSecret._id, txHash: hash };
  }

  // Check if this is an incoming deposit to the escrow wallet
  const purchasedSecret = await Secret.findOne({
    escrow_tx_hash: hash,
    status: "purchased",
  });

  if (purchasedSecret) {
    console.log(`[Webhook] Escrow deposit confirmed for secret ${purchasedSecret._id}: ${hash}`);
    return { status: "deposit_confirmed", secretId: purchasedSecret._id, txHash: hash };
  }

  console.log(`[Webhook] No matching secret for tx ${hash}`);
  return { status: "ignored", reason: "no matching secret" };
}

module.exports = { handleBitGoWebhook };
