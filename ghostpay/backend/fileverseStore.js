/**
 * Fileverse Store – Replaces MongoDB with Fileverse + In-Memory Cache
 *
 * All secrets are stored as encrypted JSON documents on Fileverse (IPFS + Gnosis chain).
 * In-memory Maps provide fast lookups. On startup, cache is rebuilt from Fileverse.
 *
 * Provides Mongoose-compatible interface so server.js and telegramService.js
 * need minimal changes.
 */

const crypto = require("crypto");
const fileverse = require("./fileverseService");

// ── In-memory stores ────────────────────────────────────
const secretsMap = new Map(); // ddocId → secret data
const usersMap = new Map();   // multi-index: id, tg:<chatId>, wa:<address> → user

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
    // Hash the original content for tamper-proof commitment
    const contentHash = data.content_hash ||
      crypto.createHash("sha256").update(data.content || data.encrypted_data || "").digest("hex");

    const doc = {
      type: "paypersecret",
      // Secret content (plaintext — Fileverse encrypts it)
      secret_content: data.content || null,
      description: data.description,
      category: data.category || "General",
      token_mentioned: data.token_mentioned || null,
      price: data.price,
      content_hash: contentHash,
      status: "listed",
      seller_telegram_id: data.seller_telegram_id,
      seller_stealth_address: data.seller_stealth_address || null,
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

    // Store on Fileverse as JSON document
    const fvResult = await fileverse.storeSecret(
      data.description || "Secret",
      JSON.stringify(doc),
      { category: doc.category, token_mentioned: doc.token_mentioned, price: doc.price, content_hash: contentHash }
    );

    if (fvResult) {
      doc._id = fvResult.ddocId;
      doc.fileverse_ddoc_id = fvResult.ddocId;
      doc.fileverse_link = fvResult.link || null;
      secretsMap.set(fvResult.ddocId, doc);

      // Wait for Fileverse link in background
      if (!fvResult.link) {
        fileverse.waitForLink(fvResult.ddocId).then(link => {
          if (link) doc.fileverse_link = link;
        });
      }
    } else {
      // Fileverse unavailable — in-memory only
      doc._id = crypto.randomBytes(12).toString("hex");
      secretsMap.set(doc._id, doc);
    }

    console.log(`[Store] Secret created: ${doc._id} – "$${doc.price} USDC"`);
    return doc;
  },

  findById(id) {
    return new QueryBuilder(() => secretsMap.get(id) || null);
  },

  find(filter = {}) {
    return new QueryBuilder(() =>
      Array.from(secretsMap.values()).filter(s => matchFilter(s, filter))
    );
  },

  async findByIdAndUpdate(id, updates) {
    const secret = secretsMap.get(id);
    if (!secret) return null;

    Object.assign(secret, updates, { updatedAt: new Date().toISOString() });

    // Persist to Fileverse in background
    if (secret.fileverse_ddoc_id) {
      fileverse.updateDocument(secret.fileverse_ddoc_id, {
        content: JSON.stringify(secret),
      }).catch(err => {
        console.error(`[Store] Fileverse update failed: ${err.message}`);
      });
    }

    return secret;
  },

  async countDocuments(filter = {}) {
    return Array.from(secretsMap.values()).filter(s => matchFilter(s, filter)).length;
  },
};

// ── User Model (in-memory only) ─────────────────────────
const User = {
  async create(data) {
    const user = {
      _id: crypto.randomBytes(12).toString("hex"),
      ...data,
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

// ── Initialise – Load secrets from Fileverse ────────────
async function initDB() {
  console.log("[Store] Initialising Fileverse-backed store (no MongoDB)...");

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

        const data = JSON.parse(full.content);
        if (data.type !== "paypersecret") continue;

        data._id = full.ddocId;
        data.fileverse_ddoc_id = full.ddocId;
        data.fileverse_link = full.link || null;
        secretsMap.set(full.ddocId, data);
      } catch {
        // Skip non-JSON or non-PayPerSecret docs
      }
    }

    console.log(`[Store] Loaded ${secretsMap.size} secrets from Fileverse`);
  } catch (err) {
    console.error(`[Store] Failed to load from Fileverse: ${err.message}`);
  }
}

module.exports = { initDB, User, Secret };
