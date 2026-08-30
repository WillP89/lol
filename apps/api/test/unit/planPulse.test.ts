import { describe, expect, test } from 'vitest';
import { derivePulseStatus } from '../../src/services/plan';

describe('derivePulseStatus', () => {
  test('no votes yet stays SHARED', () => {
    expect(derivePulseStatus(0, 'SHARED')).toBe('SHARED');
  });

  test('some interest but under half is GATHERING_INTEREST', () => {
    expect(derivePulseStatus(0.33, 'SHARED')).toBe('GATHERING_INTEREST');
  });

  test('half or more but under the ready threshold is LIKELY', () => {
    expect(derivePulseStatus(0.5, 'GATHERING_INTEREST')).toBe('LIKELY');
    expect(derivePulseStatus(0.59, 'LIKELY')).toBe('LIKELY');
  });

  test('crossing 0.6 flips to READY', () => {
    expect(derivePulseStatus(0.6, 'LIKELY')).toBe('READY');
    expect(derivePulseStatus(0.83, 'LIKELY')).toBe('READY');
  });

  test('terminal states are never overridden by vote fraction', () => {
    expect(derivePulseStatus(1, 'BOOKED')).toBe('BOOKED');
    expect(derivePulseStatus(0, 'COMPLETED')).toBe('COMPLETED');
    expect(derivePulseStatus(0.9, 'CANCELLED')).toBe('CANCELLED');
    expect(derivePulseStatus(0.9, 'IDEA')).toBe('IDEA');
  });
});
