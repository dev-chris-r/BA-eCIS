// Unit tests for the declarative rule evaluator. Everything here is pure Node —
// no browser, no scanner — so these run on any clone with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyNormalize,
  evalAssert,
  evaluateRuleSet,
  mergeRuleSets,
  registerRuleFunction,
  resolvePath,
  resolveRuleSetTemplates,
  resolveRuleSource
} from '../src/ruleEngine.js';

test('resolvePath walks dotted paths against context and item', () => {
  const context = { text: { toBlock: ['TO', 'JOHN'] }, derived: { count: 2 } };
  const item = { type: 'eparcel-standard', fields: { postcode: '2000' } };
  assert.equal(resolvePath('derived.count', context), 2);
  assert.deepEqual(resolvePath('text.toBlock', context), ['TO', 'JOHN']);
  assert.equal(resolvePath('item.fields.postcode', context, item), '2000');
  assert.equal(resolvePath('item', context, item), item);
  assert.equal(resolvePath('$context.derived.count', context, item), 2);
  assert.equal(resolvePath('text.missing.deeper', context), undefined);
  assert.equal(resolvePath('', context), undefined);
});

test('applyNormalize applies known steps and ignores unknown ones', () => {
  assert.equal(applyNormalize(' ab c ', ['stripSpaces', 'upper']), 'ABC');
  assert.equal(applyNormalize(' padded ', ['trim']), 'padded');
  assert.equal(applyNormalize('AB-12 34', ['digitsOnly']), '1234');
  assert.equal(applyNormalize('keep', ['noSuchStep']), 'keep');
  assert.equal(applyNormalize(null, ['upper']), '');
});

test('evalAssert presence and emptiness operators', () => {
  assert.equal(evalAssert({ op: 'present' }, 'x').pass, true);
  assert.equal(evalAssert({ op: 'present' }, '   ').pass, false);
  assert.equal(evalAssert({ op: 'absent' }, null).pass, true);
  assert.equal(evalAssert({ op: 'absent' }, 'x').pass, false);
  assert.equal(evalAssert({ op: 'notEmpty' }, ['a']).pass, true);
  assert.equal(evalAssert({ op: 'notEmpty' }, []).pass, false);
  assert.equal(evalAssert({ op: 'empty' }, []).pass, true);
  assert.equal(evalAssert({ op: 'empty' }, ['a']).pass, false);
});

test('evalAssert string, list and range operators', () => {
  assert.equal(evalAssert({ op: 'matches', value: '^\\d{4}$' }, '2000').pass, true);
  assert.equal(evalAssert({ op: 'matches', value: 'express', flags: 'i' }, 'EXPRESS POST').pass, true);
  assert.equal(evalAssert({ op: 'notMatches', value: ',' }, 'SYDNEY NSW 2000').pass, true);
  assert.equal(evalAssert({ op: 'equals', value: '0' }, 0).pass, true);
  assert.equal(evalAssert({ op: 'equals', value: 'AB', normalize: ['upper'] }, 'ab').pass, true);
  assert.equal(evalAssert({ op: 'notEquals', value: '00000000' }, '12345678').pass, true);
  assert.equal(evalAssert({ op: 'in', value: ['03', '08'] }, '03').pass, true);
  assert.equal(evalAssert({ op: 'in', value: ['03', '08'] }, '09').pass, false);
  assert.equal(evalAssert({ op: 'notIn', value: ['PAL', 'SKI'] }, 'CTN').pass, true);
  assert.equal(evalAssert({ op: 'range', min: 1, max: 20 }, '07').pass, true);
  assert.equal(evalAssert({ op: 'range', min: 1, max: 20 }, '21').pass, false);
  assert.equal(evalAssert({ op: 'range', min: 200 }, '').pass, false);
});

test('evalAssert resolves $constants references for list operators', () => {
  const constants = { serviceCodes: ['03', '08'] };
  assert.equal(evalAssert({ op: 'in', value: '$constants.serviceCodes' }, '08', {}, null, constants).pass, true);
  assert.equal(evalAssert({ op: 'in', value: '$constants.serviceCodes' }, '99', {}, null, constants).pass, false);
});

test('evalAssert path comparison operators', () => {
  const context = { text: { toState: 'NSW', maxWeight: '32' } };
  assert.equal(evalAssert({ op: 'equalsPath', path: 'text.toState' }, 'NSW', context).pass, true);
  assert.equal(evalAssert({ op: 'equalsPath', path: 'text.toState' }, 'VIC', context).pass, false);
  assert.equal(evalAssert({ op: 'equalsPath', path: 'text.missing' }, 'NSW', context).pass, false);
  assert.equal(evalAssert({ op: 'ltePath', path: 'text.maxWeight' }, '30', context).pass, true);
  assert.equal(evalAssert({ op: 'ltePath', path: 'text.maxWeight' }, '33', context).pass, false);
  assert.equal(evalAssert({ op: 'ltePath', path: 'text.maxWeight' }, '', context).pass, true, 'empty value passes');
});

test('evalAssert fn dispatches to registered functions and flags unregistered ones', () => {
  registerRuleFunction('testAlwaysTrue', () => true);
  registerRuleFunction('testRichResult', (value, { args }) => ({
    pass: value === args.expected,
    expected: args.expected,
    actual: value
  }));
  assert.equal(evalAssert({ op: 'fn', name: 'testAlwaysTrue' }, 'x').pass, true);
  const rich = evalAssert({ op: 'fn', name: 'testRichResult', args: { expected: 'A' } }, 'B');
  assert.equal(rich.pass, false);
  assert.equal(rich.expected, 'A');
  const missing = evalAssert({ op: 'fn', name: 'testNotRegistered' }, 'x');
  assert.equal(missing.pass, false);
  assert.match(missing.message, /not registered/);
});

test('evalAssert all/any combinators', () => {
  const all = {
    all: [
      { op: 'matches', value: '^\\d+$' },
      { op: 'notEquals', value: '0' }
    ]
  };
  assert.equal(evalAssert(all, '12').pass, true);
  assert.equal(evalAssert(all, '0').pass, false);
  const any = {
    any: [
      { op: 'equals', value: 'A' },
      { op: 'equals', value: 'B' }
    ]
  };
  assert.equal(evalAssert(any, 'B').pass, true);
  assert.equal(evalAssert(any, 'C').pass, false);
});

test('mergeRuleSets merges by rule id, drops disabled rules, merges constants and documents', () => {
  const base = {
    id: 'base',
    spec: { doc: 'Base spec' },
    constants: { a: 1, codes: ['x'] },
    documents: { 'Doc A': { title: 'Document A' } },
    rules: [
      { id: 'R1', title: 'one', severity: 'ERROR' },
      { id: 'R2', title: 'two' },
      { id: 'R3', title: 'three' }
    ]
  };
  const variant = {
    id: 'variant',
    extends: 'base',
    constants: { codes: ['y'] },
    documents: { 'Doc B': { title: 'Document B' } },
    rules: [
      { id: 'R2', severity: 'WARNING' },
      { id: 'R3', disabled: true },
      { id: 'R4', title: 'four' }
    ]
  };
  const merged = mergeRuleSets(base, variant);
  assert.equal(merged.id, 'variant');
  assert.deepEqual(merged.constants, { a: 1, codes: ['y'] });
  assert.deepEqual(Object.keys(merged.documents).sort(), ['Doc A', 'Doc B']);
  assert.deepEqual(
    merged.rules.map(r => r.id),
    ['R1', 'R2', 'R4']
  );
  const r2 = merged.rules.find(r => r.id === 'R2');
  assert.equal(r2.title, 'two', 'partial override keeps base fields');
  assert.equal(r2.severity, 'WARNING', 'partial override replaces given fields');
});

test('resolveRuleSetTemplates substitutes constants into rule strings', () => {
  const ruleSet = {
    constants: { auStates: ['NSW', 'VIC'], gtin: '99312650999998' },
    rules: [
      { id: 'R1', assert: { op: 'matches', value: '^({{auStates}})$' } },
      { id: 'R2', assert: { op: 'equals', value: '{{gtin}}' } },
      { id: 'R3', assert: { op: 'equals', value: '{{unknown}}' } }
    ]
  };
  const resolved = resolveRuleSetTemplates(ruleSet);
  assert.equal(resolved.rules[0].assert.value, '^(NSW|VIC)$');
  assert.equal(resolved.rules[1].assert.value, '99312650999998');
  assert.equal(resolved.rules[2].assert.value, '{{unknown}}', 'unknown tokens stay literal');
  assert.equal(resolveRuleSetTemplates(ruleSet), resolved, 'resolution is cached per rule set');
});

test('resolveRuleSource resolves the documents registry with sensible fallbacks', () => {
  const ruleSet = {
    spec: { doc: 'Fallback spec title v2', date: '2024-01-01' },
    documents: { 'Spec v1': { title: 'Full Specification Title', version: 'v1.4', date: '2025-06-05' } }
  };
  const resolved = resolveRuleSource({ source: { doc: 'Spec v1', page: 14 } }, ruleSet);
  assert.deepEqual(resolved, {
    doc: 'Spec v1',
    page: 14,
    title: 'Full Specification Title',
    version: 'v1.4',
    date: '2025-06-05'
  });
  const unknownDoc = resolveRuleSource({ source: { doc: 'Elsewhere', ref: 'A.1' } }, ruleSet);
  assert.equal(unknownDoc.title, 'Elsewhere', 'unknown doc falls back to the short code');
  assert.equal(unknownDoc.version, undefined);
  const specFallback = resolveRuleSource({}, ruleSet);
  assert.equal(specFallback.title, 'Fallback spec title v2');
  assert.equal(resolveRuleSource({}, {}), null);
});

// Miniature rule set exercising every result path: messages, skips, per-item rules, missing inputs, downgrades.
const REPORT_RULE_SET = {
  id: 'test-set',
  spec: { doc: 'Test spec' },
  constants: { allowed: ['A', 'B'] },
  documents: { 'Doc X': { title: 'Document X Full Title', version: 'v9' } },
  rules: [
    {
      id: 'T-01',
      title: 'Value equals A',
      obligation: 'mandatory',
      severity: 'ERROR',
      category: 'test',
      source: { doc: 'Doc X', page: 3 },
      input: 'fields.value',
      evidence: ['fields.other'],
      assert: { op: 'equals', value: 'A' },
      messages: { pass: 'Value is {actual}.', fail: 'Expected {expected} but found {actual} at {path}.' }
    },
    {
      id: 'T-02',
      title: 'Skipped when absent',
      when: { path: 'fields.enabled', op: 'equals', value: true },
      reportWhenSkipped: true,
      input: 'fields.value',
      assert: { op: 'present' },
      messages: { skipped: 'Not applicable here.' }
    },
    {
      id: 'T-03',
      title: 'Per item code allowed',
      forEach: 'items',
      itemWhen: { path: 'item.kind', op: 'equals', value: 'wanted' },
      input: 'item.code',
      assert: { op: 'in', value: '$constants.allowed' }
    },
    {
      id: 'T-04',
      title: 'Missing input escalates to manual review',
      input: 'fields.absent',
      assert: { op: 'matches', value: '^x$' },
      onMissing: 'manual_review',
      messages: { missing: 'Could not read the value.' }
    },
    {
      id: 'T-05',
      title: 'Missing input skipped silently',
      input: 'fields.absent',
      assert: { op: 'matches', value: '^x$' },
      onMissing: 'skip'
    },
    {
      id: 'T-06',
      title: 'Failure downgraded to warning',
      obligation: 'advisory',
      input: 'fields.value',
      assert: { op: 'equals', value: 'Z' },
      failStatus: 'warning'
    },
    {
      id: 'T-07',
      title: 'Empty list fails when required',
      forEach: 'missingItems',
      onEmpty: 'fail',
      input: 'item',
      assert: { op: 'present' }
    }
  ]
};

test('evaluateRuleSet end to end: statuses, messages, evidence and source resolution', () => {
  const context = {
    fields: { value: 'A', other: 'evidence-value', enabled: false },
    items: [
      { kind: 'wanted', code: 'A' },
      { kind: 'ignored', code: 'Q' },
      { kind: 'wanted', code: 'C' }
    ]
  };
  const results = evaluateRuleSet(REPORT_RULE_SET, context);
  const byId = Object.fromEntries(results.map(r => [r.id, r]));

  assert.equal(byId['T-01'].status, 'pass');
  assert.equal(byId['T-01'].message, 'Value is A.');
  assert.match(byId['T-01'].evidence, /fields\.other: evidence-value/);
  assert.equal(byId['T-01'].rule.source.title, 'Document X Full Title');
  assert.equal(byId['T-01'].rule.source.version, 'v9');
  assert.equal(byId['T-01'].rule.source.page, 3);

  assert.equal(byId['T-02'].status, 'not_applicable');
  assert.equal(byId['T-02'].message, 'Not applicable here.');

  assert.equal(byId['T-03_0'].status, 'pass', 'first wanted item passes');
  assert.equal(byId['T-03_2'].status, 'fail', 'second wanted item fails the allowed list');
  assert.equal(byId['T-03_1'], undefined, 'itemWhen-filtered items produce no result');

  assert.equal(byId['T-04'].status, 'manual_review');
  assert.equal(byId['T-04'].message, 'Could not read the value.');
  assert.equal(byId['T-05'], undefined, 'onMissing skip produces no result');

  assert.equal(byId['T-06'].status, 'warning');
  assert.equal(byId['T-06'].severity, 'INFO', 'advisory obligation defaults severity to INFO');
  assert.equal(byId['T-01'].severity, 'ERROR');

  assert.equal(byId['T-07'].status, 'fail');
  assert.match(byId['T-07'].expected, /missingItems populated/);
});

test('evaluateRuleSet formats fail messages with expected/actual/path placeholders', () => {
  const context = { fields: { value: 'B', other: 'x' }, items: [] };
  const results = evaluateRuleSet(REPORT_RULE_SET, context);
  const t01 = results.find(r => r.id === 'T-01');
  assert.equal(t01.status, 'fail');
  assert.equal(t01.message, 'Expected A but found B at fields.value.');
});

test('a failed presence check shows the missing message when the rule has no fail message', () => {
  const ruleSet = {
    id: 'presence',
    rules: [
      {
        id: 'P-01',
        title: 'Delivery address',
        input: 'text.toBlock',
        assert: { op: 'notEmpty' },
        messages: { missing: 'No TO address was found.' }
      },
      {
        id: 'P-02',
        title: 'Sender address',
        input: 'text.fromBlock',
        assert: { op: 'present' },
        messages: { fail: 'Fail wins.', missing: 'Not used.' }
      }
    ]
  };
  const byId = Object.fromEntries(evaluateRuleSet(ruleSet, { text: {} }).map(r => [r.id, r]));
  assert.equal(byId['P-01'].message, 'No TO address was found.');
  assert.equal(byId['P-02'].message, 'Fail wins.');
});

test('expectedText replaces the raw expected value and fills placeholders', () => {
  const ruleSet = {
    id: 'expected-text',
    rules: [
      {
        id: 'E-01',
        title: 'Postcode',
        input: 'postcode',
        expectedText: '4 digits',
        assert: { op: 'matches', value: '^\\d{4}$' },
        messages: { fail: 'Postcode {actual} must be 4 digits.' }
      },
      {
        id: 'E-02',
        title: 'Product',
        input: 'product',
        expectedText: 'A product for this label type: {expected}',
        assert: { op: 'in', value: ['PRM', 'ARL'] }
      },
      { id: 'E-03', title: 'Raw', input: 'postcode', assert: { op: 'matches', value: '^\\d{4}$' } }
    ]
  };
  const byId = Object.fromEntries(evaluateRuleSet(ruleSet, { postcode: '30A0', product: 'EXP' }).map(r => [r.id, r]));
  assert.equal(byId['E-01'].expected, '4 digits');
  assert.equal(byId['E-01'].message, 'Postcode 30A0 must be 4 digits.');
  assert.equal(byId['E-02'].expected, 'A product for this label type: one of PRM, ARL');
  assert.equal(byId['E-03'].expected, 'matches ^\\d{4}$', 'rules without expectedText keep the engine value');
});
