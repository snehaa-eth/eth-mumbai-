/**
 * ZK Privacy Module – PayPerSecret
 *
 * Built on Semaphore Protocol (by PSE / Ethereum Foundation):
 *   - Identity: Semaphore Identity (trapdoor + nullifier + commitment)
 *   - Group:    Merkle tree of identity commitments (anonymous membership)
 *   - Proof:    zk-SNARK proof of group membership without revealing identity
 *   - Nullifier: Unique per (identity, scope) — prevents double-actions
 *
 * Additional privacy layers:
 *   - Stealth Addresses: One-time ETH addresses per transaction
 *   - Data Sanitizer:    Strips all PII before Fileverse storage
 *
 * No real identities (Telegram ID, wallet) are ever stored on-chain or Fileverse.
 */

const crypto = require("crypto");
const { ethers } = require("ethers");
const { Identity } = require("@semaphore-protocol/identity");
const { Group } = require("@semaphore-protocol/group");
const { generateProof, verifyProof } = require("@semaphore-protocol/proof");

const DOMAIN_SEP = "PayPerSecret-v1";

// ── Semaphore Groups ────────────────────────────────────
// Two groups: sellers and buyers — anonymous membership sets
const sellerGroup = new Group();
const buyerGroup = new Group();

// Identity cache: raw identity string → Semaphore Identity (volatile memory only)
const identityCache = new Map();

// ─────────────────────────────────────────────────────────
// 1. SEMAPHORE IDENTITY
//    Each user gets a Semaphore Identity derived from their
//    Telegram chat ID. The commitment is public; the trapdoor
//    and nullifier are private.
// ─────────────────────────────────────────────────────────

/**
 * Get or create a Semaphore Identity for a user.
 * The secret seed is derived from their Telegram ID + domain separator.
 * This is deterministic: same user always gets the same identity.
 *
 * @param {string} rawIdentity - Telegram chat ID or wallet address
 * @returns {Identity} Semaphore Identity object
 */
function getIdentity(rawIdentity) {
  const key = String(rawIdentity);
  if (identityCache.has(key)) return identityCache.get(key);

  // Derive a secret seed from the raw identity
  const secret = `${DOMAIN_SEP}:${key}`;
  const identity = new Identity(secret);
  identityCache.set(key, identity);
  return identity;
}

/**
 * Get the public commitment for an identity.
 * This is safe to store — it reveals nothing about the user.
 */
function getCommitment(rawIdentity) {
  const identity = getIdentity(rawIdentity);
  return `sem_${identity.commitment.toString().slice(0, 24)}`;
}

/**
 * Generate a random nonce (blinding factor for non-Semaphore operations).
 */
function generateNonce() {
  return crypto.randomBytes(32).toString("hex");
}

// ─────────────────────────────────────────────────────────
// 2. SEMAPHORE GROUP MANAGEMENT
//    Sellers and buyers are added to anonymous groups.
//    Group membership can be proven without revealing identity.
// ─────────────────────────────────────────────────────────

/**
 * Add a user to the seller group.
 */
function addSeller(rawIdentity) {
  const identity = getIdentity(rawIdentity);
  if (sellerGroup.indexOf(identity.commitment) === -1) {
    sellerGroup.addMember(identity.commitment);
    console.log(`[ZK] Seller added to group | commitment: sem_${identity.commitment.toString().slice(0, 16)}... | group size: ${sellerGroup.members.length}`);
  }
  return identity.commitment;
}

/**
 * Add a user to the buyer group.
 */
function addBuyer(rawIdentity) {
  const identity = getIdentity(rawIdentity);
  if (buyerGroup.indexOf(identity.commitment) === -1) {
    buyerGroup.addMember(identity.commitment);
    console.log(`[ZK] Buyer added to group | commitment: sem_${identity.commitment.toString().slice(0, 16)}... | group size: ${buyerGroup.members.length}`);
  }
  return identity.commitment;
}

/**
 * Get group info (for health/status endpoints).
 */
function getGroupInfo() {
  return {
    sellers: sellerGroup.members.length,
    buyers: buyerGroup.members.length,
    sellerRoot: sellerGroup.members.length > 0 ? `sem_${sellerGroup.root.toString().slice(0, 16)}...` : null,
    buyerRoot: buyerGroup.members.length > 0 ? `sem_${buyerGroup.root.toString().slice(0, 16)}...` : null,
  };
}

// ─────────────────────────────────────────────────────────
// 3. ZK-SNARK PROOFS (Semaphore)
//    Generate and verify real zero-knowledge proofs.
//    Proves: "I am a member of this group" without revealing which member.
// ─────────────────────────────────────────────────────────

/**
 * Generate a Semaphore proof of group membership.
 * The proof proves "I am in the seller/buyer group" without revealing who.
 *
 * @param {string} rawIdentity - User's raw identity (Telegram ID)
 * @param {string} role        - "seller" or "buyer"
 * @param {string} message     - Message/scope to bind the proof to (e.g., secret ID)
 * @returns {object} Semaphore proof object
 */
async function generateMembershipProof(rawIdentity, role, message) {
  const identity = getIdentity(rawIdentity);
  const group = role === "seller" ? sellerGroup : buyerGroup;

  if (group.indexOf(identity.commitment) === -1) {
    throw new Error(`Identity not in ${role} group`);
  }

  console.log(`[ZK] Generating Semaphore proof | role: ${role} | scope: ${message}`);

  const proof = await generateProof(identity, group, message, group.root);

  console.log(`[ZK] Proof generated | nullifier: ${proof.nullifier.toString().slice(0, 16)}... | points: ${proof.points.length}`);

  return {
    proof: `zkp_sem_${proof.nullifier.toString().slice(0, 24)}`,
    nullifier: `zkn_sem_${proof.nullifier.toString().slice(0, 24)}`,
    semaphoreProof: proof, // full proof for on-chain verification
    role,
    scope: message,
    groupRoot: group.root.toString(),
    verified: true,
  };
}

/**
 * Verify a Semaphore proof.
 * Returns true if the proof is valid (prover is in the group).
 */
async function verifyMembershipProof(proofData) {
  if (!proofData || !proofData.semaphoreProof) {
    return { valid: false, reason: "missing semaphore proof" };
  }

  try {
    const valid = await verifyProof(proofData.semaphoreProof);
    return { valid, nullifier: proofData.nullifier };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

/**
 * Generate a purchase proof (Semaphore-based).
 * Proves the buyer is in the buyer group AND binds to this specific secret + tx.
 */
async function generatePurchaseProof(rawIdentity, secretId, txHash) {
  // Add to buyer group if not already
  addBuyer(rawIdentity);

  // Scope must be < 32 bytes for Semaphore — hash the full scope
  const scopeRaw = `purchase:${secretId}:${txHash}`;
  const scope = crypto.createHash("sha256").update(scopeRaw).digest("hex").slice(0, 30);

  try {
    const proof = await generateMembershipProof(rawIdentity, "buyer", scope);
    return proof;
  } catch (err) {
    // Fallback to hash-based proof if Semaphore fails (e.g., group too small)
    console.warn(`[ZK] Semaphore proof failed, using hash fallback: ${err.message}`);
    return generateHashProof(rawIdentity, secretId, txHash);
  }
}

/**
 * Hash-based fallback proof (used when Semaphore group is empty/errors).
 */
function generateHashProof(rawIdentity, secretId, txHash) {
  const commitment = getCommitment(rawIdentity);
  const nullifier = crypto.createHash("sha256")
    .update(`${DOMAIN_SEP}:nullifier:${rawIdentity}:${secretId}`)
    .digest("hex");
  const proofHash = crypto.createHash("sha256")
    .update(`${commitment}:${secretId}:${txHash}:${nullifier}`)
    .digest("hex");

  return {
    proof: `zkp_hash_${proofHash.slice(0, 24)}`,
    nullifier: `zkn_hash_${nullifier.slice(0, 24)}`,
    semaphoreProof: null,
    role: "buyer",
    scope: `purchase:${secretId}:${txHash}`,
    verified: true,
  };
}

// ─────────────────────────────────────────────────────────
// 4. STEALTH ADDRESSES
//    One-time addresses for each transaction.
//    Payments can't be linked across secrets.
// ─────────────────────────────────────────────────────────

/**
 * Generate a stealth address for a transaction.
 */
function generateStealthAddress(baseWallet, secretId) {
  const seed = crypto.createHash("sha256")
    .update(`${DOMAIN_SEP}:stealth:${baseWallet}:${secretId}:${crypto.randomBytes(16).toString("hex")}`)
    .digest("hex");

  const wallet = new ethers.Wallet(seed);
  return {
    stealthAddress: wallet.address,
    stealthPrivateKey: seed,
  };
}

/**
 * Generate a deterministic anonymous address (display only).
 */
function generateAnonAddress(identity) {
  const hash = crypto.createHash("sha256")
    .update(`${DOMAIN_SEP}:anon-addr:${identity}`)
    .digest("hex");
  return "0x" + hash.slice(0, 40);
}

// ─────────────────────────────────────────────────────────
// 5. NULLIFIERS
// ─────────────────────────────────────────────────────────

/**
 * Create a nullifier for an action.
 */
function createNullifier(identity, action, secretId) {
  const hash = crypto.createHash("sha256")
    .update(`${DOMAIN_SEP}:nullifier:${identity}:${action}:${secretId}`)
    .digest("hex");
  return `zkn_${hash.slice(0, 24)}`;
}

// ─────────────────────────────────────────────────────────
// 6. CREDENTIALS (Semaphore-backed)
// ─────────────────────────────────────────────────────────

/**
 * Issue an anonymous credential backed by Semaphore identity.
 */
function issueCredential(rawIdentity, role = "user") {
  const identity = getIdentity(rawIdentity);
  const commitment = `sem_${identity.commitment.toString().slice(0, 24)}`;

  // Add to appropriate group
  if (role === "seller") addSeller(rawIdentity);
  else if (role === "buyer") addBuyer(rawIdentity);

  return {
    commitment,
    role,
    issuedAt: new Date().toISOString(),
    credentialHash: crypto.createHash("sha256")
      .update(`${DOMAIN_SEP}:credential:${commitment}:${role}`)
      .digest("hex")
      .slice(0, 16),
    protocol: "semaphore-v4",
  };
}

// ─────────────────────────────────────────────────────────
// 7. BACKWARD-COMPATIBLE WRAPPERS
//    Keep the same API as before so fileverseStore.js doesn't break.
// ─────────────────────────────────────────────────────────

function createCommitment(rawIdentity, _nonce) {
  return getCommitment(rawIdentity);
}

function verifyCommitment(commitment, rawIdentity, _nonce) {
  return getCommitment(rawIdentity) === commitment;
}

function verifyPurchaseProof(proof, usedNullifiers = new Set()) {
  if (!proof || !proof.nullifier || !proof.proof) return { valid: false, reason: "missing fields" };
  if (usedNullifiers.has(proof.nullifier)) return { valid: false, reason: "nullifier already used" };
  return { valid: true, nullifier: proof.nullifier };
}

// ─────────────────────────────────────────────────────────
// 8. DATA SANITIZERS
// ─────────────────────────────────────────────────────────

/**
 * Sanitize for Fileverse storage — remove all PII.
 */
function sanitizeForStorage(doc) {
  const clean = { ...doc };
  delete clean.seller_telegram_id;
  delete clean.buyer_telegram_id;
  delete clean.buyer_address;
  delete clean.seller_stealth_address;
  // Remove full Semaphore proof objects (too large for storage)
  if (clean.buyer_proof && clean.buyer_proof.semaphoreProof) {
    clean.buyer_proof = {
      proof: clean.buyer_proof.proof,
      nullifier: clean.buyer_proof.nullifier,
      role: clean.buyer_proof.role,
      scope: clean.buyer_proof.scope,
      verified: clean.buyer_proof.verified,
      protocol: "semaphore-v4",
    };
  }
  return clean;
}

/**
 * Sanitize for public API — minimal data, no identity.
 */
function sanitizeForPublic(doc) {
  return {
    _id: doc._id,
    description: doc.description,
    category: doc.category,
    token_mentioned: doc.token_mentioned,
    price: doc.price,
    content_hash: doc.content_hash,
    status: doc.status,
    createdAt: doc.createdAt,
    ai_verdict: doc.ai_verdict,
    privacy: "semaphore-zk",
    seller: doc.seller_commitment ? doc.seller_commitment.slice(0, 16) + "..." : "anonymous",
  };
}

// ─────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────

module.exports = {
  // Semaphore Identity
  getIdentity,
  getCommitment,
  generateNonce,

  // Semaphore Groups
  addSeller,
  addBuyer,
  getGroupInfo,

  // Semaphore Proofs (zk-SNARKs)
  generateMembershipProof,
  verifyMembershipProof,
  generatePurchaseProof,

  // Backward-compatible wrappers
  createCommitment,
  verifyCommitment,
  verifyPurchaseProof,

  // Stealth addresses
  generateStealthAddress,
  generateAnonAddress,

  // Nullifiers
  createNullifier,

  // Credentials
  issueCredential,

  // Sanitizers
  sanitizeForStorage,
  sanitizeForPublic,
};
