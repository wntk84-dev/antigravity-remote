const { Bot, InputFile, InlineKeyboard } = require('grammy');
const config = require('./config');
const cdp = require('./cdp');
const monitor = require('./monitor');
const { captureScreenshot } = require('./screenshot');
const { htmlToTelegram, splitMessage } = require('./formatter');

function createBot() {
  const bot = new Bot(config.botToken);

  // ── Debug: log every incoming update ──
  bot.use(async (ctx, next) => {
    const update = ctx.update;
    console.log(`📩 Update received: type=${ctx.updateType}, keys=${Object.keys(update).join(',')}`);
    console.log(`   raw update: ${JSON.stringify(update).substring(0, 300)}`);
    return next();
  });

  // ── Auth middleware ──
  bot.use(async (ctx, next) => {
    const userId = String(ctx.from?.id || '');
    if (userId !== config.allowedUserId) {
      console.log(`⛔ Unauthorized user: ${userId}`);
      return ctx.reply('⛔ Unauthorized');
    }
    return next();
  });

  // ── /start ──
  bot.command('start', (ctx) => {
    ctx.reply(
      '🚀 *Antigravity Remote*\n\n' +
      'Antigravity IDE를 텔레그램에서 제어합니다\\.\n\n' +
      '📝 메시지를 보내면 Antigravity에 전달됩니다\\.\n' +
      '📸 /screenshot \\- 화면 캡처\n' +
      '📊 /status \\- 연결 상태\n' +
      '🛑 /stop \\- 생성 중단',
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── /status ──
  bot.command('status', async (ctx) => {
    try {
      await cdp.connect();
      const title = await cdp.evaluate('document.title');
      await ctx.reply(`✅ Connected\n📄 ${title || '(untitled)'}`);
    } catch (err) {
      await ctx.reply(`❌ Disconnected\n${err.message}`);
    }
  });

  // ── /screenshot ──
  bot.command('screenshot', async (ctx) => {
    try {
      const status = await ctx.reply('📸 Capturing...');
      const png = await captureScreenshot();
      await ctx.replyWithPhoto(new InputFile(png, 'screenshot.png'));
      await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ Screenshot failed: ${err.message}`);
    }
  });

  // ── /stop ──
  bot.command('stop', async (ctx) => {
    try {
      monitor.stop();
      // Try to click stop button in Antigravity
      await cdp.evaluate(`(() => {
        const btn = document.querySelector('button[aria-label="Stop generation"], button[aria-label*="stop"], button[aria-label*="Stop"]');
        if (btn) { btn.click(); return true; }
        // Fallback: press Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        return false;
      })()`);
      await ctx.reply('🛑 Stopped');
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  // ── Handle text messages ──
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // Ignore unknown commands

    let statusMsg;
    try {
      // Connect and send
      await cdp.connect();
      statusMsg = await ctx.reply('⏳ Sending...');
      await cdp.sendMessage(text);

      // Update status
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '🧠 Thinking...');

      // Start monitoring
      monitor.start();

      // Phase updates
      const onPhase = async (phase) => {
        if (phase === 'generating') {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '✍️ Generating...').catch(() => {});
        }
      };

      // Progress updates (streaming)
      const onProgress = async ({ elapsed, chars }) => {
        await ctx.api.editMessageText(
          ctx.chat.id, statusMsg.message_id,
          `✍️ Generating... (${elapsed}s, ${chars} chars)`
        ).catch(() => {});
      };

      // Approval request
      const onApproval = async () => {
        const keyboard = new InlineKeyboard()
          .text('✅ Allow', 'approve_allow')
          .text('❌ Deny', 'approve_deny');
        await ctx.reply('⚠️ Antigravity is requesting approval', { reply_markup: keyboard });
      };

      // Completion
      const onComplete = ({ html, text: responseText, elapsed }) => {
        cleanup();

        const formatted = htmlToTelegram(html, responseText);
        const chunks = splitMessage(formatted);

        // Delete status message
        ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

        // Send response chunks
        (async () => {
          for (const chunk of chunks) {
            try {
              await ctx.reply(chunk);
            } catch {
              // If formatting fails, send as plain text
              await ctx.reply(chunk, { parse_mode: undefined });
            }
          }
          // Footer with timing
          if (chunks.length > 0) {
            await ctx.reply(`⏱️ ${elapsed}s`);
          }
        })();
      };

      const cleanup = () => {
        monitor.off('phase', onPhase);
        monitor.off('progress', onProgress);
        monitor.off('approval', onApproval);
        monitor.off('complete', onComplete);
      };

      monitor.on('phase', onPhase);
      monitor.on('progress', onProgress);
      monitor.on('approval', onApproval);
      monitor.on('complete', onComplete);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (monitor.phase !== 'idle' && monitor.phase !== 'complete') {
          cleanup();
          monitor.stop();
          ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '⏰ Timeout (5min)').catch(() => {});
        }
      }, 5 * 60 * 1000);

    } catch (err) {
      const errMsg = `❌ Error: ${err.message}`;
      if (statusMsg) {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errMsg).catch(() => {});
      } else {
        await ctx.reply(errMsg);
      }
    }
  });

  // ── Approval button callbacks ──
  bot.callbackQuery('approve_allow', async (ctx) => {
    try {
      await cdp.clickButton('Allow');
      await ctx.answerCallbackQuery({ text: '✅ Allowed' });
      await ctx.editMessageText('✅ Approved — Allow');
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `❌ ${err.message}` });
    }
  });

  bot.callbackQuery('approve_deny', async (ctx) => {
    try {
      await cdp.clickButton('Deny');
      await ctx.answerCallbackQuery({ text: '❌ Denied' });
      await ctx.editMessageText('❌ Denied');
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `❌ ${err.message}` });
    }
  });

  return bot;
}

module.exports = { createBot };
