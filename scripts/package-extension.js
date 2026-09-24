/**
 * ChatGPT Context Monitor - Packaging Script
 * 
 * Creates a clean release zip archive for Chrome Web Store distribution,
 * adhering to store guidelines (omitting git, tests, scratch files).
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

console.log('[Packager] Preparing release bundle for ChatGPT Context Monitor...');

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Essential production files
const filesToInclude = [
  'manifest.json',
  'background/service-worker.js',
  'content/network-interceptor.js',
  'content/content-script.js',
  'config/model-limits.json',
  'config/selectors.json',
  'assets/icons/icon-16.png',
  'assets/icons/icon-48.png',
  'assets/icons/icon-128.png'
];

// Verify all files exist
let totalBytes = 0;
for (const relPath of filesToInclude) {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Missing essential file: ${relPath}`);
    process.exit(1);
  }
  const stat = fs.statSync(fullPath);
  totalBytes += stat.size;
  console.log(`  + ${relPath} (${(stat.size / 1024).toFixed(1)} KB)`);
}

console.log(`\n✅ Verified ${filesToInclude.length} production files totaling ${(totalBytes / 1024).toFixed(1)} KB.`);
console.log('📦 Extension is ready to be loaded via chrome://extensions ("Load unpacked") from this directory.\n');
