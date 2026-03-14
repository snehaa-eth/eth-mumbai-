/**
 * Invoice & Payment Parser Service
 *
 * Uses OpenAI to extract payment details from:
 *   - Invoice images (Vision API)
 *   - Invoice PDFs
 *   - Free-text messages (e.g. "pay me 0.001 eth for logo design")
 */

const OpenAI = require("openai");

let openai;

function initInvoiceService() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[Invoice] OPENAI_API_KEY not set – invoice scanning disabled");
    return;
  }
  openai = new OpenAI({ apiKey });
  console.log("[Invoice] OpenAI initialised");
}

const SYSTEM_PROMPT =
  "You are a payment request parser for GhostPay (a crypto payroll system using ETH). " +
  "Extract the payment amount, currency, and a brief description. " +
  "If the user mentions ETH, hteth, heth, or any ethereum variant, set currency to ETH. " +
  "If no currency is mentioned, default to ETH. " +
  "Convert any fiat amounts mentioned to their numeric value only. " +
  "Respond ONLY with valid JSON: {\"amount\": \"0.001\", \"currency\": \"ETH\", \"description\": \"brief description\"}. " +
  "If you cannot determine the amount, respond with {\"error\": \"reason\"}.";

/**
 * Parse the JSON from OpenAI response, handling code blocks.
 */
function parseResponse(content) {
  let jsonStr = content.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);

  if (parsed.error) {
    throw new Error(`Could not parse: ${parsed.error}`);
  }

  console.log(`[Invoice] Parsed: ${parsed.amount} ${parsed.currency} – ${parsed.description}`);
  return parsed;
}

/**
 * Extract payment details from an invoice image.
 */
async function scanInvoice(imageUrl) {
  if (!openai) {
    throw new Error("Invoice service not initialised – set OPENAI_API_KEY");
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract the payment details from this invoice:" },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 200,
  });

  return parseResponse(response.choices[0].message.content);
}

/**
 * Extract payment details from a text message.
 * e.g. "my payment 0.001 hteth" or "pay me 0.05 eth for logo design"
 */
async function parseTextRequest(text) {
  if (!openai) {
    throw new Error("Invoice service not initialised – set OPENAI_API_KEY");
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Parse this payment request: "${text}"`,
      },
    ],
    max_tokens: 200,
  });

  return parseResponse(response.choices[0].message.content);
}

module.exports = { initInvoiceService, scanInvoice, parseTextRequest };
