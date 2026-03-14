/**
 * Elsa Verifier – AI-powered secret verification using HeyElsa x402 APIs
 *
 * Calls Elsa's DeFi tools to check if a secret's on-chain claims are real.
 * Each API call is paid via x402 micropayments (~$0.002-$0.005 per call).
 *
 * Example: Secret says "Whale 0x7FaB is dumping 2M TOKEN_X"
 *   → elsa_analyze_wallet("0x7FaB")  → checks holdings
 *   → elsa_get_token_price("TOKEN_X") → checks if token is real
 *   → Returns verdict: LEGIT / PARTIALLY_VERIFIED / UNVERIFIABLE / FAKE
 */

const axios = require("axios");

const ELSA_BASE_URL = process.env.ELSA_X402_SERVER_URL || "https://x402-api.heyelsa.ai";

/**
 * Create an x402-enabled Axios client for Elsa API calls.
 * Falls back to regular axios if @x402/axios isn't configured.
 */
function getElsaClient() {
  try {
    const { wrapAxios } = require("@x402/axios");
    const client = wrapAxios(axios.create({ baseURL: ELSA_BASE_URL }), {
      privateKey: process.env.ELSA_PAYMENT_PRIVATE_KEY,
      network: "eip155:84532", // Base Sepolia
    });
    return client;
  } catch {
    console.warn("[Elsa] @x402/axios not configured, using regular axios (calls may fail with 402)");
    return axios.create({ baseURL: ELSA_BASE_URL });
  }
}

/**
 * Analyze a wallet's holdings via Elsa API.
 * Cost: ~$0.005 per call
 */
async function analyzeWallet(walletAddress) {
  try {
    const client = getElsaClient();
    const res = await client.get("/api/v1/wallet/analyze", {
      params: { address: walletAddress },
    });
    return res.data;
  } catch (err) {
    console.error(`[Elsa] analyzeWallet failed for ${walletAddress}:`, err.message);
    return null;
  }
}

/**
 * Get token price and info via Elsa API.
 * Cost: ~$0.002 per call
 */
async function getTokenPrice(tokenSymbol, chain = "base") {
  try {
    const client = getElsaClient();
    const res = await client.get("/api/v1/token/price", {
      params: { symbol: tokenSymbol, chain },
    });
    return res.data;
  } catch (err) {
    console.error(`[Elsa] getTokenPrice failed for ${tokenSymbol}:`, err.message);
    return null;
  }
}

/**
 * Search for token info via Elsa API.
 * Cost: ~$0.002 per call
 */
async function searchToken(query) {
  try {
    const client = getElsaClient();
    const res = await client.get("/api/v1/token/search", {
      params: { query },
    });
    return res.data;
  } catch (err) {
    console.error(`[Elsa] searchToken failed for ${query}:`, err.message);
    return null;
  }
}

/**
 * Extract verifiable claims from a secret's description.
 * Looks for wallet addresses (0x...) and token symbols.
 */
function extractClaims(description) {
  const claims = {
    walletAddresses: [],
    tokenSymbols: [],
  };

  // Extract Ethereum addresses
  const addressRegex = /0x[a-fA-F0-9]{40}/g;
  const addresses = description.match(addressRegex);
  if (addresses) claims.walletAddresses = [...new Set(addresses)];

  // Extract token symbols (uppercase words 2-10 chars, likely tokens)
  const tokenRegex = /\b[A-Z]{2,10}\b/g;
  const tokens = description.match(tokenRegex);
  if (tokens) {
    // Filter out common English words
    const skipWords = new Set(["THE", "AND", "FOR", "NOT", "ARE", "BUT", "HAS", "WAS", "ALL", "CAN", "HER", "WAS", "ONE", "OUR", "OUT"]);
    claims.tokenSymbols = [...new Set(tokens.filter(t => !skipWords.has(t)))];
  }

  return claims;
}

/**
 * Verify a secret's on-chain claims using Elsa APIs.
 *
 * @param {Object} secret – Secret document from MongoDB
 * @param {string} decryptedContent – the actual secret text (after buyer decrypts)
 * @returns {{ verdict: string, score: number, evidence: Object }}
 */
async function verifySecret(secret, decryptedContent) {
  const textToAnalyze = decryptedContent || secret.description;
  const claims = extractClaims(textToAnalyze);
  const evidence = { wallets: [], tokens: [], claims };
  let score = 0;
  let maxScore = 0;

  // Verify wallet addresses
  for (const address of claims.walletAddresses) {
    const walletData = await analyzeWallet(address);
    evidence.wallets.push({ address, data: walletData });

    if (walletData) {
      maxScore += 2;
      score += 1; // Wallet exists and has activity

      // Check if wallet holds the mentioned token
      if (claims.tokenSymbols.length > 0 && walletData.holdings) {
        const holdsToken = walletData.holdings.some(h =>
          claims.tokenSymbols.some(sym =>
            h.token?.toUpperCase().includes(sym) || h.symbol?.toUpperCase().includes(sym)
          )
        );
        if (holdsToken) score += 1;
      }
    } else {
      // API call failed — don't penalize, just note it
      console.log(`[Elsa] Wallet analysis unavailable for ${address} — skipping`);
    }
  }

  // Verify token mentions
  for (const symbol of claims.tokenSymbols) {
    const tokenData = await getTokenPrice(symbol);
    evidence.tokens.push({ symbol, data: tokenData });

    if (tokenData && tokenData.price > 0) {
      maxScore += 1;
      score += 1; // Token is real with actual value
    } else if (tokenData === null) {
      // API call failed — don't count as evidence either way
      console.log(`[Elsa] Token price unavailable for ${symbol} — skipping`);
    } else {
      // API returned data but price is 0 or missing — token may not exist
      maxScore += 1;
    }
  }

  // If no verifiable claims found, try token search on description keywords
  if (maxScore === 0 && secret.token_mentioned) {
    const tokenData = await searchToken(secret.token_mentioned);
    evidence.tokens.push({ symbol: secret.token_mentioned, data: tokenData });
    if (tokenData) {
      maxScore = 1;
      score += 1;
    }
    // If search also failed, maxScore stays 0 → UNVERIFIABLE
  }

  // Calculate verdict
  let verdict;
  if (maxScore === 0) {
    verdict = "UNVERIFIABLE";
  } else {
    const ratio = score / maxScore;
    if (ratio >= 0.75) verdict = "LEGIT";
    else if (ratio >= 0.4) verdict = "PARTIALLY_VERIFIED";
    else verdict = "FAKE";
  }

  console.log(`[Elsa] Verification complete: ${verdict} (score: ${score}/${maxScore})`);

  return { verdict, score, maxScore, evidence };
}

module.exports = {
  verifySecret,
  analyzeWallet,
  getTokenPrice,
  searchToken,
  extractClaims,
};
