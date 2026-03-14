/**
 * PayPerSecret – Express.js Backend Server
 *
 * Anonymous information marketplace powered by:
 *   - x402 Protocol: HTTP-native payments (peek + buy)
 *   - Fileverse: Decentralized encrypted storage (IPFS + Gnosis chain) — NO MongoDB
 *   - BitGo MPC: Invisible escrow wallets
 *   - HeyElsa AI: On-chain claim verification
 *   - Telegram Bot: Sole user interface
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");

const fileverse = require("./fileverseService");
const { initDB, User, Secret } = require("./fileverseStore");
const bitgo = require("./bitgoService");
const ens = require("./ensService");
const escrow = require("./escrowService");
const elsaVerifier = require("./elsaVerifier");
const telegram = require("./telegramService");
const { createPaymentMiddleware } = require("./x402Config");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "script-src-attr": ["'unsafe-inline'"],
      "connect-src": ["'self'", "https://*.ngrok-free.app", "http://*.ngrok-free.app", "http://localhost:*"],
    },
  },
}));
app.use(cors());
app.use(express.json());

// x402 payment middleware (gates peek endpoint)
const x402Middleware = createPaymentMiddleware();
if (x402Middleware) {
  app.use(x402Middleware);
}

// ── Health ───────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "paypersecret",
    timestamp: new Date().toISOString(),
    x402: !!x402Middleware,
    storage: "fileverse",
    fileverse: fileverse.isEnabled(),
  });
});

// ─────────────────────────────────────────────────────────
// SECRET ENDPOINTS
// ─────────────────────────────────────────────────────────

/**
 * POST /api/secrets
 * List a new secret for sale.
 * Content is stored on Fileverse (encrypted on IPFS + Gnosis chain).
 */
app.post("/api/secrets", async (req, res) => {
  try {
    const { content, description, category, token_mentioned, price, seller_address, seller_telegram_id } = req.body;

    if (!content || !description || !price) {
      return res.status(400).json({ error: "content, description, and price required" });
    }

    const contentHash = crypto.createHash("sha256").update(content).digest("hex");

    const secret = await Secret.create({
      content,
      seller_telegram_id: seller_telegram_id || "api",
      seller_stealth_address: seller_address || process.env.BITGO_TREASURY_ADDRESS,
      content_hash: contentHash,
      category: category || "General",
      token_mentioned,
      description,
      price,
    });

    console.log(`[API] Secret listed: ${secret._id} – "${description}" – $${price} USDC`);
    console.log(`[API] Stored on Fileverse (IPFS + Gnosis chain)`);

    res.status(201).json({
      secret: {
        id: secret._id,
        description: secret.description,
        category: secret.category,
        price: secret.price,
        content_hash: secret.content_hash,
        status: secret.status,
        storage: "fileverse",
      },
    });
  } catch (err) {
    console.error("[API] create-secret error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secrets
 * Browse all listed secrets (free).
 */
app.get("/api/secrets", async (_req, res) => {
  try {
    const secrets = await Secret.find({ status: "listed" })
      .select("description category token_mentioned price content_hash createdAt")
      .sort({ createdAt: -1 });

    res.json({ secrets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secrets/:id/peek
 * Peek at secret metadata (x402 gated: $0.50).
 */
app.get("/api/secrets/:id/peek", async (req, res) => {
  try {
    console.log(`[x402-Peek] ➤ GET /api/secrets/${req.params.id}/peek`);
    console.log(`[x402-Peek]   X-Payment header: ${req.headers["x-payment"] || "NONE (will 402)"}`);

    const secret = await Secret.findById(req.params.id)
      .select("description category token_mentioned price content_hash status createdAt ai_verdict");

    if (!secret) {
      console.log(`[x402-Peek]   ✗ Secret not found`);
      return res.status(404).json({ error: "Secret not found" });
    }
    if (secret.status !== "listed") {
      console.log(`[x402-Peek]   ✗ Secret status: ${secret.status}`);
      return res.status(410).json({ error: "Secret already sold" });
    }

    console.log(`[x402-Peek]   ✓ Returning metadata for "${secret.description}" ($${secret.price} USDC)`);
    res.json({
      secret: {
        id: secret._id,
        description: secret.description,
        category: secret.category,
        token_mentioned: secret.token_mentioned,
        price: secret.price,
        content_hash: secret.content_hash,
        status: secret.status,
        listed_at: secret.createdAt,
        ai_verdict: secret.ai_verdict,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /peek-pay/:id
 * x402 Peek Payment Page – pay $0.50 to see secret metadata.
 * Flow: connect wallet → pay $0.50 USDC → fetch x402-gated peek endpoint → show metadata.
 */
app.get("/peek-pay/:id", async (req, res) => {
  try {
    console.log(`[x402-Peek] ➤ GET /peek-pay/${req.params.id} (payment page)`);

    const secret = await Secret.findById(req.params.id)
      .select("description price status");

    if (!secret) { console.log(`[x402-Peek]   ✗ Secret not found`); return res.status(404).send("Secret not found"); }
    if (secret.status !== "listed") { console.log(`[x402-Peek]   ✗ Secret status: ${secret.status}`); return res.status(410).send("Secret already sold"); }
    console.log(`[x402-Peek]   ✓ Serving peek payment page for "${secret.description}" ($0.50 fee)`);

    const serverWallet = process.env.SERVER_WALLET || process.env.BITGO_TREASURY_ADDRESS || "";

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayPerSecret – Peek via x402</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1a1a2e; border: 1px solid #333; border-radius: 16px; padding: 32px; max-width: 420px; width: 90%; }
    .logo { font-size: 24px; font-weight: 700; color: #00d4ff; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .field { margin-bottom: 16px; }
    .label { color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .value { font-size: 16px; color: #fff; }
    .hash { font-family: monospace; font-size: 12px; color: #666; word-break: break-all; }
    .price-box { background: #0d2137; border: 1px solid #00d4ff33; border-radius: 12px; padding: 16px; text-align: center; margin: 24px 0; }
    .price { font-size: 28px; font-weight: 700; color: #00d4ff; }
    .price-label { color: #888; font-size: 12px; }
    .pay-btn { width: 100%; padding: 16px; background: #00d4ff; color: #000; font-size: 16px; font-weight: 700; border: none; border-radius: 12px; cursor: pointer; transition: all 0.2s; }
    .pay-btn:hover { background: #00b8e6; transform: translateY(-1px); }
    .pay-btn:disabled { background: #333; color: #666; cursor: not-allowed; transform: none; }
    .status { text-align: center; margin-top: 16px; font-size: 14px; color: #888; }
    .success { color: #00ff88; }
    .error { color: #ff4444; }
    .x402-badge { display: inline-block; background: #1a3a2e; border: 1px solid #00ff8833; padding: 4px 12px; border-radius: 20px; font-size: 11px; color: #00ff88; margin-bottom: 16px; }
    .powered { text-align: center; margin-top: 24px; font-size: 11px; color: #444; }
    .metadata { display: none; background: #111; border: 1px solid #333; border-radius: 12px; padding: 20px; margin-top: 20px; }
    .metadata.show { display: block; }
    .metadata .field { margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">PayPerSecret</div>
    <div class="subtitle">Peek at Secret Metadata</div>
    <div class="x402-badge">x402 Payment Protocol</div>

    <div class="field">
      <div class="label">Secret</div>
      <div class="value">${secret.description}</div>
    </div>

    <div class="price-box">
      <div class="price-label">x402 PEEK FEE</div>
      <div class="price">$0.50 USDC</div>
      <div class="price-label">Base Sepolia (EIP-155:84532)</div>
    </div>

    <button class="pay-btn" id="payBtn" onclick="handlePeek()">
      Pay $0.50 USDC to Peek
    </button>
    <div class="status" id="status"></div>

    <div class="metadata" id="metadata"></div>

    <div class="powered">x402 Protocol + Fileverse IPFS + BitGo MPC Escrow</div>
  </div>

  <script>
    const SECRET_ID = "${secret._id}";
    const PEEK_URL = "/api/secrets/${secret._id}/peek";
    const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const PAY_TO = "${serverWallet}";
    const PEEK_PRICE = 0.50;
    const USDC_RAW = Math.round(PEEK_PRICE * 1e6);
    const USDC_HEX = "0x" + USDC_RAW.toString(16);
    const SELECTOR = "0xa9059cbb";

    function encodeTransfer(to, amt) {
      return SELECTOR + to.toLowerCase().replace("0x","").padStart(64,"0") + amt.replace("0x","").padStart(64,"0");
    }

    window.addEventListener("load", () => {
      const s = document.getElementById("status");
      if (window.ethereum) {
        s.textContent = "Wallet detected. Click to peek via x402.";
        s.className = "status success";
      } else {
        s.textContent = "No wallet detected. Install MetaMask or open in a dApp browser.";
      }
    });

    async function handlePeek() {
      const btn = document.getElementById("payBtn");
      const status = document.getElementById("status");
      const metaDiv = document.getElementById("metadata");
      if (!window.ethereum) { status.className = "status error"; status.textContent = "No wallet found."; return; }

      try {
        btn.disabled = true;

        // Step 1: Try peek endpoint (will return 402)
        console.log("[x402-Peek] Step 1: Fetching peek endpoint to get 402...");
        btn.textContent = "Requesting x402 payment...";
        const reqRes = await fetch(PEEK_URL);
        console.log("[x402-Peek] Step 1 response status:", reqRes.status);
        if (reqRes.status !== 402) throw new Error("Unexpected response: " + reqRes.status);
        const payReqData = await reqRes.json();
        console.log("[x402-Peek] Step 1 x402 requirements:", JSON.stringify(payReqData, null, 2));
        status.textContent = "x402: $0.50 USDC payment required for peek";

        // Step 2: Connect wallet
        console.log("[x402-Peek] Step 2: Connecting wallet...");
        btn.textContent = "Connecting wallet...";
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        const buyer = accounts[0];
        console.log("[x402-Peek] Step 2 wallet connected:", buyer);
        status.textContent = "Connected: " + buyer.slice(0,6) + "..." + buyer.slice(-4);

        // Step 3: Switch to Base Sepolia
        console.log("[x402-Peek] Step 3: Switching to Base Sepolia (chainId 0x14A34)...");
        btn.textContent = "Switching to Base Sepolia...";
        try {
          await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14A34" }] });
          console.log("[x402-Peek] Step 3 chain switched OK");
        } catch (e) {
          console.log("[x402-Peek] Step 3 chain switch error:", e.code, e.message);
          if (e.code === 4902) {
            console.log("[x402-Peek] Step 3 adding Base Sepolia chain...");
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
              chainId: "0x14A34", chainName: "Base Sepolia",
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"],
            }]});
          } else throw e;
        }

        // Step 4: Send $0.50 USDC payment
        console.log("[x402-Peek] Step 4: Sending USDC transfer...");
        console.log("[x402-Peek]   From:", buyer);
        console.log("[x402-Peek]   To contract:", USDC_CONTRACT);
        console.log("[x402-Peek]   Pay to:", PAY_TO);
        console.log("[x402-Peek]   Amount: $0.50 USDC (raw:", USDC_RAW, "hex:", USDC_HEX, ")");
        btn.textContent = "Approve USDC transfer...";
        status.textContent = "x402: Sending $0.50 USDC to " + PAY_TO.slice(0,8) + "...";
        const txHash = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{ from: buyer, to: USDC_CONTRACT, data: encodeTransfer(PAY_TO, USDC_HEX), value: "0x0" }],
        });
        console.log("[x402-Peek] Step 4 TX hash:", txHash);

        // Step 5: Fetch peek data with x402 payment proof
        console.log("[x402-Peek] Step 5: Fetching peek with X-Payment header...");
        btn.textContent = "Fetching metadata...";
        status.textContent = "TX: " + txHash.slice(0,10) + "... Fetching metadata...";
        const peekRes = await fetch(PEEK_URL, {
          headers: { "X-Payment": txHash },
        });
        console.log("[x402-Peek] Step 5 response status:", peekRes.status);
        const data = await peekRes.json();
        console.log("[x402-Peek] Step 5 response data:", JSON.stringify(data, null, 2));

        if (peekRes.ok && data.secret) {
          console.log("[x402-Peek] SUCCESS! Metadata received");
          btn.textContent = "Peek Complete!";
          btn.style.background = "#00ff88"; btn.style.color = "#000";
          status.className = "status success";
          status.innerHTML = "x402 peek payment confirmed!<br>TX: <a href='https://sepolia.basescan.org/tx/" + txHash + "' target='_blank' style='color:#00d4ff'>" + txHash.slice(0,10) + "...</a>";

          const s = data.secret;
          metaDiv.innerHTML = \`
            <div class="field"><div class="label">Category</div><div class="value">\${s.category || "General"}</div></div>
            <div class="field"><div class="label">Description</div><div class="value">\${s.description}</div></div>
            <div class="field"><div class="label">Token</div><div class="value">\${s.token_mentioned || "N/A"}</div></div>
            <div class="field"><div class="label">Price</div><div class="value">$\${s.price} USDC</div></div>
            <div class="field"><div class="label">Content Hash (SHA-256)</div><div class="hash">\${s.content_hash}</div></div>
            <div class="field"><div class="label">AI Verdict</div><div class="value">\${s.ai_verdict || "Pending"}</div></div>
            <div class="field"><div class="label">Listed</div><div class="value">\${s.listed_at || "N/A"}</div></div>
            <div style="text-align:center;margin-top:16px;font-size:13px;color:#888">Want to buy? Use <code>/buy \${SECRET_ID}</code> in Telegram</div>
          \`;
          metaDiv.classList.add("show");
        } else throw new Error(data.error || "Failed to fetch metadata");
      } catch (err) {
        console.error("Peek error:", err);
        btn.disabled = false;
        btn.textContent = "Pay $0.50 USDC to Peek";
        status.className = "status error";
        status.textContent = "Error: " + (err.message || "User rejected");
      }
    }
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

/**
 * GET /pay/:id
 * x402 Payment Page – buyer opens from Telegram.
 * Flow: fetch buy endpoint → 402 → pay USDC via wallet → confirm purchase.
 */
app.get("/pay/:id", async (req, res) => {
  try {
    console.log(`[x402-Buy] ➤ GET /pay/${req.params.id} (payment page)`);

    const secret = await Secret.findById(req.params.id)
      .select("description category token_mentioned price status content_hash");

    if (!secret) { console.log(`[x402-Buy]   ✗ Secret not found`); return res.status(404).send("Secret not found"); }
    if (secret.status !== "listed") { console.log(`[x402-Buy]   ✗ Secret status: ${secret.status}`); return res.status(410).send("Secret already sold"); }
    console.log(`[x402-Buy]   ✓ Serving buy payment page for "${secret.description}" ($${secret.price} USDC)`);

    const chatId = req.query.chat || "";
    const serverWallet = process.env.SERVER_WALLET || process.env.BITGO_TREASURY_ADDRESS || "";

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayPerSecret – x402 Payment</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1a1a2e; border: 1px solid #333; border-radius: 16px; padding: 32px; max-width: 420px; width: 90%; }
    .logo { font-size: 24px; font-weight: 700; color: #00d4ff; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .field { margin-bottom: 16px; }
    .label { color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .value { font-size: 16px; color: #fff; }
    .hash { font-family: monospace; font-size: 12px; color: #666; word-break: break-all; }
    .price-box { background: #0d2137; border: 1px solid #00d4ff33; border-radius: 12px; padding: 16px; text-align: center; margin: 24px 0; }
    .price { font-size: 28px; font-weight: 700; color: #00d4ff; }
    .price-label { color: #888; font-size: 12px; }
    .pay-btn { width: 100%; padding: 16px; background: #00d4ff; color: #000; font-size: 16px; font-weight: 700; border: none; border-radius: 12px; cursor: pointer; transition: all 0.2s; }
    .pay-btn:hover { background: #00b8e6; transform: translateY(-1px); }
    .pay-btn:disabled { background: #333; color: #666; cursor: not-allowed; transform: none; }
    .status { text-align: center; margin-top: 16px; font-size: 14px; color: #888; }
    .success { color: #00ff88; }
    .error { color: #ff4444; }
    .x402-badge { display: inline-block; background: #1a3a2e; border: 1px solid #00ff8833; padding: 4px 12px; border-radius: 20px; font-size: 11px; color: #00ff88; margin-bottom: 16px; }
    .powered { text-align: center; margin-top: 24px; font-size: 11px; color: #444; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">PayPerSecret</div>
    <div class="subtitle">Anonymous Information Marketplace</div>
    <div class="x402-badge">x402 Payment Protocol</div>

    <div class="field">
      <div class="label">Category</div>
      <div class="value">${secret.category || "General"}</div>
    </div>
    <div class="field">
      <div class="label">Description</div>
      <div class="value">${secret.description}</div>
    </div>
    <div class="field">
      <div class="label">Token</div>
      <div class="value">${secret.token_mentioned || "N/A"}</div>
    </div>
    <div class="field">
      <div class="label">Content Hash (SHA-256)</div>
      <div class="hash">${secret.content_hash}</div>
    </div>

    <div class="price-box">
      <div class="price-label">x402 PAYMENT REQUIRED</div>
      <div class="price">$${secret.price} USDC</div>
      <div class="price-label">Base Sepolia (EIP-155:84532)</div>
    </div>

    <button class="pay-btn" id="payBtn" onclick="handlePay()">
      Pay $${secret.price} USDC via x402
    </button>
    <div class="status" id="status"></div>

    <div class="powered">x402 Protocol + Fileverse IPFS + BitGo MPC Escrow</div>
  </div>

  <script>
    const SECRET_ID = "${secret._id}";
    const CHAT_ID = "${chatId}";
    const BUY_URL = "/api/secrets/${secret._id}/buy-direct";
    const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const PAY_TO = "${serverWallet}";
    const PRICE_USD = ${secret.price};
    const USDC_RAW = Math.round(PRICE_USD * 1e6);
    const USDC_HEX = "0x" + USDC_RAW.toString(16);
    const SELECTOR = "0xa9059cbb";

    function encodeTransfer(to, amt) {
      return SELECTOR + to.toLowerCase().replace("0x","").padStart(64,"0") + amt.replace("0x","").padStart(64,"0");
    }

    window.addEventListener("load", () => {
      const s = document.getElementById("status");
      if (window.ethereum) {
        s.textContent = "Wallet detected. Click to pay via x402.";
        s.className = "status success";
      } else {
        s.textContent = "No wallet detected. Install MetaMask or open in a dApp browser.";
      }
    });

    async function handlePay() {
      const btn = document.getElementById("payBtn");
      const status = document.getElementById("status");
      if (!window.ethereum) { status.className = "status error"; status.textContent = "No wallet found."; return; }

      try {
        btn.disabled = true;

        // Step 1: Request x402 payment requirements
        console.log("[x402-Buy] Step 1: Fetching buy endpoint to get 402...");
        btn.textContent = "Requesting x402 payment...";
        const reqRes = await fetch(BUY_URL, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({}) });
        console.log("[x402-Buy] Step 1 response status:", reqRes.status);

        if (reqRes.status !== 402) throw new Error("Unexpected response: " + reqRes.status);
        const payReq = await reqRes.json();
        console.log("[x402-Buy] Step 1 x402 requirements:", JSON.stringify(payReq, null, 2));
        status.textContent = "x402: Payment of $" + payReq.accepts[0].maxAmountRequired + " USDC required";

        // Step 2: Connect wallet
        console.log("[x402-Buy] Step 2: Connecting wallet...");
        btn.textContent = "Connecting wallet...";
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        const buyer = accounts[0];
        console.log("[x402-Buy] Step 2 wallet connected:", buyer);
        status.textContent = "Connected: " + buyer.slice(0,6) + "..." + buyer.slice(-4);

        // Step 3: Switch to Base Sepolia
        console.log("[x402-Buy] Step 3: Switching to Base Sepolia (chainId 0x14A34)...");
        btn.textContent = "Switching to Base Sepolia...";
        try {
          await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14A34" }] });
          console.log("[x402-Buy] Step 3 chain switched OK");
        } catch (e) {
          console.log("[x402-Buy] Step 3 chain switch error:", e.code, e.message);
          if (e.code === 4902) {
            console.log("[x402-Buy] Step 3 adding Base Sepolia chain...");
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
              chainId: "0x14A34", chainName: "Base Sepolia",
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"],
            }]});
          } else throw e;
        }

        // Step 4: Send USDC payment (x402 payment execution)
        console.log("[x402-Buy] Step 4: Sending USDC transfer...");
        console.log("[x402-Buy]   From:", buyer);
        console.log("[x402-Buy]   To contract:", USDC_CONTRACT);
        console.log("[x402-Buy]   Pay to:", PAY_TO);
        console.log("[x402-Buy]   Amount: $" + PRICE_USD + " USDC (raw:", USDC_RAW, "hex:", USDC_HEX, ")");
        btn.textContent = "Approve USDC transfer...";
        status.textContent = "x402: Sending $" + PRICE_USD + " USDC to " + PAY_TO.slice(0,8) + "...";
        const txHash = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{ from: buyer, to: USDC_CONTRACT, data: encodeTransfer(PAY_TO, USDC_HEX), value: "0x0" }],
        });
        console.log("[x402-Buy] Step 4 TX hash:", txHash);

        // Step 5: Confirm purchase with x402 payment proof
        console.log("[x402-Buy] Step 5: Confirming purchase with X-Payment header...");
        btn.textContent = "Confirming with x402...";
        status.textContent = "TX: " + txHash.slice(0,10) + "...";
        const buyRes = await fetch(BUY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Payment": txHash },
          body: JSON.stringify({ buyer_telegram_id: CHAT_ID, buyer_address: buyer, tx_hash: txHash }),
        });
        const data = await buyRes.json();

        console.log("[x402-Buy] Step 5 response status:", buyRes.status);
        console.log("[x402-Buy] Step 5 response data:", JSON.stringify(data, null, 2));

        if (buyRes.ok) {
          console.log("[x402-Buy] SUCCESS! Purchase confirmed via x402");
          btn.textContent = "Purchased via x402!";
          btn.style.background = "#00ff88"; btn.style.color = "#000";
          status.className = "status success";
          status.innerHTML = "x402 payment confirmed!<br>TX: <a href='https://sepolia.basescan.org/tx/" + txHash + "' target='_blank' style='color:#00d4ff'>" + txHash.slice(0,10) + "...</a><br>Go to Telegram: <code>/decrypt " + SECRET_ID + "</code>";
        } else throw new Error(data.error || "Purchase failed");
      } catch (err) {
        console.error("[x402-Buy] ERROR:", err);
        btn.disabled = false;
        btn.textContent = "Pay $" + PRICE_USD + " USDC via x402";
        status.className = "status error";
        status.textContent = "Error: " + (err.message || "User rejected");
      }
    }
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

/**
 * POST /api/secrets/:id/buy-direct
 * x402 Buy Endpoint:
 *   - No X-Payment header → returns 402 with payment requirements
 *   - With X-Payment header (tx_hash) → processes purchase
 */
app.post("/api/secrets/:id/buy-direct", async (req, res) => {
  try {
    console.log(`[x402-Buy] ➤ POST /api/secrets/${req.params.id}/buy-direct`);
    console.log(`[x402-Buy]   X-Payment header: ${req.headers["x-payment"] || "NONE (will 402)"}`);

    const secret = await Secret.findById(req.params.id);
    if (!secret) { console.log(`[x402-Buy]   ✗ Secret not found`); return res.status(404).json({ error: "Secret not found" }); }
    if (secret.status !== "listed") {
      console.log(`[x402-Buy]   ✗ Secret status: ${secret.status}`);
      return res.status(410).json({ error: "Secret already sold" });
    }

    const paymentProof = req.headers["x-payment"];

    // No payment → return 402 with x402 payment requirements
    if (!paymentProof) {
      console.log(`[x402-Buy]   → Returning 402 (price: $${secret.price} USDC)`);
      return res.status(402).json({
        x402Version: 1,
        accepts: [{
          scheme: "exact",
          network: "eip155:84532",
          maxAmountRequired: String(secret.price),
          resource: req.originalUrl,
          description: `Purchase secret: ${secret.description}`,
          payTo: process.env.SERVER_WALLET || process.env.BITGO_TREASURY_ADDRESS,
          maxTimeoutSeconds: 120,
          asset: "USDC",
        }],
      });
    }

    // Payment proof present → process purchase
    console.log(`[x402-Buy]   → Payment proof received: ${paymentProof.slice(0, 20)}...`);
    const { buyer_telegram_id, buyer_address, tx_hash } = req.body;
    console.log(`[x402-Buy]   Buyer Telegram: ${buyer_telegram_id || "web"}`);
    console.log(`[x402-Buy]   Buyer Address: ${buyer_address || "N/A"}`);
    console.log(`[x402-Buy]   TX Hash: ${tx_hash || paymentProof}`);

    await Secret.findByIdAndUpdate(secret._id, {
      status: "purchased",
      buyer_telegram_id: buyer_telegram_id || "web",
      buyer_address: buyer_address || null,
      escrow_tx_hash: tx_hash || paymentProof,
    });

    console.log(`[x402] Secret purchased: ${secret._id} | TX: ${tx_hash || paymentProof}`);

    // Notify buyer via Telegram
    if (buyer_telegram_id) {
      telegram.sendNotification(
        buyer_telegram_id,
        `*x402 Payment Received!*\n\nSecret \`${secret._id}\` purchased.\nStored on Fileverse (IPFS + Gnosis).\nAI verification in progress...\nUse /decrypt ${secret._id} when ready.`
      );
    }

    // Trigger AI verification in background
    verifyAndRelease(secret._id).catch(err => {
      console.error(`[API] Background verification failed for ${secret._id}:`, err.message);
    });

    res.json({
      status: "purchased",
      message: "x402 payment confirmed. AI verification in progress.",
      secret_id: secret._id,
    });
  } catch (err) {
    console.error("[API] buy-direct error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secrets/:id/decrypt
 * Get the secret content after purchase + verification.
 * Returns the Fileverse link (decentralized access) + content hash for verification.
 */
app.get("/api/secrets/:id/decrypt", async (req, res) => {
  try {
    const secret = await Secret.findById(req.params.id);
    if (!secret) return res.status(404).json({ error: "Secret not found" });

    if (!["verified", "released"].includes(secret.status)) {
      return res.status(403).json({
        error: "Secret not yet verified",
        status: secret.status,
        ai_verdict: secret.ai_verdict,
      });
    }

    res.json({
      secret_content: secret.secret_content,
      content_hash: secret.content_hash,
      fileverse_link: secret.fileverse_link || null,
      fileverse_ddoc_id: secret.fileverse_ddoc_id || null,
      ai_verdict: secret.ai_verdict,
      message: "Verify: SHA-256 of secret_content should match content_hash",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/secrets/:id/verify
 * Manually trigger AI verification.
 */
app.post("/api/secrets/:id/verify", async (req, res) => {
  try {
    const result = await verifyAndRelease(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secrets/:id/status
 */
app.get("/api/secrets/:id/status", async (req, res) => {
  try {
    const secret = await Secret.findById(req.params.id)
      .select("status ai_verdict ai_score price category description escrow_tx_hash");

    if (!secret) return res.status(404).json({ error: "Secret not found" });
    res.json({ secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// VERIFICATION + ESCROW RELEASE
// ─────────────────────────────────────────────────────────

async function verifyAndRelease(secretId) {
  const secret = await Secret.findById(secretId);
  if (!secret) throw new Error(`Secret ${secretId} not found`);

  console.log(`[Verify] Starting AI verification for secret ${secretId}`);

  const result = await elsaVerifier.verifySecret(secret, secret.secret_content);

  await Secret.findByIdAndUpdate(secretId, {
    ai_verdict: result.verdict,
    ai_score: result.score,
    ai_evidence: result.evidence,
  });

  if (result.verdict === "LEGIT" || result.verdict === "PARTIALLY_VERIFIED" || result.verdict === "UNVERIFIABLE") {
    await Secret.findByIdAndUpdate(secretId, { status: "verified" });

    try {
      const release = await escrow.releaseToSeller(secretId);

      if (secret.seller_telegram_id && secret.seller_telegram_id !== "api") {
        await telegram.sendNotification(
          secret.seller_telegram_id,
          `*Secret Sold!*\n\nYour secret has been purchased and verified.\nPayment of $${secret.price} USDC released.\nTX: ${release.txHash}`
        );
      }

      if (secret.buyer_telegram_id) {
        const fvMsg = secret.fileverse_link ? `\nFileverse: [View on ddocs.new](${secret.fileverse_link})` : "";
        await telegram.sendNotification(
          secret.buyer_telegram_id,
          `*Secret Verified!*\n\nAI verdict: ${result.verdict} (score: ${result.score}/${result.maxScore})\nUse /decrypt ${secretId} to get the secret.${fvMsg}`
        );
      }

      return { verdict: result.verdict, released: true, txHash: release.txHash };
    } catch (err) {
      console.error(`[Verify] Escrow release failed: ${err.message}`);
      return { verdict: result.verdict, released: false, error: err.message };
    }
  } else {
    console.log(`[Verify] Secret ${secretId} failed verification: ${result.verdict}`);

    if (secret.buyer_telegram_id) {
      await telegram.sendNotification(
        secret.buyer_telegram_id,
        `*Verification Failed*\n\nAI verdict: ${result.verdict} (score: ${result.score}/${result.maxScore})\nYour payment will be refunded.`
      );
    }

    return { verdict: result.verdict, released: false, refundPending: true };
  }
}

// ─────────────────────────────────────────────────────────
// UTILITY ENDPOINTS
// ─────────────────────────────────────────────────────────

app.post("/register-user", async (req, res) => {
  try {
    let { wallet_address, ens_name, telegram_chat_id, label } = req.body;
    if (!wallet_address && ens_name) wallet_address = await ens.resolveENS(ens_name);
    else if (wallet_address && !ens_name) ens_name = await ens.reverseResolve(wallet_address);
    if (!wallet_address) return res.status(400).json({ error: "wallet_address or ens_name required" });
    const user = await User.create({ wallet_address, ens_name, telegram_chat_id, label });
    res.status(201).json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/wallet/balance", async (_req, res) => {
  try {
    const balance = await escrow.getEscrowBalance();
    res.json({ balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────
async function start() {
  // 1. Init Fileverse (must be first — it's our database)
  await fileverse.initFileverse();

  // 2. Load secrets from Fileverse into memory
  await initDB();

  // 3. Init other services
  bitgo.initBitGo();
  ens.initENS();
  telegram.initTelegram();

  app.listen(PORT, () => {
    console.log(`\n[PayPerSecret] Server running on http://localhost:${PORT}`);
    console.log("[PayPerSecret] Storage: Fileverse (IPFS + Gnosis chain) — NO MongoDB");
    console.log("[PayPerSecret] Payments: x402 Protocol (Base Sepolia USDC)");
    console.log("[PayPerSecret] Endpoints:");
    console.log("  POST /api/secrets            – list a secret");
    console.log("  GET  /api/secrets            – browse all (free)");
    console.log("  GET  /api/secrets/:id/peek   – peek (x402: $0.50)");
    console.log("  GET  /pay/:id                – x402 payment page");
    console.log("  POST /api/secrets/:id/buy-direct – buy (x402: dynamic)");
    console.log("  GET  /api/secrets/:id/decrypt – get secret after verification");
    console.log("  POST /api/secrets/:id/verify  – trigger AI verification\n");
  });
}

start().catch((err) => {
  console.error("[PayPerSecret] Failed to start:", err);
  process.exit(1);
});

module.exports = app;
