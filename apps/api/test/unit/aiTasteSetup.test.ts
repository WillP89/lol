import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * "Describe your Crew/yourself and Plot sets up your taste for you" — the real discipline this
 * proves: the model's output is NEVER trusted as-is, even though the tool schema already
 * constrains it to an array of strings. Every returned id is re-validated against the actual
 * taxonomy (TASTE_INTEREST_INDEX) here, same as tasteSignals.ts#interpretFreeText's own
 * "never invent a match" rule for a single typed phrase — now applied to a whole model response.
 */

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

describe('interpretTasteDescription', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    createMock.mockReset();
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('throws AiTasteSetupUnavailableError when ANTHROPIC_API_KEY is not configured, without calling the model', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { interpretTasteDescription, AiTasteSetupUnavailableError } = await import('../../src/services/aiTasteSetup');
    await expect(interpretTasteDescription('we love live music')).rejects.toThrow(AiTasteSetupUnavailableError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('drops any id the model returns that is not real taxonomy, even though the schema already constrains the shape', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'apply_taste_selection',
          input: { interestIds: ['uk_garage', 'totally_made_up_id', 'football'], freeText: [] },
        },
      ],
    });
    const { interpretTasteDescription } = await import('../../src/services/aiTasteSetup');
    const result = await interpretTasteDescription('we love UK garage and football');
    // uk_garage and football are real taxonomy ids (packages/shared/src/tasteTaxonomy.ts);
    // totally_made_up_id is not, and must never survive into what gets applied.
    expect(result.interestIds).toEqual(expect.arrayContaining(['uk_garage', 'football']));
    expect(result.interestIds).not.toContain('totally_made_up_id');
  });

  it('dedupes interest ids and free text, and caps free text at 10 entries', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'apply_taste_selection',
          input: {
            interestIds: ['uk_garage', 'uk_garage'],
            freeText: Array.from({ length: 15 }, (_, i) => `thing ${i}`),
          },
        },
      ],
    });
    const { interpretTasteDescription } = await import('../../src/services/aiTasteSetup');
    const result = await interpretTasteDescription('uk garage, uk garage, and lots of specific things');
    expect(result.interestIds).toEqual(['uk_garage']);
    expect(result.freeText.length).toBeLessThanOrEqual(10);
  });

  it('returns empty results (never throws) when the model returns no tool call', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry, I cannot help with that' }] });
    const { interpretTasteDescription } = await import('../../src/services/aiTasteSetup');
    const result = await interpretTasteDescription('anything');
    expect(result).toEqual({ interestIds: [], freeText: [] });
  });

  it('returns empty results for an empty/whitespace description without calling the model', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { interpretTasteDescription } = await import('../../src/services/aiTasteSetup');
    const result = await interpretTasteDescription('   ');
    expect(result).toEqual({ interestIds: [], freeText: [] });
    expect(createMock).not.toHaveBeenCalled();
  });
});
