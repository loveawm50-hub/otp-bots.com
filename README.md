# otp-bots.com

## Backend (OxaPay ↔ Telegram)

The `server/` folder contains a Node.js service that:

- registers Telegram users once they press `Start` inside your bot
- creates OxaPay invoices and redirects buyers to the payment page
- receives OxaPay webhook callbacks after successful payment
- generates single-use activation keys and sends them to the buyer on Telegram
- exposes an API for the bot to validate activation keys

### Quick start

1. Copy `server/config.sample.json` to `server/config.local.json` (or set environment variables).
2. Install dependencies:
   ```bash
   cd server
   npm install
   ```
3. Create a `.env` file with:
   ```bash
   PORT=4000
   PUBLIC_BASE_URL=https://your-ngrok-subdomain.ngrok.app
   OXAPAY_API_KEY=replace-with-oxapay-api-key
   OXAPAY_MERCHANT_ID=replace-with-oxapay-merchant-id
   OXAPAY_CALLBACK_SECRET=replace-with-callback-secret
   OXAPAY_BASE_URL=https://api.oxapay.com
   TELEGRAM_BOT_TOKEN=replace-with-telegram-bot-token
   ```
4. Run the server locally:
   ```bash
   npm run dev
   ```
5. Expose the port via `ngrok http 4000` and paste the public URL into `PUBLIC_BASE_URL`.
6. In OxaPay dashboard set the callback URL to `https://<your-ngrok>/api/oxapay/webhook`.

### Telegram bot flow

- When the user presses Start, call `POST /api/telegram/register`.
- After payment, the webhook sends `✅ تم استقبال دفعتك` with the activation key.
- The bot calls `POST /api/telegram/verify-key` to validate the code and activate the subscription on success.

> ⚠️ The sample keeps data in memory. Replace with a database before production.