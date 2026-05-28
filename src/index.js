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

let selectedProjectUrl = null;
let selectedProjectTitle = null;

console.log(`
  ╔══════════════════════════════════╗
  ║   Antigravity Remote  v1.0.0    ║
  ║   Telegram → Antigravity CDP    ║
  ╚══════════════════════════════════╝
`);

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
      ...optionButtons.map(b => [{ text: b.text, callback_data: b.data }]),
      actionButtons.map(b => ({ text: b.text, callback_data: b.data }))
    ]
  };

  console.log(`  [bot] sendApprovalKeyboard: targetMessageId=${targetMessageId}, selectedOptionIdx=${selectedOptionIdx}`);
  console.log(`  [bot] sendApprovalKeyboard buttons:`, JSON.stringify(keyboard.inline_keyboard));

  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let text = '⚠️ <b>Antigravity에서 권한 승인을 요청합니다.</b>\n옵션을 선택한 후 실행해 주세요.';
  if (headerText) {
    text = `⚠️ <b>권한 승인 요청 감지</b>\n\n💬 <b>요청 내용</b>:\n<code>${esc(headerText)}</code>\n\n옵션을 선택한 후 실행해 주세요.`;
  }

  if (targetMessageId) {
    await tg.api('editMessageText', {
      chat_id: targetChatId,
      message_id: targetMessageId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    }).catch((err) => {
      console.error('  [index] ❌ editMessageText error:', err.message);
    });
  } else {
    const sent = await tg.api('sendMessage', {
      chat_id: targetChatId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    activeApprovalMsgId = sent.message_id;
    if (approvalOptions && approvalOptions.length > 0) {
      lastSelectedOption = approvalOptions[selectedOptionIdx];
    }
  }
};

async function main() {
  // Test CDP connection
  try {
    await cdp.connect();
    // ⚡ 최초 1회: 봇 재기동 시 브라우저의 구형 캐시 플래그를 강제 정화하여 신형 matchedText 감지기가 무조건 새로 주입되도록 보장합니다.
    await cdp.evaluate(`(() => {
      window.antigravityObserverActive = false;
      if (window.antigravityCheckTimeout) clearTimeout(window.antigravityCheckTimeout);
    })()`).catch(() => {});
    
    const title = await cdp.evaluate('document.title');
    console.log(`✅ CDP connected: "${title}"`);
  } catch (err) {
    console.warn(`⚠️  CDP not available yet: ${err.message}`);
  }

  // ⚡ Global reactive spontaneous approval listener!
  cdp.on('approval_event', async (payload) => {
    try {
      const chatId = config.allowedUserId;
      if (payload.event === 'approval_opened') {
        const buttonTexts = payload.buttons;
        const headerText = payload.header || '';
        const approvalKey = buttonTexts.join(',') + '|' + headerText;

        if (approvalKey === monitor.lastSettledApprovalKey) {
          return;
        }
        if (approvalKey === monitor.lastApprovalKey && activeApprovalMsgId) {
          return; // Already sent
        }

        console.log(`  [approval] Global approval request captured: ${buttonTexts.join(', ')}`);
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

        // Fallbacks
        if (approvalOptions.length === 0) approvalOptions = buttonTexts.slice(0, 1);
        if (approvalActions.length === 0) approvalActions = buttonTexts.slice(1);

        selectedOptionIdx = 0;
        monitor.lastApprovalKey = approvalKey;
        monitor.approvalActive = true;

        // Clean up previous spontaneous visual message if any
        if (activeApprovalMsgId) {
          await tg.deleteMessage(chatId, activeApprovalMsgId).catch(() => {});
        }

        await sendApprovalKeyboard(chatId, null, activeApprovalHeader);
      } else if (payload.event === 'approval_resolved') {
        if (monitor.approvalActive) {
          console.log(`  [approval] Global approval resolved/closed.`);
          monitor.approvalActive = false;
          
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
            activeApprovalMsgId = null;
            lastSelectedOption = '';
            lastSelectedAction = '';
          }
        }
        monitor.lastApprovalKey = '';
        monitor.lastSettledApprovalKey = '';
      }
    } catch (err) {
      console.error('❌ Error in global approval handler:', err);
    }
  });

  // ── Text message handler ──
  tg.onText(async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Commands
    if (text === '/start') {
      return tg.sendMessage(chatId,
        '🚀 *Antigravity Remote*\n\n' +
        '📂 /project - 대화할 프로젝트 선택\n' +
        '📝 메시지를 보내면 선택한 프로젝트의 Antigravity에 전달됩니다.\n' +
        '📸 /screenshot - 화면 캡처\n' +
        '📊 /status - 연결 상태\n' +
        '🛑 /stop - 생성 중단\n' +
        '🆕 /new - 새 대화 세션 생성\n' +
        '🔄 /sync - 뮤타젠 동기화 세션 제어\n' +
        '🐙 /git - Git 상태 조회 및 자동 커밋',
        { parse_mode: 'Markdown' }
      );
    }

    if (text === '/sync' || text === '/mutagen') {
      const { exec } = require('child_process');
      return exec('mutagen sync list', (err, stdout, stderr) => {
        if (err) {
          return tg.sendMessage(chatId, `❌ Mutagen sync list 조회 실패: ${err.message}`);
        }
        
        // Parse Mutagen Output
        const sessions = [];
        const blocks = stdout.split('--------------------------------------------------------------------------------');
        
        blocks.forEach(block => {
          if (!block.trim()) return;
          
          const idMatch = block.match(/Identifier:\s*(.+)/);
          const nameMatch = block.match(/Name:\s*(.+)/);
          const statusMatch = block.match(/Status:\s*\[?([a-zA-Z]+)\]?/);
          const alphaMatch = block.match(/Alpha:\s*\n\s*URL:\s*(.+)/);
          const betaMatch = block.match(/Beta:\s*\n\s*URL:\s*(.+)/);
          
          if (idMatch) {
            sessions.push({
              id: idMatch[1].trim(),
              name: nameMatch ? nameMatch[1].trim() : '이름없음',
              status: statusMatch ? statusMatch[1].trim() : 'Unknown',
              alpha: alphaMatch ? alphaMatch[1].trim() : 'Unknown',
              beta: betaMatch ? betaMatch[1].trim() : 'Unknown'
            });
          }
        });
        
        if (sessions.length === 0) {
          return tg.sendMessage(chatId, '📂 **Mutagen 동기화 세션**\n\n등록된 동기화 세션이 없습니다.');
        }
        
        let responseText = '📂 **Mutagen 동기화 세션 현황**\n\n';
        const buttons = [];
        
        sessions.forEach((s, idx) => {
          const isPaused = s.status.toLowerCase().includes('paused');
          const statusEmoji = isPaused ? '⏸️' : '▶️';
          
          responseText += `🔹 **세션 ${idx + 1}: ${s.name}**\n` +
                          ` • ID: \`${s.id.substring(0, 8)}...\`\n` +
                          ` • 상태: ${statusEmoji} **${s.status}**\n` +
                          ` • Alpha: \`${s.alpha.split('/').pop()}\`\n` +
                          ` • Beta: \`${s.beta.includes(':') ? s.beta.split(':').pop() : s.beta}\`\n\n`;
                          
          const btnLabel = isPaused ? `▶️ Resume: ${s.name}` : `⏸️ Pause: ${s.name}`;
          const btnAction = isPaused ? `resume` : `pause`;
          const target = s.name === '이름없음' ? s.id : s.name;
          
          buttons.push({
            text: btnLabel,
            data: `mutagen:${btnAction}:${target}`
          });
        });
        
        // Add All Resume/Pause buttons
        const hasPaused = sessions.some(s => s.status.toLowerCase().includes('paused'));
        const allBtn = hasPaused ? 
          { text: '▶️ Resume All Sessions', data: 'mutagen:resume_all' } : 
          { text: '⏸️ Pause All Sessions', data: 'mutagen:pause_all' };
          
        const keyboard = {
          inline_keyboard: [
            ...buttons.map(b => [{ text: b.text, callback_data: b.data }]),
            [{ text: allBtn.text, callback_data: allBtn.data }]
          ]
        };
        
        return tg.api('sendMessage', {
          chat_id: chatId,
          text: responseText,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      });
    }

    if (text === '/git') {
      const { exec } = require('child_process');
      return exec('git status -s && git log -n 1 --oneline', (err, stdout, stderr) => {
        if (err) {
          return tg.sendMessage(chatId, `❌ Git status 조회 실패: ${err.message}`);
        }
        
        const lines = stdout.trim().split('\n');
        const latestCommit = lines.length > 0 ? lines.pop() : 'No commit found';
        const changedFiles = lines.filter(l => l.trim() !== '');
        
        let responseText = '🐙 **Git Repository 상태 요약**\n\n';
        responseText += `📌 **최신 커밋**: \`${latestCommit}\`\n\n`;
        
        if (changedFiles.length === 0) {
          responseText += '✅ **깨끗한 워크스페이스**: 변경된 파일이 없습니다.';
        } else {
          responseText += `⚠️ **수정된 파일 (${changedFiles.length}개)**:\n`;
          changedFiles.slice(0, 15).forEach(f => {
            responseText += ` • \`${f}\`\n`;
          });
          if (changedFiles.length > 15) {
            responseText += ` • 외 ${changedFiles.length - 15}개의 파일이 더 있습니다.\n`;
          }
        }
        
        const keyboard = {
          inline_keyboard: [
            [{ text: '🔍 상세 Git Status 조회', callback_data: 'git:status_full' }],
            [{ text: '📦 git add . & commit (Auto)', callback_data: 'git:commit_auto' }]
          ]
        };
        
        return tg.api('sendMessage', {
          chat_id: chatId,
          text: responseText,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      });
    }

    if (text === '/project') {
      try {
        const pages = await cdp.getPagesList();
        if (pages.length === 0) {
          return tg.sendMessage(chatId, '❌ 활성화된 Antigravity 프로젝트 창을 발견하지 못했습니다.\nAntigravity 앱이 실행 중이고 프로젝트가 열려 있는지 확인해 주세요.');
        }

        const allConversations = [];

        await Promise.all(pages.map(async (page) => {
          try {
            const tempClient = new cdp.constructor();
            await tempClient.connect(page.webSocketDebuggerUrl);
            
            const list = await tempClient.evaluate(`(() => {
              const h2 = Array.from(document.querySelectorAll('h2')).find(el => el.innerText.trim() === 'Projects');
              if (!h2) return [];
              const parent = h2.parentElement.parentElement;
              if (!parent) return [];
              
              const results = [];
              const items = parent.querySelectorAll('[role="button"]');
              let currentProject = 'workspace';
              
              items.forEach(item => {
                const text = (item.innerText || '').trim();
                if (!text) return;
                
                if (item.getAttribute('data-project-card') === 'true') {
                  currentProject = text;
                } else if (item.className.includes('ml-[')) {
                  const title = text.split('\\n')[0].trim();
                  results.push({
                    title: title,
                    fullText: text
                  });
                }
              });
              return results;
            })()`);
            
            await tempClient.ws.close();
            
            if (list && list.length > 0) {
              list.forEach(item => {
                allConversations.push({
                  webSocketDebuggerUrl: page.webSocketDebuggerUrl,
                  project: 'workspace',
                  title: item.title,
                  type: 'conversation'
                });
              });
            }
          } catch (e) {
            console.error('Failed to scan sidebar conversations:', e.message);
          }
        }));

        // Fallback to simple page titles if no sidebar conversations are detected
        if (allConversations.length === 0) {
          pages.forEach(p => {
            let t = p.title || '글로벌 대화방';
            if (t.includes(' — ')) t = t.split(' — ')[0].trim();
            allConversations.push({
              webSocketDebuggerUrl: p.webSocketDebuggerUrl,
              project: 'workspace',
              title: t,
              type: 'page'
            });
          });
        }

        const keyboard = {
          inline_keyboard: allConversations.map((convo, idx) => {
            let displayTitle = convo.title;
            if (displayTitle.length > 25) {
              displayTitle = displayTitle.substring(0, 23) + '...';
            }
            
            const isSelected = convo.webSocketDebuggerUrl === selectedProjectUrl && convo.title === selectedProjectTitle;
            
            return [{
              text: isSelected ? `🔘 ${displayTitle}` : `⚪️ ${displayTitle}`,
              callback_data: `selectproject:${idx}`
            }];
          })
        };

        global.lastCdpConversationsList = allConversations;

        return tg.api('sendMessage', {
          chat_id: chatId,
          text: `📂 **대화방 선택**\n\n현재 열려 있는 프로젝트의 대화방 목록입니다. 대화할 방을 선택해 주세요.`,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } catch (err) {
        return tg.sendMessage(chatId, `❌ 대화방 목록 조회 실패: ${err.message}`);
      }
    }

    if (text === '/status') {
      try {
        if (!selectedProjectUrl) {
          return tg.sendMessage(chatId, `⚠️ 연결 상태: Disconnected (프로젝트 미선택)\n/project 명령어를 사용하여 프로젝트를 선택해 주세요.`);
        }
        await cdp.connect(selectedProjectUrl);
        return tg.sendMessage(chatId, `✅ 연결 상태: Connected\n📂 활성 프로젝트: *${selectedProjectTitle}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        return tg.sendMessage(chatId, `❌ Disconnected\n${err.message}`);
      }
    }

    if (text === '/screenshot') {
      if (!selectedProjectUrl) {
        return tg.sendMessage(chatId, '⚠️ 프로젝트를 먼저 선택해 주세요. (/project)');
      }
      try {
        const status = await tg.sendMessage(chatId, '📸 Capturing...');
        await cdp.connect(selectedProjectUrl);
        const png = await cdp.screenshot();
        await tg.sendPhoto(chatId, png);
        await tg.deleteMessage(chatId, status.message_id);
      } catch (err) {
        return tg.sendMessage(chatId, `❌ Screenshot failed: ${err.message}`);
      }
      return;
    }

    if (text === '/stop') {
      if (!selectedProjectUrl) {
        return tg.sendMessage(chatId, '⚠️ 프로젝트를 먼저 선택해 주세요. (/project)');
      }
      monitor.stop();
      try {
        await cdp.connect(selectedProjectUrl);
        await cdp.evaluate(`(() => {
          const btn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="stop"]');
          if (btn) btn.click();
        })()`);
      } catch {}
      return tg.sendMessage(chatId, '🛑 Stopped');
    }

    if (text === '/new' || text === '/newchat') {
      if (!selectedProjectUrl) {
        return tg.sendMessage(chatId, '⚠️ 프로젝트를 먼저 선택해 주세요. (/project)');
      }
      try {
        await cdp.connect(selectedProjectUrl);
        const res = await cdp.createNewSession();
        if (res?.ok) {
          return tg.sendMessage(chatId, '🆕 새로운 대화 세션이 성공적으로 생성되었습니다!');
        } else {
          return tg.sendMessage(chatId, `❌ 새 세션 생성 실패: ${res?.error || '알 수 없는 오류'}`);
        }
      } catch (err) {
        return tg.sendMessage(chatId, `❌ 오류 발생: ${err.message}`);
      }
    }

    if (text === '/model') {
      if (!selectedProjectUrl) {
        return tg.sendMessage(chatId, '⚠️ 프로젝트를 먼저 선택해 주세요. (/project)');
      }
      try {
        await cdp.connect(selectedProjectUrl);
        const res = await cdp.getAvailableModels();
        const currentModel = res?.current || '알 수 없음';
        const options = res?.options || [];
        
        if (options.length === 0) {
          return tg.sendMessage(chatId, `🤖 현재 선택된 모델: *${currentModel}*\n\n⚠️ 화면에서 선택 가능한 모델 드롭다운을 발견하지 못했습니다.`, { parse_mode: 'Markdown' });
        }
        
        const keyboard = {
          inline_keyboard: options.map(opt => [{
            text: opt === currentModel ? `🔘 ${opt}` : `⚪️ ${opt}`,
            callback_data: `changemodel:${opt}`
          }])
        };
        
        return tg.api('sendMessage', {
          chat_id: chatId,
          text: `🤖 **모델 변경 모드**\n\n현재 활성화된 모델: *${currentModel}*\n\n변경할 모델을 아래 목록에서 선택해 주세요.`,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } catch (err) {
        return tg.sendMessage(chatId, `❌ 모델 정보 조회 실패: ${err.message}`);
      }
    }

    if (text.startsWith('/')) return; // Ignore unknown commands

    if (!selectedProjectUrl) {
      return tg.sendMessage(chatId, '⚠️ 작업할 프로젝트가 선택되지 않았습니다.\n\n먼저 `/project` 명령어를 사용하여 대화할 프로젝트를 선택해 주세요.', { parse_mode: 'Markdown' });
    }

    // ── Send message to Antigravity ──
    let statusMsg;
    try {
      console.log('  [1] Connecting to CDP...');
      await cdp.connect(selectedProjectUrl);
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

      const onComplete = async ({ html, text: responseText, elapsed }) => {
        try {
          cleanup();
          console.log(`  [response] Sending ${responseText.length} chars to Telegram...`);
          const formatted = htmlToTelegram(html, responseText);
          const chunks = splitMessage(formatted);

          await tg.deleteMessage(chatId, statusMsg.message_id);

          for (const chunk of chunks) {
            try {
              await tg.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
            } catch (err) {
              console.warn('⚠️ Markdown rendering failed, falling back to plain text:', err.message);
              await tg.sendMessage(chatId, chunk);
            }
          }
          if (chunks.length > 0) {
            await tg.sendMessage(chatId, `⏱️ ${elapsed}s`);
          }
          console.log(`  [response] ✅ Sent to Telegram!`);
        } catch (err) {
          console.error('❌ Error in onComplete handler:', err);
        }
      };

      const cleanup = () => {
        monitor.off('phase', onPhase);
        monitor.off('progress', onProgress);
        monitor.off('complete', onComplete);
      };

      // Prevent listener duplication leak by removing all legacy listeners before registering new ones!
      monitor.removeAllListeners('phase');
      monitor.removeAllListeners('progress');
      monitor.removeAllListeners('complete');

      // Register listeners BEFORE starting monitor
      monitor.on('phase', onPhase);
      monitor.on('progress', onProgress);
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
      // ── Mutagen Callback Commands ──
      if (query.data.startsWith('mutagen:')) {
        const parts = query.data.split(':');
        const action = parts[1];
        const target = parts[2];
        const { exec } = require('child_process');
        
        let cmd = '';
        if (action === 'resume_all') {
          cmd = 'mutagen sync resume --all';
          await tg.answerCallback(query.id, '▶️ 모든 세션 재개 중...');
        } else if (action === 'pause_all') {
          cmd = 'mutagen sync pause --all';
          await tg.answerCallback(query.id, '⏸️ 모든 세션 일시정지 중...');
        } else if (action === 'resume') {
          cmd = `mutagen sync resume ${target}`;
          await tg.answerCallback(query.id, `▶️ ${target} 세션 재개 중...`);
        } else if (action === 'pause') {
          cmd = `mutagen sync pause ${target}`;
          await tg.answerCallback(query.id, `⏸️ ${target} 세션 일시정지 중...`);
        }
        
        console.log(`  [bot] Executing Mutagen control: "${cmd}"`);
        
        return exec(cmd, (err, stdout, stderr) => {
          if (err) {
            return tg.sendMessage(query.message.chat.id, `❌ Mutagen 제어 실패: ${err.message}`);
          }
          
          // Refresh Mutagen status card
          return exec('mutagen sync list', async (listErr, listStdout) => {
            if (listErr) {
              return tg.sendMessage(query.message.chat.id, `✅ 명령은 실행되었으나 상태 갱신 실패: ${listErr.message}`);
            }
            
            const sessions = [];
            const blocks = listStdout.split('--------------------------------------------------------------------------------');
            blocks.forEach(block => {
              if (!block.trim()) return;
              const idMatch = block.match(/Identifier:\s*(.+)/);
              const nameMatch = block.match(/Name:\s*(.+)/);
              const statusMatch = block.match(/Status:\s*\[?([a-zA-Z]+)\]?/);
              const alphaMatch = block.match(/Alpha:\s*\n\s*URL:\s*(.+)/);
              const betaMatch = block.match(/Beta:\s*\n\s*URL:\s*(.+)/);
              if (idMatch) {
                sessions.push({
                  id: idMatch[1].trim(),
                  name: nameMatch ? nameMatch[1].trim() : '이름없음',
                  status: statusMatch ? statusMatch[1].trim() : 'Unknown',
                  alpha: alphaMatch ? alphaMatch[1].trim() : 'Unknown',
                  beta: betaMatch ? betaMatch[1].trim() : 'Unknown'
                });
              }
            });
            
            let responseText = `✅ **Mutagen 동기화 상태 변경 완료**\n\n`;
            const buttons = [];
            
            sessions.forEach((s, idx) => {
              const isPaused = s.status.toLowerCase().includes('paused');
              const statusEmoji = isPaused ? '⏸️' : '▶️';
              
              responseText += `🔹 **세션 ${idx + 1}: ${s.name}**\n` +
                              ` • ID: \`${s.id.substring(0, 8)}...\`\n` +
                              ` • 상태: ${statusEmoji} **${s.status}**\n` +
                              ` • Alpha: \`${s.alpha.split('/').pop()}\`\n` +
                              ` • Beta: \`${s.beta.includes(':') ? s.beta.split(':').pop() : s.beta}\`\n\n`;
                              
              const btnLabel = isPaused ? `▶️ Resume: ${s.name}` : `⏸️ Pause: ${s.name}`;
              const btnAction = isPaused ? `resume` : `pause`;
              const targetSession = s.name === '이름없음' ? s.id : s.name;
              
              buttons.push({
                text: btnLabel,
                data: `mutagen:${btnAction}:${targetSession}`
              });
            });
            
            const hasPaused = sessions.some(s => s.status.toLowerCase().includes('paused'));
            const allBtn = hasPaused ? 
              { text: '▶️ Resume All Sessions', data: 'mutagen:resume_all' } : 
              { text: '⏸️ Pause All Sessions', data: 'mutagen:pause_all' };
              
            const keyboard = {
              inline_keyboard: [
                ...buttons.map(b => [{ text: b.text, callback_data: b.data }]),
                [{ text: allBtn.text, callback_data: allBtn.data }]
              ]
            };
            
            await tg.api('editMessageText', {
              chat_id: query.message.chat.id,
              message_id: query.message.message_id,
              text: responseText,
              parse_mode: 'Markdown',
              reply_markup: keyboard
            }).catch(() => {});
          });
        });
      }

      // ── Git Callback Commands ──
      if (query.data.startsWith('git:')) {
        const action = query.data.substring('git:'.length);
        const { exec } = require('child_process');
        
        if (action === 'status_full') {
          await tg.answerCallback(query.id, '🔍 Git Status 상세 조회 중...');
          return exec('git status', (err, stdout) => {
            if (err) return tg.sendMessage(query.message.chat.id, `❌ Git Status 상세 조회 실패: ${err.message}`);
            return tg.sendMessage(query.message.chat.id, `🐙 **Git Status 상세 결과**:\n\n\`\`\`\n${stdout.substring(0, 3000)}\n\`\`\``, { parse_mode: 'Markdown' });
          });
        }
        
        if (action === 'commit_auto') {
          await tg.answerCallback(query.id, '📦 자동 커밋 및 푸시 중...');
          const commitMsg = `wip: auto-committed via Antigravity Remote at ${new Date().toLocaleTimeString()}`;
          const cmd = `git add . && git commit -m "${commitMsg}" && git push`;
          console.log(`  [bot] Executing auto git commit/push: "${cmd}"`);
          
          return exec(cmd, (err, stdout, stderr) => {
            if (err) {
              return tg.sendMessage(query.message.chat.id, `❌ 자동 커밋/푸시 실패: ${err.message}\n${stderr}`);
            }
            return tg.sendMessage(query.message.chat.id, `✅ **자동 커밋 & 푸시 완료!**\n\n\`\`\`\n${stdout.substring(0, 1000)}\n\`\`\``, { parse_mode: 'Markdown' });
          });
        }
      }

      if (query.data.startsWith('selectproject:')) {
        const idx = parseInt(query.data.substring('selectproject:'.length), 10);
        const convos = global.lastCdpConversationsList || [];
        const targetConvo = convos[idx];
        
        if (!targetConvo) {
          return tg.answerCallback(query.id, '❌ 만료된 요청입니다. 다시 /project를 입력해 주세요.');
        }

        const title = targetConvo.title;
        let displayTitle = title;
        if (displayTitle.length > 25) {
          displayTitle = displayTitle.substring(0, 23) + '...';
        }

        selectedProjectUrl = targetConvo.webSocketDebuggerUrl;
        selectedProjectTitle = title;
        cdp.targetUrl = selectedProjectUrl; // Update cdp target URL

        console.log(`  [bot] Project/Conversation selected: "${title}" (${selectedProjectUrl})`);
        
        try {
          await cdp.connect(selectedProjectUrl);
          
          if (targetConvo.type === 'conversation') {
            const clickRes = await cdp.evaluate(`(() => {
              const h2 = Array.from(document.querySelectorAll('h2')).find(el => el.innerText.trim() === 'Projects');
              if (!h2) return { ok: false, error: 'Projects header not found' };
              const parent = h2.parentElement.parentElement;
              if (!parent) return { ok: false, error: 'Projects parent not found' };
              
              const items = parent.querySelectorAll('[role="button"]');
              const targetTitle = ${JSON.stringify(title)};
              
              for (const item of items) {
                const text = (item.innerText || '').trim();
                const title = text.split('\\n')[0].trim();
                if (item.className.includes('ml-[') && (title === targetTitle || title.includes(targetTitle) || targetTitle.includes(title))) {
                  item.click();
                  return { ok: true, clicked: title };
                }
              }
              return { ok: false, error: 'Conversation item not found in sidebar' };
            })()`);
            console.log(`  [cdp] Sidebar click outcome for "${title}":`, clickRes);
          }
          
          await cdp.call('Page.bringToFront');
          console.log(`  [cdp] 🚀 Page.bringToFront and focus successful`);
        } catch (focusErr) {
          console.warn(`  [cdp] ⚠️ Failed to click conversation or focus:`, focusErr.message);
        }

        await tg.answerCallback(query.id, `선택됨: ${displayTitle}`);
        
        await tg.api('editMessageText', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text: `📂 **대화방 선택 완료**\n\n현재 활성화된 대화방: *${displayTitle}*\n\n이제 메시지를 입력하시면 해당 대화방의 Antigravity로 바로 전달됩니다!`,
          parse_mode: 'Markdown'
        });
        return;
      }

      if (query.data.startsWith('changemodel:')) {
        const targetModel = query.data.substring('changemodel:'.length);
        console.log(`  [bot] Changing AI model to: "${targetModel}"`);
        await tg.answerCallback(query.id, `모델 변경 중: ${targetModel}`);
        const res = await cdp.changeAiModel(targetModel);
        if (res?.ok) {
          await tg.api('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: `🤖 **모델 변경 완료**\n\nAI 모델이 성공적으로 *${res.model}* 로 전환되었습니다!`,
            parse_mode: 'Markdown'
          });
        } else {
          await tg.sendMessage(query.message.chat.id, `❌ 모델 변경 실패: ${res?.error}`);
        }
        return;
      }

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
