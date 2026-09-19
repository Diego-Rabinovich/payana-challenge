import type { MovementType } from '@aa/core';

/**
 * What a bank descriptor says.
 *
 * Only what it *says* — a type and a counterparty name. Whether a given
 * counterparty is the channel we were expecting is a reconciliation decision
 * that belongs to the ruleset, not here. Keeping the two apart is what stops
 * the confidence score from grading a conclusion ingestion already reached.
 *
 * Rules are matched in order, so a more specific prefix has to come first:
 * `IVA CUOTA MANEJO` before `CUOTA MANEJO`, or the fee rule would swallow it.
 */

export interface DescriptorRule {
  readonly id: string;
  readonly match: { readonly startsWith?: string; readonly contains?: string };
  readonly type: MovementType;
  readonly counterparty?: string;
  /** Takes the payer's name from whatever follows the prefix. */
  readonly counterpartyFrom?: { readonly afterPrefix: string };
}

export interface DescriptorConfig {
  readonly rules: readonly DescriptorRule[];
  readonly fallback: { readonly type: MovementType };
}

export interface Classification {
  readonly type: MovementType;
  readonly counterparty?: string;
  readonly ruleId: string;
  /** False when nothing matched: reported, never hidden. */
  readonly recognised: boolean;
}

export function classifyDescriptor(
  description: string,
  config: DescriptorConfig,
): Classification {
  const text = description.trim().toUpperCase();

  for (const rule of config.rules) {
    if (!matches(text, rule)) continue;
    const counterparty = resolveCounterparty(description.trim(), rule);
    return {
      type: rule.type,
      ...(counterparty ? { counterparty } : {}),
      ruleId: rule.id,
      recognised: true,
    };
  }

  return { type: config.fallback.type, ruleId: 'fallback', recognised: false };
}

function matches(text: string, rule: DescriptorRule): boolean {
  if (rule.match.startsWith) return text.startsWith(rule.match.startsWith.toUpperCase());
  if (rule.match.contains) return text.includes(rule.match.contains.toUpperCase());
  return false;
}

function resolveCounterparty(description: string, rule: DescriptorRule): string | undefined {
  if (rule.counterparty) return rule.counterparty;
  if (!rule.counterpartyFrom) return undefined;

  const prefix = rule.counterpartyFrom.afterPrefix;
  const rest = description.slice(prefix.length).trim();
  return rest.length > 0 ? rest : undefined;
}
