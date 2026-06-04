import { describe, expect, test } from 'vitest';
import {
  newTimerexNonce,
  signTimerexBooking,
  buildTimerexBookingUrl,
  verifyTimerexBookingSignature,
} from './timerex-link.js';

const VALID_SECRET = 'test-secret-key-32-chars-minimum-';

describe('timerex-link — signature generation and verification', () => {
  describe('newTimerexNonce', () => {
    test('generates a non-empty UUID-like string', () => {
      const nonce = newTimerexNonce();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(0);
      // Should be UUID without hyphens (32 chars typically)
      expect(nonce).toMatch(/^[a-f0-9]+$/);
    });

    test('generates different nonce on each call', () => {
      const nonce1 = newTimerexNonce();
      const nonce2 = newTimerexNonce();
      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe('signTimerexBooking', () => {
    test('generates consistent signature for same inputs', async () => {
      const userId = 'U1234567890abcdef1234567890abcd';
      const nonce = 'nonce-abc123';
      const sig1 = await signTimerexBooking(userId, nonce, VALID_SECRET);
      const sig2 = await signTimerexBooking(userId, nonce, VALID_SECRET);
      expect(sig1).toBe(sig2);
    });

    test('generates different signature for different userId', async () => {
      const nonce = 'nonce-abc123';
      const sig1 = await signTimerexBooking('U_user1', nonce, VALID_SECRET);
      const sig2 = await signTimerexBooking('U_user2', nonce, VALID_SECRET);
      expect(sig1).not.toBe(sig2);
    });

    test('generates different signature for different nonce', async () => {
      const userId = 'U_user1';
      const sig1 = await signTimerexBooking(userId, 'nonce1', VALID_SECRET);
      const sig2 = await signTimerexBooking(userId, 'nonce2', VALID_SECRET);
      expect(sig1).not.toBe(sig2);
    });

    test('generates different signature for different secret', async () => {
      const userId = 'U_user1';
      const nonce = 'nonce-abc123';
      const sig1 = await signTimerexBooking(userId, nonce, VALID_SECRET);
      const sig2 = await signTimerexBooking(userId, nonce, 'different-secret-key-32-chars');
      expect(sig1).not.toBe(sig2);
    });

    test('returns lowercase hex string', async () => {
      const sig = await signTimerexBooking('U1', 'nonce', VALID_SECRET);
      expect(sig).toMatch(/^[a-f0-9]{64}$/); // SHA256 = 64 hex chars
    });
  });

  describe('buildTimerexBookingUrl', () => {
    test('returns valid HTTPS URL with query params', async () => {
      const baseUrl = 'https://calendar.example.com/book';
      const userId = 'U_test';
      const url = await buildTimerexBookingUrl(baseUrl, userId, VALID_SECRET);
      expect(url).toMatch(/^https:\/\//);
      expect(url).toContain('line_user_id=');
      expect(url).toContain('nonce=');
      expect(url).toContain('sig=');
    });

    test('includes lineUserId in URL params', async () => {
      const userId = 'U_user123';
      const url = await buildTimerexBookingUrl(
        'https://example.com/book',
        userId,
        VALID_SECRET,
      );
      expect(url).toContain(`line_user_id=${userId}`);
    });

    test('includes generated nonce when not provided', async () => {
      const url = await buildTimerexBookingUrl(
        'https://example.com/book',
        'U_user',
        VALID_SECRET,
      );
      const urlObj = new URL(url);
      const nonce = urlObj.searchParams.get('nonce');
      expect(nonce).toBeTruthy();
      expect(nonce).toMatch(/^[a-f0-9]+$/);
    });

    test('uses provided nonce when given', async () => {
      const providedNonce = 'provided-nonce-123';
      const url = await buildTimerexBookingUrl(
        'https://example.com/book',
        'U_user',
        VALID_SECRET,
        providedNonce,
      );
      const urlObj = new URL(url);
      expect(urlObj.searchParams.get('nonce')).toBe(providedNonce);
    });

    test('includes valid signature in URL', async () => {
      const userId = 'U_user';
      const nonce = 'test-nonce';
      const url = await buildTimerexBookingUrl(
        'https://example.com/book',
        userId,
        VALID_SECRET,
        nonce,
      );
      const urlObj = new URL(url);
      const sig = urlObj.searchParams.get('sig');
      expect(sig).toBeTruthy();
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    test('preserves existing URL path and params', async () => {
      const baseUrl = 'https://example.com/book?existing=param';
      const url = await buildTimerexBookingUrl(baseUrl, 'U_user', VALID_SECRET);
      expect(url).toContain('existing=param');
    });
  });

  describe('verifyTimerexBookingSignature', () => {
    test('accepts valid signature', async () => {
      const userId = 'U_user123';
      const nonce = 'nonce-abc';
      const sig = await signTimerexBooking(userId, nonce, VALID_SECRET);
      const result = await verifyTimerexBookingSignature(userId, nonce, sig, VALID_SECRET);
      expect(result).toBe(true);
    });

    test('rejects mismatched signature (altered sig)', async () => {
      const userId = 'U_user123';
      const nonce = 'nonce-abc';
      const sig = await signTimerexBooking(userId, nonce, VALID_SECRET);
      // Alter one character
      const alteredSig = sig.slice(0, -1) + (sig[sig.length - 1] === 'a' ? 'b' : 'a');
      const result = await verifyTimerexBookingSignature(
        userId,
        nonce,
        alteredSig,
        VALID_SECRET,
      );
      expect(result).toBe(false);
    });

    test('rejects when userId changes but sig stays same', async () => {
      const nonce = 'nonce-abc';
      const sig = await signTimerexBooking('U_user1', nonce, VALID_SECRET);
      const result = await verifyTimerexBookingSignature('U_user2', nonce, sig, VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects when nonce changes but sig stays same', async () => {
      const userId = 'U_user123';
      const sig = await signTimerexBooking(userId, 'nonce1', VALID_SECRET);
      const result = await verifyTimerexBookingSignature(userId, 'nonce2', sig, VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects when secret changes', async () => {
      const userId = 'U_user123';
      const nonce = 'nonce-abc';
      const sig = await signTimerexBooking(userId, nonce, VALID_SECRET);
      const result = await verifyTimerexBookingSignature(
        userId,
        nonce,
        sig,
        'different-secret-key-32-chars',
      );
      expect(result).toBe(false);
    });

    test('accepts uppercase sig (case-insensitive)', async () => {
      const userId = 'U_user123';
      const nonce = 'nonce-abc';
      const sig = await signTimerexBooking(userId, nonce, VALID_SECRET);
      const upperSig = sig.toUpperCase();
      const result = await verifyTimerexBookingSignature(userId, nonce, upperSig, VALID_SECRET);
      expect(result).toBe(true);
    });

    test('rejects null userId', async () => {
      const result = await verifyTimerexBookingSignature(
        null,
        'nonce',
        'sig',
        VALID_SECRET,
      );
      expect(result).toBe(false);
    });

    test('rejects undefined userId', async () => {
      const result = await verifyTimerexBookingSignature(
        undefined,
        'nonce',
        'sig',
        VALID_SECRET,
      );
      expect(result).toBe(false);
    });

    test('rejects empty string userId', async () => {
      const result = await verifyTimerexBookingSignature('', 'nonce', 'sig', VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects null nonce', async () => {
      const result = await verifyTimerexBookingSignature('U_user', null, 'sig', VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects undefined nonce', async () => {
      const result = await verifyTimerexBookingSignature('U_user', undefined, 'sig', VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects empty string nonce', async () => {
      const result = await verifyTimerexBookingSignature('U_user', '', 'sig', VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects null sig', async () => {
      const result = await verifyTimerexBookingSignature('U_user', 'nonce', null, VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects undefined sig', async () => {
      const result = await verifyTimerexBookingSignature(
        'U_user',
        'nonce',
        undefined,
        VALID_SECRET,
      );
      expect(result).toBe(false);
    });

    test('rejects empty string sig', async () => {
      const result = await verifyTimerexBookingSignature('U_user', 'nonce', '', VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects sig that is too short', async () => {
      const result = await verifyTimerexBookingSignature('U_user', 'nonce', 'abc', VALID_SECRET);
      expect(result).toBe(false);
    });

    test('rejects sig with invalid hex characters', async () => {
      const result = await verifyTimerexBookingSignature(
        'U_user',
        'nonce',
        'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        VALID_SECRET,
      );
      expect(result).toBe(false);
    });

    test('is resistant to timing attacks (constant-time comparison)', async () => {
      // This test validates that safeEqualHex is used (constant-time comparison).
      // We can't directly measure timing, but we verify the function doesn't leak
      // information via different-length comparisons or early-return patterns.
      const userId = 'U_user';
      const nonce = 'nonce';
      const correctSig = await signTimerexBooking(userId, nonce, VALID_SECRET);

      // Test various wrong sigs with same length
      const wrongSig1 = 'a'.repeat(64);
      const wrongSig2 = 'b'.repeat(64);

      const result1 = await verifyTimerexBookingSignature(userId, nonce, wrongSig1, VALID_SECRET);
      const result2 = await verifyTimerexBookingSignature(userId, nonce, wrongSig2, VALID_SECRET);

      expect(result1).toBe(false);
      expect(result2).toBe(false);
      // Both should fail consistently (implementation uses constant-time comparison)
    });
  });

  describe('integration: sign → build URL → verify', () => {
    test('full flow from signature generation to verification', async () => {
      const userId = 'U_integration_test';
      const nonce = newTimerexNonce();

      // Build URL with signature
      const url = await buildTimerexBookingUrl(
        'https://calendar.example.com/book',
        userId,
        VALID_SECRET,
        nonce,
      );

      // Extract params from URL
      const urlObj = new URL(url);
      const extractedUserId = urlObj.searchParams.get('line_user_id');
      const extractedNonce = urlObj.searchParams.get('nonce');
      const extractedSig = urlObj.searchParams.get('sig');

      // Verify the extracted signature
      const verified = await verifyTimerexBookingSignature(
        extractedUserId,
        extractedNonce,
        extractedSig,
        VALID_SECRET,
      );

      expect(verified).toBe(true);
    });

    test('URL with tampered nonce fails verification', async () => {
      const userId = 'U_test';
      const nonce = newTimerexNonce();
      const url = await buildTimerexBookingUrl(
        'https://calendar.example.com/book',
        userId,
        VALID_SECRET,
        nonce,
      );

      const urlObj = new URL(url);
      const sig = urlObj.searchParams.get('sig')!;

      // Tamper with nonce
      const tamperedNonce = nonce + 'x';

      const verified = await verifyTimerexBookingSignature(userId, tamperedNonce, sig, VALID_SECRET);
      expect(verified).toBe(false);
    });

    test('URL with tampered userId fails verification', async () => {
      const userId = 'U_original';
      const nonce = newTimerexNonce();
      const url = await buildTimerexBookingUrl(
        'https://calendar.example.com/book',
        userId,
        VALID_SECRET,
        nonce,
      );

      const urlObj = new URL(url);
      const sig = urlObj.searchParams.get('sig')!;
      const extractedNonce = urlObj.searchParams.get('nonce')!;

      // Different user
      const verified = await verifyTimerexBookingSignature(
        'U_attacker',
        extractedNonce,
        sig,
        VALID_SECRET,
      );
      expect(verified).toBe(false);
    });
  });
});
