/**
 * DOM Extractor & Detection Tests
 * 
 * Tests MessageExtractor, ModelDetector, AttachmentDetector, and ToolDetector
 * against realistic ChatGPT Web HTML fixtures.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MessageExtractor } from '../../content/message-extractor.js';
import { ModelDetector } from '../../content/model-detector.js';
import { AttachmentDetector } from '../../content/attachment-detector.js';
import { ToolDetector } from '../../content/tool-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read HTML fixture
const fixtureHtml = fs.readFileSync(path.resolve(__dirname, '../fixtures/conversations.html'), 'utf8');
const modelLimitsDb = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../config/model-limits.json'), 'utf8')
);

/**
 * Minimalistic DOM Element implementation for Node testing
 */
class MockElement {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attributes = attrs;
    this.children = [];
    this.parentElement = null;
    this._textContent = text;
    this.classList = {
      contains: (cls) => (this.attributes['class'] || '').split(/\s+/).includes(cls)
    };
  }

  getAttribute(attr) {
    return this.attributes[attr] || null;
  }

  get textContent() {
    if (this._textContent) return this._textContent;
    return this.children.map(c => c.textContent).join(' ');
  }

  set textContent(val) {
    this._textContent = val;
    this.children = [];
  }

  get innerText() {
    return this.textContent;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  cloneNode(deep = false) {
    const clone = new MockElement(this.tagName, { ...this.attributes }, this._textContent);
    if (deep) {
      for (const c of this.children) {
        clone.appendChild(c.cloneNode(true));
      }
    }
    return clone;
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        this.parentElement.children.splice(idx, 1);
      }
    }
  }

  querySelectorAll(selector) {
    const results = [];
    const search = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) {
          results.push(child);
        }
        search(child);
      }
    };
    search(this);
    return results;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }
}

function matchesSelector(el, sel) {
  const parts = sel.split(',').map(s => s.trim());
  return parts.some(singleSel => {
    // Tag only
    if (/^[a-zA-Z]+$/.test(singleSel)) {
      return el.tagName.toLowerCase() === singleSel.toLowerCase();
    }
    // Class
    if (singleSel.startsWith('.')) {
      const cls = singleSel.slice(1);
      return el.classList.contains(cls);
    }
    // Attribute exact [attr='val']
    const attrMatch = singleSel.match(/\[([a-zA-Z0-9_-]+)=['"]([^'"]+)['"]\]/);
    if (attrMatch) {
      return el.getAttribute(attrMatch[1]) === attrMatch[2];
    }
    // Attribute prefix [attr^='val']
    const prefixMatch = singleSel.match(/\[([a-zA-Z0-9_-]+)\^=['"]([^'"]+)['"]\]/);
    if (prefixMatch) {
      const val = el.getAttribute(prefixMatch[1]);
      return val && val.startsWith(prefixMatch[2]);
    }
    // Attribute contains [attr*='val']
    const containsMatch = singleSel.match(/\[([a-zA-Z0-9_-]+)\*=['"]([^'"]+)['"]\]/);
    if (containsMatch) {
      const val = el.getAttribute(containsMatch[1]);
      return val && val.includes(containsMatch[2]);
    }
    return false;
  });
}

/**
 * Builds a mock DOM tree representing the fixture
 */
function buildMockDOM() {
  const root = new MockElement('root');
  
  // Header with model selector
  const header = root.appendChild(new MockElement('header'));
  const modelBtn = header.appendChild(new MockElement('button', {
    'data-testid': 'model-switcher-dropdown'
  }));
  modelBtn.appendChild(new MockElement('span', { 'class': 'text-token-text-secondary' }, 'GPT-4o'));

  // Main container
  const main = root.appendChild(new MockElement('main', { role: 'presentation' }));
  const flow = main.appendChild(new MockElement('div', { class: 'flex-1 overflow-hidden' }));

  // Turn 1: User
  const t1 = flow.appendChild(new MockElement('article', {
    'data-testid': 'conversation-turn-1',
    'data-message-author-role': 'user'
  }));
  t1.appendChild(new MockElement('div', { class: 'whitespace-pre-wrap' }, 'Can you write a Python function to calculate Fibonacci numbers?'));
  const tb1 = t1.appendChild(new MockElement('div', { class: 'toolbar' }));
  tb1.appendChild(new MockElement('button', {}, 'Edit'));

  // Turn 2: Assistant with code block
  const t2 = flow.appendChild(new MockElement('article', {
    'data-testid': 'conversation-turn-2',
    'data-message-author-role': 'assistant'
  }));
  const prose = t2.appendChild(new MockElement('div', { class: 'markdown prose' }));
  prose.appendChild(new MockElement('p', {}, 'Here is an optimized Python function:'));
  const pre = prose.appendChild(new MockElement('pre', {}));
  pre.appendChild(new MockElement('code', { class: 'language-python' }, 'def fib(n): return n'));
  const tb2 = t2.appendChild(new MockElement('div', { class: 'toolbar' }));
  tb2.appendChild(new MockElement('button', { 'data-testid': 'copy-turn-action-button' }, 'Copy'));

  // Turn 3: User with file attachment and image
  const t3 = flow.appendChild(new MockElement('article', {
    'data-testid': 'conversation-turn-3',
    'data-message-author-role': 'user'
  }));
  const fileChip = t3.appendChild(new MockElement('div', { 'data-testid': 'file-attachment', class: 'file-attachment' }));
  fileChip.appendChild(new MockElement('span', { class: 'font-semibold' }, 'financial_report.csv'));
  t3.appendChild(new MockElement('img', { alt: 'Uploaded image chart.png' }));
  t3.appendChild(new MockElement('div', { class: 'whitespace-pre-wrap' }, 'Please review the attached spreadsheet and chart.'));

  // Turn 4: Assistant with web search
  const t4 = flow.appendChild(new MockElement('article', {
    'data-testid': 'conversation-turn-4',
    'data-message-author-role': 'assistant'
  }));
  t4.appendChild(new MockElement('button', { 'aria-label': 'Searched 3 sites', class: 'search-pill' }, 'Searched 3 sites'));
  t4.appendChild(new MockElement('div', { class: 'markdown' }, 'Based on recent data, growth is steady.'));

  return root;
}

export function runDomExtractorTests() {
  console.log('--- Running DOM Extractor & Detection Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(name, condition) {
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}`);
      failed++;
    }
  }

  const mockRoot = buildMockDOM();

  // 1. Model Detection Test
  const modelDetector = new ModelDetector(modelLimitsDb);
  const detectedModel = modelDetector.detect(mockRoot);
  assert('Model detector accurately identifies "GPT-4o" from header button', detectedModel.id === 'gpt-4o' && detectedModel.displayName === 'GPT-4o');
  assert('Model detector attaches verified 128k context window', detectedModel.contextWindow === 128000);

  // 2. Message Extraction Test
  const extractor = new MessageExtractor();
  const messages = extractor.extractMessages(mockRoot);

  assert('Extracts exactly 4 conversation turns', messages.length === 4);
  assert('Turn 1 correctly assigned role "user"', messages[0].role === 'user');
  assert('Turn 2 correctly assigned role "assistant"', messages[1].role === 'assistant');
  assert('Turn 3 correctly assigned role "user"', messages[2].role === 'user');
  assert('Turn 4 correctly assigned role "assistant"', messages[3].role === 'assistant');

  assert('Strips UI buttons ("Edit", "Copy") from turn text', !messages[0].text.includes('Edit') && !messages[1].text.includes('Copy'));
  assert('Preserves preformatted code block in assistant turn', messages[1].text.includes('def fib(n): return n'));

  // 3. Attachment Detection Test
  const attachmentDetector = new AttachmentDetector();
  const attachments = attachmentDetector.detect(mockRoot);
  assert('Detects uploaded image attachment', attachments.files.some(f => f.type === 'image'));
  assert('Detects uploaded document attachment', attachments.files.some(f => f.type === 'document'));
  assert('Estimates image vision tokens (~300 tokens)', attachments.estimatedTokens === 300);
  assert('Marks internal document tokens as UNKNOWN (hasUnknown = true)', attachments.hasUnknown === true);

  // 4. Tool & Web Search Detection Test
  const toolDetector = new ToolDetector();
  const tools = toolDetector.detect(mockRoot);
  assert('Detects Web Search invocation', tools.observed === true && tools.list.some(t => t.type === 'web_search'));
  assert('Marks tool context token impact as UNKNOWN', tools.list.every(t => t.tokenStatus === 'UNKNOWN'));

  return { passed, failed };
}
