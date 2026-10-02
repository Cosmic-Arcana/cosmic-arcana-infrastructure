// Shared helpers for the application validation suites. No dependencies beyond node itself, so a
// suite can run on a bare runner against a stack started from a release manifest.
import { randomUUID } from 'node:crypto';

/** Host ports published by compose/application.yml. */
export const ENDPOINTS = {
  'tarot-service-api': { base: 'http://127.0.0.1:3004', live: '/health/live', ready: '/health/ready' },
  'history-service-api': {
    base: 'http://127.0.0.1:3005',
    live: '/health/live',
    ready: '/health/ready',
  },
  'cosmic-arcana-storefront': {
    base: 'http://127.0.0.1:3000',
    live: '/health/live',
    ready: '/health/ready',
  },
  'ai-service-api': { base: 'http://127.0.0.1:3001', live: '/health/live', ready: '/health/ready' },
  'nasa-service-api': { base: 'http://127.0.0.1:3002', live: '/health/live', ready: '/health/ready' },
  // No health module in this service yet; the root route is the only liveness signal it offers.
  'mcp-service-api': { base: 'http://127.0.0.1:3003', live: '/', ready: '/' },
};

export const step = (message) => process.stdout.write(`  → ${message}\n`);
export const pass = (message) => process.stdout.write(`  ✓ ${message}\n`);

export class ValidationError extends Error {
  name = 'ValidationError';
}

export const assert = (condition, message) => {
  if (!condition) {
    throw new ValidationError(message);
  }
};

export const uuid = () => randomUUID();

export const request = async (url, init = {}) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
};

export const waitFor = async (description, probe, { timeoutMs = 90_000, intervalMs = 1_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new ValidationError(
    `timed out after ${timeoutMs}ms waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
};

/** Creates a spread through the public api and returns the created resource. */
export const createSpread = async (question, { userId = uuid(), idempotencyKey = uuid() } = {}) => {
  const response = await request(`${ENDPOINTS['tarot-service-api'].base}/spreads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ userId, question }),
  });
  assert(
    response.status === 201,
    `POST /spreads returned ${response.status}: ${JSON.stringify(response.body)}`,
  );
  return { ...response, userId, idempotencyKey };
};

export const historyPage = (userId) =>
  request(`${ENDPOINTS['history-service-api'].base}/users/${userId}/spread-history`);

/** Runs a suite, prints a stable header and turns any failure into a non-zero exit. */
export const runSuite = async (name, suite) => {
  process.stdout.write(`\n[${name}] starting\n`);
  try {
    await suite();
    process.stdout.write(`[${name}] passed\n`);
  } catch (error) {
    process.stdout.write(`[${name}] FAILED: ${error.message}\n`);
    if (!(error instanceof ValidationError)) {
      process.stdout.write(`${error.stack}\n`);
    }
    process.exit(1);
  }
};
