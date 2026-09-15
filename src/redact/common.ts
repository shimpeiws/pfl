import { notImplemented } from '../cli/exit-codes.js';

/**
 * Common redaction policy (design doc §20). Covers token-like values, secrets,
 * passwords, authorization headers, URL credentials, sensitive query
 * parameters, environment values, and unknown sensitive-looking values.
 * Adapters add runtime-specific rules on top.
 *
 * Display and persistence differ: interactive terminal output may be richer
 * than machine-readable export, which is safer, and snapshot persistence is
 * the safest (design doc §19).
 */
export function redactText(_value: string): string {
  notImplemented('common redaction');
}
