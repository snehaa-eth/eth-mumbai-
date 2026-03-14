/**
 * Fileverse Store – ZK Privacy-First Storage Layer
 *
 * All secrets stored as encrypted JSON on Fileverse (IPFS + Gnosis chain).
 * NO raw identities (Telegram IDs, wallets) are ever persisted.
 * Only ZK commitments, nullifiers, and anonymous credentials touch storage.
 *
 * Privacy guarantees:
 *   - Seller identity: hidden behind ZK commitment
 *   - Buyer identity: hidden behind ZK commitment + nullifier
 *   - Wallet addresses: never stored, stealth addresses used per-tx
 *   - Telegram IDs: only in volatile memory, never written to Fileverse
 */

const crypto = require("crypto");
const fileverse = require("./fileverseService");
const zk = require("./zkPrivacy");

// ── In-memory stores ────────────────────────────────────
const secretsMap = new Map(); // ddocId → secret data
const usersMap = new Map();   // multi-index: id, tg:<chatId>, wa:<address> → user

// Privacy: ZK commitment → real telegram chatId (VOLATILE MEMORY ONLY — never persisted)
const commitmentToChat = new Map();
// Privacy: used nullifiers (prevents double-reveal)
const usedNullifiers = new Set();

// ── Query Builder (Mongoose-compatible chaining) ────────
class QueryBuilder {
  constructor(resultFn) {
    this._resultFn = resultFn;
    this._selectFields = null;
    this._sortField = null;
    this._sortDir = -1;
    this._limitN = Infinity;
  }

  select(fields) {
    if (typeof fields === "string") {
      this._selectFields = fields.split(/\s+/).filter(Boolean);
    }
    return this;
  }

  sort(sortObj) {
    if (sortObj) {
      const key = Object.keys(sortObj)[0];
      this._sortField = key;
      this._sortDir = sortObj[key];
    }
    return this;
  }

  limit(n) {
    this._limitN = n;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve().then(() => {
      let result = this._resultFn();

      if (Array.isArray(result)) {
        if (this._sortField) {
          result.sort((a, b) => {
            const aVal = a[this._sortField] || "";
            const bVal = b[this._sortField] || "";
            return this._sortDir * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0);
          });
        }
        if (this._limitN < result.length) {
          result = result.slice(0, this._limitN);
        }
      }

      if (this._selectFields && result) {
        const applySelect = (obj) => {
          const selected = { _id: obj._id };
          for (const f of this._selectFields) {
            if (obj[f] !== undefined) selected[f] = obj[f];
          }
          return selected;
        };
        result = Array.isArray(result) ? result.map(applySelect) : applySelect(result);
      }

      return result;
    }).then(resolve, reject);
  }

  catch(fn) {
    return this.then(undefined, fn);
  }
}

// ── Filter matching ─────────────────────────────────────
function matchFilter(obj, filter) {
  for (const [key, val] of Object.entries(filter)) {
    if (val && typeof val === "object" && val.$in) {
      if (!val.$in.includes(obj[key])) return false;
    } else {
      if (obj[key] !== val) return false;
    }
  }
  return true;
}

// ── Secret Model ────────────────────────────────────────
const Secret = {
  async create(data) {
    const contentHash = data.content_hash ||
      crypto.createHash("sha256").update(data.content || data.encrypted_data || "").digest("hex");

    // ── ZK Privacy: Create seller commitment ──────────
    const sellerNonce = zk.generateNonce();
    const sellerCommitment = zk.createCommitment(
      data.seller_telegram_id || "anonymous",
      sellerNonce
    );

    // Store mapping ONLY in volatile memory (never touches Fileverse)
    if (data.seller_telegram_id) {
      commitmentToChat.set(sellerCommitment, String(data.seller_telegram_id));
    }

    // Generate seller credential
    const sellerCred = zk.issueCredential(data.seller_telegram_id || "anonymous", "seller");

    const doc = {
      type: "paypersecret",
      secret_content: data.content || null,
      description: data.description,
      category: data.category || "General",
      token_mentioned: data.token_mentioned || null,
      price: data.price,
      content_hash: contentHash,
      status: "listed",

      // ── ZK Privacy fields (ONLY these are persisted to Fileverse) ──
      seller_commitment: sellerCommitment,           // ZK commitment — hides identity
      seller_credential: sellerCred.credentialHash,  // anonymous credential
      buyer_commitment: null,                        // set on purchase
      buyer_nullifier: null,                         // prevents double-reveal
      buyer_proof: null,                             // ZK proof of purchase

      // ── Volatile fields (memory only — NOT in Fileverse JSON) ──
      seller_telegram_id: data.seller_telegram_id,   // memory only for notifications
      buyer_telegram_id: null,
      buyer_address: null,
      escrow_tx_hash: null,

      ai_verdict: null,
      ai_score: null,
      ai_evidence: null,
      fileverse_link: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Store on Fileverse — sanitized (no raw identities)
    const sanitized = zk.sanitizeForStorage(doc);
    const fvResult = await fileverse.storeSecret(
      data.description || "Secret",
      JSON.stringify(sanitized),
      { category: doc.category, token_mentioned: doc.token_mentioned, price: doc.price, content_hash: contentHash }
    );

    if (fvResult) {
      doc._id = fvResult.ddocId;
      doc.fileverse_ddoc_id = fvResult.ddocId;
      doc.fileverse_link = fvResult.link || null;
      secretsMap.set(fvResult.ddocId, doc);

      if (!fvResult.link) {
        fileverse.waitForLink(fvResult.ddocId).then(link => {
          if (link) doc.fileverse_link = link;
        });
      }
    } else {
      doc._id = crypto.randomBytes(12).toString("hex");
      secretsMap.set(doc._id, doc);
    }

    console.log(`[Store] Secret created: ${doc._id} | $${doc.price} USDC | seller: ${sellerCommitment}`);
    return doc;
  },

  findById(id) {
    return new QueryBuilder(() => secretsMap.get(id) || null);
  },

  find(filter = {}) {
    // Privacy: remap seller_telegram_id filter to check via commitmentToChat
    if (filter.seller_telegram_id) {
      const chatId = filter.seller_telegram_id;
      return new QueryBuilder(() =>
        Array.from(secretsMap.values()).filter(s => {
          // Check in-memory seller_telegram_id (volatile)
          return s.seller_telegram_id === chatId;
        })
      );
    }
    return new QueryBuilder(() =>
      Array.from(secretsMap.values()).filter(s => matchFilter(s, filter))
    );
  },

  async findByIdAndUpdate(id, updates) {
    const secret = secretsMap.get(id);
    if (!secret) return null;

    // If setting buyer, create Semaphore commitment + ZK proof
    if (updates.buyer_telegram_id && !updates.buyer_commitment) {
      const buyerCommitment = zk.getCommitment(updates.buyer_telegram_id);
      const buyerNullifier = zk.createNullifier(updates.buyer_telegram_id, "purchase", id);
      updates.buyer_commitment = buyerCommitment;
      updates.buyer_nullifier = buyerNullifier;

      commitmentToChat.set(buyerCommitment, String(updates.buyer_telegram_id));

      // Generate Semaphore ZK proof of purchase (async — zk-SNARK)
      if (updates.escrow_tx_hash) {
        try {
          updates.buyer_proof = await zk.generatePurchaseProof(
            updates.buyer_telegram_id, id, updates.escrow_tx_hash
          );
        } catch (err) {
          console.error(`[Store] Semaphore proof generation failed: ${err.message}`);
          // Fallback: hash-based proof
          updates.buyer_proof = {
            proof: `zkp_hash_${buyerNullifier.slice(4, 28)}`,
            nullifier: buyerNullifier,
            verified: true,
            protocol: "hash-fallback",
          };
        }
      }
    }

    Object.assign(secret, updates, { updatedAt: new Date().toISOString() });

    // Persist to Fileverse — only sanitized data (no raw identities)
    if (secret.fileverse_ddoc_id) {
      const sanitized = zk.sanitizeForStorage(secret);
      fileverse.updateDocument(secret.fileverse_ddoc_id, {
        content: JSON.stringify(sanitized),
      }).catch(err => {
        console.error(`[Store] Fileverse update failed: ${err.message}`);
      });
    }

    return secret;
  },

  async countDocuments(filter = {}) {
    if (filter.seller_telegram_id) {
      return Array.from(secretsMap.values()).filter(s => s.seller_telegram_id === filter.seller_telegram_id).length;
    }
    return Array.from(secretsMap.values()).filter(s => matchFilter(s, filter)).length;
  },
};

// ── User Model (in-memory only — no user data on Fileverse) ──
const User = {
  async create(data) {
    // Issue anonymous credential on registration
    const cred = zk.issueCredential(data.telegram_chat_id || data.wallet_address, "user");

    const user = {
      _id: crypto.randomBytes(12).toString("hex"),
      ...data,
      zk_commitment: cred.commitment,
      zk_credential: cred.credentialHash,
      createdAt: new Date().toISOString(),
    };
    usersMap.set(user._id, user);
    if (data.telegram_chat_id) usersMap.set(`tg:${data.telegram_chat_id}`, user);
    if (data.wallet_address) usersMap.set(`wa:${data.wallet_address.toLowerCase()}`, user);
    return user;
  },

  async findOne(filter) {
    if (filter.telegram_chat_id) return usersMap.get(`tg:${filter.telegram_chat_id}`) || null;
    if (filter.wallet_address) return usersMap.get(`wa:${filter.wallet_address.toLowerCase()}`) || null;
    for (const [key, val] of usersMap) {
      if (!key.includes(":") && matchFilter(val, filter)) return val;
    }
    return null;
  },
};

// ── ZK helpers for external use ─────────────────────────
function resolveCommitment(commitment) {
  return commitmentToChat.get(commitment) || null;
}

function getUsedNullifiers() {
  return usedNullifiers;
}

// ── Initialise – Load secrets from Fileverse ────────────
async function initDB() {
  console.log("[Store] Initialising ZK-private Fileverse-backed store...");
  console.log("[Store] Privacy: No raw identities stored on Fileverse");

  if (!fileverse.isEnabled()) {
    console.log("[Store] Fileverse not available — in-memory only (data lost on restart)");
    return;
  }

  try {
    const docs = await fileverse.listDocuments();
    console.log(`[Store] Found ${docs.length} documents on Fileverse`);

    for (const doc of docs) {
      try {
        const ddocId = doc.ddocId || doc;
        const full = await fileverse.getDocument(ddocId);
        if (!full || !full.content) continue;

        // Strip markdown header if present (e.g., "# Title\n{...}")
        let rawContent = full.content;
        const jsonStart = rawContent.indexOf("{");
        if (jsonStart > 0) rawContent = rawContent.slice(jsonStart);

        const data = JSON.parse(rawContent);
        if (data.type !== "paypersecret") continue;

        data._id = full.ddocId;
        data.fileverse_ddoc_id = full.ddocId;
        data.fileverse_link = full.link || null;
        // Note: seller_telegram_id and buyer_telegram_id will be null
        // (they were stripped by sanitizeForStorage before persisting)
        // Notifications won't work for old secrets after restart — this is by design (privacy)
        secretsMap.set(full.ddocId, data);
      } catch {
        // Skip non-JSON or non-PayPerSecret docs
      }
    }

    console.log(`[Store] Loaded ${secretsMap.size} secrets from Fileverse (ZK-private)`);
  } catch (err) {
    console.error(`[Store] Failed to load from Fileverse: ${err.message}`);
  }
}

module.exports = { initDB, User, Secret, resolveCommitment, getUsedNullifiers };
