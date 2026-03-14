/**
 * Fileverse Service – Decentralized Encrypted Document Storage
 *
 * Stores secrets as encrypted markdown documents on IPFS + Gnosis chain
 * via the Fileverse local API server (@fileverse/api).
 *
 * Flow:
 *   1. Seller lists secret → content encrypted + stored as Fileverse ddoc
 *   2. Fileverse encrypts client-side & uploads to IPFS, registers on Gnosis chain
 *   3. After purchase + verification → buyer gets ddocs.new link
 *   4. Link contains encryption key in URL fragment (#key) — only link holder can decrypt
 *
 * Setup:
 *   1. Log in to ddocs.new → Settings → Developer Mode → Generate API Key
 *   2. Set FILEVERSE_API_KEY in .env
 *   3. Start server: npx @fileverse/api --apiKey <key> --rpcUrl https://rpc.ankr.com/gnosis
 *   4. Server runs on http://localhost:8001 by default
 *
 * All /api/* endpoints require ?apiKey=<key> query parameter.
 */

const axios = require("axios");

const FILEVERSE_URL = process.env.FILEVERSE_API_URL || "http://localhost:8001";
const API_KEY = process.env.FILEVERSE_API_KEY;

let enabled = false;

/**
 * Check if Fileverse is available and configured.
 * Tries listing ddocs to verify the server is reachable and API key works.
 */
async function initFileverse() {
  if (!API_KEY) {
    console.warn("[Fileverse] FILEVERSE_API_KEY not set – Fileverse disabled");
    return;
  }

  try {
    // Use GET /api/ddocs to verify server is up and API key is valid
    const res = await axios.get(`${FILEVERSE_URL}/api/ddocs?apiKey=${API_KEY}`, { timeout: 5000 });
    if (res.status === 200) {
      enabled = true;
      console.log("[Fileverse] Connected to local API server");
      console.log(`[Fileverse]   URL: ${FILEVERSE_URL}`);
      console.log(`[Fileverse]   Existing documents: ${res.data.total ?? "?"}`);
    }
  } catch (err) {
    console.warn(`[Fileverse] Server not reachable at ${FILEVERSE_URL} (${err.message})`);
    console.warn("[Fileverse] Start it with: npx @fileverse/api --apiKey <YOUR_KEY> --rpcUrl https://rpc.ankr.com/gnosis");
    console.warn("[Fileverse] Secrets will be stored in MongoDB only");
  }
}

function isEnabled() {
  return enabled;
}

/**
 * Store a secret as an encrypted Fileverse document (ddoc).
 *
 * @param {string} title – Document title (description)
 * @param {string} content – The secret content (plaintext — Fileverse encrypts it client-side)
 * @param {Object} metadata – Extra metadata (category, price, etc.)
 * @returns {{ ddocId: string, link: string|null, syncStatus: string }} or null if unavailable
 */
async function storeSecret(title, content, metadata = {}) {
  if (!enabled) return null;

  try {
    // Store pure JSON — no markdown wrapper (cleaner parsing on reload)
    const res = await axios.post(
      `${FILEVERSE_URL}/api/ddocs?apiKey=${API_KEY}`,
      { title, content },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );

    const data = res.data.data || res.data;
    const ddocId = data.ddocId || data._id;
    const link = data.link || null;  // empty string "" when not yet synced
    const syncStatus = data.syncStatus || "pending";

    console.log(`[Fileverse] Document created: ${ddocId} (sync: ${syncStatus})`);

    return { ddocId, link, syncStatus };
  } catch (err) {
    console.error(`[Fileverse] Failed to store document: ${err.message}`);
    if (err.response) {
      console.error(`[Fileverse]   Status: ${err.response.status}`);
      console.error(`[Fileverse]   Body: ${JSON.stringify(err.response.data)}`);
    }
    return null;
  }
}

/**
 * Get a document by ID.
 *
 * @param {string} ddocId – Fileverse document ID
 * @returns {Object|null} Document data including link, syncStatus, title, content
 */
async function getDocument(ddocId) {
  if (!enabled) return null;

  try {
    const res = await axios.get(
      `${FILEVERSE_URL}/api/ddocs/${ddocId}?apiKey=${API_KEY}`,
      { timeout: 10000 }
    );
    return res.data;  // GET /api/ddocs/:id returns flat object (no data wrapper)
  } catch (err) {
    console.error(`[Fileverse] Failed to get document ${ddocId}: ${err.message}`);
    return null;
  }
}

/**
 * List all documents.
 *
 * @returns {Array|null} Array of document objects
 */
async function listDocuments() {
  if (!enabled) return null;

  try {
    const res = await axios.get(
      `${FILEVERSE_URL}/api/ddocs?apiKey=${API_KEY}`,
      { timeout: 10000 }
    );
    return res.data.ddocs || [];  // GET /api/ddocs returns { ddocs: [...], total, hasNext }
  } catch (err) {
    console.error(`[Fileverse] Failed to list documents: ${err.message}`);
    return null;
  }
}

/**
 * Delete a document by ID.
 *
 * @param {string} ddocId – Fileverse document ID
 * @returns {boolean} true if deleted successfully
 */
async function deleteDocument(ddocId) {
  if (!enabled) return false;

  try {
    await axios.delete(
      `${FILEVERSE_URL}/api/ddocs/${ddocId}?apiKey=${API_KEY}`,
      { timeout: 10000 }
    );
    console.log(`[Fileverse] Document deleted: ${ddocId}`);
    return true;
  } catch (err) {
    console.error(`[Fileverse] Failed to delete document ${ddocId}: ${err.message}`);
    return false;
  }
}

/**
 * Update a document's content on Fileverse.
 *
 * @param {string} ddocId – Fileverse document ID
 * @param {Object} updates – { title?, content? }
 * @returns {Object|null} Updated document data
 */
async function updateDocument(ddocId, updates) {
  if (!enabled) return null;

  try {
    const res = await axios.put(
      `${FILEVERSE_URL}/api/ddocs/${ddocId}?apiKey=${API_KEY}`,
      updates,
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    return res.data.data || res.data;
  } catch (err) {
    console.error(`[Fileverse] Failed to update document ${ddocId}: ${err.message}`);
    return null;
  }
}

/**
 * Wait for a document to sync to IPFS/chain and return the shareable link.
 * Polls every 3 seconds, up to maxAttempts.
 *
 * @param {string} ddocId
 * @param {number} maxAttempts – default 10 (~30 seconds)
 * @returns {string|null} The ddocs.new link with encryption key in URL fragment
 */
async function waitForLink(ddocId, maxAttempts = 10) {
  if (!enabled) return null;

  for (let i = 0; i < maxAttempts; i++) {
    const doc = await getDocument(ddocId);
    if (doc && doc.link) {
      console.log(`[Fileverse] Document synced: ${doc.link}`);
      return doc.link;
    }
    if (doc && (doc.syncStatus === "failed" || doc.status === "failed")) {
      console.error(`[Fileverse] Sync failed for ${ddocId}`);
      return null;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.warn(`[Fileverse] Timeout waiting for sync: ${ddocId}`);
  return null;
}

module.exports = {
  initFileverse,
  isEnabled,
  storeSecret,
  getDocument,
  listDocuments,
  updateDocument,
  deleteDocument,
  waitForLink,
};
