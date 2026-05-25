const cdp = require('./src/cdp');

async function inspectUncaught() {
  try {
    await cdp.connect();
    console.log('✅ Connected to CDP');

    const result = await cdp.evaluate(`(() => {
      try {
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

        const btns = findAllClickables();
        const found = [];
        const seen = new Set();
        btns.forEach(btn => {
          const text = (btn.textContent || '').trim();
          if (!text || seen.has(text) || text.length > 30) return;
          
          const lowerText = text.toLowerCase();
          if (lowerText === 'run' || lowerText === '실행') return;
          
          if (
            lowerText.startsWith('runnode') || lowerText.startsWith('runps') || lowerText.startsWith('runrm') || 
            lowerText.startsWith('rungit') || lowerText.startsWith('runlsof') || lowerText.startsWith('runpkill') ||
            lowerText.startsWith('run ') || lowerText.includes('|') || lowerText.includes('/') || 
            lowerText.includes('\\\\') || lowerText.includes(' -')
          ) {
            return;
          }
          
          if (
            lowerText.includes('allow this time') ||
            lowerText.includes('yes, allow') ||
            lowerText.includes('yes') ||
            lowerText.includes('no') ||
            lowerText.includes('skip') ||
            lowerText.includes('submit') ||
            lowerText.includes('allow') ||
            lowerText.includes('deny') ||
            lowerText.includes('approve') ||
            lowerText.includes('reject') ||
            lowerText.includes('승인') || lowerText.includes('허용') || lowerText.includes('허가') ||
            lowerText.includes('거절') || lowerText.includes('거부') || lowerText.includes('반려')
          ) {
            found.push(text);
            seen.add(text);
          }
        });
        return {
          ok: true,
          found: found.length > 0 ? found : null,
          allTexts: btns.map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 30)
        };
      } catch (err) {
        return { ok: false, error: err.stack || err.message };
      }
    })()`);

    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    cdp.disconnect();
  }
}

inspectUncaught();
