// Loads the StarTrack rule sets and resolves each variant file over the base file.
// Rule files are the source of truth for label validation; tests/rulesCatalogue.test.mjs guards them.
import { mergeRuleSets } from '../../ruleEngine.js';
import { GS1_AUSTRALIA_PREFIXES } from '../shared/reference.js';
import baseFile from './base/rules.json' with { type: 'json' };
import express from './express/rules.json' with { type: 'json' };
import premium from './premium/rules.json' with { type: 'json' };
import fpp from './fpp/rules.json' with { type: 'json' };
import sscc from './sscc/rules.json' with { type: 'json' };

// Hand-editable reference values (shared/reference-values.json) become rule constants.
const base = { ...baseFile, constants: { ...baseFile.constants, gs1AustraliaPrefixes: GS1_AUSTRALIA_PREFIXES } };

export const RULE_SETS = {
  base,
  express: mergeRuleSets(base, express),
  premium: mergeRuleSets(base, premium),
  fpp: mergeRuleSets(base, fpp),
  sscc: mergeRuleSets(base, sscc)
};

export function ruleSetFor(variant) {
  return RULE_SETS[variant] || RULE_SETS.base;
}
