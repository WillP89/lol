import Anthropic from '@anthropic-ai/sdk';
import { TASTE_TAXONOMY, TASTE_INTEREST_INDEX } from '@plot/shared';
import { config } from '../lib/config';
import { logger } from '../lib/logger';

/**
 * "Describe your Crew/yourself and Plot sets up your taste for you" — the real gap this closes:
 * every taste-capture surface (TuneMyPlotSheet, CrewTuneSheet) is a tap-through-the-taxonomy
 * picker, which is honest and specific but genuinely slow the first time someone sets it up.
 * This is the fast path: one free-text description ("we're a group of five who love UK garage,
 * football on a Saturday, and trying new restaurants") in, and Plot pre-selects the real taxonomy
 * interests that description actually supports — reviewable and editable afterwards through the
 * exact same tap-to-toggle sheets, never a black box the person can't see or correct.
 *
 * Deliberately NOT free-form: the model is given the real taxonomy and forced (via a strict,
 * tool-choice-forced tool call) to answer with interest ids from that exact list, or a short
 * literal phrase when nothing in the taxonomy fits — the same "never invent a match" discipline
 * tasteSignals.ts#interpretFreeText already applies to a single typed phrase, now applied to a
 * whole paragraph. Every id the model returns is re-validated against TASTE_INTEREST_INDEX below
 * regardless of what the tool schema already constrains it to — belt and braces against a model
 * that ignores the schema.
 */

export class AiTasteSetupUnavailableError extends Error {
  constructor() {
    super('AI-assisted taste setup isn\'t configured yet — ANTHROPIC_API_KEY is not set.');
    this.name = 'AiTasteSetupUnavailableError';
  }
}

export interface AiTasteSetupResult {
  interestIds: string[];
  /** Specific things the description named that the real taxonomy has no interest for (an
   *  artist, a team, a cuisine) — preserved verbatim, same honesty rule as a person's own
   *  free-text taps (tasteSignals.ts#interpretFreeText), never forced onto a nearby taxonomy id. */
  freeText: string[];
}

const MAX_DESCRIPTION_LENGTH = 600;
const MODEL = 'claude-opus-5';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) throw new AiTasteSetupUnavailableError();
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

/** Compact "id (label) — synonym, synonym" lines, one per interest, grouped by territory — the
 *  full real taxonomy, not a summary, since the whole point is the model can ONLY pick from
 *  what's actually here. */
function taxonomyPrompt(): string {
  return TASTE_TAXONOMY.map((territory) => {
    const lines = territory.interests.map((i) => `  - ${i.id}: ${i.label}`).join('\n');
    return `${territory.label}:\n${lines}`;
  }).join('\n\n');
}

const TOOL_NAME = 'apply_taste_selection';

export async function interpretTasteDescription(description: string): Promise<AiTasteSetupResult> {
  const anthropic = getClient(); // throws AiTasteSetupUnavailableError before any real work if unset
  const text = description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  if (!text) return { interestIds: [], freeText: [] };

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1536,
    output_config: { effort: 'medium' },
    system:
      'You turn a free-text description of what a person or a Crew (a small group of friends) is into ' +
      'into a real, specific taste selection — never a vague guess. You are given the COMPLETE real taxonomy ' +
      'below; you may only return interest ids that appear in it verbatim. Only include an id when the ' +
      'description genuinely, specifically supports it — "we like going out" alone does not justify picking ' +
      'ten interests, and a description that never mentions food should return no food interests. When the ' +
      'description names something specific the taxonomy has no id for (an artist, a sports team, a cuisine, ' +
      'a particular venue or night), put the short literal phrase in freeText instead of forcing it onto the ' +
      'nearest taxonomy id — inventing a match is worse than leaving it out.\n\nTaxonomy:\n' + taxonomyPrompt(),
    tools: [
      {
        name: TOOL_NAME,
        description: 'Records the taste selection extracted from the description.',
        input_schema: {
          type: 'object',
          properties: {
            interestIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Taxonomy interest ids (verbatim, from the list given) the description genuinely supports.',
            },
            freeText: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific named things (artist, team, cuisine, venue) not covered by any taxonomy id.',
            },
          },
          required: ['interestIds', 'freeText'],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: text }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  if (!toolUse) {
    logger.warn({ stopReason: response.stop_reason }, 'AI taste setup: model returned no tool call');
    return { interestIds: [], freeText: [] };
  }

  const input = toolUse.input as { interestIds?: unknown; freeText?: unknown };
  const rawInterestIds = Array.isArray(input.interestIds) ? input.interestIds : [];
  const rawFreeText = Array.isArray(input.freeText) ? input.freeText : [];

  // Never trust the model's output as-is, even with a strict schema — strict guarantees SHAPE
  // (an array of strings), never that each string is a real id. Re-checked against the actual
  // taxonomy index, the exact same discipline every other free-text/interest path in this
  // codebase already applies.
  const interestIds = [...new Set(rawInterestIds.filter((id): id is string => typeof id === 'string' && TASTE_INTEREST_INDEX.has(id)))];
  const freeText = [...new Set(rawFreeText.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim().slice(0, 120)))].slice(0, 10);

  return { interestIds, freeText };
}
