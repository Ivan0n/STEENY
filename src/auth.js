'use strict';

// Browser-based sign-in for the desktop client.
//
// The app never renders a password form. It opens a link request, sends the
// user to their own browser (already signed in, with the password manager and
// the captcha they trust), and polls until that tab approves. Only then does it
// trade its one-time device code for a session token.
//
// The exchange is bound with PKCE, so a device code intercepted on the way out
// -- in a log, in a shell history, over a hostile network -- cannot be redeemed
// by anyone but the process that started the flow.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORE_FILE = 'session.json';
const STORE_VERSION = 1;
// A poll every couple of seconds for at most ten minutes; the server repeats
// both numbers in its replies and they win over these fallbacks.
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

function base64url(buffer) {
  return buffer.toString('base64url');
}

function createPkcePair() {
  // 48 random bytes → 64 base64url characters, inside RFC 7636's 43..128 range.
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

// ── Token storage ───────────────────────────────────────────────────────────
// safeStorage binds the file to the OS keychain (libsecret / DPAPI / Keychain).
// On a machine with no keyring the token is still written, but only with 0600
// permissions -- the alternative would be asking the user to sign in on every
// launch, which is worse and pushes people back to typing the password.

function createTokenStore({ app, safeStorage, logger = console }) {
  const filePath = () => path.join(app.getPath('userData'), STORE_FILE);

  const encryptionAvailable = () => {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable());
    } catch {
      return false;
    }
  };

  function read() {
    let raw;
    try {
      raw = fs.readFileSync(filePath(), 'utf8');
    } catch {
      return null;
    }
    try {
      const payload = JSON.parse(raw);
      if (!payload || payload.version !== STORE_VERSION) return null;
      if (!payload.encrypted) {
        return typeof payload.value === 'string' ? payload.value || null : null;
      }
      if (!encryptionAvailable()) return null;
      const decrypted = safeStorage.decryptString(
        Buffer.from(String(payload.value || ''), 'base64'),
      );
      return decrypted || null;
    } catch {
      // A keyring reset or a half-written file must not wedge the app; the
      // user simply signs in again.
      logger.warn?.('Stored session unreadable; a new sign-in is required.');
      return null;
    }
  }

  function write(token) {
    if (typeof token !== 'string' || !token) return false;
    const encrypted = encryptionAvailable();
    const payload = {
      version: STORE_VERSION,
      encrypted,
      value: encrypted
        ? safeStorage.encryptString(token).toString('base64')
        : token,
    };
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(filePath(), JSON.stringify(payload), { mode: 0o600 });
      return true;
    } catch (error) {
      logger.warn?.(`Could not persist the session: ${error.message}`);
      return false;
    }
  }

  function clear() {
    try {
      fs.rmSync(filePath(), { force: true });
    } catch {
      // Already gone, or the profile directory is read-only.
    }
  }

  return { read, write, clear, encryptionAvailable, filePath };
}

// ── Backend calls ───────────────────────────────────────────────────────────

function createLinkClient({ origin, fetchImpl, clientInfo = {} }) {
  const endpoint = pathname => new URL(pathname, origin).href;

  async function request(pathname, { method = 'POST', body, token } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(endpoint(pathname), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // No reply at all: the server is down, or there is no network. This is
      // never a reason to throw away a stored token.
      const failure = new Error(error?.message || 'network error');
      failure.offline = true;
      throw failure;
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, ok: response.ok, payload };
  }

  return {
    async start(challenge) {
      const { ok, payload } = await request('/api/client/auth/start', {
        body: {
          code_challenge: challenge,
          client_name: clientInfo.name || 'STEENY',
          client_version: clientInfo.version || '',
          platform: clientInfo.platform || '',
        },
      });
      if (!ok || !payload?.device_code || !payload?.verification_url) {
        throw new Error(payload?.error || 'Не удалось начать вход');
      }
      return payload;
    },

    async poll(deviceCode) {
      const { payload } = await request('/api/client/auth/poll', {
        body: { device_code: deviceCode },
      });
      return payload?.status || 'invalid';
    },

    async exchange(deviceCode, verifier) {
      const { ok, payload } = await request('/api/client/auth/exchange', {
        body: { device_code: deviceCode, code_verifier: verifier },
      });
      if (!ok || !payload?.token) {
        throw new Error(payload?.error || 'Не удалось завершить вход');
      }
      return payload;
    },

    async checkToken(token) {
      const { ok, status, payload } = await request('/api/client/auth/status', {
        method: 'GET',
        token,
      });
      return { valid: Boolean(ok && payload?.valid), status, user: payload?.user };
    },

    // Replays the stored token once so the embedded window ends up with the
    // same cookie a browser login would have set. That is what lets the web app
    // stay completely unaware of any of this.
    async establishSession(token) {
      const { ok, status, payload } = await request('/api/client/auth/session', {
        token,
      });
      return {
        ok,
        unauthorized: status === 401,
        user: payload?.user || null,
      };
    },
  };
}

// ── The flow itself ─────────────────────────────────────────────────────────

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    }, { once: true });
  });
}

/**
 * Drive one sign-in attempt end to end.
 *
 * `onState` is called on every visible transition so the window can follow
 * along; the promise resolves with the issued token, or with a terminal state
 * (`denied` / `expired` / `cancelled`) when there is nothing to hand back.
 */
async function runLinkFlow({
  client,
  openBrowser,
  onState = () => undefined,
  signal,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const { verifier, challenge } = createPkcePair();
  onState({ status: 'opening' });

  const started = await client.start(challenge);
  const verificationUrl = started.verification_url;
  const userCode = started.user_code || '';
  const intervalMs = Math.max(
    1000, Number(started.interval) * 1000 || DEFAULT_POLL_INTERVAL_MS,
  );
  const deadline = now() + Math.min(
    timeoutMs, (Number(started.expires_in) * 1000) || timeoutMs,
  );

  onState({ status: 'waiting', verificationUrl, userCode });
  openBrowser(verificationUrl);

  while (now() < deadline) {
    if (signal?.aborted) return { status: 'cancelled' };
    try {
      await delay(intervalMs, signal);
    } catch {
      return { status: 'cancelled' };
    }

    let status;
    try {
      status = await client.poll(started.device_code);
    } catch (error) {
      // A blip while polling is not fatal: the request stays valid on the
      // server, so keep trying until the deadline.
      if (!error.offline) throw error;
      onState({ status: 'waiting', verificationUrl, userCode, flaky: true });
      continue;
    }

    if (status === 'pending') {
      onState({ status: 'waiting', verificationUrl, userCode });
      continue;
    }
    if (status === 'approved') {
      onState({ status: 'finishing', verificationUrl, userCode });
      const result = await client.exchange(started.device_code, verifier);
      return { status: 'authorized', token: result.token, user: result.user };
    }
    if (status === 'denied') return { status: 'denied' };
    if (status === 'expired') return { status: 'expired' };
    return { status: 'invalid' };
  }
  return { status: 'expired' };
}

module.exports = {
  createPkcePair,
  createTokenStore,
  createLinkClient,
  runLinkFlow,
  DEFAULT_POLL_INTERVAL_MS,
};
