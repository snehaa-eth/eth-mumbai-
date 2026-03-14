/**
 * ENS Resolution Service
 *
 * Resolves ENS names (e.g. sneha.eth) to Ethereum addresses using ethers.js.
 * Uses Sepolia testnet ENS registry for development.
 * Falls back to returning the input if it already looks like an address.
 */

const { ethers } = require("ethers");

let provider;

function initENS() {
  const rpcUrl = process.env.ETH_RPC_URL;
  if (rpcUrl) {
    // Connect to Sepolia with ENS registry address
    provider = new ethers.JsonRpcProvider(rpcUrl, {
      name: "sepolia",
      chainId: 11155111,
      ensAddress: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
    });
  } else {
    provider = ethers.getDefaultProvider("sepolia");
  }
  console.log("[ENS] Provider initialised (Sepolia testnet)");
}

/**
 * Resolve an ENS name to an Ethereum address.
 *
 * @param {string} nameOrAddress – ENS name or hex address
 * @returns {Promise<string>} resolved hex address
 * @throws if the ENS name cannot be resolved
 */
async function resolveENS(nameOrAddress) {
  // Already a hex address – return as-is
  if (ethers.isAddress(nameOrAddress)) {
    return ethers.getAddress(nameOrAddress); // checksum
  }

  if (!nameOrAddress.endsWith(".eth")) {
    throw new Error(`Invalid ENS name or address: ${nameOrAddress}`);
  }

  const address = await provider.resolveName(nameOrAddress);
  if (!address) {
    throw new Error(`ENS name could not be resolved: ${nameOrAddress}`);
  }

  console.log(`[ENS] ${nameOrAddress} → ${address}`);
  return address;
}

/**
 * Reverse-resolve an address to its primary ENS name (if set).
 */
async function reverseResolve(address) {
  try {
    const name = await provider.lookupAddress(address);
    return name; // may be null
  } catch {
    return null;
  }
}

module.exports = { initENS, resolveENS, reverseResolve };
