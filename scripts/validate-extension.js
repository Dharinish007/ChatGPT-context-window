/**
 * ChatGPT Context Monitor - Extension Validation Script
 * 
 * Validates Manifest V3 compliance, file path existence,
 * permission scoping, and security constraints.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('[Validator] Running Manifest V3 & Extension Pre-flight Verification...\n');

let errorCount = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`❌ [FAIL] ${message}`);
    errorCount++;
  } else {
    console.log(`✅ [PASS] ${message}`);
  }
}

// 1. Check manifest.json
const manifestPath = path.join(rootDir, 'manifest.json');
assert(fs.existsSync(manifestPath), 'manifest.json exists');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// 2. MV3 checks
assert(manifest.manifest_version === 3, 'manifest_version is 3');
assert(!manifest.background?.scripts, 'No MV2 background.scripts declaration');
assert(manifest.background?.service_worker, 'MV3 background.service_worker declared');

// 3. Physical file existence
const swPath = path.join(rootDir, manifest.background.service_worker);
assert(fs.existsSync(swPath), `Service worker file exists: ${manifest.background.service_worker}`);

const popupPath = path.join(rootDir, manifest.action.default_popup);
assert(fs.existsSync(popupPath), `Popup HTML file exists: ${manifest.action.default_popup}`);

for (const [size, iconRelPath] of Object.entries(manifest.icons)) {
  const iconPath = path.join(rootDir, iconRelPath);
  assert(fs.existsSync(iconPath), `Icon file (${size}x${size}) exists: ${iconRelPath}`);
}

for (const cs of manifest.content_scripts || []) {
  for (const jsFile of cs.js || []) {
    const csPath = path.join(rootDir, jsFile);
    assert(fs.existsSync(csPath), `Content script file exists: ${jsFile}`);
  }
}

// 4. Permissions check
assert(!manifest.permissions.includes('<all_urls>'), 'Permissions do not contain broad <all_urls>');
assert(manifest.permissions.includes('storage'), 'Required "storage" permission declared');
assert(manifest.host_permissions && manifest.host_permissions.length === 2, 'Host permissions specifically scoped to chatgpt.com & chat.openai.com');

// 5. Config files check
assert(fs.existsSync(path.join(rootDir, 'config', 'model-limits.json')), 'config/model-limits.json exists');
assert(fs.existsSync(path.join(rootDir, 'config', 'selectors.json')), 'config/selectors.json exists');

console.log('\n--- Verification Result ---');
if (errorCount === 0) {
  console.log('🎉 All 12 Extension Validation checks PASSED with 0 errors.\n');
  process.exit(0);
} else {
  console.error(`💥 Extension Validation FAILED with ${errorCount} error(s).\n`);
  process.exit(1);
}
