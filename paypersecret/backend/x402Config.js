/**
 * x402 Payment Middleware Configuration
 *
 * Adds x402 toll booths to API endpoints:
 *   GET /api/secrets/:id/peek → $0.01 to see metadata
 *
 * New @x402/express v2 API:
 *   1. Create HTTPFacilitatorClient
 *   2. Create x402ResourceServer and register EVM scheme
 *   3. Pass routes + server to paymentMiddleware
 */

/**
 * Create x402 payment middleware for PayPerSecret routes.
 * Falls through gracefully if x402 packages aren't configured.
 */
function createPaymentMiddleware() {
  try {
    const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
    const { HTTPFacilitatorClient } = require("@x402/core/server");
    const { ExactEvmScheme } = require("@x402/evm/exact/server");

    const facilitatorUrl = process.env.X402_FACILITATOR_URL || "https://facilitator.x402.org";
    const serverWallet = process.env.SERVER_WALLET;

    if (!serverWallet) {
      console.warn("[x402] SERVER_WALLET not set – x402 disabled");
      return null;
    }

    // Step 1: Create facilitator client
    const facilitatorClient = new HTTPFacilitatorClient({
      url: facilitatorUrl,
    });

    // Step 2: Create resource server and register EVM payment scheme
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register("eip155:84532", new ExactEvmScheme()); // Base Sepolia

    // Step 3: Define paid routes
    // Peek = $0.50 fixed via x402. Buy = seller-defined price via payment page (not x402).
    const routes = {
      "GET /api/secrets/:id/peek": {
        accepts: {
          scheme: "exact",
          price: "$0.50",
          network: "eip155:84532", // Base Sepolia
          payTo: serverWallet,
          maxTimeoutSeconds: 60,
        },
        description: "Peek at secret metadata",
      },
    };

    // Step 4: Create middleware
    const middleware = paymentMiddleware(routes, resourceServer);

    console.log("[x402] Payment middleware configured");
    console.log(`[x402]   Facilitator: ${facilitatorUrl}`);
    console.log(`[x402]   Revenue wallet: ${serverWallet}`);

    return middleware;
  } catch (err) {
    console.warn(`[x402] Failed to initialize payment middleware: ${err.message}`);
    console.warn("[x402] Endpoints will work without payment gates");
    return null;
  }
}

module.exports = { createPaymentMiddleware };
