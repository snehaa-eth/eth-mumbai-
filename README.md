# PayPerSecret

**Anonymous Information Marketplace** built for **ETHMumbai 2026**

Sell and buy secrets anonymously via Telegram. Payments use the **x402 protocol** (HTTP 402). Secrets are encrypted and stored on **Fileverse** (IPFS + Gnosis chain). AI verifies claims before releasing funds.

## Hackathon Tracks

| Track | Integration |
|-------|------------|
| **Fileverse** – Build What Big Tech Won't ($1000) | Sole database. All secrets stored as encrypted documents on IPFS + Gnosis chain via Fileverse API. No MongoDB. |
| **x402 / Elsa** – HTTP-Native Payments | Peek ($0.50 fixed) and Buy (dynamic price) both gated via x402 protocol. HeyElsa AI verifies secret claims on-chain. |

## How It Works

```
Seller                        Buyer
  |                             |
  |  /sell 5 Big alpha leak     |
  |  [sends secret content]     |
  |  --> Fileverse encrypts     |
  |      & stores on IPFS       |
  |                             |
  |                        /browse
  |                        /peek <id>
  |                          --> pay $0.50 USDC via x402
  |                          <-- metadata revealed
  |                        /buy <id>
  |                          --> pay $5 USDC via x402
  |                          --> AI verifies claim
  |  <-- "$5 USDC released"     |
  |                        /decrypt <id>
  |                          <-- secret content + Fileverse link
```

## Architecture

```
Telegram Bot (sole UI)
    |
    v
Express.js Server (port 3001)
    |
    +-- x402 Middleware (@x402/express)
    |     |-- GET /api/secrets/:id/peek  --> 402 --> $0.50 USDC
    |     +-- POST /api/secrets/:id/buy-direct --> 402 --> $X USDC
    |
    +-- Fileverse (database layer)
    |     |-- fileverseService.js  --> localhost:8001 --> IPFS + Gnosis
    |     +-- fileverseStore.js    --> in-memory cache + Fileverse persistence
    |
    +-- HeyElsa AI (verification)
    |     +-- elsaVerifier.js --> x402-api.heyelsa.ai
    |
    +-- BitGo MPC (escrow)
    |     +-- escrowService.js --> BitGo wallet (Hoodi testnet)
    |
    +-- Payment Pages (served by Express)
          |-- /peek-pay/:id  --> peek payment page ($0.50)
          +-- /pay/:id       --> buy payment page ($X)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| UI | Telegram Bot API |
| Backend | Node.js + Express.js |
| Storage | Fileverse (@fileverse/api) on IPFS + Gnosis chain |
| Payments | x402 Protocol (@x402/express) on Base Sepolia |
| Currency | USDC on Base Sepolia (0x036CbD53842c5426634e7929541eC2318f3dCF7e) |
| AI Verification | HeyElsa x402 DeFi API |
| Escrow | BitGo MPC wallet (Hoodi testnet) |
| ENS | ethers.js (Ethereum mainnet) |
| Encryption | Fileverse client-side E2E encryption |
| Hashing | SHA-256 (tamper-proof content commitment) |

## Project Structure

```
paypersecret/
  backend/
    server.js              # Express API + payment pages (x402)
    telegramService.js     # Telegram bot commands
    fileverseStore.js      # Database layer (in-memory + Fileverse)
    fileverseService.js    # Fileverse API wrapper (IPFS + Gnosis)
    x402Config.js          # x402 payment middleware config
    elsaVerifier.js        # HeyElsa AI verification
    escrowService.js       # BitGo MPC escrow
    bitgoService.js        # BitGo SDK wrapper
    ensService.js          # ENS name resolution
    cryptoService.js       # AES/ECIES crypto utilities
    .env                   # Environment variables
```

## Prerequisites

- **Node.js** >= 18
- **ngrok** (public URL for Telegram webhook + payment pages)
- **MetaMask** (or any EVM wallet with Base Sepolia USDC)

## Setup

### 1. Clone and install

```bash
cd paypersecret/backend
npm install
```

### 2. Get credentials

#### Fileverse API Key
1. Go to [ddocs.new](https://ddocs.new)
2. Settings -> Developer Mode -> Generate API Key
3. Set `FILEVERSE_API_KEY` in `.env`

#### Telegram Bot Token
1. Open Telegram, search for **@BotFather**
2. Send `/newbot`, choose a name and username
3. Copy the token into `TELEGRAM_BOT_TOKEN` in `.env`

#### x402 / Server Wallet
1. Any EVM wallet address that receives USDC payments
2. Set `SERVER_WALLET` in `.env`
3. The x402 facilitator is free (no signup): `https://x402.org/facilitator`

#### HeyElsa (AI Verification)
1. Generate a wallet: `node -e "const {ethers}=require('ethers'); const w=ethers.Wallet.createRandom(); console.log(w.address, w.privateKey)"`
2. Fund with test USDC at [faucet.circle.com](https://faucet.circle.com) (Base Sepolia)
3. Set `ELSA_PAYMENT_PRIVATE_KEY` in `.env`

#### BitGo (Escrow)
1. Sign up at [app.bitgo-test.com](https://app.bitgo-test.com)
2. Settings -> Developer -> Access Tokens -> Create with "Spending" permission
3. Set `BITGO_ACCESS_TOKEN` in `.env`

### 3. Configure `.env`

```bash
cp .env.example .env
# Edit .env with your credentials
```

Key variables:

| Variable | Description |
|----------|------------|
| `FILEVERSE_API_KEY` | Fileverse API key from ddocs.new |
| `FILEVERSE_API_URL` | `http://localhost:8001` (default) |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `SERVER_WALLET` | EVM address that receives x402 payments |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` (free) |
| `ELSA_PAYMENT_PRIVATE_KEY` | Private key for HeyElsa API payments |
| `BITGO_ACCESS_TOKEN` | BitGo testnet access token |
| `WEBHOOK_BASE_URL` | Your ngrok public URL |
| `PORT` | `3001` (default) |

### 4. Start services

You need **3 terminals**:

```bash
# Terminal 1 – Fileverse API server
npx @fileverse/api --apiKey YOUR_FILEVERSE_KEY --rpcUrl https://rpc.ankr.com/gnosis

# Terminal 2 – ngrok (public URL for Telegram + payment pages)
ngrok http 3001

# Terminal 3 – PayPerSecret server
cd paypersecret/backend
node server.js
```

After ngrok starts, copy the HTTPS URL and update `WEBHOOK_BASE_URL` in `.env`, then restart the server.

### 5. Test the flow

Open Telegram and message your bot:

```
/start                          # See all commands
/register 0xYourWallet          # Link your wallet
/sell 5 Whale dumping TOKEN_X   # List a secret ($5 USDC)
[send the actual secret text]   # Bot stores it on Fileverse
/browse                         # See available secrets
/peek <id>                      # Pay $0.50 via x402 to see metadata
/buy <id>                       # Pay $5 via x402 to purchase
/decrypt <id>                   # Get the secret after AI verification
```

## x402 Payment Flow

Both **peek** and **buy** use the x402 protocol:

1. User clicks payment link from Telegram
2. Browser page calls API endpoint -> gets **HTTP 402** response with payment requirements
3. Page connects MetaMask, switches to Base Sepolia
4. User approves USDC transfer (this IS the x402 payment)
5. Page retries endpoint with `X-Payment: <tx_hash>` header
6. Server processes the payment and returns data

### Peek Flow ($0.50 fixed)
```
GET /api/secrets/:id/peek
  -> 402 { accepts: [{ price: "$0.50", network: "eip155:84532", ... }] }
  -> User pays $0.50 USDC via MetaMask
GET /api/secrets/:id/peek  (with X-Payment header)
  -> 200 { secret: { description, category, token, hash, price, ... } }
```

### Buy Flow (dynamic price)
```
POST /api/secrets/:id/buy-direct
  -> 402 { accepts: [{ maxAmountRequired: "5", network: "eip155:84532", ... }] }
  -> User pays $5 USDC via MetaMask
POST /api/secrets/:id/buy-direct  (with X-Payment header)
  -> 200 { status: "purchased", message: "x402 payment confirmed" }
  -> AI verification runs in background
  -> Telegram notification sent when verified
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | - | Health check |
| `POST` | `/api/secrets` | - | List a new secret |
| `GET` | `/api/secrets` | - | Browse all listed secrets |
| `GET` | `/api/secrets/:id/peek` | x402 $0.50 | Peek at secret metadata |
| `GET` | `/peek-pay/:id` | - | Peek payment page |
| `POST` | `/api/secrets/:id/buy-direct` | x402 $X | Buy a secret |
| `GET` | `/pay/:id` | - | Buy payment page |
| `GET` | `/api/secrets/:id/decrypt` | - | Get secret after verification |
| `POST` | `/api/secrets/:id/verify` | - | Trigger AI verification |
| `GET` | `/api/secrets/:id/status` | - | Check secret status |
| `POST` | `/register-user` | - | Register wallet |
| `GET` | `/wallet/balance` | - | Escrow wallet balance |

## Debugging

Open browser DevTools (F12) -> **Console** tab to see step-by-step x402 logs:

```
[x402-Peek] Step 1: Fetching peek endpoint to get 402...
[x402-Peek] Step 1 response status: 402
[x402-Peek] Step 1 x402 requirements: { ... }
[x402-Peek] Step 2: Connecting wallet...
[x402-Peek] Step 3: Switching to Base Sepolia...
[x402-Peek] Step 4: Sending USDC transfer...
[x402-Peek] Step 5: Fetching peek with X-Payment header...
[x402-Peek] SUCCESS! Metadata received
```

Server terminal shows:
```
[x402-Peek] -> GET /api/secrets/<id>/peek
[x402-Peek]   X-Payment header: NONE (will 402)
[x402-Buy]  -> POST /api/secrets/<id>/buy-direct
[x402-Buy]    -> Returning 402 (price: $5 USDC)
[x402-Buy]    -> Payment proof received: 0x1234...
```

## Testnet Info

| Network | Details |
|---------|---------|
| **Base Sepolia** | Chain ID: 84532 (0x14A34) - USDC payments |
| **Gnosis Chain** | Fileverse document storage |
| **Hoodi Testnet** | BitGo escrow wallet |

- Get test USDC: [faucet.circle.com](https://faucet.circle.com) (select Base Sepolia)
- Get test ETH: [Base Sepolia faucet](https://www.alchemy.com/faucets/base-sepolia)
- Explorer: [sepolia.basescan.org](https://sepolia.basescan.org)

## License

Built for ETHMumbai 2026 hackathon.
