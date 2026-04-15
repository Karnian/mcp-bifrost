/**
 * Level-aware logger tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../server/logger.js';

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
  const prev = logger._getLevel();
  logger._setLevel('info');
  try {
    const lines = captureConsole(() => {
      logger.debug('D');
      logger.info('I');
      logger.warn('W');
      logger.error('E');
    });
    const kinds = lines.map(l => l[1]);
    assert.deepEqual(kinds, ['I', 'W', 'E']);
  } finally { logger._setLevel(['error','warn','info','debug'][prev]); }
});

test('logger: debug level emits all four', () => {
  const prev = logger._getLevel();
  logger._setLevel('debug');
  try {
    const lines = captureConsole(() => {
      logger.debug('D');
      logger.info('I');
      logger.warn('W');
      logger.error('E');
    });
    assert.deepEqual(lines.map(l => l[1]), ['D', 'I', 'W', 'E']);
  } finally { logger._setLevel(['error','warn','info','debug'][prev]); }
});

test('logger: error level suppresses info/warn/debug', () => {
  const prev = logger._getLevel();
  logger._setLevel('error');
  try {
    const lines = captureConsole(() => {
      logger.debug('D'); logger.info('I'); logger.warn('W'); logger.error('E');
    });
    assert.deepEqual(lines.map(l => l[1]), ['E']);
  } finally { logger._setLevel(['error','warn','info','debug'][prev]); }
});

test('logger: invalid level name falls back to info (no throw)', () => {
  const prev = logger._getLevel();
  logger._setLevel('verbose'); // unknown
  try {
    assert.equal(logger._getLevel(), 2, 'unknown level must resolve to info(=2)');
    const lines = captureConsole(() => {
      logger.debug('D'); logger.info('I');
    });
    assert.deepEqual(lines.map(l => l[1]), ['I']);
  } finally { logger._setLevel(['error','warn','info','debug'][prev]); }
});
