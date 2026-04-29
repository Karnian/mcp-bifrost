/**
 * Phase 12-3 — SlackOAuthManager.
 *
 * Implements Slack OAuth v2 install flow + token refresh for the native
 * `providers/slack.js` integration. Separate from `OAuthManager` because:
 *   - Slack discovery is hardcoded (no RFC 9728 / RFC 8414)
 *   - Slack does not support RFC 7591 DCR (no registration endpoint)
 *   - Slack response shape (`team`, `authed_user`, `is_enterprise_install`,
 *     scope/user_scope split) is unique to Slack
 *   - Phase 12 uses confidential web-app mode → PKCE off + client_secret_post
 *
 * Mutex topology:
 *   - `_workspaceMutex(workspaceId)` — for refresh / revoke / save on an
 *     existing workspace. Same FIFO chain pattern as OAuthManager (Phase 10a).
 *   - `_teamInstallMutex(lockKey)` — install callback path before workspace
 *     exists. Lock key = `slack-install::${enterprise.id || team.id}`.
 *
 * Storage shape (slackOAuth):
 *   tokens: { accessToken, refreshToken?, expiresAt? (ISO 8601 string), tokenType: 'user' }
 *   team:   { id, name }
 *   authedUser: { id, scopesGranted? }
 *   status: 'active' | 'action_needed'
 *
 * Token-rotation handling (R13):
 *   - rotation enabled (Slack response carries refresh_token + expires_in)
 *     → refresh path engaged
 *   - rotation disabled (no refresh_token, no expires_in) → long-lived
 *     user-token, refresh path is a no-op
 *   - rotation disabled but expires_in returned → action_needed (corrupt
 *     response or partial rotation enable)
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitize, tokenPrefix } from './oauth-sanitize.js';
import { getPublicOrigin, getSlackRedirectUri, SLACK_OAUTH_CALLBACK_PATH } from './public-origin.js';
import { logger } from './logger.js';

// ─── constants ────────────────────────────────────────────────────────
const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const SLACK_REVOKE_URL = 'https://slack.com/api/auth.revoke';

const STATE_TYP = 'slack-oauth';
const STATE_AUD = SLACK_OAUTH_CALLBACK_PATH;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_LEEWAY_MS = 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

const DEFAULT_USER_SCOPES = [
  'search:read',
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
];

// Phase 12 §4.5 — Slack error mapping. Codes returned by oauth.v2.access body
// or query string `error=` from the authorize redirect. Unknown codes fall
// through to the raw Slack code so the operator still sees something.
const SLACK_ERROR_MAP = {
  bad_redirect_uri: 'Slack App 의 Redirect URLs 에 등록된 값과 BIFROST_PUBLIC_URL 의 origin 이 일치하지 않습니다.',
  invalid_team_for_non_distributed_app: 'Slack App 의 Public Distribution 활성화가 필요합니다.',
  unapproved_scope: 'Slack workspace admin 의 scope 승인 대기 상태입니다.',
  org_login_required: 'Enterprise Grid 환경은 Phase 12 비범위입니다.',
  invalid_client: 'Slack App 의 client_id / client_secret 이 일치하지 않습니다.',
  invalid_client_id: 'Slack App 의 client_id 가 일치하지 않습니다.',
  invalid_grant: 'refresh_token 이 만료되었거나 1회용 사용이 끝났습니다. 재인증이 필요합니다.',
  access_denied: '사용자가 권한 동의를 거부했습니다.',
};

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function maskTeamId(teamId) {
  if (!teamId || typeof teamId !== 'string') return null;
  if (teamId.length <= 4) return '***';
  return `${teamId.slice(0, 2)}***${teamId.slice(-2)}`;
}

export function describeSlackError(code, fallbackMessage) {
  if (!code) return fallbackMessage || 'Slack OAuth error (no code)';
  const friendly = SLACK_ERROR_MAP[code];
  if (friendly) return `${friendly} (slack: ${code})`;
  return `Slack OAuth error: ${code}${fallbackMessage ? ` — ${fallbackMessage}` : ''}`;
}

export class SlackOAuthManager {
  /**
   * @param {object} wm — WorkspaceManager-shaped interface.
   *   Required methods used: getSlackAppRaw, getRawWorkspace,
   *     _save, logAudit, addWorkspace, updateWorkspace.
   *   Optional: capability cache touch, etc.
   * @param {object} [opts]
   * @param {Function} [opts.fetchImpl] — fetch() for tests
   * @param {number}   [opts.refreshTimeoutMs]
   * @param {number}   [opts.stateTtlMs]
   * @param {object}   [opts.metrics] — counters recorder
   * @param {Function} [opts.serverSecretProvider] — async () => secret
   *   string used for state HMAC. Reuses OAuthManager's server secret so
   *   we don't spawn a parallel state-signing key.
   */
  constructor(wm, opts = {}) {
    this.wm = wm;
    this.fetch = opts.fetchImpl || globalThis.fetch;
    this._refreshTimeoutMs = opts.refreshTimeoutMs || DEFAULT_REFRESH_TIMEOUT_MS;
    this._stateTtlMs = opts.stateTtlMs || STATE_TTL_MS;
    this.metrics = opts.metrics || null;
    this._serverSecretProvider = opts.serverSecretProvider || null;

    this._workspaceMutex = new Map();
    this._teamInstallMutex = new Map();

    // installId → { state, status, workspaceId, error, createdAt }
    // In-memory only — install completes within minutes; no need for disk.
    this._installPending = new Map();
    this._maxPending = 100; // safety cap; older entries evicted on insert
    // Process-private fallback secret if no provider was wired. Generated
    // lazily so test setup that constructs manager without a provider still
    // gets a working state HMAC for unit tests.
    this._fallbackSecret = null;
  }

  _metric(name, labels) {
    if (!this.metrics) return;
    try { this.metrics.inc(name, labels); } catch { /* swallow */ }
  }

  async _getServerSecret() {
    if (this._serverSecretProvider) {
      return this._serverSecretProvider();
    }
    if (!this._fallbackSecret) {
      this._fallbackSecret = b64url(randomBytes(32));
    }
    return this._fallbackSecret;
  }

  // ─── App credential accessor (uses WorkspaceManager source-of-truth) ─
  async getAppCredentials() {
    const raw = await this.wm.getSlackAppRaw?.();
    return raw || { clientId: null, clientSecret: null, tokenRotationEnabled: true, sources: { clientId: 'none', clientSecret: 'none' } };
  }

  // ─── State signing ───────────────────────────────────────────────────
  async _signState(payload) {
    const secret = await this._getServerSecret();
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = b64url(createHmac('sha256', secret).update(body).digest());
    return `${body}.${sig}`;
  }

  async _verifyState(state) {
    if (typeof state !== 'string') return null;
    // Phase 12-3 (Codex R1 REVISE): require exactly two `.`-separated
    // segments. A state with extra dots could be a JWT-shaped probe or a
    // malformed body that decodes into garbage. Strict shape check first.
    const parts = state.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    if (!body || !sig) return null;
    const secret = await this._getServerSecret();
    const expected = b64url(createHmac('sha256', secret).update(body).digest());
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
    let payload;
    try {
      payload = JSON.parse(fromB64url(body).toString('utf-8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (payload.typ !== STATE_TYP) return null;
    if (payload.aud !== STATE_AUD) return null;
    if (typeof payload.installId !== 'string' || payload.installId.length === 0) return null;
    const now = Date.now();
    if (typeof payload.iat !== 'number' || payload.iat > now + 1000) return null;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    // Phase 12-3 (Codex R1 REVISE): bound TTL so an attacker who somehow
    // captures the secret and tries to forge a long-lived state still hits
    // the 10-min cap. Also prevents copy/paste from a long-TTL ENV.
    if (payload.exp - payload.iat > this._stateTtlMs + 1000) return null;
    return payload;
  }

  // ─── Mutexes (FIFO chain pattern) ────────────────────────────────────
  _withWorkspaceMutex(workspaceId, fn) {
    const key = workspaceId;
    const prev = this._workspaceMutex.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn());
    this._workspaceMutex.set(key, next);
    next.finally(() => {
      if (this._workspaceMutex.get(key) === next) this._workspaceMutex.delete(key);
    }).catch(() => {});
    return next;
  }

  _withTeamInstallMutex(lockKey, fn) {
    const prev = this._teamInstallMutex.get(lockKey) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn());
    this._teamInstallMutex.set(lockKey, next);
    next.finally(() => {
      if (this._teamInstallMutex.get(lockKey) === next) this._teamInstallMutex.delete(lockKey);
    }).catch(() => {});
    return next;
  }

  // ─── Install flow ────────────────────────────────────────────────────
  async initializeInstall({ scopes, identityHint = null } = {}) {
    const app = await this.getAppCredentials();
    if (!app.clientId || !app.clientSecret) {
      const err = new Error('Slack App credential 미설정 — /admin/slack 에서 client_id/client_secret 등록 필요');
      err.code = 'SLACK_APP_NOT_CONFIGURED';
      throw err;
    }
    // getSlackRedirectUri throws if BIFROST_PUBLIC_URL missing/invalid —
    // bubble that through so the caller renders a friendly setup page.
    const redirectUri = getSlackRedirectUri();

    const installId = `inst_${b64url(randomBytes(12))}`;
    const issuedAt = Date.now();
    const userScopes = (scopes && scopes.length) ? scopes : DEFAULT_USER_SCOPES;
    const state = await this._signState({
      typ: STATE_TYP,
      aud: STATE_AUD,
      installId,
      iat: issuedAt,
      exp: issuedAt + this._stateTtlMs,
    });

    // Cap pending size — install rate is human-scale so this never trips
    // in normal use. Eviction policy: drop oldest entry when full.
    if (this._installPending.size >= this._maxPending) {
      const oldest = [...this._installPending.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this._installPending.delete(oldest[0]);
    }
    this._installPending.set(installId, {
      state,
      status: 'pending',
      identityHint,
      createdAt: issuedAt,
      expiresAt: issuedAt + this._stateTtlMs,
    });

    const url = new URL(SLACK_AUTHORIZE_URL);
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('user_scope', userScopes.join(','));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);

    if (this.wm.logAudit) {
      this.wm.logAudit('slack.install_started', null, JSON.stringify({
        installId,
        scopes: userScopes,
      }));
    }
    this._metric('slack_install_total', { result: 'started' });

    return { installId, authorizationUrl: url.toString() };
  }

  getInstallStatus(installId) {
    const entry = this._installPending.get(installId);
    if (!entry) return { status: 'unknown' };
    return {
      status: entry.status,
      workspaceId: entry.workspaceId || null,
      error: entry.error || null,
      mode: entry.mode || null,
      teamId: entry.teamId || null,
    };
  }

  _markPending(installId, patch) {
    const entry = this._installPending.get(installId);
    if (!entry) return;
    Object.assign(entry, patch);
  }

  async _exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const params = new URLSearchParams();
    params.set('code', code);
    params.set('redirect_uri', redirectUri);
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);

    const res = await this.fetch(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`token_endpoint_http_${res.status}: ${sanitize(text).slice(0, 200)}`);
      err.code = 'SLACK_HTTP_ERROR';
      err.status = res.status;
      throw err;
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      const err = new Error('token_endpoint_invalid_json');
      err.code = 'SLACK_INVALID_JSON';
      throw err;
    }
    if (!json.ok) {
      const err = new Error(describeSlackError(json.error, json.error_description));
      err.code = 'SLACK_OAUTH_ERROR';
      err.slackError = json.error || 'unknown';
      throw err;
    }
    return json;
  }

  /**
   * Phase 12 §3.2 — parse oauth.v2.access response into our storage shape.
   * Reject:
   *   - is_enterprise_install: true
   *   - missing authed_user.access_token
   *   - authed_user.token_type !== 'user'
   *   - rotation half-state (expires_in present without refresh_token)
   *
   * Discards:
   *   - root access_token (bot token — Phase 12 invariant: user-token only)
   *   - incoming_webhook (no use case in Phase 12)
   */
  parseTokenResponse(json) {
    if (!json || typeof json !== 'object') {
      const err = new Error('Slack response is not an object');
      err.code = 'SLACK_BAD_SHAPE';
      throw err;
    }
    if (json.is_enterprise_install === true) {
      const err = new Error('Enterprise Grid org-wide install 은 Phase 12 비범위입니다 (is_enterprise_install=true)');
      err.code = 'SLACK_ENTERPRISE_INSTALL_REJECTED';
      throw err;
    }
    if (!json.team || !json.team.id) {
      const err = new Error('Slack 응답에 team.id 가 없습니다 (Enterprise-only 응답일 수 있음)');
      err.code = 'SLACK_NO_TEAM';
      throw err;
    }
    const u = json.authed_user;
    if (!u || !u.access_token) {
      const err = new Error('Slack 응답에 authed_user.access_token 이 없습니다 (root bot token only — Phase 12 invariant 위반)');
      err.code = 'SLACK_NO_USER_TOKEN';
      throw err;
    }
    // Phase 12-3 (Codex R1 REVISE): require token_type='user' explicitly —
    // a missing token_type previously slipped through, but our storage
    // schema demands the literal 'user' so the parser must enforce it.
    if (u.token_type !== 'user') {
      const err = new Error(`authed_user.token_type 이 'user' 가 아니거나 누락 (${u.token_type ?? 'absent'})`);
      err.code = 'SLACK_BAD_TOKEN_TYPE';
      throw err;
    }
    const hasRefresh = !!u.refresh_token;
    const hasExpires = typeof u.expires_in === 'number' && u.expires_in > 0;
    // Phase 12-3 (Codex R1 BLOCKER): reject *both* half-state directions.
    //   (expires_in only, no refresh_token) → rotation enabled but Slack
    //     didn't issue a refresh — token will silently expire with no
    //     recovery path.
    //   (refresh_token only, no expires_in)  → rotation enabled but no
    //     expiry advertised — we'd never trigger the refresh and the
    //     refresh_token sits unused while access_token quietly expires.
    if (hasExpires !== hasRefresh) {
      const err = new Error(`Slack rotation half-state: expires_in=${hasExpires}, refresh_token=${hasRefresh}`);
      err.code = 'SLACK_ROTATION_HALF_STATE';
      throw err;
    }
    const issuedAtIso = new Date().toISOString();
    const expiresAtIso = hasExpires
      ? new Date(Date.now() + u.expires_in * 1000).toISOString()
      : null;
    const scopesGranted = typeof u.scope === 'string'
      ? u.scope.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    return {
      team: { id: json.team.id, name: json.team.name || json.team.id },
      authedUser: { id: u.id, scopesGranted },
      tokens: {
        accessToken: u.access_token,
        refreshToken: u.refresh_token || undefined,
        expiresAt: expiresAtIso || undefined,
        tokenType: 'user',
      },
      issuedAt: issuedAtIso,
    };
  }

  /**
   * Phase 12-3 (Codex R1 BLOCKER): Slack token rotation refresh response is
   * shaped differently from oauth.v2.access install response — rotated
   * tokens are TOP-LEVEL access_token / refresh_token / expires_in / scope,
   * with NO authed_user wrapper. team / enterprise still appear as
   * companion descriptors. Reusing parseTokenResponse would always fail
   * the authed_user.access_token check.
   *
   * Reference: https://docs.slack.dev/tools/node-slack-sdk/reference/oauth/interfaces/OAuthV2TokenRefreshResponse/
   *
   * Invariants preserved from the install parser:
   *   - is_enterprise_install=true → reject (R9)
   *   - token_type must be 'user' (Phase 12 invariant)
   *   - half-state: expires_in / refresh_token must be both-present or
   *     both-absent
   *   - Stored shape matches workspace-schema slackOAuthTokensSchema.
   */
  parseRefreshResponse(json) {
    if (!json || typeof json !== 'object') {
      const err = new Error('Slack refresh response is not an object');
      err.code = 'SLACK_BAD_SHAPE';
      throw err;
    }
    if (json.is_enterprise_install === true) {
      const err = new Error('Enterprise Grid install detected on refresh — rotation rejected');
      err.code = 'SLACK_ENTERPRISE_INSTALL_REJECTED';
      throw err;
    }
    if (!json.access_token) {
      const err = new Error('refresh response missing top-level access_token');
      err.code = 'SLACK_NO_ACCESS_TOKEN';
      throw err;
    }
    if (json.token_type !== 'user') {
      const err = new Error(`refresh token_type !== 'user' (${json.token_type ?? 'absent'})`);
      err.code = 'SLACK_BAD_TOKEN_TYPE';
      throw err;
    }
    const hasRefresh = !!json.refresh_token;
    const hasExpires = typeof json.expires_in === 'number' && json.expires_in > 0;
    if (hasExpires !== hasRefresh) {
      const err = new Error(`refresh half-state: expires_in=${hasExpires}, refresh_token=${hasRefresh}`);
      err.code = 'SLACK_ROTATION_HALF_STATE';
      throw err;
    }
    const issuedAtIso = new Date().toISOString();
    const expiresAtIso = hasExpires
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : null;
    const scopesGranted = typeof json.scope === 'string'
      ? json.scope.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    return {
      team: json.team ? { id: json.team.id, name: json.team.name || json.team.id } : null,
      tokens: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || undefined,
        expiresAt: expiresAtIso || undefined,
        tokenType: 'user',
      },
      scopesGranted,
      issuedAt: issuedAtIso,
    };
  }

  /**
   * Phase 12 §4.1 — completeInstall.
   * Phase A (mutex 진입 전): state verify + token exchange + parse + reject.
   * Phase B (lockKey 산출 후 mutex 진입): duplicate detection +
   *   create-or-update + atomic save.
   */
  async completeInstall({ code, state, errorParam } = {}) {
    if (errorParam) {
      // Slack appended ?error=... on the redirect — short-circuit.
      const err = new Error(describeSlackError(errorParam));
      err.code = 'SLACK_AUTHORIZE_ERROR';
      err.slackError = errorParam;
      this._metric('slack_install_total', { result: 'failed' });
      throw err;
    }
    const verified = await this._verifyState(state);
    if (!verified) {
      const err = new Error('state_invalid (HMAC / aud / typ / iat / exp 검증 실패)');
      err.code = 'STATE_INVALID';
      this._metric('slack_install_total', { result: 'failed' });
      throw err;
    }
    const installId = verified.installId;

    // Mark pending entry for status polling. We continue even if installId
    // wasn't tracked (e.g. server restart in between) — the state HMAC is
    // sufficient for security.
    this._markPending(installId, { status: 'in_progress' });

    const app = await this.getAppCredentials();
    if (!app.clientId || !app.clientSecret) {
      this._markPending(installId, { status: 'failed', error: 'SLACK_APP_NOT_CONFIGURED' });
      const err = new Error('Slack App credential 미설정 (callback 시점)');
      err.code = 'SLACK_APP_NOT_CONFIGURED';
      this._metric('slack_install_total', { result: 'failed' });
      throw err;
    }

    let redirectUri;
    try { redirectUri = getSlackRedirectUri(); }
    catch (err) {
      this._markPending(installId, { status: 'failed', error: err.code || 'PUBLIC_ORIGIN_MISSING' });
      this._metric('slack_install_total', { result: 'failed' });
      throw err;
    }

    let tokenResp;
    try {
      tokenResp = await this._exchangeCode({
        code,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri,
      });
    } catch (err) {
      this._markPending(installId, { status: 'failed', error: err.slackError || err.code });
      if (this.wm.logAudit) {
        this.wm.logAudit('slack.install_failed', null, JSON.stringify({
          installId,
          stage: 'token_exchange',
          slackError: err.slackError || null,
          code: err.code,
        }));
      }
      this._metric('slack_install_total', { result: 'failed' });
      throw err;
    }

    let parsed;
    try {
      parsed = this.parseTokenResponse(tokenResp);
    } catch (err) {
      this._markPending(installId, { status: 'failed', error: err.code });
      if (this.wm.logAudit) {
        this.wm.logAudit('slack.install_failed', null, JSON.stringify({
          installId,
          stage: 'parse',
          code: err.code,
        }));
      }
      // Phase 12-3 (Codex R1 REVISE): best-effort revoke ALL tokens that
      // could have arrived in the response, not just authed_user.access_token.
      // SLACK_NO_USER_TOKEN means root access_token (bot) is present and
      // needs revoking; rotation responses can also carry refresh_tokens
      // even when the rest of the shape is malformed.
      const stranded = [
        tokenResp?.authed_user?.access_token,
        tokenResp?.authed_user?.refresh_token,
        tokenResp?.access_token,
        tokenResp?.refresh_token,
      ].filter(Boolean);
      for (const tok of stranded) {
        await this._revokeToken(tok).catch(() => {});
      }
      this._metric('slack_install_total', { result: 'failed' });
      throw err;
    }

    const lockKey = `slack-install::${parsed.team.id}`;

    return this._withTeamInstallMutex(lockKey, async () => {
      // Duplicate detection — read AFTER lock so a concurrent install for
      // the same team can't both create new entries.
      const existing = this._findSlackOAuthWorkspaceByTeamId(parsed.team.id);
      let mode, workspaceId;
      try {
        if (existing) {
          mode = 're-authorize';
          workspaceId = existing.id;
          await this.wm.updateWorkspace(existing.id, {
            authMode: 'oauth',
            slackOAuth: {
              ...existing.slackOAuth,
              team: parsed.team,
              authedUser: parsed.authedUser,
              tokens: parsed.tokens,
              status: 'active',
              issuedAt: parsed.issuedAt,
              lastRefreshedAt: parsed.issuedAt,
            },
          });
        } else {
          mode = 'create';
          // Generate a stable alias from the team name (sanitized) and
          // delegate suffix collision handling to addWorkspace.
          const alias = aliasForTeam(parsed.team.name || parsed.team.id);
          const ws = await this.wm.addWorkspace({
            kind: 'native',
            provider: 'slack',
            authMode: 'oauth',
            displayName: parsed.team.name || `Slack ${parsed.team.id}`,
            alias,
            slackOAuth: {
              team: parsed.team,
              authedUser: parsed.authedUser,
              tokens: parsed.tokens,
              status: 'active',
              issuedAt: parsed.issuedAt,
              lastRefreshedAt: parsed.issuedAt,
            },
          });
          workspaceId = ws.id;
        }
      } catch (err) {
        // Save failed — revoke the freshly-received tokens so the user is
        // not left with a dangling install.
        await this._revokeToken(parsed.tokens.accessToken).catch(() => {});
        if (parsed.tokens.refreshToken) {
          await this._revokeToken(parsed.tokens.refreshToken).catch(() => {});
        }
        this._markPending(installId, { status: 'failed', error: 'SAVE_FAILED' });
        if (this.wm.logAudit) {
          this.wm.logAudit('slack.install_failed', null, JSON.stringify({
            installId,
            stage: 'save',
            code: err.code,
            message: sanitize(err.message).slice(0, 200),
          }));
        }
        this._metric('slack_install_total', { result: 'failed' });
        throw err;
      }

      this._markPending(installId, {
        status: 'completed',
        workspaceId,
        mode,
        teamId: parsed.team.id,
      });
      if (this.wm.logAudit) {
        this.wm.logAudit('slack.install_completed', workspaceId, JSON.stringify({
          installId,
          mode,
          teamMasked: maskTeamId(parsed.team.id),
          accessTokenPrefix: tokenPrefix(parsed.tokens.accessToken),
          hasRefreshToken: !!parsed.tokens.refreshToken,
        }));
      }
      this._metric('slack_install_total', { result: 'success', team: maskTeamId(parsed.team.id) });
      return { workspaceId, team: parsed.team, authedUser: parsed.authedUser, mode, installId };
    });
  }

  _findSlackOAuthWorkspaceByTeamId(teamId) {
    const list = this.wm._raw_workspaces ? this.wm._raw_workspaces() : null;
    const all = list || (this.wm.config?.workspaces || []);
    return all.find(w =>
      w.provider === 'slack' &&
      w.authMode === 'oauth' &&
      !w.deletedAt &&
      w.slackOAuth?.team?.id === teamId
    ) || null;
  }

  // ─── Refresh ─────────────────────────────────────────────────────────
  async ensureValidAccessToken(workspaceId) {
    const ws = this.wm.getRawWorkspace(workspaceId);
    if (!ws) {
      const err = new Error(`workspace_not_found: ${workspaceId}`);
      err.code = 'WORKSPACE_NOT_FOUND';
      throw err;
    }
    if (ws.provider !== 'slack' || ws.authMode !== 'oauth') {
      const err = new Error(`not_a_slack_oauth_workspace: ${workspaceId}`);
      err.code = 'NOT_SLACK_OAUTH';
      throw err;
    }
    const oauth = ws.slackOAuth;
    if (!oauth || !oauth.tokens?.accessToken) {
      const err = new Error('slackOAuth.tokens.accessToken absent');
      err.code = 'NO_ACCESS_TOKEN';
      throw err;
    }
    if (oauth.status === 'action_needed') {
      const err = new Error('slackOAuth.status === action_needed — re-authorize required');
      err.code = 'ACTION_NEEDED';
      throw err;
    }
    const expiresAt = oauth.tokens.expiresAt;
    const refreshToken = oauth.tokens.refreshToken;
    // R13 case ①: non-rotating long-lived user-token. expiresAt and
    // refreshToken are both absent. Just return the access token.
    if (!expiresAt && !refreshToken) {
      return oauth.tokens.accessToken;
    }
    if (!expiresAt) {
      // refreshToken present but no expiresAt — Slack should always send
      // both together. Treat as rotating but not expiring soon.
      return oauth.tokens.accessToken;
    }
    const remainingMs = Date.parse(expiresAt) - Date.now();
    if (Number.isNaN(remainingMs) || remainingMs > REFRESH_LEEWAY_MS) {
      return oauth.tokens.accessToken;
    }
    if (!refreshToken) {
      const err = new Error('access_token expiring but no refresh_token — re-authorize required');
      err.code = 'NO_REFRESH_TOKEN';
      throw err;
    }
    return this._refreshWithMutex(workspaceId);
  }

  _refreshWithMutex(workspaceId) {
    return this._withWorkspaceMutex(workspaceId, () => this._runRefresh(workspaceId));
  }

  async _runRefresh(workspaceId) {
    // Re-read inside lock — another caller may have already refreshed.
    const ws = this.wm.getRawWorkspace(workspaceId);
    if (!ws || !ws.slackOAuth?.tokens?.refreshToken) {
      const err = new Error('refresh_token absent at refresh time');
      err.code = 'NO_REFRESH_TOKEN';
      throw err;
    }
    if (ws.slackOAuth.status === 'action_needed') {
      const err = new Error('action_needed flag set during pending refresh');
      err.code = 'ACTION_NEEDED';
      throw err;
    }
    const oldRefresh = ws.slackOAuth.tokens.refreshToken;
    // If another refresh raced and already updated the token, return early.
    const expiresAt = ws.slackOAuth.tokens.expiresAt;
    if (expiresAt && (Date.parse(expiresAt) - Date.now()) > REFRESH_LEEWAY_MS) {
      return ws.slackOAuth.tokens.accessToken;
    }

    const app = await this.getAppCredentials();
    if (!app.clientId || !app.clientSecret) {
      const err = new Error('Slack App credential 미설정 (refresh 시점)');
      err.code = 'SLACK_APP_NOT_CONFIGURED';
      throw err;
    }

    // Phase 11-5 pattern — abortable fetch with timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._refreshTimeoutMs);
    timer.unref?.();
    let json;
    try {
      const params = new URLSearchParams();
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', oldRefresh);
      params.set('client_id', app.clientId);
      params.set('client_secret', app.clientSecret);
      const res = await this.fetch(SLACK_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: params.toString(),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`refresh_http_${res.status}: ${sanitize(text).slice(0, 200)}`);
        err.code = 'SLACK_HTTP_ERROR';
        err.status = res.status;
        throw err;
      }
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    if (!json.ok) {
      const slackError = json.error || 'unknown';
      // invalid_grant → refresh token already used (Slack rotation is
      // single-use). Mark workspace action_needed so the user re-authorizes.
      if (slackError === 'invalid_grant' || slackError === 'invalid_client') {
        await this._markActionNeededInLock(workspaceId, slackError);
      }
      this._metric('slack_refresh_total', { result: 'failed' });
      if (this.wm.logAudit) {
        this.wm.logAudit('slack.token_refresh_failed', workspaceId, JSON.stringify({
          slackError,
          mappedMessage: describeSlackError(slackError),
        }));
      }
      const err = new Error(describeSlackError(slackError));
      err.code = 'SLACK_OAUTH_ERROR';
      err.slackError = slackError;
      throw err;
    }

    let parsed;
    try {
      parsed = this.parseRefreshResponse(json);
    } catch (err) {
      // Half-state or shape error — best-effort revoke any tokens that
      // arrived in the malformed response so they don't dangle.
      const stranded = [json.access_token, json.refresh_token].filter(Boolean);
      for (const tok of stranded) {
        await this._revokeToken(tok).catch(() => {});
      }
      // Surface action_needed (already in lock).
      await this._markActionNeededInLock(workspaceId, err.code || 'parse_failed');
      this._metric('slack_refresh_total', { result: 'failed' });
      throw err;
    }

    // Phase 12-3 (Codex R1 BLOCKER): atomic clone-then-swap save. The
    // helper writes to disk first (snapshot-based) and only swaps the
    // in-memory config on success — so a writeFile failure leaves both
    // disk and runtime on the previous good token, never the partial
    // new one.
    try {
      await this.wm.updateSlackOAuthAtomic(workspaceId, (current) => ({
        ...(current || {}),
        team: parsed.team || current?.team || null,
        authedUser: current?.authedUser || null,
        tokens: parsed.tokens,
        status: 'active',
        lastRefreshedAt: parsed.issuedAt,
        actionNeededReason: undefined,
      }));
    } catch (saveErr) {
      // Durable save failure — Codex R10. The clone-then-swap helper has
      // already restored this.config, but the runtime still needs to
      // surface action_needed so the user re-authorizes (refresh_token
      // is single-use and the previous in-memory copy was consumed by
      // the token endpoint).
      await this._markActionNeededInLock(workspaceId, 'save_failed').catch(() => {});
      // Best-effort revoke the rotated tokens we just received but cannot
      // safely persist — Slack server-side will mark the new refresh as
      // used and our refresh_token is gone too.
      await this._revokeToken(parsed.tokens.accessToken).catch(() => {});
      if (parsed.tokens.refreshToken) {
        await this._revokeToken(parsed.tokens.refreshToken).catch(() => {});
      }
      if (this.wm.logAudit) {
        this.wm.logAudit('slack.token_save_failed', workspaceId, JSON.stringify({
          message: sanitize(saveErr.message).slice(0, 200),
        }));
      }
      this._metric('slack_refresh_total', { result: 'save_failed' });
      throw saveErr;
    }

    if (this.wm.logAudit) {
      this.wm.logAudit('slack.token_refreshed', workspaceId, JSON.stringify({
        accessTokenPrefix: tokenPrefix(parsed.tokens.accessToken),
        hasRefreshToken: !!parsed.tokens.refreshToken,
        expiresAt: parsed.tokens.expiresAt || null,
      }));
    }
    this._metric('slack_refresh_total', { result: 'success' });
    return parsed.tokens.accessToken;
  }

  async markActionNeeded(workspaceId, reason) {
    return this._withWorkspaceMutex(workspaceId, () => this._markActionNeededInLock(workspaceId, reason));
  }

  /**
   * Internal — applied while the workspace mutex is already held. Used by
   * the public markActionNeeded (which takes the lock first) AND by
   * _runRefresh's error paths (which already hold the lock — re-entering
   * the mutex from inside would deadlock the FIFO chain).
   */
  async _markActionNeededInLock(workspaceId, reason) {
    const ws = this.wm.getRawWorkspace(workspaceId);
    if (!ws || !ws.slackOAuth) return { marked: false };
    if (ws.slackOAuth.status === 'action_needed') return { marked: false, alreadyActionNeeded: true };
    ws.slackOAuth.status = 'action_needed';
    ws.slackOAuth.actionNeededReason = reason;
    if (this.wm._save) await this.wm._save().catch(() => {});
    if (this.wm.logAudit) {
      this.wm.logAudit('slack.action_needed', workspaceId, JSON.stringify({ reason }));
    }
    return { marked: true };
  }

  // ─── Disconnect ──────────────────────────────────────────────────────
  async revoke(workspaceId, { revokeRefresh = true } = {}) {
    return this._withWorkspaceMutex(workspaceId, async () => {
      const ws = this.wm.getRawWorkspace(workspaceId);
      if (!ws || !ws.slackOAuth) return { revoked: false, reason: 'no_oauth_state' };
      const accessToken = ws.slackOAuth.tokens?.accessToken;
      const refreshToken = ws.slackOAuth.tokens?.refreshToken;
      let accessRevoked = false;
      let refreshRevoked = false;
      if (accessToken) {
        accessRevoked = await this._revokeToken(accessToken).catch((err) => {
          if (this.wm.logAudit) {
            this.wm.logAudit('slack.disconnect_revoke_failed', workspaceId, JSON.stringify({
              tokenKind: 'access',
              message: sanitize(err.message).slice(0, 200),
            }));
          }
          return false;
        });
      }
      if (revokeRefresh && refreshToken) {
        refreshRevoked = await this._revokeToken(refreshToken).catch((err) => {
          if (this.wm.logAudit) {
            this.wm.logAudit('slack.disconnect_revoke_failed', workspaceId, JSON.stringify({
              tokenKind: 'refresh',
              message: sanitize(err.message).slice(0, 200),
            }));
          }
          return false;
        });
      }
      if (this.wm.logAudit) {
        this.wm.logAudit('slack.disconnect', workspaceId, JSON.stringify({
          accessRevoked: !!accessRevoked,
          refreshRevoked: !!refreshRevoked,
        }));
      }
      return { revoked: true, accessRevoked: !!accessRevoked, refreshRevoked: !!refreshRevoked };
    });
  }

  async _revokeToken(token) {
    if (!token) return false;
    const params = new URLSearchParams();
    params.set('token', token);
    const res = await this.fetch(SLACK_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const err = new Error(`auth.revoke HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    let body;
    try { body = await res.json(); } catch { return false; }
    return !!body?.ok;
  }

  // ─── State maintenance ───────────────────────────────────────────────
  /** Drop expired pending install entries so the in-memory cap doesn't fill. */
  purgeStaleInstalls({ now = Date.now() } = {}) {
    let removed = 0;
    for (const [id, entry] of this._installPending.entries()) {
      if (entry.status === 'pending' && entry.expiresAt < now) {
        this._installPending.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// Phase 12 §4.1 — alias derivation. team name → lowercase, hyphenated.
// Falls back to team id when the name produces an empty alias.
export function aliasForTeam(teamName) {
  const normalized = String(teamName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'slack';
}
