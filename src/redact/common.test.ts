import { describe, expect, it } from 'vitest';
import { redactText } from './common.js';

const HIGH_ENTROPY = 'Zx9k2pQ7mN4vR1sT8uW3yA6bC0dE5fG7hJ2kL9mN4pQ';

describe('redactText — common policy', () => {
  it('redacts authorization headers', () => {
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe(
      'Authorization: [redacted]',
    );
  });

  it('redacts URL credentials', () => {
    expect(redactText('https://user:pass@github.com/o/r')).toBe(
      'https://[redacted]@github.com/o/r',
    );
  });

  it('redacts sensitive query parameters', () => {
    expect(redactText('https://api.example.com/v1?token=abc123&page=2')).toBe(
      'https://api.example.com/v1?token=[redacted]&page=2',
    );
  });

  it('redacts environment-style sensitive assignments', () => {
    expect(redactText('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')).toBe(
      'AWS_SECRET_ACCESS_KEY=[redacted]',
    );
  });

  it('redacts a PEM private-key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redactText(pem)).toBe('[redacted]');
  });

  it('redacts known token shapes', () => {
    expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('[redacted]');
    expect(redactText('sk-abcdefghijklmnop')).toBe('[redacted]');
    // A JWT-shaped fixture, not a real credential.
    // nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token
    expect(redactText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk')).toBe('[redacted]');
  });

  it('leaves ordinary harness text untouched', () => {
    expect(redactText('Read the CLAUDE.md and AGENTS.md files.')).toBe(
      'Read the CLAUDE.md and AGENTS.md files.',
    );
    expect(redactText('https://example.com/docs?page=2')).toBe('https://example.com/docs?page=2');
  });

  it('is idempotent', () => {
    const once = redactText('Authorization: Bearer abcdefghijklmnop');
    expect(redactText(once)).toBe(once);
  });
});

describe('redactText — display vs persistence tiers', () => {
  it('keeps an unknown high-entropy value at display, redacts it when safer', () => {
    expect(redactText(HIGH_ENTROPY, 'display')).toBe(HIGH_ENTROPY);
    expect(redactText(HIGH_ENTROPY, 'export')).toBe('[redacted]');
    expect(redactText(HIGH_ENTROPY)).toBe('[redacted]');
  });

  it('redacts baseline secrets even at display', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop', 'display')).toBe(
      'Authorization: [redacted]',
    );
  });
});
