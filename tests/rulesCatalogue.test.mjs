// Catalogue lint for the rule JSON files: every rule must be well-formed, reference only
// operators/functions/categories the engine and UI actually implement, cite documents that
// resolve in the `documents` registry, and contain no duplicate JSON keys (JSON.parse keeps
// only the last duplicate silently — exactly how evidence lists have been lost before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NORMALIZE_STEP_NAMES, resolvePath, resolveRuleSetTemplates } from '../src/ruleEngine.js';
import { listRuleSets } from '../src/carriers/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE_FILES = [
  'src/carriers/eparcel/base/rules.json',
  'src/carriers/eparcel/parcel-post/rules.json',
  'src/carriers/eparcel/express-post/rules.json',
  'src/carriers/eparcel/returns/rules.json',
  'src/carriers/eparcel/metro/rules.json',
  'src/carriers/eparcel/sscc/rules.json',
  'src/carriers/startrack/base/rules.json',
  'src/carriers/startrack/express/rules.json',
  'src/carriers/startrack/premium/rules.json',
  'src/carriers/startrack/fpp/rules.json',
  'src/carriers/startrack/sscc/rules.json'
];

const ASSERT_OPS = new Set([
  'present',
  'absent',
  'notEmpty',
  'empty',
  'matches',
  'notMatches',
  'equals',
  'notEquals',
  'equalsPath',
  'in',
  'notIn',
  'range',
  'ltePath',
  'fn'
]);
const SEVERITIES = new Set(['CRITICAL', 'ERROR', 'WARNING', 'INFO']);
const OBLIGATIONS = new Set(['mandatory', 'conditional', 'advisory', 'optional']);
const ON_MISSING = new Set(['fail', 'skip', 'warning', 'manual_review', 'info']);
const FAIL_STATUSES = new Set(['fail', 'warning', 'manual_review', 'info']);
const MESSAGE_PLACEHOLDERS = new Set(['value', 'expected', 'actual', 'path']);
// Mirrors the displayCategories maps in src/carriers/*/index.js plus the categories passed through.
const CATEGORIES = new Set([
  'label-layout',
  'address-format',
  'gs1-128',
  'datamatrix',
  'barcode-structure',
  'check-digit',
  'service-code',
  'sscc',
  'startrack-label-layout',
  'startrack-text',
  'startrack-qr',
  'startrack-freight',
  'startrack-routing',
  'startrack-product',
  'startrack-atl',
  'startrack-sscc'
]);

/** Rule functions registered with registerRuleFunction(), scraped from the carrier-pack sources. */
function registeredFunctionNames() {
  const sourceFiles = [
    'src/carriers/shared/audit.js',
    'src/carriers/eparcel/audit.js',
    'src/carriers/startrack/audit.js'
  ];
  const source = sourceFiles.map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
  return new Set([...source.matchAll(/registerRuleFunction\(\s*'([^']+)'/g)].map(m => m[1]));
}

/**
 * Finds keys that appear twice in the same JSON object. A minimal scanner rather than
 * JSON.parse, because JSON.parse silently keeps only the last duplicate.
 */
function findDuplicateJsonKeys(text) {
  const duplicates = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          value += text[j] + text[j + 1];
          j += 2;
        } else {
          value += text[j];
          j += 1;
        }
      }
      const top = stack[stack.length - 1];
      if (top?.type === 'object' && top.expectKey) {
        if (top.keys.has(value)) duplicates.push({ key: value, index: i });
        top.keys.add(value);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') stack.push({ type: 'object', keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push({ type: 'array' });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top?.type === 'object') top.expectKey = true;
    }
    i += 1;
  }
  return duplicates;
}

test('duplicate-key scanner detects duplicates (self-check)', () => {
  assert.equal(findDuplicateJsonKeys('{"a": 1, "b": {"a": 2}, "c": ["a", "a"]}').length, 0);
  assert.deepEqual(
    findDuplicateJsonKeys('{"a": 1, "a": 2}').map(d => d.key),
    ['a']
  );
  assert.deepEqual(
    findDuplicateJsonKeys('{"r": [{"evidence": [1], "evidence": [2]}]}').map(d => d.key),
    ['evidence']
  );
});

for (const file of RULE_FILES) {
  test(`${file}: parses cleanly with unique ids and no duplicate JSON keys`, () => {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const duplicates = findDuplicateJsonKeys(text);
    assert.deepEqual(
      duplicates,
      [],
      `duplicate keys would be silently dropped by JSON.parse: ${duplicates.map(d => d.key).join(', ')}`
    );
    const ruleSet = JSON.parse(text);
    const ids = (ruleSet.rules || []).map(r => r.id);
    assert.deepEqual(ids, [...new Set(ids)], 'rule ids must be unique within a file');
    for (const rule of ruleSet.rules || []) assert.ok(rule.id, 'every rule needs an id');
  });
}

/** Walks an assert/when node tree and yields every leaf node. */
function* assertNodes(node) {
  if (!node) return;
  if (Array.isArray(node.all)) {
    for (const sub of node.all) yield* assertNodes(sub);
    return;
  }
  if (Array.isArray(node.any)) {
    for (const sub of node.any) yield* assertNodes(sub);
    return;
  }
  yield node;
}

test('every merged rule set is internally consistent', () => {
  const functionNames = registeredFunctionNames();
  assert.ok(functionNames.size >= 5, 'expected registered rule functions to be scraped from auditEngine');
  const problems = [];
  const check = (condition, where, message) => {
    if (!condition) problems.push(`${where}: ${message}`);
  };

  for (const [carrier, variants] of Object.entries(listRuleSets())) {
    for (const [variant, rawRuleSet] of Object.entries(variants)) {
      const ruleSet = resolveRuleSetTemplates(rawRuleSet);
      const constants = ruleSet.constants || {};
      const documents = ruleSet.documents || {};
      for (const rule of ruleSet.rules || []) {
        const where = `${carrier}/${variant} ${rule.id}`;
        check(rule.title, where, 'missing title');
        check(rule.description, where, 'missing description');
        check(OBLIGATIONS.has(rule.obligation), where, `unknown obligation ${rule.obligation}`);
        check(SEVERITIES.has(rule.severity), where, `unknown severity ${rule.severity}`);
        check(CATEGORIES.has(rule.category), where, `unknown category ${rule.category}`);
        check(rule.assert, where, 'missing assert');
        if (rule.onMissing !== undefined)
          check(ON_MISSING.has(rule.onMissing), where, `unknown onMissing ${rule.onMissing}`);
        if (rule.failStatus !== undefined)
          check(FAIL_STATUSES.has(rule.failStatus), where, `unknown failStatus ${rule.failStatus}`);
        if (rule.onEmpty !== undefined)
          check(FAIL_STATUSES.has(rule.onEmpty) || rule.onEmpty === 'skip', where, `unknown onEmpty ${rule.onEmpty}`);

        if (rule.source) {
          check(rule.source.doc, where, 'source without doc');
          const documentInfo = documents[rule.source.doc];
          check(
            documentInfo?.title,
            where,
            `source doc "${rule.source.doc}" has no documents registry entry with a title`
          );
        }

        // A regex is not a reader-friendly "Expected" value, so pattern rules must say it in words.
        const usesPattern = [...assertNodes(rule.assert)].some(n => n.op === 'matches' || n.op === 'notMatches');
        if (usesPattern) check(rule.expectedText, where, 'pattern rule needs an expectedText in plain words');
        for (const [, token] of String(rule.expectedText || '').matchAll(/\{(\w+)\}/g)) {
          check(MESSAGE_PLACEHOLDERS.has(token), where, `expectedText uses unknown placeholder {${token}}`);
        }

        for (const node of [...assertNodes(rule.when), ...assertNodes(rule.itemWhen), ...assertNodes(rule.assert)]) {
          check(ASSERT_OPS.has(node.op), where, `unknown op ${node.op}`);
          for (const step of node.normalize || []) {
            check(NORMALIZE_STEP_NAMES.includes(step), where, `unknown normalize step ${step}`);
          }
          if (node.op === 'matches' || node.op === 'notMatches') {
            try {
              new RegExp(node.value, node.flags);
            } catch (error) {
              check(false, where, `regex does not compile: ${error.message}`);
            }
            check(!String(node.value).includes('{{'), where, `unresolved template token in regex ${node.value}`);
          }
          if (node.op === 'fn')
            check(functionNames.has(node.name), where, `rule function ${node.name} is not registered`);
          if ((node.op === 'in' || node.op === 'notIn') && typeof node.value === 'string') {
            check(
              node.value.startsWith('$constants.'),
              where,
              `in/notIn with a string value must be a $constants reference (${node.value})`
            );
            const list = resolvePath(node.value.slice('$constants.'.length), constants);
            check(Array.isArray(list), where, `${node.value} does not resolve to a constants list`);
          }
        }

        for (const [messageKey, message] of Object.entries(rule.messages || {})) {
          for (const [, token] of String(message).matchAll(/\{(\w+)\}/g)) {
            check(MESSAGE_PLACEHOLDERS.has(token), where, `messages.${messageKey} uses unknown placeholder {${token}}`);
          }
        }
      }
    }
  }

  assert.deepEqual(problems, []);
});
