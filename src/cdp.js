const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');
const config = require('./config');

class CdpClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.idCounter = 1;
    this.pendingCalls = new Map();
    this.connected = false;
    this.targetUrl = null;
    this.bindingListener = null;
  }

  /** Fetch JSON from CDP HTTP endpoint */
  _getJson(url) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  /** Connect to Antigravity via CDP */
  async connect() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;

    const list = await this._getJson(`http://${config.cdpHost}:${config.cdpPort}/json/list`);
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);

    if (!page) throw new Error('No Antigravity page found on CDP');

    this.targetUrl = page.webSocketDebuggerUrl;
    console.log(`🔌 Connecting to: ${page.title || '(untitled)'}`);

    await this._connectWs();
    await this.call('Runtime.enable');
    console.log('✅ CDP connected');
  }

  /** Establish WebSocket connection */
  _connectWs() {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.close();
      }

      this.ws = new WebSocket(this.targetUrl);

      this.ws.on('open', () => {
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pendingCalls.has(msg.id)) {
          const { resolve, reject, timer } = this.pendingCalls.get(msg.id);
          clearTimeout(timer);
          this.pendingCalls.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
        // Forward CDP events
        if (msg.method) this.emit('event', msg);
      });

      this.ws.on('close', () => {
        this.connected = false;
        console.log('⚠️  CDP disconnected');
        this.emit('disconnected');
      });

      this.ws.on('error', (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  /** Send CDP command */
  async call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected');
    }
    return new Promise((resolve, reject) => {
      const id = this.idCounter++;
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, 15000);
      this.pendingCalls.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate JS expression in page and return value */
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation error');
    }
    return result?.result?.value;
  }

  /** Send a message to Antigravity chat */
  async sendMessage(text) {
    await this.connect();

    // Step 1: Focus the input and clear existing content
    const focusResult = await this.evaluate(`(() => {
      const input = document.querySelector('${config.selectors.chatInput}');
      if (!input) return { ok: false, error: 'Chat input not found' };
      input.focus();
      // Select all existing content so insertText replaces it
      const sel = window.getSelection();
      sel.selectAllChildren(input);
      return { ok: true };
    })()`);

    if (!focusResult?.ok) throw new Error(focusResult?.error || 'Failed to focus chat input');

    // Step 2: Use CDP Input.insertText (works with React/contenteditable)
    await this.call('Input.insertText', { text });

    // Step 3: Small delay then press Enter to submit
    await new Promise((r) => setTimeout(r, 200));

    await this.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await this.call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });

    // Step 4: Fallback Send Button click to guarantee submission
    await new Promise((r) => setTimeout(r, 100));
    await this.evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="Send message"], button[aria-label*="Send"], button[class*="submit"], button[class*="send"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    })()`);

    return true;
  }

  /** Get latest assistant response from DOM */
  async getLatestResponse() {
    return this.evaluate(`(() => {
      // Find all assistant message containers
      const allMsgs = document.querySelectorAll('[data-turn-role="assistant"], [class*="assistant"], [class*="response"]');
      
      // Fallback: look for structured message blocks
      const blocks = document.querySelectorAll('.prose, .markdown-body, [class*="message-content"]');
      
      let target = null;
      if (allMsgs.length > 0) {
        target = allMsgs[allMsgs.length - 1];
      } else if (blocks.length > 0) {
        target = blocks[blocks.length - 1];
      }

      if (!target) return null;
      
      return {
        html: target.innerHTML,
        text: target.innerText,
      };
    })()`);
  }

  /** Detect current generation state */
  async getGenerationState() {
    return this.evaluate(`(() => {
      const body = document.body.innerText;
      const stopBtn = document.querySelector('button[aria-label="Stop generation"], button[aria-label*="stop"], button[aria-label*="Stop"]');
      
      // Check for loading/thinking indicators
      const thinkingEls = document.querySelectorAll('[class*="thinking"], [class*="loading"], [class*="spinner"]');
      const isThinking = thinkingEls.length > 0;
      
      // Check for approval dialogs
      const approvalBtns = document.querySelectorAll('button');
      let hasApproval = false;
      let approvalText = '';
      approvalBtns.forEach(btn => {
        const text = (btn.textContent || '').trim();
        if (text === 'Allow' || text === 'Deny' || text === 'Allow This Conversation') {
          hasApproval = true;
          approvalText += text + ',';
        }
      });

      return {
        isGenerating: !!stopBtn,
        isThinking,
        hasApproval,
        approvalText,
        hasStopButton: !!stopBtn,
      };
    })()`);
  }

  /** Initialize reactive mutation observer binding for approvals */
  async initApprovalBinding() {
    await this.connect();
    
    // 1. Add CDP binding
    try {
      await this.call('Runtime.addBinding', { name: 'antigravityApprovalEvent' });
      console.log('  [cdp] 🔗 Reactive CDP Binding registered: antigravityApprovalEvent');
    } catch (err) {
      if (!err.message.includes('binding already exists')) {
        console.warn('  [cdp] ⚠️ Runtime.addBinding warning:', err.message);
      }
    }

    // 2. Listen to binding calls
    if (this.ws) {
      if (this.bindingListener) {
        this.ws.off('message', this.bindingListener);
      }
      
      this.bindingListener = (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === 'antigravityApprovalEvent') {
            const payload = JSON.parse(msg.params.payload);
            console.log(`  [cdp] 📡 Received Reactive Binding Event: ${payload.event}`);
            this.emit('approval_event', payload);
          }
        } catch (err) {
          console.error('  [cdp] ❌ Error parsing CDP binding message:', err);
        }
      };
      
      this.ws.on('message', this.bindingListener);
      this.ws.on('close', () => {
        if (this.ws && this.bindingListener) {
          this.ws.off('message', this.bindingListener);
          this.bindingListener = null;
        }
      });
    }

    // 3. Inject MutationObserver script to the page
    const script = `(() => {
      if (window.antigravityObserverActive) return;
      window.antigravityObserverActive = true;
      console.log("🚀 Antigravity MutationObserver Active!");

      function findAllElements(root = document) {
        let all = Array.from(root.querySelectorAll('*'));
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.shadowRoot) {
            const shadowEls = Array.from(el.shadowRoot.querySelectorAll('*'));
            for (const sel of shadowEls) {
              if (all.indexOf(sel) === -1) all.push(sel);
            }
          }
          if (el.tagName && el.tagName.toLowerCase() === 'iframe') {
            try {
              if (el.contentDocument) {
                const iframeEls = Array.from(el.contentDocument.querySelectorAll('*'));
                for (const iel of iframeEls) {
                  if (all.indexOf(iel) === -1) all.push(iel);
                }
              }
            } catch (e) {}
          }
        }
        return all;
      }

      function isVisible(el) {
        if (!el) return false;
        try {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }
        } catch (e) {}
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return false;
        }
        return true;
      }

      function isInsideAntiTargets(el) {
        let curr = el;
        while (curr) {
          if (curr.className && typeof curr.className === 'string') {
            const cls = curr.className.toLowerCase();
            if (
              cls.includes('editor') || cls.includes('monaco') || 
              cls.includes('chat') || cls.includes('message') || 
              cls.includes('history') || cls.includes('bubble') || 
              cls.includes('terminal') || cls.includes('console') || 
              cls.includes('log')
            ) return true;
          }
          if (curr.id && typeof curr.id === 'string') {
            const id = curr.id.toLowerCase();
            if (
              id.includes('editor') || id.includes('monaco') || 
              id.includes('chat') || id.includes('message') || 
              id.includes('terminal') || id.includes('console')
            ) return true;
          }
          try {
            const role = curr.getAttribute('role');
            if (role && (role === 'code' || role === 'textbox')) return true;
          } catch (e) {}
          curr = curr.parentElement || (curr.parentNode && curr.parentNode.host) || null;
        }
        return false;
      }

      function findModalContainer(el) {
        let curr = el;
        while (curr) {
          if (curr.tagName && curr.tagName.toLowerCase() === 'dialog') return curr;
          try {
            const role = curr.getAttribute('role');
            if (role === 'dialog' || role === 'alertdialog') return curr;
          } catch (e) {}
          if (curr.className && typeof curr.className === 'string') {
            const cls = curr.className.toLowerCase();
            if (
              cls.includes('dialog') || cls.includes('modal') || 
              cls.includes('popup') || cls.includes('overlay') || 
              cls.includes('callout')
            ) return curr;
          }
          curr = curr.parentElement || (curr.parentNode && curr.parentNode.host) || null;
        }
        let fallback = el;
        for (let i = 0; i < 3; i++) {
          if (fallback && (fallback.parentElement || fallback.parentNode.host)) {
            fallback = fallback.parentElement || fallback.parentNode.host;
          }
        }
        return fallback;
      }

      let wasModalOpen = false;
      let lastSentKey = '';

      function checkApprovalState() {
        if (window.antigravityApprovalCooling) {
          return;
        }
        const all = findAllElements();
        let isPermissionOpen = false;
        let matchedText = '';
        let foundButtons = [];

        for (const el of all) {
          if (el.children && el.children.length > 3) continue;
          if (!isVisible(el)) continue;
          if (isInsideAntiTargets(el)) continue;

          const text = (el.textContent || '').trim();
          if (
            text.includes('Allow running this command?') ||
            text.includes('Allow write to') ||
            text.includes('Allow read file') ||
            text.includes('Allow folder') ||
            text.includes('Allow permission') ||
            text.includes('Allow execute') ||
            text.includes('승인하시겠습니까') ||
            text.includes('권한을 승인') ||
            text.includes('허용하시겠습니까')
          ) {
            const container = findModalContainer(el);
            if (!container) continue;

            const containerElements = findAllElements(container);
            let hasActiveButtons = false;
            for (const subEl of containerElements) {
              if (!isVisible(subEl)) continue;
              const btnText = (subEl.textContent || '').trim();
              if (
                btnText.includes('allow this time') || 
                btnText.includes('Yes, allow') ||
                btnText.includes('Submit') ||
                btnText.includes('승인') ||
                btnText.includes('허용')
              ) {
                hasActiveButtons = true;
                break;
              }
            }
            if (hasActiveButtons) {
              isPermissionOpen = true;
              matchedText = text.substring(0, 60);
              foundButtons = ["Yes, allow this time", "No", "Submit", "Skip"];
              break;
            }
          }
        }

        if (isPermissionOpen) {
          const currentKey = foundButtons.join(',') + '|' + matchedText;
          
          // 고유 키 기반 정밀 쿨다운 락 (동일 모달의 깜빡임만 Mute, 다른 모달은 Bypass)
          if (window.antigravityApprovalCoolingKey && window.antigravityApprovalCoolingKey === currentKey) {
            return;
          }

          if (!wasModalOpen || currentKey !== lastSentKey) {
            wasModalOpen = true;
            lastSentKey = currentKey;
            if (typeof window.antigravityApprovalEvent === 'function') {
              window.antigravityApprovalEvent(JSON.stringify({
                event: 'approval_opened',
                buttons: foundButtons,
                header: matchedText
              }));
            }
          }
        } else {
          if (wasModalOpen) {
            wasModalOpen = false;
            lastSentKey = '';
            if (typeof window.antigravityApprovalEvent === 'function') {
              window.antigravityApprovalEvent(JSON.stringify({
                event: 'approval_resolved'
              }));
            }
          }
          // 모달이 완전히 닫히면 쿨다운 락 키를 스스로 제거(자가 청소)
          window.antigravityApprovalCoolingKey = '';
        }
      }

      checkApprovalState();

      const observer = new MutationObserver(() => {
        if (window.antigravityCheckTimeout) clearTimeout(window.antigravityCheckTimeout);
        window.antigravityCheckTimeout = setTimeout(() => {
          checkApprovalState();
        }, 50);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden']
      });
    })();`;

    await this.evaluate(script).catch((err) => {
      console.warn('  [cdp] ⚠️ MutationObserver injection warning:', err.message);
    });
  }

  /** Click a button by its text content */
  async clickButton(buttonText) {
    await this.connect();
    const findResult = await this.evaluate(`(() => {
      function findAllClickables(root = document) {
        let all = Array.from(root.querySelectorAll('*'));
        
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          
          if (el.shadowRoot) {
            const shadowEls = Array.from(el.shadowRoot.querySelectorAll('*'));
            for (const sel of shadowEls) {
              if (all.indexOf(sel) === -1) {
                all.push(sel);
              }
            }
          }
          
          if (el.tagName && el.tagName.toLowerCase() === 'iframe') {
            try {
              if (el.contentDocument) {
                const iframeEls = Array.from(el.contentDocument.querySelectorAll('*'));
                for (const iel of iframeEls) {
                  if (all.indexOf(iel) === -1) {
                    all.push(iel);
                  }
                }
              }
            } catch (e) {}
          }
        }
        
        let clickables = all.filter(el => {
          const tag = el.tagName.toLowerCase();
          if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
            return true;
          }
          if (tag === 'input' && (el.type === 'button' || el.type === 'submit')) {
            return true;
          }
          try {
            const style = window.getComputedStyle(el);
            if (style && style.cursor === 'pointer') {
              return true;
            }
          } catch (e) {}
          return false;
        });
        
        return clickables.filter(el => {
          const tag = el.tagName.toLowerCase();
          if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
            return true;
          }
          const hasClickableChild = clickables.some(child => child !== el && el.contains(child));
          return !hasClickableChild;
        });
      }

      function getElementCoords(el) {
        const rect = el.getBoundingClientRect();
        let x = rect.left + rect.width / 2;
        let y = rect.top + rect.height / 2;
        
        let currentWindow = el.ownerDocument.defaultView;
        while (currentWindow !== window) {
          const parentDoc = currentWindow.parent.document;
          const iframes = parentDoc.querySelectorAll('iframe');
          let frameEl = null;
          for (const iframe of iframes) {
            if (iframe.contentWindow === currentWindow) {
              frameEl = iframe;
              break;
            }
          }
          if (frameEl) {
            const frameRect = frameEl.getBoundingClientRect();
            x += frameRect.left;
            y += frameRect.top;
            currentWindow = currentWindow.parent;
          } else {
            break;
          }
        }
        return { x, y, width: rect.width, height: rect.height };
      }

      const buttons = findAllClickables().reverse();
      const targetQuery = ${JSON.stringify(buttonText)}.toLowerCase().replace(/[^a-z0-9ㄱ-ㅎㅏ-ㅣ가-힣]/g, '');
      
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        const normalizedText = text.replace(/[^a-z0-9ㄱ-ㅎㅏ-ㅣ가-힣]/g, '');
        const query = ${JSON.stringify(buttonText)}.toLowerCase();
        
        let isMatch = false;
        if (text === query || text.includes(query) || query.includes(text)) {
          isMatch = true;
        } else if (targetQuery && normalizedText.includes(targetQuery)) {
          isMatch = true;
        } else if (normalizedText && targetQuery.includes(normalizedText)) {
          isMatch = true;
        }
        
        if (isMatch) {
          // 1. Scroll the button into center of viewport to ensure coordinate clicks fall inside the viewport
          try {
            btn.scrollIntoView({ block: 'center', inline: 'center' });
          } catch (scrollErr) {}

          const coords = getElementCoords(btn);
          
          // 2. Dispatch MouseEvents and click() on the element itself.
          // Event bubbling (bubbles: true) will naturally propagate to React handlers without touching dangerous parent backdrops.
          try {
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } catch (e) {}
          
          try {
            btn.click();
          } catch (e) {}
          
          return { ok: true, hasCoords: coords.width > 0 && coords.height > 0, coords };
        }
      }
      return { ok: false, error: 'Button not found: ' + ${JSON.stringify(buttonText)} };
    })()`);

    if (!findResult?.ok) {
      return findResult;
    }

    if (findResult.hasCoords && findResult.coords) {
      const { x, y } = findResult.coords;
      console.log(`  [cdp] Simulating trusted click at (${x.toFixed(1)}, ${y.toFixed(1)}) for "${buttonText}"`);
      try {
        await this.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x, y,
        });
        await new Promise((r) => setTimeout(r, 50));
        
        await this.call('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x, y,
          button: 'left',
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 50));

        await this.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x, y,
          button: 'left',
          clickCount: 1,
        });
        
        return { ok: true, method: 'hybrid_mouse' };
      } catch (err) {
        console.warn(`  [cdp] CDP mouse click failed, fell back to JS/DOM events: ${err.message}`);
        return { ok: true, method: 'js_events', warning: err.message };
      }
    }

    return { ok: true, method: 'js_events' };
  }

  /** Take a screenshot */
  async screenshot() {
    await this.connect();
    const result = await this.call('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(result.data, 'base64');
  }

  /** Disconnect */
  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /** Create a new chat/session inside Antigravity */
  async createNewSession() {
    await this.connect();
    return this.evaluate(`(() => {
      // 1. Common New Chat/New Session selector (case-insensitive i flag matching)
      const btn = document.querySelector('button[aria-label="New Conversation"], button[aria-label="New conversation"], button[aria-label*="New conversation" i], button[aria-label*="new chat" i], [class*="new-session"]');
      if (btn) {
        btn.click();
        return { ok: true };
      }
      
      // 2. Custom role="button" or general elements search for "New Conversation" or "New Chat"
      const allElements = Array.from(document.querySelectorAll('button, [role="button"], a, div'));
      const newSessionEl = allElements.find(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'new conversation' || text === 'new chat' || text.includes('new conversation');
      });
      
      if (newSessionEl) {
        newSessionEl.click();
        return { ok: true };
      }
      
      return { ok: false, error: 'New Session button not found' };
    })()`);
  }

  /** Scan and return currently available AI models in the UI */
  async getAvailableModels() {
    await this.connect();
    return this.evaluate(`(() => {
      const select = document.querySelector('select[class*="model"], select[id*="model"]');
      if (select) {
        return {
          type: 'select',
          current: select.value,
          options: Array.from(select.options).map(o => o.text || o.value)
        };
      }
      const btn = document.querySelector('button[aria-label*="model"], button[class*="model-selector"], [class*="model-select"]');
      if (btn) {
        return {
          type: 'custom_button',
          current: (btn.textContent || '').trim(),
          options: []
        };
      }
      return {
        type: 'fallback',
        current: 'Gemini 1.5 Pro',
        options: ['Gemini 1.5 Pro', 'Gemini 1.5 Flash', 'Claude 3.5 Sonnet', 'GPT-4o']
      };
    })()`);
  }

  /** Select and change the AI model via remote DOM clicking */
  async changeAiModel(modelName) {
    await this.connect();
    return this.evaluate(`(() => {
      // 1. Standard HTML select dropdown
      const select = document.querySelector('select[class*="model"], select[id*="model"]');
      if (select) {
        const option = Array.from(select.options).find(o => 
          (o.text || '').toLowerCase().includes(${JSON.stringify(modelName)}.toLowerCase()) ||
          (o.value || '').toLowerCase().includes(${JSON.stringify(modelName)}.toLowerCase())
        );
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, model: option.text };
        }
      }
      
      // 2. Custom dropdown button options click
      const buttons = Array.from(document.querySelectorAll('button, span, a, div'));
      const targetOption = buttons.find(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === ${JSON.stringify(modelName)}.toLowerCase() || text.includes(${JSON.stringify(modelName)}.toLowerCase());
      });
      if (targetOption) {
        targetOption.click();
        return { ok: true, model: targetOption.textContent.trim() };
      }
      
      return { ok: false, error: 'Model option not found: ' + ${JSON.stringify(modelName)} };
    })()`);
  }
}

module.exports = new CdpClient();
