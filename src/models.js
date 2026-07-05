/**
 * The single source of truth for the model catalog: ids, UI labels, and
 * $/MTok rates for the cost meter. The wizard and Settings build their
 * dropdowns from this via GET /api/config, so adding a model is one edit.
 */
export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet — recommended (~$0.20/hr)', inRate: 3, outRate: 15 },
  { id: 'claude-haiku-4-5', label: 'Haiku — budget (~$0.07/hr)', inRate: 1, outRate: 5 },
  { id: 'claude-opus-4-8', label: 'Opus — premium (~$0.60/hr)', inRate: 5, outRate: 25 },
];

/**
 * Cost of one API response in dollars, or null for models we have no rates
 * for. Cache reads bill at 10% of the input rate, 5-minute cache writes at
 * 125%; usage.input_tokens is the uncached remainder, so no double-counting.
 */
export function messageCost(modelId, usage) {
  const model = MODELS.find((m) => modelId && modelId.startsWith(m.id));
  if (!model || !usage) return null;
  return (
    ((usage.input_tokens || 0) * model.inRate +
      (usage.output_tokens || 0) * model.outRate +
      (usage.cache_read_input_tokens || 0) * model.inRate * 0.1 +
      (usage.cache_creation_input_tokens || 0) * model.inRate * 1.25) /
    1_000_000
  );
}
