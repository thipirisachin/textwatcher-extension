/**
 * tests/unit/matcher.test.js
 * Unit tests for src/shared/matcher.js — pure functions, no Chrome API needed.
 */

import { describe, it, expect } from 'vitest';
import {
  matchesKeyword,
  findMatchPositions,
  extractSnippet,
  matchesUrl,
  safeRegexTest,
  validateRegex,
} from '../../src/shared/matcher.js';

// ─── matchesKeyword ────────────────────────────────────────────────────────────

describe('matchesKeyword', () => {
  describe('EXACT_CASE (case-sensitive substring)', () => {
    it('matches when case is identical', () => {
      expect(matchesKeyword('Hello World', 'Hello', 'exact_case')).toBe(true);
    });
    it('matches mid-string', () => {
      expect(matchesKeyword('say Hello today', 'Hello', 'exact_case')).toBe(true);
    });
    it('rejects wrong case', () => {
      expect(matchesKeyword('hello world', 'Hello', 'exact_case')).toBe(false);
    });
    it('matches full string exactly', () => {
      expect(matchesKeyword('Hello', 'Hello', 'exact_case')).toBe(true);
    });
  });

  describe('EXACT_NOCASE (case-insensitive substring)', () => {
    it('matches regardless of case', () => {
      expect(matchesKeyword('HELLO WORLD', 'hello', 'exact_nocase')).toBe(true);
    });
    it('matches mixed case', () => {
      expect(matchesKeyword('HeLLo', 'hello', 'exact_nocase')).toBe(true);
    });
    it('rejects non-matching text', () => {
      expect(matchesKeyword('goodbye', 'hello', 'exact_nocase')).toBe(false);
    });
  });

  describe('CONTAINS (alias for case-insensitive substring)', () => {
    it('matches case-insensitively', () => {
      expect(matchesKeyword('The Quick Brown Fox', 'quick', 'contains')).toBe(true);
    });
    it('rejects absent text', () => {
      expect(matchesKeyword('The Quick Brown Fox', 'slow', 'contains')).toBe(false);
    });
  });

  describe('STARTS_WITH', () => {
    it('matches at the start', () => {
      expect(matchesKeyword('Hello World', 'Hello', 'starts_with')).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(matchesKeyword('HELLO World', 'hello', 'starts_with')).toBe(true);
    });
    it('rejects text that only matches mid-string', () => {
      expect(matchesKeyword('Say Hello', 'Hello', 'starts_with')).toBe(false);
    });
    it('ignores leading whitespace when checking start', () => {
      expect(matchesKeyword('   Hello World', 'Hello', 'starts_with')).toBe(true);
    });
    it('rejects empty needle', () => {
      expect(matchesKeyword('Hello', '', 'starts_with')).toBe(false);
    });
  });

  describe('ENDS_WITH', () => {
    it('matches at the end', () => {
      expect(matchesKeyword('Hello World', 'World', 'ends_with')).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(matchesKeyword('Hello WORLD', 'world', 'ends_with')).toBe(true);
    });
    it('rejects text that only matches mid-string', () => {
      expect(matchesKeyword('Hello World today', 'World', 'ends_with')).toBe(false);
    });
    it('ignores trailing whitespace when checking end', () => {
      expect(matchesKeyword('Hello World   ', 'World', 'ends_with')).toBe(true);
    });
  });

  describe('REGEX', () => {
    it('matches a simple pattern', () => {
      expect(matchesKeyword('price: $99', '\\$\\d+', 'regex')).toBe(true);
    });
    it('is case-insensitive by default', () => {
      expect(matchesKeyword('Error: timeout', 'error', 'regex')).toBe(true);
    });
    it('returns false for invalid regex', () => {
      expect(matchesKeyword('some text', '[invalid', 'regex')).toBe(false);
    });
    it('matches anchored pattern', () => {
      expect(matchesKeyword('hello world', '^hello', 'regex')).toBe(true);
      expect(matchesKeyword('say hello', '^hello', 'regex')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty haystack', () => {
      expect(matchesKeyword('', 'hello', 'exact_nocase')).toBe(false);
    });
    it('returns false for empty needle', () => {
      expect(matchesKeyword('hello', '', 'exact_nocase')).toBe(false);
    });
    it('returns false for null haystack', () => {
      expect(matchesKeyword(null, 'hello', 'contains')).toBe(false);
    });
    it('returns false for unknown match type', () => {
      expect(matchesKeyword('hello', 'hello', 'unknown_type')).toBe(false);
    });
    it('handles Unicode characters', () => {
      expect(matchesKeyword('héllo wörld', 'héllo', 'exact_case')).toBe(true);
    });
  });
});

// ─── findMatchPositions ────────────────────────────────────────────────────────

describe('findMatchPositions', () => {
  it('finds a single substring match (EXACT_CASE)', () => {
    const positions = findMatchPositions('Hello World', 'World', 'exact_case');
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual({ index: 6, length: 5 });
  });

  it('finds multiple substring matches (CONTAINS)', () => {
    const positions = findMatchPositions('aabababa', 'ab', 'contains');
    expect(positions.length).toBeGreaterThanOrEqual(3);
    for (const p of positions) {
      expect(p.length).toBe(2);
    }
  });

  it('is case-sensitive for EXACT_CASE', () => {
    expect(findMatchPositions('Hello hello', 'hello', 'exact_case')).toHaveLength(1);
    expect(findMatchPositions('Hello hello', 'Hello', 'exact_case')).toHaveLength(1);
  });

  it('is case-insensitive for EXACT_NOCASE', () => {
    expect(findMatchPositions('Hello HELLO', 'hello', 'exact_nocase')).toHaveLength(2);
  });

  describe('STARTS_WITH', () => {
    it('returns a single position anchored to the start', () => {
      const positions = findMatchPositions('Hello World', 'Hello', 'starts_with');
      expect(positions).toHaveLength(1);
      expect(positions[0].index).toBe(0);
      expect(positions[0].length).toBe(5);
    });

    it('accounts for leading whitespace offset', () => {
      // "  Hello" — trimStart removes 2 chars, so Hello starts at index 2
      const positions = findMatchPositions('  Hello World', 'Hello', 'starts_with');
      expect(positions).toHaveLength(1);
      expect(positions[0].index).toBe(2);
    });

    it('returns empty when text does not start with needle', () => {
      expect(findMatchPositions('World Hello', 'Hello', 'starts_with')).toHaveLength(0);
    });
  });

  describe('ENDS_WITH', () => {
    it('returns a single position anchored to the end', () => {
      const hay = 'Hello World';
      const positions = findMatchPositions(hay, 'World', 'ends_with');
      expect(positions).toHaveLength(1);
      expect(positions[0].index).toBe(6);
      expect(positions[0].length).toBe(5);
    });

    it('accounts for trailing whitespace', () => {
      // "Hello World   " — trimEnd gives "Hello World", World ends at index 10
      const positions = findMatchPositions('Hello World   ', 'World', 'ends_with');
      expect(positions).toHaveLength(1);
      expect(positions[0].index).toBe(6);
    });

    it('returns empty when text does not end with needle', () => {
      expect(findMatchPositions('Hello World!', 'World', 'ends_with')).toHaveLength(0);
    });
  });

  describe('REGEX', () => {
    it('finds all regex matches', () => {
      const positions = findMatchPositions('cat bat rat', '[cbr]at', 'regex');
      expect(positions).toHaveLength(3);
    });

    it('records correct index and length per match', () => {
      const positions = findMatchPositions('abc 123 def', '\\d+', 'regex');
      expect(positions).toHaveLength(1);
      expect(positions[0]).toEqual({ index: 4, length: 3 });
    });

    it('returns empty array for invalid regex', () => {
      expect(findMatchPositions('some text', '[bad', 'regex')).toHaveLength(0);
    });
  });

  it('returns empty array for empty inputs', () => {
    expect(findMatchPositions('', 'hello', 'contains')).toHaveLength(0);
    expect(findMatchPositions('hello', '', 'contains')).toHaveLength(0);
  });
});

// ─── extractSnippet ───────────────────────────────────────────────────────────

describe('extractSnippet', () => {
  it('returns the full text when short enough', () => {
    const text = 'short text';
    expect(extractSnippet(text, 0, text.length)).toBe('short text');
  });

  it('adds leading ellipsis when context is cut at the start', () => {
    const text = 'a'.repeat(100) + 'MATCH' + 'b'.repeat(100);
    const snippet = extractSnippet(text, 100, 5, 20);
    expect(snippet.startsWith('…')).toBe(true);
  });

  it('adds trailing ellipsis when context is cut at the end', () => {
    const text = 'MATCH' + 'b'.repeat(200);
    const snippet = extractSnippet(text, 0, 5, 20);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('does not add ellipsis when match is near the start with enough context', () => {
    const text = 'MATCH is here';
    const snippet = extractSnippet(text, 0, 5, 80);
    expect(snippet.startsWith('…')).toBe(false);
  });

  it('surrounds the match with context', () => {
    const text = 'before MATCH after';
    const snippet = extractSnippet(text, 7, 5, 10);
    expect(snippet).toContain('MATCH');
    expect(snippet).toContain('before');
    expect(snippet).toContain('after');
  });
});

// ─── matchesUrl ───────────────────────────────────────────────────────────────

describe('matchesUrl', () => {
  describe('EXACT', () => {
    it('matches identical URLs', () => {
      expect(matchesUrl('https://example.com/page', 'https://example.com/page', 'exact')).toBe(true);
    });
    it('normalises trailing slash', () => {
      expect(matchesUrl('https://example.com/page/', 'https://example.com/page', 'exact')).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(matchesUrl('HTTPS://EXAMPLE.COM/PAGE', 'https://example.com/page', 'exact')).toBe(true);
    });
    it('rejects different paths', () => {
      expect(matchesUrl('https://example.com/page1', 'https://example.com/page2', 'exact')).toBe(false);
    });
  });

  describe('WILDCARD', () => {
    it('matches with a trailing wildcard', () => {
      expect(matchesUrl('https://example.com/foo/bar', 'https://example.com/*', 'wildcard')).toBe(true);
    });
    it('matches a mid-path wildcard', () => {
      expect(matchesUrl('https://example.com/a/b/c', 'https://example.com/*/c', 'wildcard')).toBe(true);
    });
    it('rejects non-matching domain', () => {
      expect(matchesUrl('https://other.com/page', 'https://example.com/*', 'wildcard')).toBe(false);
    });
    it('handles * matching zero characters', () => {
      expect(matchesUrl('https://example.com/', 'https://example.com/*', 'wildcard')).toBe(true);
    });
  });

  describe('DOMAIN', () => {
    it('matches exact domain', () => {
      expect(matchesUrl('https://example.com/page', 'example.com', 'domain')).toBe(true);
    });
    it('matches subdomain', () => {
      expect(matchesUrl('https://sub.example.com/page', 'example.com', 'domain')).toBe(true);
    });
    it('matches with explicit wildcard prefix', () => {
      expect(matchesUrl('https://deep.sub.example.com/', '*.example.com', 'domain')).toBe(true);
    });
    it('rejects a different domain', () => {
      expect(matchesUrl('https://notexample.com/page', 'example.com', 'domain')).toBe(false);
    });
    it('rejects a domain that only ends with the pattern string (not a real subdomain)', () => {
      // "fakeexample.com" should NOT match pattern "example.com"
      expect(matchesUrl('https://fakeexample.com/', 'example.com', 'domain')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty inputs', () => {
      expect(matchesUrl('', 'example.com', 'domain')).toBe(false);
      expect(matchesUrl('https://example.com', '', 'domain')).toBe(false);
    });
    it('returns false for invalid URL', () => {
      expect(matchesUrl('not-a-url', 'example.com', 'domain')).toBe(false);
    });
    it('returns false for unknown match type', () => {
      expect(matchesUrl('https://example.com', 'example.com', 'unknown')).toBe(false);
    });
  });
});

// ─── safeRegexTest ────────────────────────────────────────────────────────────

describe('safeRegexTest', () => {
  it('returns true for a valid matching pattern', () => {
    expect(safeRegexTest('hel+o', 'hello')).toBe(true);
  });
  it('returns false for a valid non-matching pattern', () => {
    expect(safeRegexTest('^world', 'hello world')).toBe(false);
  });
  it('returns false for an invalid regex instead of throwing', () => {
    expect(() => safeRegexTest('[invalid', 'hello')).not.toThrow();
    expect(safeRegexTest('[invalid', 'hello')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(safeRegexTest('HELLO', 'hello world')).toBe(true);
  });
});

// ─── validateRegex ────────────────────────────────────────────────────────────

describe('validateRegex', () => {
  it('returns valid:true for a correct pattern', () => {
    expect(validateRegex('\\d+')).toEqual({ valid: true, error: null });
  });
  it('returns valid:true for an empty string (matches everything)', () => {
    expect(validateRegex('')).toEqual({ valid: true, error: null });
  });
  it('returns valid:false and an error message for broken syntax', () => {
    const result = validateRegex('[broken');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
  it('returns valid:false for unmatched parenthesis', () => {
    const result = validateRegex('(unclosed');
    expect(result.valid).toBe(false);
  });
});
