/**
 * Level-aware logger for Bifrost runtime.
 *
 * Set BIFROST_LOG_LEVEL=debug to see stream lifecycle transitions and other
 * verbose events. Defaults to "info": errors and warnings surface, debug
 * traces stay silent to avoid operational noise.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Invalid/unknown BIFROST_LOG_LEVEL values silently fall back to `info`.
// Empty env var, typos ("verbose"), and case variants ("DEBUG") all resolve
// deterministically — explicit by design to avoid boot-time failures.
function resolveLevel() {
  const raw = (process.env.BIFROST_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

let current = resolveLevel();

export const logger = {
  error: (...args) => { if (current >= LEVELS.error) console.error(...args); },
  warn:  (...args) => { if (current >= LEVELS.warn)  console.warn(...args); },
  info:  (...args) => { if (current >= LEVELS.info)  console.log(...args); },
  debug: (...args) => { if (current >= LEVELS.debug) console.log(...args); },
  // Test-only hooks. Do NOT call from production code paths — runtime level
  // is governed by BIFROST_LOG_LEVEL at process start. Prefixed with `_` to
  // signal internal/test usage; exported solely so tests can flip level
  // around assertions without mutating env.
  _setLevel(name) { current = LEVELS[name] ?? LEVELS.info; },
  _getLevel() { return current; },
};
