const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  botToken: process.env.BOT_TOKEN,
  allowedUserId: process.env.ALLOWED_USER_ID,
  cdpPort: parseInt(process.env.CDP_PORT || '9222', 10),
  cdpHost: '127.0.0.1',

  // DOM selectors (verified via direct CDP probe)
  selectors: {
    chatInput: 'div[role="combobox"][contenteditable="true"][aria-label="Message input"]',
    submitButton: 'button[aria-label="Send message"]',
  },

  // Polling intervals
  monitorIntervalMs: 800,
  streamUpdateIntervalMs: 2000,

  // Telegram message length limit
  telegramMaxLength: 4096,
};

if (!config.botToken) {
  console.error('❌ BOT_TOKEN is not set in .env');
  process.exit(1);
}

if (!config.allowedUserId) {
  console.error('❌ ALLOWED_USER_ID is not set in .env');
  process.exit(1);
}

module.exports = config;
