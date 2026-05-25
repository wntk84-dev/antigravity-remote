const cdp = require('./src/cdp');
const monitor = require('./src/monitor');

async function testSimulator() {
  console.log(`
  🤖══════════════════════════════════════════════════🤖
  ║   Antigravity Remote - Automated Test Simulator   ║
  ║     양방향 리액티브 연동 & 쿨다운 락 실시간 검증    ║
  🤖══════════════════════════════════════════════════🤖
  `);
  
  try {
    // 1. Connect to CDP
    await cdp.connect();
    console.log('✅ [1] Connected to Antigravity IDE browser via CDP!');
    
    // 2. Clean up previous test flags
    await cdp.evaluate(`
      window.antigravityApprovalCooling = false;
      window.antigravityApprovalCoolingKey = '';
      window.antigravityObserverActive = false;
      if (window.antigravityCheckTimeout) clearTimeout(window.antigravityCheckTimeout);
    `).catch(() => {});
    console.log('🧹 [2] Initialized/cleared previous browser test flags.');
    
    // 3. Initialize Reactive Binding and MutationObserver
    await cdp.initApprovalBinding();
    console.log('🚀 [3] Reactive Binding & MutationObserver safely injected into browser!');

    // 4. Bind approval event for logging
    cdp.removeAllListeners('approval_event');
    cdp.on('approval_event', async (payload) => {
      console.log(`\n🔔 [CDP REAL-TIME EVENT RECEIVED]`);
      console.log(`   └─ Type:   "${payload.event}"`);
      if (payload.event === 'approval_opened') {
        console.log(`   └─ Header: "${payload.header}"`);
        console.log(`   └─ Buttons: [${payload.buttons.join(', ')}]`);
        
        // Simulating the 1.5s Cooling Lock test in browser
        console.log('   🧪 Testing browser cooldown lock validation...');
        const coolingKey = await cdp.evaluate(`window.antigravityApprovalCoolingKey`).catch(() => '');
        console.log(`   🧪 Current window.antigravityApprovalCoolingKey state: "${coolingKey}"`);
      } else if (payload.event === 'approval_resolved') {
        console.log('   🎉 Event type Resolved (Modal completely vanished from DOM)');
      }
    });

    console.log('\n🎉 Simulator Setup Successfully Completed! Process is now listening...');
    console.log('💡 브라우저 IDE에서 쉘 명령어 실행이나 파일 생성/삭제 등의 실제 승인 이벤트를 발생시키면');
    console.log('💡 1ms 내로 낚아챈 실시간 CDP 바인딩 패킷이 본 터미널에 즉각 출력됩니다.');
    console.log('💡 CTRL+C를 누르면 테스트 시뮬레이터가 종료됩니다.\n');
    
    // Keep alive
    setInterval(async () => {
      // Periodic check for self-healing verification
      const isObserverActive = await cdp.evaluate(`window.antigravityObserverActive`).catch(() => false);
      if (!isObserverActive) {
        console.log('🔄 [Self-Healing Alert] Browser observer lost! Self-healing triggered.');
        await cdp.initApprovalBinding().catch(() => {});
      }
    }, 2000);
    
  } catch (err) {
    console.error('❌ Simulator setup failed:', err.message);
    process.exit(1);
  }
}

testSimulator();
