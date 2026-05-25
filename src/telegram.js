const https = require('https');
const config = require('./config');

class TelegramBot {
  constructor(token) {
    this.token = token;
    this.offset = 0;
    this.running = false;
    this.handlers = { text: null, callback: null };
  }

  /** Make a Telegram Bot API request */
  api(method, body = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(chunks);
            if (!json.ok) reject(new Error(json.description || 'API error'));
            else resolve(json.result);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('API timeout')); });
      req.write(data);
      req.end();
    });
  }

  /** Send a text message */
  async sendMessage(chatId, text, opts = {}) {
    // Truncate if too long
    if (text.length > config.telegramMaxLength) {
      text = text.substring(0, config.telegramMaxLength - 20) + '\n...(truncated)';
    }
    return this.api('sendMessage', { chat_id: chatId, text, ...opts });
  }

  /** Edit a message */
  async editMessage(chatId, messageId, text) {
    if (text.length > config.telegramMaxLength) {
      text = text.substring(0, config.telegramMaxLength - 20) + '\n...(truncated)';
    }
    return this.api('editMessageText', { chat_id: chatId, message_id: messageId, text });
  }

  /** Delete a message */
  async deleteMessage(chatId, messageId) {
    return this.api('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }

  /** Send a photo */
  async sendPhoto(chatId, photoBuffer) {
    return new Promise((resolve, reject) => {
      const boundary = '----FormBoundary' + Date.now();
      const header = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`;
      const footer = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(header), photoBuffer, Buffer.from(footer)]);

      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.token}/sendPhoto`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(chunks);
            if (!json.ok) reject(new Error(json.description));
            else resolve(json.result);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Send message with inline keyboard */
  async sendWithKeyboard(chatId, text, buttons) {
    return this.api('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] },
    });
  }

  /** Answer callback query */
  async answerCallback(callbackId, text) {
    return this.api('answerCallbackQuery', { callback_query_id: callbackId, text });
  }

  /** Register text message handler */
  onText(handler) { this.handlers.text = handler; }

  /** Register callback query handler */
  onCallback(handler) { this.handlers.callback = handler; }

  /** Start long polling */
  async start() {
    // Clear pending updates
    await this.api('deleteWebhook', { drop_pending_updates: true });

    const me = await this.api('getMe');
    console.log(`✅ Bot started: @${me.username}`);
    console.log('📱 Send a message on Telegram to get started!\n');

    this.running = true;
    this._poll();
  }

  /** Stop polling */
  stop() { this.running = false; }

  async _poll() {
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;

          if (update.message?.text && this.handlers.text) {
            const msg = update.message;
            // Auth check
            if (String(msg.from.id) !== config.allowedUserId) {
              await this.sendMessage(msg.chat.id, '⛔ Unauthorized');
              continue;
            }
            console.log(`📩 Message from ${msg.from.first_name}: "${msg.text}"`);
            try {
              await this.handlers.text(msg);
            } catch (handlerErr) {
              console.error(`❌ Handler error: ${handlerErr.message}`);
              console.error(handlerErr.stack);
              await this.sendMessage(msg.chat.id, `❌ Error: ${handlerErr.message}`).catch(() => {});
            }
          }

          if (update.callback_query && this.handlers.callback) {
            console.log(`🔘 Callback: ${update.callback_query.data}`);
            try {
              await this.handlers.callback(update.callback_query);
            } catch (handlerErr) {
              console.error(`❌ Callback handler error: ${handlerErr.message}`);
            }
          }
        }
      } catch (err) {
        if (err.message !== 'API timeout') {
          console.error('⚠️  Polling error:', err.message);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}

module.exports = new TelegramBot(config.botToken);
