const { EventEmitter } = require('events');
const cdp = require('./cdp');
const config = require('./config');

class ResponseMonitor extends EventEmitter {
  constructor() {
    super();
    this.polling = false;
    this.pollTimer = null;
    this.sentMessage = '';
    this.lastTailText = '';
    this.stableCount = 0;
    this.phase = 'idle';
    this.startTime = 0;
    this.lastStreamUpdate = 0;
    this.pollCount = 0;
    this.responseStarted = false;
    this.lastSettledApprovalKey = '';
    this.approvalActive = false;
  }

  /** Start monitoring for a response */
  start(sentMessage) {
    this.stop();

    this.polling = true;
    this.sentMessage = sentMessage || '';
    this.lastTailText = '';
    this.stableCount = 0;
    this.phase = 'waiting';
    this.startTime = Date.now();
    this.lastStreamUpdate = 0;
    this.pollCount = 0;
    this.responseStarted = false;
    this.approvalSent = false;
    this.lastApprovalKey = '';
    this.lastSettledApprovalKey = '';
    this.approvalActive = false;
    this.maxChars = 0;

    this.emit('phase', 'thinking');
    this._init();
  }

  async _init() {
    try {
      await cdp.initApprovalBinding();
      cdp.removeAllListeners('approval_event');
      cdp.on('approval_event', (payload) => {
        if (!this.polling) return;

        if (payload.event === 'approval_opened') {
          const approvalInfo = payload.buttons;
          const headerText = payload.header || '';
          const approvalKey = approvalInfo.join(',') + '|' + headerText;

          if (approvalKey === this.lastSettledApprovalKey) {
            // Already handled/submitted
          } else if (approvalKey !== this.lastApprovalKey) {
            const contentText = payload.content || '';
            const diag = payload.diag || {};
            console.log(`  [monitor] ⚠️  (Reactive) Approval requested: ${approvalInfo.join(', ')} (Header: ${headerText}) (Content: ${contentText})`);
            if (diag.elTag) {
              console.log(`  [monitor] 📊 Diag: el=${diag.elTag}.${diag.elClass || ''} textLen=${diag.elTextLen} rect=${JSON.stringify(diag.elRect)} nearbyBtns=${diag.nearbyBtnCount}`);
            }
            if (payload.htmlDumps) {
              console.log('  [monitor] 📄 HTML Dumps:');
              for (const [btnText, html] of Object.entries(payload.htmlDumps)) {
                console.log(`    - [${btnText}]: ${html}`);
              }
            }
            this.lastApprovalKey = approvalKey;
            this.approvalActive = true;
            this.emit('approval', approvalInfo, headerText, contentText);
          }
        } else if (payload.event === 'approval_resolved') {
          if (this.approvalActive) {
            console.log(`  [monitor] ℹ️  (Reactive) Approval dialog closed/resolved.`);
            this.approvalActive = false;
            this.emit('approval_resolved');
          }
          this.lastApprovalKey = '';
          this.lastSettledApprovalKey = '';
        }
      });
    } catch (err) {
      console.error('  [monitor] ❌ Failed to initialize reactive approval binding:', err.message);
    }

    // Wait for the message to be processed
    await new Promise(r => setTimeout(r, 2500));
    console.log('  [monitor] Starting response polls...');
    this._poll();
  }

  stop() {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.phase = 'idle';
  }

  async _poll() {
    if (!this.polling) return;
    this.pollCount++;

    try {
      // Self-healing check for Reactive MutationObserver
      const isObserverActive = await cdp.evaluate(`window.antigravityObserverActive`).catch(() => false);
      if (!isObserverActive && this.polling) {
        console.log('  [monitor] 🔄 Reactive MutationObserver lost. Self-healing/re-injecting...');
        await cdp.initApprovalBinding().catch((err) => {
          console.warn('  [monitor] ⚠️ Self-healing injection failed:', err.message);
        });
      }

      // Robust DOM-level assistant response extraction (completely immune to terminal logs, tool outputs, and UI chrome)
      const cleanResponse = await cdp.evaluate(`(() => {
        // 1. Find the last actual User message chat bubble
        const userMsgs = Array.from(document.querySelectorAll('[aria-label="User message"]'));
        const targetUserMsg = userMsgs[userMsgs.length - 1];
        if (!targetUserMsg) return '';

        // 2. Find all assistant message elements that appear AFTER the user message
        const assistantMsgs = Array.from(document.querySelectorAll('[aria-label="Agent response"] div.px-2.py-1 > div.leading-relaxed.select-text'));
        const subsequentMsgs = assistantMsgs.filter(el => {
          return (targetUserMsg.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        });

        if (subsequentMsgs.length === 0) return '';

        // 3. Combine their text content as the response
        return subsequentMsgs.map(el => el.innerText).join('\\n\\n').trim();
      })()`).catch((err) => {
        console.error(`  [monitor] cleanResponse evaluate error: ${err.message}`);
        return '';
      }) || '';

      const responseLen = cleanResponse.length;
      if (responseLen > this.maxChars) {
        this.maxChars = responseLen;
      }

      if (this.pollCount <= 3 || this.pollCount % 10 === 0) {
        console.log(`  [monitor] Poll #${this.pollCount}: responseLen=${responseLen} (max=${this.maxChars}), stable=${this.stableCount}`);
        console.log(`  [monitor] debug cleanResponse: ${JSON.stringify(cleanResponse)}`);
      }

      // Detect generation start
      if (responseLen > 5 && !this.responseStarted) {
        this.responseStarted = true;
        this.phase = 'generating';
        console.log(`  [monitor] Generating! (${responseLen} chars)`);
        this.emit('phase', 'generating');
      }



      // Extract detailed thinking/tool execution status from the DOM
      const detailedStatus = await cdp.evaluate(`(() => {
        const toolCalls = Array.from(document.querySelectorAll('[class*="tool-call"], [class*="step"], [class*="execution"], mcp-tool-call, [class*="callout"]'));
        if (toolCalls.length > 0) {
          const lastCall = toolCalls[toolCalls.length - 1];
          const text = (lastCall.textContent || '').trim();
          if (text) {
            return text.substring(0, 100).replace(/\\n/g, ' ').trim();
          }
        }
        const thinking = document.querySelector('[class*="thinking"], [class*="loading"], [class*="spinner"]');
        if (thinking) {
          return 'Thinking...';
        }
        return '';
      })()`).catch(() => '') || '';

      // Progress updates
      if (this.responseStarted || detailedStatus) {
        const now = Date.now();
        const elapsed = Math.floor((now - this.startTime) / 1000);
        // Force status updates every 1.5 seconds even if cleanResponse is identical to show timing/status changes!
        if (now - this.lastStreamUpdate >= 1500 || cleanResponse !== this.lastTailText) {
          this.lastStreamUpdate = now;
          this.emit('progress', { elapsed, chars: this.maxChars, status: detailedStatus });
        }
      }

      // Check for stop/cancel button presence to determine if active generating
      const hasStopBtn = await cdp.evaluate(`(() => {
        const stopBtn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="⌃C"], button[aria-label="Stop generation"], button[aria-label*="stop"], button[aria-label*="Stop"]');
        return !!stopBtn;
      })()`).catch(() => false);

      const isGenerating = hasStopBtn || this.approvalActive;

      // Stability check
      if (this.responseStarted && responseLen > 5) {
        if (!isGenerating && cleanResponse === this.lastTailText) {
          this.stableCount++;
        } else {
          this.stableCount = 0;
        }

        if (this.stableCount >= 3) {
          this.phase = 'complete';
          const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
          console.log(`  [monitor] ✅ Complete! ${responseLen} chars in ${elapsed}s`);
          this.emit('complete', {
            html: '',
            text: cleanResponse,
            elapsed,
          });
          this.stop();
          return;
        }
      }

      this.lastTailText = cleanResponse;

    } catch (err) {
      console.error(`  [monitor] Poll error: ${err.message}`);
    }

    if (this.polling) {
      this.pollTimer = setTimeout(() => this._poll(), config.monitorIntervalMs);
    }
  }
}

module.exports = new ResponseMonitor();
