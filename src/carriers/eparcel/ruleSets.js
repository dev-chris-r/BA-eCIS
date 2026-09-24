// Loads the eParcel rule sets and resolves each variant file over the base file.
// Rule files are the source of truth for label validation; tests/rulesCatalogue.test.mjs guards them.
import { mergeRuleSets } from '../../ruleEngine.js';
import { GS1_AUSTRALIA_PREFIXES, TEST_MLIDS } from '../shared/reference.js';
import baseFile from './base/rules.json' with { type: 'json' };
import parcelPost from './parcel-post/rules.json' with { type: 'json' };
import expressPost from './express-post/rules.json' with { type: 'json' };
import returns from './returns/rules.json' with { type: 'json' };
import metro from './metro/rules.json' with { type: 'json' };
import sscc from './sscc/rules.json' with { type: 'json' };

// Hand-editable reference values (shared/reference-values.json) become rule constants, so
// rules can say "$constants.testMlids" and the values stay in one easy-to-edit file.
const base = {
  ...baseFile,
  constants: { ...baseFile.constants, testMlids: TEST_MLIDS, gs1AustraliaPrefixes: GS1_AUSTRALIA_PREFIXES }
};

export const RULE_SETS = {
  base,
  'parcel-post': mergeRuleSets(base, parcelPost),
  'express-post': mergeRuleSets(base, expressPost),
  returns: mergeRuleSets(base, returns),
  metro: mergeRuleSets(base, metro),
  sscc: mergeRuleSets(base, sscc)
};

export function ruleSetFor(variant) {
  return RULE_SETS[variant] || RULE_SETS.base;
}
