# GhostPay

Privacy-preserving payroll and bounty distribution system on **Base chain**. Distributes USDC payments via BitGo while hiding the relationship between treasury wallets and recipients through relay address routing.

## Architecture

```
Treasury Wallet ──► Relay Address ──► Recipient Wallet
   (BitGo/Base)     (fresh per tx)      (contributor)
```

Each payment uses a unique intermediary address so on-chain observers cannot trivially link treasury outflows to recipient inflows.

## Tech Stack

- **Chain**: Base (Coinbase L2)
- **Backend**: Node.js + Express.js
- **Database**: MongoDB + Mongoose
- **Wallet Infra**: BitGo SDK
- **Frontend**: Next.js 14 (App Router)
- **Notifications**: Telegram Bot API
- **ENS**: ethers.js (resolves on Ethereum mainnet)

## Project Structure

```
ghostpay/
├── backend/
│   ├── server.js            # Express API server
│   ├── bitgoService.js      # BitGo SDK wrapper (Base chain)
│   ├── ensService.js        # ENS name resolution
│   ├── relayService.js      # Two-hop payment routing
│   ├── telegramService.js   # Telegram bot notifications
│   ├── webhookHandler.js    # BitGo webhook processor
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── app/
│   │   ├── layout.js        # Root layout
│   │   ├── globals.css      # Styles
│   │   ├── page.js          # Dashboard
│   │   ├── api.js           # API client
│   │   ├── payments/page.js # Payment management
│   │   └── users/page.js    # Contributor management
│   ├── package.json
│   └── next.config.js
└── database/
    └── models/index.js      # Mongoose models (User, Payment)
```

## Prerequisites

- Node.js >= 18
- MongoDB (local or Atlas)
- BitGo testnet account
- Telegram bot token
- Infura/Alchemy RPC URL (for ENS resolution)

## Where to Get Credentials

### BitGo Access Token

1. Go to [test.bitgo.com](https://test.bitgo.com) and create an account
2. Navigate to **Settings** > **Developer** > **Access Tokens**
3. Click **Create Token** with **Spending** permission
4. Copy the token into `.env` as `BITGO_ACCESS_TOKEN`
5. Your enterprise ID is visible on the same settings page

### Telegram Bot Token

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a display name (e.g. "GhostPay Bot")
4. Choose a username (e.g. `ghostpay_bot`)
5. BotFather replies with a token like `7123456789:AAF1234abcd...`
6. Copy the token into `.env` as `TELEGRAM_BOT_TOKEN`

### MongoDB URI

- **Local**: Install MongoDB and use `mongodb://localhost:27017/ghostpay`
- **Atlas** (free tier): [mongodb.com/atlas](https://www.mongodb.com/atlas) > Create cluster > Get connection string

### ENS / RPC

- Get a free RPC URL from [Infura](https://infura.io) or [Alchemy](https://alchemy.com)
- Use an **Ethereum mainnet** URL for ENS resolution (`ETH_RPC_URL`)
- Use **Base Sepolia** for transactions (`BASE_RPC_URL`)

## Setup

### 1. Install dependencies

```bash
cd ghostpay/backend && npm install
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your credentials:

| Variable | Description |
|---|---|
| `BITGO_ACCESS_TOKEN` | BitGo testnet API token |
| `BITGO_ENVIRONMENT` | `test` for testnet |
| `BITGO_COIN` | `base:usdc` for Base chain USDC |
| `BITGO_WALLET_ID` | Treasury wallet ID (created via API) |
| `BITGO_WALLET_PASSPHRASE` | Wallet passphrase |
| `MONGODB_URI` | MongoDB connection string |
| `ETH_RPC_URL` | Ethereum mainnet RPC (for ENS) |
| `BASE_RPC_URL` | Base Sepolia RPC |
| `EXPLORER_URL` | `https://sepolia.basescan.org` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `WEBHOOK_BASE_URL` | Public URL for BitGo webhooks (use ngrok) |

### 3. Start MongoDB

```bash
# Local
mongod --dbpath /data/db

# Or use Docker
docker run -d -p 27017:27017 --name ghostpay-mongo mongo:7
```

### 4. Create treasury wallet (first time only)

```bash
cd backend && npm run dev

# In another terminal
curl -X POST http://localhost:3001/wallet/create \
  -H "Content-Type: application/json" \
  -d '{"label": "GhostPay Treasury"}'
```

Copy the returned `walletId` into your `.env` as `BITGO_WALLET_ID`.

### 5. Set up webhooks (requires public URL)

```bash
ngrok http 3001

curl -X POST http://localhost:3001/webhook/register \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-ngrok-url.ngrok.io"}'
```

### 6. Start the system

```bash
# Terminal 1 – Backend
cd backend && npm run dev

# Terminal 2 – Frontend
cd frontend && npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:3000

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/register-user` | Register a contributor |
| `GET` | `/users` | List all contributors |
| `GET` | `/users/:id` | Get contributor details |
| `POST` | `/create-payment` | Initiate a relayed payment |
| `GET` | `/payments` | List payments (filter: `?status=`) |
| `GET` | `/payments/:id` | Get payment details |
| `POST` | `/payments/:id/complete-relay` | Manually complete second hop |
| `GET` | `/wallet/balance` | Treasury wallet balance |
| `POST` | `/wallet/create` | Create treasury wallet |
| `GET` | `/resolve-ens/:name` | Resolve ENS name |
| `POST` | `/webhook/bitgo` | BitGo webhook receiver |
| `POST` | `/webhook/register` | Register webhook with BitGo |

## Usage Example

### Register a contributor

```bash
curl -X POST http://localhost:3001/register-user \
  -H "Content-Type: application/json" \
  -d '{
    "ens_name": "sneha.eth",
    "telegram_chat_id": "123456789",
    "label": "Sneha"
  }'
```

### Send a bounty payment

```bash
curl -X POST http://localhost:3001/create-payment \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "sneha.eth",
    "amount": "200",
    "reason": "Smart contract audit bounty"
  }'
```

### Payment Flow

1. Backend resolves `sneha.eth` to wallet address via ENS
2. BitGo generates a fresh relay address on Base
3. Treasury sends 200 USDC to relay address (tx 1)
4. BitGo webhook confirms tx 1
5. Relay forwards 200 USDC to recipient (tx 2)
6. Telegram bot sends payment receipt to contributor

## Telegram Bot

Contributors message the bot to get their chat ID, then provide it during registration. After each payment, they receive a notification with amount, reason, and BaseScan explorer link.

## Privacy Model

- **Relay routing**: Every payment passes through a unique intermediary address
- **Fresh addresses**: BitGo generates a new address per transaction
- **Transaction separation**: Two separate on-chain transactions break direct linkability

Note: This is a prototype. Production systems should add time delays between hops, variable amounts, and multiple relay hops for stronger privacy guarantees.

## Testnet

This prototype is configured for **Base Sepolia testnet** via BitGo. Fund your treasury wallet with test ETH and test USDC on Base before creating payments.
