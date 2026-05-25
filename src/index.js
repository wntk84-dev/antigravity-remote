const config = require('./config');
const cdp = require('./cdp');
const tg = require('./telegram');
const monitor = require('./monitor');
const { htmlToTelegram, splitMessage } = require('./formatter');

let approvalOptions = [];
let approvalActions = [];
let selectedOptionIdx = 0;
let activeApprovalMsgId = null;
let lastSelectedOption = '';
let lastSelectedAction = '';
let activeApprovalHeader = '';

console.log(`
  ╔══════════════════════════════════╗
  ║   Antigravity Remote  v1.0.0    ║
  ║   Telegram → Antigravity CDP    ║
  ╚══════════════════════════════════╝
`);

async function main() {
  // Test CDP connection
  try {
    await cdp.connect();
    const title = await cdp.evaluate('document.title');
    console.log(`✅ CDP connected: "${title}"`);
  } catch (err) {
    console.warn(`⚠️  CDP not available yet: ${err.message}`);
  }

  // ── Text message handler ──
  tg.onText(async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Commands
    if (text === '/start') {
      return tg.sendMessage(chatId,
        '🚀 Antigravity Remote\n\n' +
        '📝 메시지를 보내면 Antigravity에 전달됩니다.\n' +
        '📸 /screenshot - 화면 캡처\n' +
        '📊 /status - 연결 상태\n' +
        '🛑 /stop - 생성 중단'
      );
    }

    if (text === '/status') {
      try {
        await cdp.connect();
        const title = await cdp.evaluate('document.title');
        return tg.sendMessage(chatId, `✅ Connected\n📄 ${title || '(untitled)'}`);
      } catch (err) {
        return tg.sendMessage(chatId, `❌ Disconnected\n${err.message}`);
      }
    }

    if (text === '/screenshot') {
      try {
        const status = await tg.sendMessage(chatId, '📸 Capturing...');
        await cdp.connect();
        const png = await cdp.screenshot();
        await tg.sendPhoto(chatId, png);
        await tg.deleteMessage(chatId, status.message_id);
      } catch (err) {
        return tg.sendMessage(chatId, `❌ Screenshot failed: ${err.message}`);
      }
      return;
    }

    if (text === '/stop') {
      monitor.stop();
      try {
        await cdp.evaluate(`(() => {
          const btn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="stop"]');
          if (btn) btn.click();
        })()`);
      } catch {}
      return tg.sendMessage(chatId, '🛑 Stopped');
    }

    if (text.startsWith('/')) return; // Ignore unknown commands

    // ── Send message to Antigravity ──
    let statusMsg;
    try {
      console.log('  [1] Connecting to CDP...');
      await cdp.connect();
      console.log('  [2] Sending status to Telegram...');
      statusMsg = await tg.sendMessage(chatId, '⏳ Sending...');
      console.log('  [3] Injecting message to Antigravity...');
      await cdp.sendMessage(text);
      console.log('  [4] Message sent! Updating status...');
      const stopKeyboard = {
        inline_keyboard: [[{ text: '🛑 Stop Generation', callback_data: 'action:stop_generation' }]]
      };

      await tg.api('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: '🧠 Thinking...',
        reply_markup: stopKeyboard
      }).catch(() => {});

      const onPhase = async (phase) => {
        try {
          if (phase === 'generating') {
            await tg.api('editMessageText', {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              text: '✍️ Generating...',
              reply_markup: stopKeyboard
            }).catch(() => {});
          }
        } catch (err) {
          console.error('❌ Error in onPhase handler:', err);
        }
      };

      const onProgress = async ({ elapsed, chars, status }) => {
        try {
          let msgText = `✍️ Generating... (${elapsed}s, ${chars} chars)`;
          if (status) {
            msgText += `\n⚙️ 현재 상태: ${status}`;
          }
          await tg.api('editMessageText', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            text: msgText,
            reply_markup: stopKeyboard
          }).catch(() => {});
        } catch (err) {
          console.error('❌ Error in onProgress handler:', err);
        }
      };

      const sendApprovalKeyboard = async (targetChatId, targetMessageId = null, headerText = '') => {
        const optionButtons = approvalOptions.map((text, idx) => ({
          text: `${idx === selectedOptionIdx ? '🔘' : '⚪️'} ${text}`,
          data: `select:${idx}`
        }));

        const actionButtons = approvalActions.map(text => ({
          text: text.toLowerCase().includes('skip') || text.toLowerCase().includes('cancel') || text.toLowerCase().includes('reject') ? `❌ ${text}` : `✅ ${text}`,
          data: `action:${text}`
        }));

        const keyboard = {
          inline_keyboard: [
            optionButtons.map(b => ({ text: b.text, callback_data: b.data })),
            actionButtons.map(b => ({ text: b.text, callback_data: b.data }))
          ]
        };

        let text = '⚠️ Antigravity에서 권한 승인을 요청합니다. 옵션을 선택한 후 실행해 주세요.';
        if (headerText) {
          text = `⚠️ **권한 승인 요청 감지**\n\n💬 **요청 내용**:\n\`\`\`\n${headerText}\n\`\`\`\n옵션을 선택한 후 실행해 주세요.`;
        }

        if (targetMessageId) {
          await tg.api('editMessageText', {
            chat_id: targetChatId,
            message_id: targetMessageId,
            text,
            parse_mode: 'Markdown',
            reply_markup: keyboard
          }).catch(() => {});
        } else {
          const sent = await tg.api('sendMessage', {
            chat_id: targetChatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: keyboard
          });
          activeApprovalMsgId = sent.message_id;
          if (approvalOptions && approvalOptions.length > 0) {
            lastSelectedOption = approvalOptions[selectedOptionIdx];
          }
        }
      };

      const onApproval = async (buttonTexts, headerText) => {
        try {
          console.log(`  [approval] Received approval request with buttons: ${buttonTexts.join(', ')} (Header: ${headerText})`);
          activeApprovalHeader = headerText || '';
          
          const optionKeywords = ['yes, allow this time', 'yes', 'no', 'allow this time', 'deny', 'allow once', '승인', '허용', '거절', '허가'];
          const actionKeywords = ['submit', 'run', 'skip', 'cancel', 'reject', 'close', '확인', '실행'];
          
          approvalOptions = buttonTexts.filter(text => {
            const lower = text.toLowerCase();
            return optionKeywords.some(kw => lower.includes(kw)) && !actionKeywords.some(kw => lower.includes(kw));
          });
          
          approvalActions = buttonTexts.filter(text => {
            const lower = text.toLowerCase();
            return actionKeywords.some(kw => lower.includes(kw));
          });

          // Fallbacks in case classification is empty
          if (approvalOptions.length === 0) {
            approvalOptions = buttonTexts.slice(0, 1);
          }
          if (approvalActions.length === 0) {
            approvalActions = buttonTexts.slice(1);
          }

          selectedOptionIdx = 0; // Default to first option selected

          console.log(`  [approval] Sending stateful keyboard (options: ${approvalOptions.join(', ')} / actions: ${approvalActions.join(', ')})`);
          await sendApprovalKeyboard(chatId, null, activeApprovalHeader);
        } catch (err) {
          console.error('❌ Error in onApproval handler:', err);
        }
      };

      const onComplete = async ({ html, text: responseText, elapsed }) => {
        try {
          cleanup();
          console.log(`  [response] Sending ${responseText.length} chars to Telegram...`);
          const formatted = htmlToTelegram(html, responseText);
          const chunks = splitMessage(formatted);

          await tg.deleteMessage(chatId, statusMsg.message_id);

          for (const chunk of chunks) {
            await tg.sendMessage(chatId, chunk);
          }
          if (chunks.length > 0) {
            await tg.sendMessage(chatId, `⏱️ ${elapsed}s`);
          }
          console.log(`  [response] ✅ Sent to Telegram!`);
        } catch (err) {
          console.error('❌ Error in onComplete handler:', err);
        }
      };

      const onApprovalResolved = async () => {
        try {
          console.log(`  [approval_resolved] Modal closed on IDE. Updating Telegram message (msgId: ${activeApprovalMsgId})...`);
          if (activeApprovalMsgId) {
            let updateText = '';
            if (lastSelectedAction) {
              const isSkipOrCancel = lastSelectedAction.toLowerCase().includes('skip') || 
                                     lastSelectedAction.toLowerCase().includes('cancel') || 
                                     lastSelectedAction.toLowerCase().includes('reject');
              if (isSkipOrCancel) {
                updateText = `❌ 거절/건너뜀 완료: ${lastSelectedAction}`;
              } else {
                updateText = `✅ 최종 승인 완료: ${lastSelectedOption || 'Yes, allow this time'} (${lastSelectedAction})`;
              }
            } else {
              updateText = `✅ Antigravity 브라우저에서 승인 창이 닫혔거나 직접 처리되었습니다.`;
            }

            await tg.api('editMessageText', {
              chat_id: chatId,
              message_id: activeApprovalMsgId,
              text: updateText,
              reply_markup: { inline_keyboard: [] }
            }).catch((err) => {
              console.warn(`  [approval_resolved] editMessageText warn: ${err.message}`);
            });
            
            // 상태 초기화
            activeApprovalMsgId = null;
            lastSelectedOption = '';
            lastSelectedAction = '';
          }
        } catch (err) {
          console.error('❌ Error in onApprovalResolved handler:', err);
        }
      };

      const cleanup = () => {
        monitor.off('phase', onPhase);
        monitor.off('progress', onProgress);
        monitor.off('approval', onApproval);
        monitor.off('approval_resolved', onApprovalResolved);
        monitor.off('complete', onComplete);
        activeApprovalMsgId = null;
        lastSelectedOption = '';
        lastSelectedAction = '';
      };

      // Prevent listener duplication leak by removing all legacy listeners before registering new ones!
      monitor.removeAllListeners('phase');
      monitor.removeAllListeners('progress');
      monitor.removeAllListeners('approval');
      monitor.removeAllListeners('approval_resolved');
      monitor.removeAllListeners('complete');

      // Register listeners BEFORE starting monitor
      monitor.on('phase', onPhase);
      monitor.on('progress', onProgress);
      monitor.on('approval', onApproval);
      monitor.on('approval_resolved', onApprovalResolved);
      monitor.on('complete', onComplete);

      // Start monitoring (async, fires events)
      monitor.start(text);

      // Timeout 5 min
      setTimeout(() => {
        if (monitor.phase !== 'idle' && monitor.phase !== 'complete') {
          cleanup();
          monitor.stop();
          tg.editMessage(chatId, statusMsg.message_id, '⏰ Timeout (5min)').catch(() => {});
        }
      }, 5 * 60 * 1000);

    } catch (err) {
      const errMsg = `❌ Error: ${err.message}`;
      if (statusMsg) {
        await tg.editMessage(chatId, statusMsg.message_id, errMsg).catch(() => {});
      } else {
        await tg.sendMessage(chatId, errMsg);
      }
    }
  });

  // ── Callback query handler ──
  tg.onCallback(async (query) => {
    try {
      if (query.data === 'action:stop_generation') {
        console.log(`  [bot] Stopping generation via Telegram button...`);
        await tg.answerCallback(query.id, '🛑 Stop requested');
        await cdp.evaluate(`(() => {
          const btn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="⌃C"], button[aria-label="Stop generation"], button[aria-label*="stop"], button[aria-label*="Stop"]');
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        })()`).catch(() => {});
        
        await tg.api('editMessageText', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text: '🛑 명령 실행이 중단되었습니다.',
          reply_markup: { inline_keyboard: [] }
        }).catch(() => {});
      } else if (query.data === 'approve_allow') {
        const res = await cdp.clickButton('Allow');
        if (res?.ok) {
          await tg.answerCallback(query.id, '✅ Allowed');
          await tg.api('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: '✅ Approved — Allow',
          });
        } else {
          await tg.answerCallback(query.id, `❌ Failed to click Allow: ${res?.error}`);
        }
      } else if (query.data === 'approve_deny') {
        const res = await cdp.clickButton('Deny');
        if (res?.ok) {
          await tg.answerCallback(query.id, '❌ Denied');
          await tg.api('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: '❌ Denied',
          });
        } else {
          await tg.answerCallback(query.id, `❌ Failed to click Deny: ${res?.error}`);
        }
      } else if (query.data.startsWith('select:')) {
        const idx = parseInt(query.data.substring('select:'.length), 10);
        selectedOptionIdx = idx;
        lastSelectedOption = approvalOptions[idx];
        await tg.answerCallback(query.id, `선택됨: ${approvalOptions[idx]}`);
        await sendApprovalKeyboard(query.message.chat.id, query.message.message_id, activeApprovalHeader);
      } else if (query.data.startsWith('action:')) {
        const actionText = query.data.substring('action:'.length);
        
        const isSkipOrCancel = actionText.toLowerCase().includes('skip') || 
                               actionText.toLowerCase().includes('cancel') || 
                               actionText.toLowerCase().includes('reject');
                               
        if (isSkipOrCancel) {
          console.log(`  [bot] Clicking direct action: "${actionText}"`);
          lastSelectedAction = actionText;
          await tg.answerCallback(query.id, `실행 중: ${actionText}`);
          const res = await cdp.clickButton(actionText);
          if (res?.ok) {
            monitor.lastSettledApprovalKey = monitor.lastApprovalKey; // Mark settled to prevent dual-alerts during modal transition
            const coolingKey = monitor.lastApprovalKey || '';
            await cdp.evaluate(`(() => {
              window.antigravityApprovalCoolingKey = ${JSON.stringify(coolingKey)};
              setTimeout(() => {
                if (window.antigravityApprovalCoolingKey === ${JSON.stringify(coolingKey)}) {
                  window.antigravityApprovalCoolingKey = '';
                }
              }, 1500);
            })()`).catch(() => {});
          } else {
            await tg.sendMessage(query.message.chat.id, `❌ 실행 실패 (${actionText}): ${res?.error}`);
          }
        } else {
          const selectedOption = approvalOptions[selectedOptionIdx];
          if (!selectedOption) {
            return tg.answerCallback(query.id, '❌ 선택된 옵션이 없습니다.');
          }
          
          lastSelectedOption = selectedOption;
          lastSelectedAction = actionText;
          
          console.log(`  [bot] Executing flow: Option "${selectedOption}" -> Action "${actionText}"`);
          await tg.answerCallback(query.id, `제출 중: ${selectedOption} ➔ ${actionText}`);
          
          // Step 1: Click the radio option in the IDE
          const optRes = await cdp.clickButton(selectedOption);
          if (!optRes?.ok) {
            return tg.sendMessage(query.message.chat.id, `❌ 옵션 선택 실패 (${selectedOption}): ${optRes?.error}`);
          }
          
          // Step 2: Click the submit/action button in the IDE
          console.log(`  [bot] Option selected. Auto-clicking action "${actionText}" in 350ms...`);
          await new Promise((r) => setTimeout(r, 350));
          
          const actRes = await cdp.clickButton(actionText);
          if (actRes?.ok) {
            monitor.lastSettledApprovalKey = monitor.lastApprovalKey; // Mark settled to prevent dual-alerts during modal transition
            const coolingKey = monitor.lastApprovalKey || '';
            await cdp.evaluate(`(() => {
              window.antigravityApprovalCoolingKey = ${JSON.stringify(coolingKey)};
              setTimeout(() => {
                if (window.antigravityApprovalCoolingKey === ${JSON.stringify(coolingKey)}) {
                  window.antigravityApprovalCoolingKey = '';
                }
              }, 1500);
            })()`).catch(() => {});
          } else {
            await tg.sendMessage(query.message.chat.id, `❌ 제출 실패 (${actionText}): ${actRes?.error}`);
          }
        }
      }
    } catch (err) {
      await tg.answerCallback(query.id, `❌ ${err.message}`);
    }
  });

  // Start bot
  await tg.start();
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  tg.stop();
  cdp.disconnect();
  process.exit(0);
});
