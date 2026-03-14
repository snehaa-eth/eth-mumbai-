/**
 * Crypto Service – encryption, decryption, hashing for PayPerSecret
 *
 * Uses:
 *   AES-256-GCM  – encrypt/decrypt secret content (fast, symmetric)
 *   SHA-256       – hash content for tamper-proof commitment
 *   ECIES         – wrap AES key so only buyer can unwrap it
 */

const crypto = require("crypto");
const { encrypt: eciesEncrypt, decrypt: eciesDecrypt, PrivateKey } = require("eciesjs");

// ── AES-256-GCM Encryption ────────────────────────────────

/**
 * Encrypt plaintext with a random AES-256-GCM key.
 * Returns { encrypted (base64), aesKey (hex), iv (hex), authTag (hex) }
 */
function encryptSecret(plaintext) {
  const aesKey = crypto.randomBytes(32); // 256-bit key
  const iv = crypto.randomBytes(16);     // initialization vector

  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();

  return {
    encrypted,                          // base64 ciphertext
    aesKey: aesKey.toString("hex"),     // hex key (store securely)
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/**
 * Decrypt AES-256-GCM encrypted data.
 */
function decryptSecret(encryptedBase64, aesKeyHex, ivHex, authTagHex) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(aesKeyHex, "hex"),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  let decrypted = decipher.update(encryptedBase64, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ── SHA-256 Hashing ───────────────────────────────────────

/**
 * Hash plaintext with SHA-256. Used as tamper-proof commitment.
 */
function hashSecret(plaintext) {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Verify that decrypted content matches the original hash.
 */
function verifyHash(decryptedText, originalHash) {
  const check = hashSecret(decryptedText);
  return check === originalHash;
}

// ── ECIES Key Wrapping ────────────────────────────────────

/**
 * Wrap AES key with buyer's public key using ECIES.
 * Only the buyer's private key can unwrap it.
 *
 * @param {string} aesKeyHex – the AES key in hex
 * @param {string} buyerPublicKeyHex – buyer's secp256k1 public key (hex, uncompressed or compressed)
 * @returns {string} wrapped key in hex
 */
function wrapKeyForBuyer(aesKeyHex, buyerPublicKeyHex) {
  const aesKeyBuffer = Buffer.from(aesKeyHex, "hex");
  const encrypted = eciesEncrypt(buyerPublicKeyHex, aesKeyBuffer);
  return Buffer.from(encrypted).toString("hex");
}

/**
 * Unwrap AES key with buyer's private key.
 *
 * @param {string} wrappedKeyHex – ECIES-encrypted AES key in hex
 * @param {string} buyerPrivateKeyHex – buyer's secp256k1 private key (hex)
 * @returns {string} AES key in hex
 */
function unwrapKeyForBuyer(wrappedKeyHex, buyerPrivateKeyHex) {
  const sk = new PrivateKey(Buffer.from(buyerPrivateKeyHex, "hex"));
  const decrypted = eciesDecrypt(sk.toHex(), Buffer.from(wrappedKeyHex, "hex"));
  return Buffer.from(decrypted).toString("hex");
}

/**
 * Generate a fresh secp256k1 keypair for a buyer.
 * Returns { publicKey (hex), privateKey (hex) }
 */
function generateBuyerKeyPair() {
  const sk = new PrivateKey();
  return {
    publicKey: sk.publicKey.toHex(),
    privateKey: sk.toHex(),
  };
}

module.exports = {
  encryptSecret,
  decryptSecret,
  hashSecret,
  verifyHash,
  wrapKeyForBuyer,
  unwrapKeyForBuyer,
  generateBuyerKeyPair,
};
