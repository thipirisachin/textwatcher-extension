/**
 * matcher.js
 * Pure text matching logic — no DOM, no storage, no side effects.
 * All match types handled here. Import and use anywhere safely.
 */

import { MATCH_TYPE, URL_MATCH_TYPE } from './constants.js';

// ─── Keyword Matching ─────────────────────────────────────────────────────────

/**
 * Test whether a text node's content matches a keyword rule.
 *
 * @param {string} haystack  - The page text to search within
 * @param {string} needle    - The keyword/phrase from the rule
 * @param {string} matchType - One of MATCH_TYPE values
 * @returns {boolean}
 */
export function matchesKeyword(haystack, needle, matchType) {
  if (!haystack || !needle) return false;

  switch (matchType) {
    case MATCH_TYPE.EXACT_CASE:
      return haystack.includes(needle);

    case MATCH_TYPE.EXACT_NOCASE:
      return haystack.toLowerCase().includes(needle.toLowerCase());

    case MATCH_TYPE.CONTAINS:
      return haystack.toLowerCase().includes(needle.toLowerCase());

    case MATCH_TYPE.CONTAINS_CASE:
      return haystack.includes(needle);

    case MATCH_TYPE.STARTS_WITH:
      return haystack.trimStart().toLowerCase().startsWith(needle.toLowerCase());

    case MATCH_TYPE.ENDS_WITH:
      return haystack.trimEnd().toLowerCase().endsWith(needle.toLowerCase());

    case MATCH_TYPE.REGEX: {
      const result = safeRegexTest(needle, haystack);
      return result;
    }

    default:
      return false;
  }
}

/**
 * Find all match positions in a string for snippet extraction.
 *
 * @param {string} haystack
 * @param {string} needle
 * @param {string} matchType
 * @returns {{ index: number, length: number }[]}
 */
export function findMatchPositions(haystack, needle, matchType) {
  const positions = [];

  if (!haystack || !needle) return positions;

  if (matchType === MATCH_TYPE.REGEX) {
    try {
      const rx = new RegExp(needle, 'gi');
      let m;
      while ((m = rx.exec(haystack)) !== null) {
        positions.push({ index: m.index, length: m[0].length });
        if (!rx.global) break;
      }
    } catch (_) { /* invalid regex — silently ignore */ }
    return positions;
  }

  // STARTS_WITH: match is anchored to the start of trimmed text.
  if (matchType === MATCH_TYPE.STARTS_WITH) {
    const trimmed      = haystack.trimStart();
    const trimmedLower = trimmed.toLowerCase();
    const needleLower  = needle.toLowerCase();
    if (trimmedLower.startsWith(needleLower)) {
      const offset = haystack.length - trimmed.length; // chars stripped by trimStart
      positions.push({ index: offset, length: needle.length });
    }
    return positions;
  }

  // ENDS_WITH: match is anchored to the end of trimmed text.
  if (matchType === MATCH_TYPE.ENDS_WITH) {
    const trimmed      = haystack.trimEnd();
    const trimmedLower = trimmed.toLowerCase();
    const needleLower  = needle.toLowerCase();
    if (trimmedLower.endsWith(needleLower)) {
      positions.push({ index: trimmed.length - needle.length, length: needle.length });
    }
    return positions;
  }

  // EXACT_CASE / EXACT_NOCASE / CONTAINS / CONTAINS_CASE: substring scan.
  const caseSensitive = matchType === MATCH_TYPE.EXACT_CASE || matchType === MATCH_TYPE.CONTAINS_CASE;
  const searchStr    = caseSensitive ? haystack       : haystack.toLowerCase();
  const searchNeedle = caseSensitive ? needle         : needle.toLowerCase();

  let start = 0;
  while (true) {
    const idx = searchStr.indexOf(searchNeedle, start);
    if (idx === -1) break;
    positions.push({ index: idx, length: needle.length });
    start = idx + 1;
  }

  return positions;
}

/**
 * Extract a readable snippet (surrounding context) for a match.
 *
 * @param {string} text       - Full text
 * @param {number} index      - Match start index
 * @param {number} length     - Match length
 * @param {number} [ctxChars=80] - Context characters on each side
 * @returns {string}
 */
export function extractSnippet(text, index, length, ctxChars = 80) {
  const start  = Math.max(0, index - ctxChars);
  const end    = Math.min(text.length, index + length + ctxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).trim() + suffix;
}

// ─── URL Matching ─────────────────────────────────────────────────────────────

/**
 * Test whether a page URL matches a URL rule.
 *
 * @param {string} pageUrl   - The current tab's URL
 * @param {string} pattern   - The pattern from the URL rule
 * @param {string} matchType - One of URL_MATCH_TYPE values
 * @returns {boolean}
 */
export function matchesUrl(pageUrl, pattern, matchType) {
  if (!pageUrl || !pattern) return false;

  try {
    switch (matchType) {
      case URL_MATCH_TYPE.EXACT:
        return normalizeUrl(pageUrl) === normalizeUrl(pattern);

      case URL_MATCH_TYPE.WILDCARD:
        return wildcardMatch(pageUrl, pattern);

      case URL_MATCH_TYPE.DOMAIN:
        return domainMatch(pageUrl, pattern);

      default:
        return false;
    }
  } catch (_) {
    return false;
  }
}

/**
 * Convert a wildcard pattern (using *) to a RegExp and test.
 * Example: "https://example.com/*" matches "https://example.com/page"
 *
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function wildcardMatch(url, pattern) {
  // Escape all regex special chars except *
  const escaped = pattern
    .replace(/[-[\]{}()+?.,\\^$|#\s]/g, '\\$&')
    .replace(/\*/g, '.*');
  const rx = new RegExp(`^${escaped}$`, 'i');
  return rx.test(url);
}

/**
 * Domain-level match. Pattern can be:
 *  - "example.com"       → matches example.com and *.example.com
 *  - "*.example.com"     → matches any subdomain of example.com
 *
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function domainMatch(url, pattern) {
  const hostname = new URL(url).hostname.toLowerCase();
  const p        = pattern.replace(/^\*\./, '').toLowerCase();
  return hostname === p || hostname.endsWith(`.${p}`);
}

/**
 * Strip trailing slash and lowercase for exact comparisons.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  return url.replace(/\/$/, '').toLowerCase();
}

// ─── Regex Safety ─────────────────────────────────────────────────────────────

/**
 * Safely test a user-supplied regex string against a target.
 * Returns false (not throws) on invalid pattern.
 *
 * @param {string} pattern
 * @param {string} target
 * @returns {boolean}
 */
export function safeRegexTest(pattern, target) {
  try {
    const rx = new RegExp(pattern, 'i');
    return rx.test(target);
  } catch (_) {
    return false;
  }
}

/**
 * Validate a regex string — used in UI before saving.
 * @param {string} pattern
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateRegex(pattern) {
  try {
    new RegExp(pattern);
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
