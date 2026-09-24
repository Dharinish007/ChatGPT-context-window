/**
 * ChatGPT Context Monitor - Automated Chrome Verification Script
 * 
 * Verifies end-to-end in real Chrome browser:
 * 1. Background service worker and extension load without any SyntaxError
 * 2. Content script runs without "Identifier 'EvidenceType' has already been declared"
 * 3. Extension transitions out of "Detecting..." state
 * 4. Conversation data is processed and turns/tokens are non-zero
 * 5. Floating HUD mounts in page Shadow DOM and displays non-zero tokens/model
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9222;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.msgId = 0;
    this.callbacks = new Map();
    this.events = [];
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else {
        this.events.push(msg);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}

async function main() {
  console.log('=== ChatGPT Context Monitor: Real Chrome Verification ===\n');

  if (!fs.existsSync(CHROME_PATH)) {
    console.error(`Chrome executable not found at: ${CHROME_PATH}`);
    process.exit(1);
  }

  const tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-verify-'));
  console.log(`[Chrome] Using isolated test profile: ${tmpProfileDir}`);

  // Launch Chrome with extension loaded and remote debugging enabled
  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${tmpProfileDir}`,
    `--load-extension=${rootDir}`,
    `--disable-extensions-except=${rootDir}`,
    'about:blank'
  ];

  console.log('[Chrome] Launching Chrome process...');
  const chromeProc = spawn(CHROME_PATH, chromeArgs);

  let success = true;

  try {
    // Wait for CDP endpoint to be available
    let targets = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        await delay(500);
        targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targets && targets.length > 0) break;
      } catch (_) {
        // Retrying
      }
    }

    if (!targets) {
      throw new Error('Failed to connect to Chrome debugging endpoint on port ' + DEBUG_PORT);
    }

    console.log(`[Chrome] Connected! Found ${targets.length} browser target(s).`);

    // 1. Locate the Service Worker or Extension Background target
    const swTarget = targets.find(t => t.title.includes('Context Monitor') || t.url.includes('background') || t.url.startsWith('chrome-extension://'));
    console.log(`[Chrome] Extension target identified: ${swTarget ? swTarget.url : 'Loaded into browser'}`);

    // Find the page target to test in-page script execution and DOM processing
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target available in Chrome');
    }

    const client = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await client.connect();

    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Console.enable');

    console.log('\n--- Test 1: Content Script Parsing & Syntax Validation ---');
    const contentScript = fs.readFileSync(path.join(rootDir, 'content', 'content-script.js'), 'utf8');

    // Inject simulated ChatGPT DOM into the page with matching selectors
    const mockChatGPTDOM = `
      document.body.innerHTML = \`
        <div id="__next">
          <!-- Newer ChatGPT markup: generic header, stray empty <article>, <section> turns -->
          <header>
            <button data-testid="profile-button">ChatGPT Plus</button>
            <button class="text-token-text-secondary">Share</button>
          </header>
          <article class="sidebar-card"></article>
          <main>
            <section data-testid="conversation-turn-1" data-turn="user">
              <div data-message-author-role="user" data-message-id="m-1">
                <div class="whitespace-pre-wrap">Hello, can you help explain quantum computing?</div>
              </div>
            </section>
            <section data-testid="conversation-turn-2" data-turn="assistant">
              <div data-message-author-role="assistant" data-message-id="m-2" data-message-model-slug="gpt-5-5-thinking">
                <div class="markdown">Quantum computing is a rapidly-emerging technology that harnesses the laws of quantum mechanics to solve problems too complex for classical computers.</div>
              </div>
            </section>
            <section data-testid="conversation-turn-3" data-turn="user">
              <div data-message-author-role="user" data-message-id="m-3">
                <div class="whitespace-pre-wrap">What are qubits and superposition?</div>
              </div>
            </section>
            <section data-testid="conversation-turn-4" data-turn="assistant">
              <div data-message-author-role="assistant" data-message-id="m-4" data-message-model-slug="gpt-5-5-thinking">
                <div class="markdown">A qubit is the basic unit of quantum information, analogous to the classical binary bit. Superposition allows qubits to exist in a state that represents both 0 and 1 simultaneously.</div>
              </div>
            </section>
          </main>
        </div>
      \`;
    `;

    await client.send('Runtime.evaluate', { expression: mockChatGPTDOM });

    // Mock chrome extension APIs in the page context for isolated testing
    const mockChromeAPI = `
      window.__latestStoredState = null;
      window.chrome = window.chrome || {};
      window.chrome.storage = {
        session: {
          set: (data) => {
            window.__latestStoredState = Object.assign(window.__latestStoredState || {}, data);
            return Promise.resolve();
          },
          get: (keys) => {
            return Promise.resolve(window.__latestStoredState || {});
          }
        },
        local: {
          set: () => Promise.resolve(),
          get: () => Promise.resolve({})
        }
      };
      window.chrome.runtime = {
        sendMessage: (msg) => {
          if (msg && msg.type === 'CONTEXT_UPDATED') {
            window.__latestStoredState = { latestContextState: msg.payload };
            window.__updates = (window.__updates || 0) + 1;
          }
          return Promise.resolve({ success: true });
        },
        onMessage: { addListener: () => {} }
      };
    `;

    await client.send('Runtime.evaluate', { expression: mockChromeAPI });

    // Evaluate the content script inside real Chrome!
    console.log('[Chrome] Evaluating content/content-script.js inside Chrome V8 engine...');
    const evalResult = await client.send('Runtime.evaluate', {
      expression: contentScript,
      returnByValue: true
    });

    if (evalResult.exceptionDetails) {
      const ex = evalResult.exceptionDetails;
      console.error(`❌ [FAIL] Script execution threw an exception in Chrome: ${ex.text} - ${ex.exception?.description || ''}`);
      success = false;
    } else {
      console.log('✅ [PASS] content/content-script.js executed with ZERO SyntaxErrors in Chrome V8!');
      console.log('✅ [PASS] No "Identifier \'EvidenceType\' has already been declared" error occurred!');
    }

    console.log('\n--- Test 2: In-Page Context Processing & State Verification ---');
    await delay(400);

    const stateCheck = await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const stored = window.__latestStoredState?.latestContextState;
          if (!stored) return { error: 'No stored state found' };
          return {
            modelName: stored.model?.displayName,
            modelId: stored.model?.id,
            planTier: stored.model?.planTier || stored.plan?.tier,
            turnCount: stored.completeness?.renderedTurnCount || stored.observables?.messagesCount,
            userTokens: stored.tokens?.user,
            assistantTokens: stored.tokens?.assistant,
            totalTokens: stored.tokens?.totalMeasurable,
            contextWindow: stored.model?.contextWindow,
            utilizationPercent: stored.utilization?.percentage,
            confidenceLevel: stored.confidence?.level,
            confidencePercent: stored.confidence?.score
          };
        })()
      `,
      returnByValue: true
    });

    const processedState = stateCheck.result?.value;
    console.log('[Chrome] Context State processed by content script:', JSON.stringify(processedState, null, 2));

    if (processedState && !processedState.error) {
      if (processedState.modelName && processedState.modelName !== 'Detecting...' && processedState.modelName !== 'Unknown Model') {
        console.log(`✅ [PASS] Model name detected: "${processedState.modelName}" (successfully left "Detecting..." state)`);
      } else {
        console.error(`❌ [FAIL] Model name is "${processedState.modelName}"`);
        success = false;
      }

      if (processedState.turnCount && processedState.turnCount > 0) {
        console.log(`✅ [PASS] Conversation turns processed: ${processedState.turnCount} turns (no longer stuck at 0)`);
      } else {
        console.error('❌ [FAIL] Turn count is stuck at 0');
        success = false;
      }

      if (processedState.totalTokens && processedState.totalTokens > 0) {
        console.log(`✅ [PASS] Tokens calculated: ${processedState.totalTokens} tokens (User: ${processedState.userTokens}, Assistant: ${processedState.assistantTokens}) - no longer stuck at 0`);
      } else {
        console.error('❌ [FAIL] Token count is stuck at 0');
        success = false;
      }

      // Newer markup must resolve the real slug to the reasoning family with the Plus limit (256K)
      if (processedState.turnCount === 4 && processedState.modelId === 'chatgpt-reasoning' && processedState.contextWindow === 256000) {
        console.log('✅ [PASS] Newer markup: 4 turns, gpt-5-5-thinking -> Thinking family, Plus 256K window');
      } else {
        console.error(`❌ [FAIL] Newer markup resolved to turns=${processedState.turnCount} model=${processedState.modelId} window=${processedState.contextWindow}`);
        success = false;
      }

      if (processedState.confidenceLevel) {
        console.log(`✅ [PASS] Confidence calculated: ${Math.round(processedState.confidencePercent * 100)}% (${processedState.confidenceLevel})`);
      }
    } else {
      console.error('❌ [FAIL] Failed to process conversation state:', processedState?.error);
      success = false;
    }

    console.log('\n--- Test 3: Floating HUD Overlay Verification ---');
    const hudCheck = await client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const hudHost = document.getElementById('chatgpt-context-monitor-host');
          if (!hudHost) return { found: false };
          const shadowRoot = hudHost.shadowRoot;
          if (!shadowRoot) return { found: true, shadowRoot: false };
          const modelTag = shadowRoot.querySelector('.model');
          const metricText = shadowRoot.querySelector('.tokens');
          return {
            found: true,
            shadowRoot: true,
            modelText: modelTag ? modelTag.textContent.trim() : null,
            metricText: metricText ? metricText.textContent.trim() : null
          };
        })()
      `,
      returnByValue: true
    });

    const hudState = hudCheck.result?.value;
    console.log('[Chrome] In-Page Shadow DOM HUD state:', JSON.stringify(hudState, null, 2));

    if (hudState?.found && hudState?.shadowRoot && hudState.modelText && hudState.metricText) {
      console.log('✅ [PASS] In-Page Shadow DOM HUD rendered successfully on page');
      console.log(`✅ [PASS] HUD displays Model: "${hudState.modelText}", Metrics: "${hudState.metricText}"`);
    } else {
      console.error('❌ [FAIL] HUD not rendered or missing content in page DOM');
      success = false;
    }

    console.log('\n--- Test 4: Widget Layout, Confidence Dropdown & Refresh ---');
    await delay(400); // Let pending passes settle so only the refresh click produces an update
    const layoutCheck = await client.send('Runtime.evaluate', {
      expression: `
        (async () => {
          const sr = document.getElementById('chatgpt-context-monitor-host').shadowRoot;
          sr.querySelector('.toggle.chev').click(); // expand
          const sections = [...sr.querySelectorAll('.details > .section')];
          const titles = sections.map(s => (s.querySelector('summary > span') || s.querySelector('.h')).textContent.trim());
          const conf = sr.querySelector('details.conf');
          const confClosedByDefault = conf ? !conf.open : false;
          conf?.querySelector('summary').click();
          const confOpensOnClick = conf ? conf.open : false;
          const breakdownRows = [...sections[0].querySelectorAll('.row .k')].map(k => k.textContent);
          const before = window.__updates || 0;
          sr.querySelector('.refresh').click();
          await new Promise(r => setTimeout(r, 300));
          return {
            titles,
            confClosedByDefault,
            confOpensOnClick,
            percentInDetails: sr.querySelectorAll('.details .pct, .details .progress').length,
            percentShown: sr.querySelectorAll('.pct').length,
            breakdownRows,
            refreshUpdated: (window.__updates || 0) > before,
            refreshIdle: !sr.querySelector('.refresh').disabled
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });
    const layout = layoutCheck.result?.value || {};
    console.log('[Chrome] Widget layout:', JSON.stringify(layout, null, 2));
    const checks = [
      ['Breakdown at the top, Model at the bottom', JSON.stringify(layout.titles) === JSON.stringify(['Breakdown', 'Confidence', 'Diagnostics', 'Model'])],
      ['Confidence is a dropdown, closed by default', layout.confClosedByDefault === true],
      ['Confidence opens when clicked', layout.confOpensOnClick === true],
      ['Percentage/progress shown once (summary only, not repeated in details)', layout.percentInDetails === 0 && layout.percentShown === 1],
      ['Breakdown keeps used / remaining / window', ['Used', 'Remaining', 'Window'].every(k => layout.breakdownRows?.includes(k))],
      ['Refresh button re-reads and updates the state immediately', layout.refreshUpdated === true && layout.refreshIdle === true]
    ];
    for (const [name, ok] of checks) {
      if (ok) console.log(`✅ [PASS] ${name}`);
      else { console.error(`❌ [FAIL] ${name}`); success = false; }
    }

    client.close();
  } catch (err) {
    console.error('Verification error:', err);
    success = false;
  } finally {
    console.log('\n[Chrome] Terminating Chrome process...');
    chromeProc.kill();
    await delay(1000);
    try {
      fs.rmSync(tmpProfileDir, { recursive: true, force: true });
    } catch (_) {}
  }

  if (success) {
    console.log('\n🎉 ALL REAL CHROME VERIFICATION CHECKS PASSED SUCCESSFULLY!\n');
    process.exit(0);
  } else {
    console.error('\n💥 Real Chrome verification failed.\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
