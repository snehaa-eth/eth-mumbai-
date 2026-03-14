/**
 * Relay Service – orchestrates the two-hop payment flow on Base chain:
 *
 *   Treasury  ──►  Relay Address  ──►  Recipient Wallet
 *
 * Each payment gets a unique relay address generated via BitGo.
 * The service manages the lifecycle: create relay, fund relay,
 * forward funds, update database records.
 */

const bitgo = require("./bitgoService");
const { Payment } = require("./models");

// ETH uses 18 decimals (wei)
const ETH_DECIMALS = 18;

/**
 * Convert a human-readable ETH amount (e.g. "0.01") to wei.
 */
function toBaseUnits(amount) {
  const parts = String(amount).split(".");
  const whole = parts[0];
  const frac = (parts[1] || "").padEnd(ETH_DECIMALS, "0").slice(0, ETH_DECIMALS);
  return BigInt(whole) * BigInt(10 ** ETH_DECIMALS) + BigInt(frac);
}

/**
 * Initiate a relayed payment.
 *
 * 1. Generate relay address via BitGo
 * 2. Send funds from treasury -> relay
 * 3. Update payment record with relay info + first tx hash
 */
async function initiateRelayedPayment(payment) {
  const amountBase = toBaseUnits(payment.amount).toString();

  // Step 1 – Generate relay address
  const relayAddr = await bitgo.generateRelayAddress(payment._id.toString());

  await Payment.findByIdAndUpdate(payment._id, {
    relay_address: relayAddr.address,
    status: "pending",
  });

  console.log(
    `[Relay] Payment ${payment._id}: relay address ${relayAddr.address}`
  );

  // Step 2 – Fund the relay address from treasury
  const txToRelay = await bitgo.sendToRelay(relayAddr.address, amountBase);

  await Payment.findByIdAndUpdate(payment._id, {
    tx_hash_to_relay: txToRelay.txid,
    status: "relay_funded",
  });

  console.log(
    `[Relay] Payment ${payment._id}: treasury -> relay tx ${txToRelay.txid}`
  );

  return { relayAddress: relayAddr.address, txHash: txToRelay.txid };
}

/**
 * Complete the second leg: relay -> recipient.
 */
async function completeRelayToRecipient(paymentId) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  if (payment.status !== "relay_funded") {
    throw new Error(
      `Payment ${paymentId} not in relay_funded state (current: ${payment.status})`
    );
  }

  const amountBase = toBaseUnits(payment.amount).toString();

  const txToRecipient = await bitgo.sendFromRelayToRecipient(
    payment.recipient_wallet,
    amountBase
  );

  await Payment.findByIdAndUpdate(paymentId, {
    tx_hash_to_recipient: txToRecipient.txid,
    status: "completed",
  });

  console.log(
    `[Relay] Payment ${paymentId}: relay -> recipient tx ${txToRecipient.txid}`
  );

  return txToRecipient;
}

module.exports = {
  initiateRelayedPayment,
  completeRelayToRecipient,
  toBaseUnits,
};
