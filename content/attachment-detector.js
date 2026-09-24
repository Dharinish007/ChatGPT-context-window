/**
 * ChatGPT Context Monitor - Attachment Detector
 * 
 * Detects observable files, images, documents, and canvas artifacts attached
 * to user prompts or assistant responses, estimating token impact where defensible.
 */

import { queryGroups } from './tool-detector.js';

const ATTACHMENT_GROUPS = [
  "img[alt*='Uploaded image'], [data-testid='attachment-thumbnail']",
  "[data-testid='file-attachment'], div[class*='file-pill'], div[class*='file-attachment']"
];

export class AttachmentDetector {
  /**
   * Scans DOM for observable attachments.
   * @param {Document|HTMLElement} root 
   * @returns {{ count: number, files: Array<{ name: string, type: string, size: string|null, estimatedTokens: number, isUnknown: boolean }>, estimatedTokens: number, hasUnknown: boolean }}
   */
  detect(root = document) {
    const files = [];
    let totalTokens = 0;
    let hasUnknown = false;

    // One page traversal for both kinds (see queryGroups in tool-detector.js)
    const [imageElements, fileChips] = queryGroups(root, ATTACHMENT_GROUPS);

    // 1. Detect uploaded image thumbnails
    for (let i = 0; i < imageElements.length; i++) {
      // OpenAI vision models use ~85 base tokens (low detail) or ~765-1105 (high detail tiles)
      // We use a conservative calibrated estimate of ~300 tokens per image
      const imgTokens = 300;
      files.push({
        name: `Image Attachment ${i + 1}`,
        type: 'image',
        size: null,
        estimatedTokens: imgTokens,
        isUnknown: false
      });
      totalTokens += imgTokens;
    }

    // 2. Detect document and code file chips
    for (let i = 0; i < fileChips.length; i++) {
      const chip = fileChips[i];
      const nameEl = chip.querySelector("div[class*='font-semibold'], span[class*='text-sm'], .truncate");
      const fileName = nameEl ? nameEl.textContent.trim() : `File ${i + 1}`;

      // Check if file size is shown
      const sizeMatch = chip.textContent.match(/(\d+(?:\.\d+)?\s*(?:KB|MB|bytes))/i);
      const sizeStr = sizeMatch ? sizeMatch[0] : null;

      // When ChatGPT ingests documents (PDFs, spreadsheets, word docs) into code interpreter,
      // the exact token footprint loaded into model context is handled server-side and variable.
      // We mark documents with unknown exact tokens
      files.push({
        name: fileName,
        type: 'document',
        size: sizeStr,
        estimatedTokens: 0,
        isUnknown: true
      });
      hasUnknown = true;
    }

    return {
      count: files.length,
      files,
      estimatedTokens: totalTokens,
      hasUnknown: hasUnknown || files.some(f => f.isUnknown)
    };
  }
}
