/**
 * ChatGPT Context Monitor - Production BPE Tokenizer
 * 
 * Implements exact, model-aware byte-pair encoding (BPE) using js-tiktoken
 * with support for OpenAI's official o200k_base and cl100k_base tokenizers.
 * 
 * Features:
 * - 100% offline, local, client-side execution (zero data exfiltration).
 * - Exact model-aware BPE encoding (o200k_base for GPT-4o/o1/o3-mini; cl100k_base for GPT-4/GPT-3.5).
 * - Lazy encoder instantiation for minimal startup latency and optimal memory usage.
 * - Robust handling of special tokens (allowedSpecial: 'all') preventing runtime exceptions.
 * - Message parts[] support: counts exact BPE tokens for text while keeping non-text content classified.
 * - High-speed 32-bit FNV-1a hash caching with LRU eviction for real-time 60fps streaming.
 */

import { Tiktoken as TiktokenModule } from 'js-tiktoken/lite';
import cl100k_base_module from 'js-tiktoken/ranks/cl100k_base';
import o200k_base_module from 'js-tiktoken/ranks/o200k_base';

// In bundled browser context (scripts/build.js), Tiktoken and rank tables are defined in outer scope
const TiktokenClass = typeof Tiktoken !== 'undefined' ? Tiktoken : TiktokenModule;
const cl100kData = typeof cl100k_base !== 'undefined' ? cl100k_base : cl100k_base_module;
const o200kData = typeof o200k_base !== 'undefined' ? o200k_base : o200k_base_module;

export const SUPPORTED_ENCODINGS = Object.freeze({
  O200K_BASE: 'o200k_base',
  CL100K_BASE: 'cl100k_base'
});

export const MODEL_TO_ENCODING = Object.freeze({
  'gpt-4o': SUPPORTED_ENCODINGS.O200K_BASE,
  'gpt-4o-mini': SUPPORTED_ENCODINGS.O200K_BASE,
  'gpt-4.5': SUPPORTED_ENCODINGS.O200K_BASE,
  'o1': SUPPORTED_ENCODINGS.O200K_BASE,
  'o1-mini': SUPPORTED_ENCODINGS.O200K_BASE,
  'o1-preview': SUPPORTED_ENCODINGS.O200K_BASE,
  'o3-mini': SUPPORTED_ENCODINGS.O200K_BASE,
  'gpt-4-turbo': SUPPORTED_ENCODINGS.CL100K_BASE,
  'gpt-4': SUPPORTED_ENCODINGS.CL100K_BASE,
  'gpt-3.5-turbo': SUPPORTED_ENCODINGS.CL100K_BASE
});

const clockMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** UTF-8 bytes of a string as a one-char-per-byte string (ASCII is returned as is). */
function utf8ByteString(text) {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  const bytes = BpeCounter.textEncoder.encode(text); // Lone surrogates become EF BF BD, as in js-tiktoken
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return out;
}

/**
 * Count-only byte-pair encoding. Returns exactly js-tiktoken's `encode(text, 'all').length`: the same
 * special-token split, the same regex pieces, the same lowest-rank-first (leftmost on ties) merge
 * order. It is faster because:
 *  - ranks are keyed by the raw byte string (atob of the rank file), not comma-joined byte lists,
 *    which also makes the one-off table build several times cheaper;
 *  - after a merge only the two neighbouring pair ranks are recomputed, instead of re-joining every pair;
 *  - each distinct piece is counted once: BPE of a piece never depends on the surrounding text, and
 *    conversations repeat the same words constantly (a streamed reply is re-counted many times).
 * Exactness against js-tiktoken is checked by the tokenizer tests.
 */
export class BpeCounter {
  static textEncoder = new TextEncoder();

  constructor(ranks) {
    this.ranks = new Map();
    for (const line of ranks.bpe_ranks.split('\n')) {
      if (!line) continue;
      const fields = line.split(' '); // "<marker> <offset> <token> <token> ..."
      const offset = Number.parseInt(fields[1], 10);
      for (let i = 2; i < fields.length; i++) this.ranks.set(atob(fields[i]), offset + i - 2);
    }
    this.pieceRe = new RegExp(ranks.pat_str, 'ug');
    const specials = Object.keys(ranks.special_tokens || {});
    this.specialRe = specials.length
      ? new RegExp(specials.map(s => s.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'), 'g')
      : null;
    this.pieces = new Map(); // piece -> token count
    this.stats = { pieces: 0, pieceHits: 0 };
  }

  /** @param {string} text */
  count(text) {
    let total = 0;
    let start = 0;
    while (true) {
      let next = null;
      if (this.specialRe) {
        this.specialRe.lastIndex = start;
        next = this.specialRe.exec(text);
      }
      const end = next ? next.index : text.length;
      if (end > start) {
        for (const m of text.substring(start, end).matchAll(this.pieceRe)) total += this.countPiece(m[0]);
      }
      if (!next) break;
      total++; // Every special token is allowed and is a single token
      start = next.index + next[0].length;
    }
    return total;
  }

  countPiece(piece) {
    const hit = this.pieces.get(piece);
    if (hit !== undefined) {
      this.stats.pieceHits++;
      return hit;
    }
    const n = this.bpeCount(utf8ByteString(piece));
    if (this.pieces.size >= 200000) this.pieces.clear(); // Bounded; refills with what is in use
    this.pieces.set(piece, n);
    this.stats.pieces++;
    return n;
  }

  /** Number of tokens BPE produces for one piece given as a byte string. */
  bpeCount(s) {
    const n = s.length;
    if (n === 0) return 0;
    if (n === 1 || this.ranks.has(s)) return 1;
    const ranks = this.ranks;
    const bounds = new Array(n + 1);
    for (let i = 0; i <= n; i++) bounds[i] = i;
    const pair = new Array(n - 1); // pair[i]: rank of merging part i with part i + 1
    for (let i = 0; i < n - 1; i++) pair[i] = ranks.get(s.substring(i, i + 2)) ?? Infinity;
    while (pair.length > 0) {
      let min = Infinity;
      let at = -1;
      for (let i = 0; i < pair.length; i++) if (pair[i] < min) { min = pair[i]; at = i; }
      if (at === -1) break;
      bounds.splice(at + 1, 1);
      pair.splice(at, 1);
      if (at > 0) pair[at - 1] = ranks.get(s.substring(bounds[at - 1], bounds[at + 1])) ?? Infinity;
      if (at < pair.length) pair[at] = ranks.get(s.substring(bounds[at], bounds[at + 2])) ?? Infinity;
    }
    // js-tiktoken drops parts without a rank (never happens with byte-level ranks, kept for parity)
    let count = 0;
    for (let i = 0; i < bounds.length - 1; i++) if (ranks.has(s.substring(bounds[i], bounds[i + 1]))) count++;
    return count;
  }
}

export class Tokenizer {
  constructor(options = {}) {
    // Entries are tiny (numbers); room for several long conversations so switching back is instant
    this.maxCacheSize = options.maxCacheSize || 6000;
    this.defaultEncoding = options.defaultEncoding || SUPPORTED_ENCODINGS.O200K_BASE;
    // Map: messageId -> { hash: number, tokens: number, textLength: number, encoding: string }
    this.cache = new Map();
    // Work counters for performance diagnostics: BPE runs vs cache reuse
    this.stats = { encoded: 0, encodedChars: 0, cacheHits: 0 };
    // Lazy instance cache: encodingName -> Tiktoken instance
    this.encoders = new Map();
    // Lazy count-only BPE per encoding (what countTokens uses); encoders above are only built on demand
    this.counters = new Map();
  }

  /**
   * Count-only BPE for an encoding, built once (the rank table build is the one-off startup cost).
   * @param {string} [encoding]
   * @returns {BpeCounter}
   */
  getCounter(encoding = this.defaultEncoding) {
    const encName = this.resolveEncoding(encoding);
    if (!this.counters.has(encName)) {
      const t0 = clockMs();
      this.counters.set(encName, new BpeCounter(encName === SUPPORTED_ENCODINGS.CL100K_BASE ? cl100kData : o200kData));
      this.stats.initMs = Math.round(clockMs() - t0);
    }
    return this.counters.get(encName);
  }

  /** Builds the default encoding's tables ahead of the first count (e.g. while the network is busy). */
  warm(encoding = this.defaultEncoding) {
    this.getCounter(encoding);
  }

  /**
   * Resolves a model identifier or encoding string into a canonical encoding name.
   * @param {string} [encodingOrModel] 
   * @returns {string} 'o200k_base' | 'cl100k_base'
   */
  resolveEncoding(encodingOrModel) {
    if (!encodingOrModel) return this.defaultEncoding;
    const lower = String(encodingOrModel).toLowerCase().trim();

    if (lower === SUPPORTED_ENCODINGS.O200K_BASE || lower === 'o200k') {
      return SUPPORTED_ENCODINGS.O200K_BASE;
    }
    if (lower === SUPPORTED_ENCODINGS.CL100K_BASE || lower === 'cl100k') {
      return SUPPORTED_ENCODINGS.CL100K_BASE;
    }

    if (MODEL_TO_ENCODING[lower]) {
      return MODEL_TO_ENCODING[lower];
    }

    // Substring / fuzzy detection for model family
    if (lower.includes('4o') || lower.includes('o1') || lower.includes('o3') || lower.includes('4.5') || lower.includes('omni')) {
      return SUPPORTED_ENCODINGS.O200K_BASE;
    }
    if (lower.includes('gpt-4') || lower.includes('3.5') || lower.includes('turbo')) {
      return SUPPORTED_ENCODINGS.CL100K_BASE;
    }

    return this.defaultEncoding;
  }

  /**
   * Resolves model ID to encoding name.
   * @param {string} modelId 
   * @returns {string}
   */
  getEncodingForModel(modelId) {
    return this.resolveEncoding(modelId);
  }

  /**
   * Lazily instantiates or retrieves the Tiktoken encoder for the specified encoding.
   * @param {string} [encoding] 
   * @returns {Tiktoken}
   */
  getEncoder(encoding = this.defaultEncoding) {
    const encName = this.resolveEncoding(encoding);
    if (!this.encoders.has(encName)) {
      const ranks = encName === SUPPORTED_ENCODINGS.CL100K_BASE ? cl100kData : o200kData;
      this.encoders.set(encName, new TiktokenClass(ranks));
    }
    return this.encoders.get(encName);
  }

  /**
   * Generates a fast 32-bit FNV-1a hash of a string for cache invalidation.
   * @param {string} str 
   * @returns {number}
   */
  hashString(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /**
   * Safely encodes text without throwing on special tokens.
   * @param {Tiktoken} encoder 
   * @param {string} text 
   * @returns {Array<number>}
   */
  encodeSafely(encoder, text) {
    try {
      return encoder.encode(text, 'all');
    } catch (_) {
      try {
        return encoder.encode(text);
      } catch (err) {
        // Fallback: character-based estimate if encoder encounters an unexpected syntax failure
        console.warn('[ChatGPT Context Monitor] Tokenizer encode exception, using fallback:', err);
        return new Array(Math.max(1, Math.ceil(text.length / 4)));
      }
    }
  }

  /**
   * Tokenizes raw text and returns the exact BPE token count.
   * @param {string} text 
   * @param {string} [encodingOrModel] 
   * @returns {number}
   */
  countTokens(text, encodingOrModel = this.defaultEncoding) {
    if (!text || typeof text !== 'string' || text.length === 0) {
      return 0;
    }
    try {
      return this.getCounter(encodingOrModel).count(text);
    } catch (_) {
      // Unexpected input for the fast path: fall back to the reference encoder
      const tokens = this.encodeSafely(this.getEncoder(encodingOrModel), text);
      return tokens ? tokens.length : 0;
    }
  }

  /**
   * Tokenizes an array of message parts.
   * Exact BPE token counting is applied to text parts.
   * Non-text parts (e.g. images, files, tools) are preserved and classified without fabricating text tokens.
   * 
   * @param {string} messageId 
   * @param {Array<string|Object>} parts 
   * @param {string} [encodingOrModel] 
   * @returns {{ tokens: number, textTokens: number, hasNonTextParts: boolean, nonTextParts: Array<Object>, isExactText: boolean }}
   */
  countMessagePartsTokens(messageId, parts, encodingOrModel = this.defaultEncoding) {
    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      return {
        tokens: 0,
        textTokens: 0,
        hasNonTextParts: false,
        nonTextParts: [],
        isExactText: true
      };
    }

    const encoding = this.resolveEncoding(encodingOrModel);
    let combinedText = '';
    const nonTextParts = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (typeof part === 'string') {
        combinedText += (combinedText ? '\n' : '') + part;
      } else if (part && typeof part === 'object') {
        if (part.type === 'text' || (!part.type && typeof part.text === 'string')) {
          if (part.text) {
            combinedText += (combinedText ? '\n' : '') + part.text;
          }
        } else {
          // Non-text part (image, tool, attachment, vector, etc.)
          nonTextParts.push({
            type: part.type || 'unknown',
            classification: part.classification || 'UNKNOWN',
            details: part.details || null
          });
        }
      }
    }

    let textTokens = 0;
    if (combinedText.length > 0) {
      textTokens = this.countMessageTokens(messageId ? `${messageId}_text` : null, combinedText, encoding);
    }

    return {
      tokens: textTokens,
      textTokens,
      hasNonTextParts: nonTextParts.length > 0,
      nonTextParts,
      isExactText: true
    };
  }

  /**
   * Tokenizes a message turn with caching support.
   * If messageId matches and text hash + encoding have not changed, returns cached count in O(1).
   * Also accepts an array of parts[].
   * 
   * @param {string} messageId 
   * @param {string|Array<Object>} textOrParts 
   * @param {string} [encodingOrModel] 
   * @returns {number}
   */
  countMessageTokens(messageId, textOrParts, encodingOrModel = this.defaultEncoding) {
    if (!textOrParts) return 0;

    // Handle parts array delegation
    if (Array.isArray(textOrParts)) {
      const result = this.countMessagePartsTokens(messageId, textOrParts, encodingOrModel);
      return result.tokens;
    }

    if (typeof textOrParts !== 'string') return 0;
    if (textOrParts.length === 0) return 0;

    const encoding = this.resolveEncoding(encodingOrModel);
    const hash = this.hashString(textOrParts);
    const cacheKey = messageId ? `${messageId}_${encoding}` : null;

    if (cacheKey && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (cached.hash === hash && cached.textLength === textOrParts.length && cached.encoding === encoding) {
        // Re-insert so eviction drops the least recently USED entry, not the oldest inserted
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        this.stats.cacheHits++;
        return cached.tokens;
      }
    }

    const tokens = this.countTokens(textOrParts, encoding);
    this.stats.encoded++;
    this.stats.encodedChars += textOrParts.length;

    if (cacheKey) {
      this.cache.delete(cacheKey);
      if (this.cache.size >= this.maxCacheSize) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, { hash, tokens, textLength: textOrParts.length, encoding });
    }

    return tokens;
  }

  /**
   * Clears the tokenizer cache.
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Returns current cache and encoder diagnostics.
   * @returns {{ size: number, maxCacheSize: number, activeEncoders: Array<string> }}
   */
  getDiagnostics() {
    return {
      size: this.cache.size,
      maxCacheSize: this.maxCacheSize,
      activeEncoders: Array.from(this.encoders.keys())
    };
  }
}
