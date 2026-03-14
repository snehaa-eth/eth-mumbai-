/**
 * PayPerSecret – Demo Script
 *
 * Demonstrates the full flow via API calls:
 *   1. Alice lists a secret
 *   2. Bob browses
 *   3. Bob peeks (would be x402 gated in production)
 *   4. Bob buys
 *   5. AI verifies
 *   6. Bob decrypts
 *   7. Bob verifies hash matches
 *
 * Run: node demo.js
 * (Server must be running on localhost:3001)
 */

const axios = require("axios");
const crypto = require("crypto");

const BASE = `http://localhost:${process.env.PORT || 3001}`;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function demo() {
  console.log("\n========================================");
  console.log("   PayPerSecret – Full Demo Flow");
  console.log("========================================\n");

  // ── Step 1: Alice lists a secret ────────────────────────
  console.log("STEP 1: Alice lists a secret\n");

  const secretContent = "Whale wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 (vitalik.eth) just approved 500K UNI tokens for sale on Uniswap. Tx pending in mempool. Dump incoming within 30 minutes.";

  const listRes = await axios.post(`${BASE}/api/secrets`, {
    content: secretContent,
    description: "Whale alert: Major UNI dump incoming from top wallet",
    category: "Whale Alert",
    token_mentioned: "UNI",
    price: 0.005,
    seller_address: "0xbe7695b7db6e180a7fc935e9a1ed91327fba66d1",
    seller_telegram_id: "alice_demo",
  });

  const secretId = listRes.data.secret.id;
  console.log(`  Secret listed: ${secretId}`);
  console.log(`  Hash: ${listRes.data.secret.content_hash}`);
  console.log(`  Price: ${listRes.data.secret.price} ETH\n`);

  // ── Step 2: Bob browses ─────────────────────────────────
  console.log("STEP 2: Bob browses available secrets\n");

  const browseRes = await axios.get(`${BASE}/api/secrets`);
  console.log(`  Found ${browseRes.data.secrets.length} secret(s):`);
  for (const s of browseRes.data.secrets) {
    console.log(`    - ${s.description} | ${s.price} ETH | ${s.category}`);
  }
  console.log();

  // ── Step 3: Bob peeks ───────────────────────────────────
  console.log("STEP 3: Bob peeks at the secret (x402: $0.01 in production)\n");

  const peekRes = await axios.get(`${BASE}/api/secrets/${secretId}/peek`);
  console.log(`  Category: ${peekRes.data.secret.category}`);
  console.log(`  Description: ${peekRes.data.secret.description}`);
  console.log(`  Token: ${peekRes.data.secret.token_mentioned}`);
  console.log(`  Price: ${peekRes.data.secret.price} ETH`);
  console.log(`  Hash: ${peekRes.data.secret.content_hash}\n`);

  // ── Step 4: Bob buys ────────────────────────────────────
  console.log("STEP 4: Bob buys the secret (funds go to BitGo MPC escrow)\n");

  const buyRes = await axios.post(`${BASE}/api/secrets/${secretId}/buy`, {
    buyer_telegram_id: "bob_demo",
    tx_hash: "0xdemo_tx_hash_" + Date.now(),
  });

  console.log(`  Status: ${buyRes.data.status}`);
  console.log(`  Message: ${buyRes.data.message}\n`);

  // ── Step 5: Wait for AI verification ────────────────────
  console.log("STEP 5: Waiting for AI verification (Elsa OpenClaw)...\n");

  await sleep(3000);

  const statusRes = await axios.get(`${BASE}/api/secrets/${secretId}/status`);
  console.log(`  Status: ${statusRes.data.secret.status}`);
  console.log(`  AI Verdict: ${statusRes.data.secret.ai_verdict}`);
  console.log(`  AI Score: ${statusRes.data.secret.ai_score}\n`);

  // ── Step 6: Bob decrypts ────────────────────────────────
  console.log("STEP 6: Bob gets decryption key and decrypts\n");

  try {
    const decryptRes = await axios.get(`${BASE}/api/secrets/${secretId}/decrypt`);
    const { encrypted_data, aes_key, iv, auth_tag, content_hash } = decryptRes.data;

    // Decrypt using AES-256-GCM
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(aes_key, "hex"),
      Buffer.from(iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(auth_tag, "hex"));
    let decrypted = decipher.update(encrypted_data, "base64", "utf8");
    decrypted += decipher.final("utf8");

    console.log(`  Decrypted secret: "${decrypted}"\n`);

    // ── Step 7: Verify hash ─────────────────────────────
    console.log("STEP 7: Bob verifies the hash matches\n");

    const hash = crypto.createHash("sha256").update(decrypted).digest("hex");
    const matches = hash === content_hash;

    console.log(`  Computed hash: ${hash}`);
    console.log(`  Original hash: ${content_hash}`);
    console.log(`  Match: ${matches ? "YES — secret is authentic" : "NO — secret was tampered"}\n`);
  } catch (err) {
    if (err.response?.status === 403) {
      console.log(`  Cannot decrypt yet. Status: ${err.response.data.status}`);
      console.log(`  AI Verdict: ${err.response.data.ai_verdict}`);
      console.log("  (In production, this means AI is still verifying or verification failed)\n");
    } else {
      console.log(`  Decrypt error: ${err.message}\n`);
    }
  }

  // ── Summary ─────────────────────────────────────────────
  console.log("========================================");
  console.log("   What Etherscan shows:");
  console.log("========================================");
  console.log("  Tx 1: 0xA1... → 0xB2... (escrow deposit)  ← who is this? no idea");
  console.log("  Tx 2: 0xB2... → 0xC3... (escrow release)  ← who is this? no idea");
  console.log("  No contract. No events. No names. Just random wallets.");
  console.log("========================================\n");
}

demo().catch((err) => {
  console.error("Demo failed:", err.message);
  if (err.response) {
    console.error("Response:", err.response.data);
  }
  process.exit(1);
});
