/**
 * Generic declarative rule evaluator for the carrier rule sets in /rules.
 *
 * A rule set is JSON: { id, carrier, name, extends?, constants?, rules: [...] }.
 * Each rule is data; anything not expressible declaratively calls a named
 * function registered via registerRuleFunction. Evaluation returns results in
 * the same shape as auditEngine's result() objects, with `rule` and `input`
 * metadata attached so the report UI can show input data, rule logic and
 * outcome side by side.
 */

const CUSTOM_FNS = {};

/** Registers a named assert function callable from rule JSON via { "op": "fn", "name": ... }. */
export function registerRuleFunction(name, fn) {
  CUSTOM_FNS[name] = fn;
}

/** Resolves a dotted path against the evidence context or the current forEach item. */
export function resolvePath(path, context, item) {
  if (path == null || path === '') return undefined;
  let root = context;
  let rest = path;
  if (path === 'item') return item;
  if (path.startsWith('item.')) {
    root = item;
    rest = path.slice(5);
  } else if (path.startsWith('$context.')) {
    rest = path.slice(9);
  }
  let cur = root;
  for (const part of rest.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Resolves an assert's `value`: $constants./$context./item. prefixes are lookups, other strings literals. */
function resolveValueRef(ref, context, item, constants) {
  if (typeof ref !== 'string') return ref;
  if (ref.startsWith('$constants.')) return resolvePath(ref.slice(11), constants);
  if (ref.startsWith('$context.') || ref.startsWith('item.')) return resolvePath(ref, context, item);
  return ref;
}

/** "1 entry" / "3 entries" for list-valued inputs. */
function entryCount(list) {
  return `${list.length} ${list.length === 1 ? 'entry' : 'entries'}`;
}

/** Shared definition of "missing" across the engine: null/undefined, blank string, or empty array. */
function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// Normalize steps a rule may name in `assert.normalize`. `digitsOnly` has no rule-JSON
// user but is called directly by the `ltePath` operator below - do not drop it on the
// strength of a rules/ search alone.
const NORMALIZE_STEPS = {
  stripSpaces: s => s.replace(/\s+/g, ''),
  upper: s => s.toUpperCase(),
  trim: s => s.trim(),
  digitsOnly: s => s.replace(/\D+/g, '')
};

export const NORMALIZE_STEP_NAMES = Object.keys(NORMALIZE_STEPS);

/** Applies the named normalize steps in order; unknown step names are ignored rather than failing the rule. */
export function applyNormalize(value, normalize = []) {
  let out = value === undefined || value === null ? '' : String(value);
  for (const step of normalize) {
    const apply = Object.hasOwn(NORMALIZE_STEPS, step) ? NORMALIZE_STEPS[step] : null;
    if (apply) out = apply(out);
  }
  return out;
}

/**
 * Evaluates one assert node against a value, returning { pass, expected, actual,
 * message?, evidence? }. Combinator { all } stops at its first failing child;
 * { any } passes on the first passing child and otherwise reports its first failure.
 */
export function evalAssert(assert, value, context, item, constants) {
  if (!assert) return { pass: true, actual: value };
  if (Array.isArray(assert.all)) {
    for (const sub of assert.all) {
      const res = evalAssert(sub, value, context, item, constants);
      if (!res.pass) return res;
    }
    return { pass: true, actual: value };
  }
  if (Array.isArray(assert.any)) {
    const failures = [];
    for (const sub of assert.any) {
      const res = evalAssert(sub, value, context, item, constants);
      if (res.pass) return res;
      failures.push(res);
    }
    return failures[0] || { pass: false, actual: value };
  }

  const op = assert.op;
  const normalize = assert.normalize || [];
  const left = normalize.length ? applyNormalize(value, normalize) : value;
  const refValue = resolveValueRef(assert.value, context, item, constants);
  const right = normalize.length ? applyNormalize(refValue, normalize) : refValue;
  const str = left === undefined || left === null ? '' : String(left);

  switch (op) {
    case 'present':
      return { pass: !isEmptyValue(value), expected: 'value present', actual: isEmptyValue(value) ? 'missing' : value };
    case 'absent':
      return { pass: isEmptyValue(value), expected: 'value absent', actual: isEmptyValue(value) ? 'absent' : value };
    case 'notEmpty':
      return {
        pass: !isEmptyValue(value),
        expected: 'one or more entries',
        actual: Array.isArray(value) ? entryCount(value) : value
      };
    case 'empty':
      return {
        pass: isEmptyValue(value),
        expected: 'no entries',
        actual: Array.isArray(value) ? entryCount(value) : value
      };
    case 'matches': {
      const pattern = assert.flags ? new RegExp(assert.value, assert.flags) : new RegExp(assert.value);
      return { pass: pattern.test(str), expected: `matches ${assert.value}`, actual: str || 'missing' };
    }
    case 'notMatches': {
      const pattern = assert.flags ? new RegExp(assert.value, assert.flags) : new RegExp(assert.value);
      return { pass: !pattern.test(str), expected: `does not match ${assert.value}`, actual: str || 'missing' };
    }
    case 'equals':
      return { pass: String(left) === String(right), expected: String(right), actual: str || 'missing' };
    case 'notEquals':
      return { pass: String(left) !== String(right), expected: `not ${String(right)}`, actual: str };
    case 'equalsPath': {
      const other = resolvePath(assert.path, context, item);
      const otherNorm = applyNormalize(other, normalize);
      const pass = !isEmptyValue(other) && applyNormalize(value, normalize) === otherNorm;
      return {
        pass,
        expected: `${assert.path} = ${isEmptyValue(other) ? 'missing' : otherNorm}`,
        actual: applyNormalize(value, normalize) || 'missing'
      };
    }
    case 'in': {
      const list = (Array.isArray(right) ? right : []).map(v => applyNormalize(v, normalize));
      return {
        pass: list.includes(applyNormalize(value, normalize)),
        expected: `one of ${list.join(', ')}`,
        actual: str || 'missing'
      };
    }
    case 'notIn': {
      const list = (Array.isArray(right) ? right : []).map(v => applyNormalize(v, normalize));
      return {
        pass: !list.includes(applyNormalize(value, normalize)),
        expected: `none of ${list.join(', ')}`,
        actual: str
      };
    }
    case 'range': {
      const num = Number(str);
      const min = assert.min ?? -Infinity;
      const max = assert.max ?? Infinity;
      const pass = str !== '' && Number.isFinite(num) && num >= min && num <= max;
      return {
        pass,
        expected: `number between ${assert.min ?? '-'} and ${assert.max ?? '-'}`,
        actual: str || 'missing'
      };
    }
    case 'ltePath': {
      const other = resolvePath(assert.path, context, item);
      if (isEmptyValue(value) || isEmptyValue(other)) return { pass: true, actual: str, expected: `<= ${assert.path}` };
      return {
        pass: Number(applyNormalize(value, ['digitsOnly'])) <= Number(applyNormalize(other, ['digitsOnly'])),
        expected: `<= ${other}`,
        actual: str
      };
    }
    case 'fn': {
      const fn = CUSTOM_FNS[assert.name];
      if (!fn) return { pass: false, message: `Rule function ${assert.name} is not registered.`, actual: str };
      const res = fn(value, { context, item, constants, args: assert.args });
      if (typeof res === 'boolean') return { pass: res, actual: str };
      return res;
    }
    default:
      return { pass: false, message: `Unknown assert op ${op}.`, actual: str };
  }
}

/** Evaluates a rule's `when`/`itemWhen` guard tree; a rule with no guard always applies. */
function evalWhen(when, context, item, constants) {
  if (!when) return true;
  if (Array.isArray(when.all)) return when.all.every(w => evalWhen(w, context, item, constants));
  if (Array.isArray(when.any)) return when.any.some(w => evalWhen(w, context, item, constants));
  const value = resolvePath(when.path, context, item);
  return evalAssert(when, value, context, item, constants).pass;
}

/** Fills the {value}/{expected}/{actual}/{path} placeholders in a rule's custom message template. */
function formatMessage(template, parts) {
  if (!template) return '';
  return template.replace(/\{(value|expected|actual|path)\}/g, (_, key) => {
    const v = parts[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Merges a variant rule set over its base: constants and documents shallow-merge, rules merge by id. */
export function mergeRuleSets(base, variant) {
  if (!base) return variant;
  const byId = new Map();
  for (const rule of base.rules || []) byId.set(rule.id, rule);
  for (const rule of variant.rules || []) {
    const existing = byId.get(rule.id);
    byId.set(rule.id, existing ? { ...existing, ...rule } : rule);
  }
  return {
    ...base,
    ...variant,
    constants: { ...(base.constants || {}), ...(variant.constants || {}) },
    documents: { ...(base.documents || {}), ...(variant.documents || {}) },
    rules: [...byId.values()].filter(rule => !rule.disabled)
  };
}

/**
 * Resolves a rule's spec citation against the rule set's `documents` registry so results
 * carry the full document title and version alongside the short doc code and page/ref.
 * Sources are optional on rules; a rule without one falls back to the rule set's `spec`.
 */
export function resolveRuleSource(rule, ruleSet) {
  const source = rule.source || null;
  if (!source) {
    const spec = ruleSet.spec;
    return spec ? { doc: spec.doc, title: spec.doc, ...(spec.date ? { date: spec.date } : {}) } : null;
  }
  const documentInfo = (ruleSet.documents || {})[source.doc];
  return {
    ...source,
    title: documentInfo?.title || source.doc,
    ...(documentInfo?.version ? { version: documentInfo.version } : {}),
    ...(documentInfo?.date ? { date: documentInfo.date } : {})
  };
}

// Presence ops fail when their input is blank, so a rule with no `fail` message falls back
// to its `missing` message rather than the generic text.
const PRESENCE_OPS = new Set(['present', 'notEmpty']);

/**
 * Shapes one rule outcome into a report row. Message precedence: assert-supplied message,
 * then the rule's pass/fail template, then a generic fallback. A rule's `expectedText`
 * (placeholders allowed) replaces the engine's expected value in the report, so readers see
 * "4 digits" rather than a regex. forEach items get index-suffixed ids so repeated rows stay
 * unique in the report.
 */
function buildResult(rule, ruleSet, status, assertRes, inputPath, inputValue, context, item, index, multiple) {
  const actual = assertRes.actual !== undefined ? assertRes.actual : inputValue;
  const messageParts = { value: inputValue, expected: assertRes.expected, actual, path: inputPath };
  const expected =
    rule.expectedText && status !== 'not_applicable'
      ? formatMessage(rule.expectedText, messageParts)
      : assertRes.expected;
  const template =
    status === 'pass'
      ? rule.messages?.pass
      : rule.messages?.fail || (PRESENCE_OPS.has(rule.assert?.op) ? rule.messages?.missing : undefined);
  const message =
    assertRes.message ||
    formatMessage(template, messageParts) ||
    (status === 'pass' ? `${rule.title} requirement met.` : `${rule.title} requirement not met.`);
  const evidencePaths = rule.evidence || [];
  const inputEvidence = evidencePaths
    .map(path => ({ path, value: resolvePath(path, context, item) }))
    .filter(e => !isEmptyValue(e.value));
  return {
    id: multiple ? `${rule.id}_${index}` : rule.id,
    title: rule.title,
    severity: rule.severity || (rule.obligation === 'mandatory' ? 'ERROR' : 'INFO'),
    category: rule.category || 'general',
    status,
    message,
    expected: expected === undefined ? '' : String(expected),
    actual: actual === undefined || actual === null ? '' : typeof actual === 'string' ? actual : JSON.stringify(actual),
    evidence:
      assertRes.evidence ||
      inputEvidence
        .map(e => `${e.path}: ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}`)
        .join('\n'),
    rule: {
      id: rule.id,
      ruleSet: ruleSet.id,
      title: rule.title,
      description: rule.description || '',
      obligation: rule.obligation || 'mandatory',
      source: resolveRuleSource(rule, ruleSet),
      logic: {
        when: rule.when,
        forEach: rule.forEach,
        input: rule.input,
        assert: rule.assert,
        onMissing: rule.onMissing
      }
    },
    input: {
      path: inputPath || rule.forEach || '',
      value: inputValue === undefined || inputValue === null ? null : inputValue,
      evidence: inputEvidence
    }
  };
}

// Memoizes template resolution per rule-set object (WeakMap, so replaced rule sets stay collectable).
const TEMPLATE_CACHE = new WeakMap();

/**
 * Resolves {{constantName}} placeholders in rule strings against
 * ruleSet.constants - arrays join with | (regex alternation), scalars
 * stringify - so list-like reference data is defined once per rule file.
 */
export function resolveRuleSetTemplates(ruleSet) {
  if (TEMPLATE_CACHE.has(ruleSet)) return TEMPLATE_CACHE.get(ruleSet);
  const constants = ruleSet.constants || {};
  const sub = value => {
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (token, key) => {
        const c = constants[key];
        if (c === undefined) return token;
        return Array.isArray(c) ? c.join('|') : String(c);
      });
    }
    if (Array.isArray(value)) return value.map(sub);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = sub(v);
      return out;
    }
    return value;
  };
  const resolved = { ...ruleSet, rules: (ruleSet.rules || []).map(sub) };
  TEMPLATE_CACHE.set(ruleSet, resolved);
  return resolved;
}

/**
 * Runs every rule in a (merged) rule set against the evidence context.
 * Returns an array of result objects compatible with auditEngine validations.
 */
export function evaluateRuleSet(inputRuleSet, context) {
  const ruleSet = resolveRuleSetTemplates(inputRuleSet);
  const constants = ruleSet.constants || {};
  const results = [];
  for (const rule of ruleSet.rules || []) {
    if (rule.disabled) continue;
    if (!evalWhen(rule.when, context, null, constants)) {
      if (rule.reportWhenSkipped) {
        results.push(
          buildResult(
            rule,
            ruleSet,
            'not_applicable',
            { actual: '', message: rule.messages?.skipped || `${rule.title} does not apply to this label.` },
            rule.input,
            null,
            context,
            null,
            0,
            false
          )
        );
      }
      continue;
    }
    const items = rule.forEach ? resolvePath(rule.forEach, context) || [] : [null];
    if (rule.forEach && items.length === 0) {
      const onEmpty = rule.onEmpty || 'skip';
      if (onEmpty !== 'skip') {
        results.push(
          buildResult(
            rule,
            ruleSet,
            onEmpty,
            { expected: `${rule.forEach} populated`, actual: 'none decoded', message: rule.messages?.empty },
            rule.input,
            null,
            context,
            null,
            0,
            false
          )
        );
      }
      continue;
    }
    items.forEach((item, index) => {
      if (rule.itemWhen && !evalWhen(rule.itemWhen, context, item, constants)) return;
      const inputValue = rule.input ? resolvePath(rule.input, context, item) : item;
      // Presence-style ops judge emptiness themselves, so empty input must reach the assert
      // rather than being short-circuited by the onMissing handling below.
      const wantsAbsence =
        rule.assert &&
        (rule.assert.op === 'absent' ||
          rule.assert.op === 'empty' ||
          rule.assert.op === 'notEmpty' ||
          rule.assert.op === 'present');
      if (isEmptyValue(inputValue) && !wantsAbsence) {
        const onMissing = rule.onMissing || 'fail';
        if (onMissing === 'skip') return;
        const status = onMissing === 'fail' ? rule.failStatus || 'fail' : onMissing;
        results.push(
          buildResult(
            rule,
            ruleSet,
            status,
            { expected: 'value present', actual: 'missing', message: rule.messages?.missing },
            rule.input,
            inputValue,
            context,
            item,
            index,
            items.length > 1
          )
        );
        return;
      }
      const assertRes = evalAssert(rule.assert, inputValue, context, item, constants);
      const status = assertRes.pass ? 'pass' : assertRes.status || rule.failStatus || 'fail';
      results.push(
        buildResult(rule, ruleSet, status, assertRes, rule.input, inputValue, context, item, index, items.length > 1)
      );
    });
  }
  return results;
}
