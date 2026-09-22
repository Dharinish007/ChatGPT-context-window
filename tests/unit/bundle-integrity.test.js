/**
 * ChatGPT Context Monitor - Bundle Integrity & Syntax Tests
 * 
 * Verifies that the production bundled content script:
 * - Compiles without SyntaxErrors (preventing duplicate declaration errors like EvidenceType)
 * - Contains exactly one canonical declaration of EvidenceType
 * - Maintains referential identity between context-classifier and evidence-merger exports
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EvidenceType as ClassifierEvidenceType, AccuracyClass } from '../../engine/context-classifier.js';
import { EvidenceType as MergerEvidenceType } from '../../engine/evidence-merger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

export function runBundleIntegrityTests() {
  console.log('--- Running Bundle Integrity & Canonical Definition Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`  ❌ [FAIL] ${message}`);
      failed++;
    } else {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    }
  }

  // 1. Referential identity across modules
  assert(
    ClassifierEvidenceType === MergerEvidenceType,
    'Canonical EvidenceType has identical reference across context-classifier and evidence-merger'
  );

  assert(
    AccuracyClass === ClassifierEvidenceType,
    'AccuracyClass is an alias with identical reference to EvidenceType'
  );

  // 2. Canonical tiers
  assert(
    ClassifierEvidenceType.EXACT === 'EXACT' &&
    ClassifierEvidenceType.OBSERVED === 'OBSERVED' &&
    ClassifierEvidenceType.ESTIMATED === 'ESTIMATED' &&
    ClassifierEvidenceType.UNKNOWN === 'UNKNOWN',
    'EvidenceType contains all four epistemic tiers'
  );

  assert(
    Object.isFrozen(ClassifierEvidenceType),
    'EvidenceType object is frozen against runtime mutations'
  );

  // 3. Read production bundle
  const bundlePath = path.join(rootDir, 'content', 'content-script.js');
  assert(fs.existsSync(bundlePath), 'content/content-script.js exists');

  const bundleContent = fs.readFileSync(bundlePath, 'utf8');

  // 4. Bundle parses cleanly without SyntaxErrors
  let parsedCleanly = false;
  let syntaxErrorMessage = null;
  try {
    new Function(bundleContent);
    parsedCleanly = true;
  } catch (err) {
    syntaxErrorMessage = err.message;
  }

  assert(
    parsedCleanly,
    `Production bundle compiles with zero SyntaxErrors (error: ${syntaxErrorMessage})`
  );

  // 5. EvidenceType declaration is not duplicated
  const lines = bundleContent.split('\n');
  const evidenceTypeDecls = lines.filter(line => /^\s*const\s+EvidenceType\s*=/.test(line));

  assert(
    evidenceTypeDecls.length === 1,
    `EvidenceType is declared exactly once in the bundle (found ${evidenceTypeDecls.length})`
  );

  return { passed, failed };
}
