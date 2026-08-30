import { describe, expect, test } from 'vitest';
import { displayNameOf } from '../../src/lib/displayName';

describe('displayNameOf', () => {
  test('uses a real displayName when set, trimmed', () => {
    expect(displayNameOf('  Sam Taylor  ', 'sam@example.com')).toBe('Sam Taylor');
  });

  test('falls back to a prettified guess from the email local part', () => {
    expect(displayNameOf(null, 'sam.taylor@example.com')).toBe('Sam Taylor');
    expect(displayNameOf(undefined, 'sam_taylor92@example.com')).toBe('Sam Taylor');
    expect(displayNameOf(null, 'samtaylor@example.com')).toBe('Samtaylor');
  });

  test('an empty-string displayName is treated the same as none', () => {
    expect(displayNameOf('   ', 'sam@example.com')).toBe('Sam');
  });

  test('falls back to the raw email if the local part has nothing usable in it', () => {
    expect(displayNameOf(null, '12345@example.com')).toBe('12345@example.com');
  });
});
