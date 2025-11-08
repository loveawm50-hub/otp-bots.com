import express from 'express';
import axios from 'axios';
import { config as loadEnv } from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfigFile() {
  const candidates = [
    path.resolve(__dirname, '../config.local.json'),
    path.resolve(__dirname, '../config.json'),
    path.resolve(__dirname, '../config.sample.json')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        return JSON.parse(raw);
      } catch (error) {
        console.warn(`⚠️  Failed to parse config file ${candidate}:`, error.message);
      }
    }
  }
  return {};
}

const fileConfig = loadConfigFile();

const configValue = (envKey, fallbackPath, defaultValue) => {
  if (process.env[envKey]) {
    return process.env[envKey];
  }
  if (!fallbackPath) {
    return defaultValue;
  }
  return fallbackPath.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), fileConfig) ?? defaultValue;
};

const app = express();
app.use(express.json());

const CLIENT_ROOT = path.resolve(__dirname, '../../');
app.use(express.static(CLIENT_ROOT, { extensions: ['html'] }));

const PORT = Number(configValue('PORT', 'port', 4000));
const PUBLIC_BASE_URL = configValue('PUBLIC_BASE_URL', 'publicBaseUrl');

const OXAPAY_API_KEY = configValue('OXAPAY_API_KEY', 'oxapay.apiKey');
const OXAPAY_MERCHANT_ID = configValue('OXAPAY_MERCHANT_ID', 'oxapay.merchantId');
const OXAPAY_BASE_URL = configValue('OXAPAY_BASE_URL', 'oxapay.baseUrl', 'https://api.oxapay.com');
const OXAPAY_CALLBACK_SECRET = configValue('OXAPAY_CALLBACK_SECRET', 'oxapay.callbackSecret');

const TELEGRAM_BOT_TOKEN = configValue('TELEGRAM_BOT_TOKEN', 'telegram.botToken');
const ADMIN_CHAT_ID = configValue('ADMIN_CHAT_ID', 'telegram.adminChatId');

if (!TELEGRAM_BOT_TOKEN) {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN not set. Telegram messaging will be disabled.');
}

if (!PUBLIC_BASE_URL) {
  console.warn('⚠️  PUBLIC_BASE_URL not set. Webhooks will fail unless the server is reachable from OxaPay.');
}

const bot = TELEGRAM_BOT_TOKEN
  ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })
  : null;

/**
 * Simple in-memory stores (replace with a real database in production).
 */
const pendingOrders = new Map(); // orderId -> { chatId, packageId, amount, currency }
const activationKeys = new Map(); // key -> { chatId, packageId, expiresAt }

/**
 * Utility to verify OxaPay signature if you configured a callback secret.
 */
function verifyOxaPaySignature(payload, providedSignature) {
  if (!OXAPAY_CALLBACK_SECRET) {
    return true;
  }
  const payloadString = JSON.stringify(payload);
  const hmac = crypto
    .createHmac('sha256', OXAPAY_CALLBACK_SECRET)
    .update(payloadString)
    .digest('hex');
  return hmac === providedSignature;
}

/**
 * Generates a single-use activation key.
 */
function generateActivationKey() {
  return uuidv4().replace(/-/g, '').toUpperCase();
}

/**
 * Endpoint to register a user from the Telegram bot.
 * Expected payload: { chatId, username, displayName }
 */
app.post('/api/telegram/register', (req, res) => {
  const { chatId, username, displayName } = req.body || {};
  if (!chatId) {
    return res.status(400).json({ error: 'chatId is required' });
  }
  pendingOrders.set(String(chatId), {
    chatId: String(chatId),
    username,
    displayName,
    registeredAt: new Date().toISOString()
  });
  return res.json({ status: 'registered' });
});

/**
 * Endpoint to create an OxaPay payment order.
 * Expected payload: { chatId, packageId, amount, currency }
 */
app.post('/api/payments/create', async (req, res) => {
  const { chatId, packageId, amount, currency } = req.body || {};
  if (!chatId || !packageId || !amount || !currency) {
    return res.status(400).json({ error: 'chatId, packageId, amount and currency are required' });
  }

  if (!pendingOrders.has(String(chatId))) {
    return res.status(404).json({ error: 'Telegram user not registered. Ask user to start the bot first.' });
  }

  const callbackUrl = `${PUBLIC_BASE_URL}/api/oxapay/webhook`;

  try {
    const response = await axios.post(
      `${OXAPAY_BASE_URL}/merchant/invoice`,
      {
        merchant: OXAPAY_MERCHANT_ID,
        price_amount: amount,
        price_currency: currency,
        pay_currency: currency,
        order_id: `${packageId}-${Date.now()}`,
        callback_url: callbackUrl,
        description: `Activation for package ${packageId}`,
        cancel_url: `${PUBLIC_BASE_URL}/payment/cancel`,
        success_url: `${PUBLIC_BASE_URL}/payment/success`,
        custom: {
          chatId: String(chatId),
          packageId
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OXAPAY_API_KEY}`
        },
        timeout: 10_000
      }
    );

    const invoice = response.data;
    pendingOrders.set(invoice.invoice_id, {
      chatId: String(chatId),
      packageId,
      amount,
      currency
    });

    return res.json({
      paymentUrl: invoice.invoice_url,
      invoiceId: invoice.invoice_id
    });
  } catch (error) {
    console.error('Failed to create OxaPay invoice', error?.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to create payment order' });
  }
});

/**
 * OxaPay webhook receiver.
 */
app.post('/api/oxapay/webhook', async (req, res) => {
  const signature = req.headers['x-oxapay-signature'];
  const payload = req.body;

  if (!verifyOxaPaySignature(payload, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { status, invoice_id: invoiceId, custom } = payload;
  if (status !== 'completed') {
    return res.status(202).json({ status: 'ignored', reason: 'payment not completed' });
  }

  const orderInfo = pendingOrders.get(invoiceId) || pendingOrders.get(custom?.chatId);
  if (!orderInfo) {
    return res.status(404).json({ error: 'Order not found for invoice' });
  }

  const key = generateActivationKey();
  activationKeys.set(key, {
    chatId: orderInfo.chatId,
    packageId: orderInfo.packageId,
    createdAt: new Date().toISOString()
  });

  try {
    if (bot) {
      await bot.sendMessage(orderInfo.chatId, [
        '✅ *تم استقبال دفعتك بنجاح*',
        '',
        `الباقة: ${orderInfo.packageId}`,
        `مفتاح التفعيل: \`${key}\``,
        '',
        'أرسل المفتاح داخل البوت لتفعيل اشتراكك. المفتاح يستخدم مرة واحدة فقط.'
      ].join('\n'), { parse_mode: 'Markdown' });
    }
  } catch (botError) {
    console.error('Failed to send Telegram message', botError.message);
  }

  pendingOrders.delete(invoiceId);
  pendingOrders.delete(orderInfo.chatId);

  return res.json({ status: 'ok' });
});

/**
 * Endpoint for the Telegram bot to verify a key.
 * Expected payload: { chatId, activationKey }
 */
app.post('/api/telegram/verify-key', (req, res) => {
  const { chatId, activationKey } = req.body || {};
  if (!chatId || !activationKey) {
    return res.status(400).json({ error: 'chatId and activationKey are required' });
  }

  const keyInfo = activationKeys.get(activationKey);
  if (!keyInfo) {
    return res.status(404).json({ status: 'invalid' });
  }

  if (String(keyInfo.chatId) !== String(chatId)) {
    return res.status(403).json({ status: 'mismatch' });
  }

  activationKeys.delete(activationKey);
  return res.json({ status: 'valid', packageId: keyInfo.packageId });
});

/**
 * Health check
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(CLIENT_ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

