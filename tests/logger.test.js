/**
 * Level-aware logger tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, withLogLevel } from '../server/logger.js';

function captureConsole(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = (...a) => lines.push(['log', a.join(' ')]);
  console.warn = (...a) => lines.push(['warn', a.join(' ')]);
  console.error = (...a) => lines.push(['error', a.join(' ')]);
  try { fn(); } finally { Object.assign(console, orig); }
  return lines;
}

test('logger: default level (info) emits info/warn/error, suppresses debug', () => {
  withLogLevel('info', () => {
    const lines = captureConsole(() => {
      logger.debug('D');
      logger.info('I');
      logger.warn('W');
      logger.error('E');
    });
    assert.deepEqual(lines.map(l => l[1]), ['I', 'W', 'E']);
  });
});

test('logger: debug level emits all four', () => {
  withLogLevel('debug', () => {
    const lines = captureConsole(() => {
      logger.debug('D');
      logger.info('I');
      logger.warn('W');
      logger.error('E');
    });
    assert.deepEqual(lines.map(l => l[1]), ['D', 'I', 'W', 'E']);
  });
});

test('logger: error level suppresses info/warn/debug', () => {
  withLogLevel('error', () => {
    const lines = captureConsole(() => {
      logger.debug('D'); logger.info('I'); logger.warn('W'); logger.error('E');
    });
    assert.deepEqual(lines.map(l => l[1]), ['E']);
  });
});

test('logger: invalid level name falls back to info (no throw)', () => {
  withLogLevel('verbose', () => {
    assert.equal(logger._getLevel(), 2, 'unknown level must resolve to info(=2)');
    const lines = captureConsole(() => {
      logger.debug('D'); logger.info('I');
    });
    assert.deepEqual(lines.map(l => l[1]), ['I']);
  });
});

test('withLogLevel helper restores level after execution', () => {
  const before = logger._getLevel();
  withLogLevel('debug', () => {
    assert.equal(logger._getLevel(), 3);
  });
  assert.equal(logger._getLevel(), before, 'level should be restored after withLogLevel');
});
