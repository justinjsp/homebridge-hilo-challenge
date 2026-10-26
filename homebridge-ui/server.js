// Settings-page backend: this plugin's own Hilo login. The resulting refresh token is
// written to <storage>/hilo-challenge/auth.json, never to config.json, and is separate
// from homebridge-hilo's session.
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const {
  authFilePath, exchangeCode, newAuthFile, parseRedirect, readAuthFile, startLogin, writeAuthFile,
} = require('../dist/hiloAuth.js');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.pending = null;
    this.authPath = authFilePath(this.homebridgeStoragePath);

    this.onRequest('/status', () => this.status());
    this.onRequest('/login/start', () => {
      this.pending = startLogin();
      return { url: this.pending.url };
    });
    this.onRequest('/login/finish', (payload) => this.finishLogin(payload));
    this.onRequest('/logout', () => {
      fs.rmSync(this.authPath, { force: true });
      return this.status();
    });
    this.ready();
  }

  status() {
    const auth = readAuthFile(this.authPath);
    return { loggedIn: auth !== null, updatedAt: auth ? auth.updatedAt : null };
  }

  async finishLogin(payload) {
    if (!this.pending) {
      throw new RequestError('Start the login first.', { status: 400 });
    }
    try {
      const code = parseRedirect(String((payload && payload.redirect) || ''), this.pending.state);
      const tokens = await exchangeCode(code, this.pending.verifier);
      writeAuthFile(this.authPath, newAuthFile(tokens.refreshToken));
      this.pending = null;
      return this.status();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Hilo login failed: ${message} (pasted: ${describePasted(payload && payload.redirect)})`);
      throw new RequestError(message, { status: 400 });
    }
  }
}

// What the pasted text looked like, for the log: site, path and parameter names only,
// never the values (the login code is a secret until it's used).
function describePasted(pasted) {
  const text = String(pasted || '').trim();
  if (text === '') return 'nothing';
  try {
    const url = new URL(text);
    const names = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.replace(/^#/, '')).keys()];
    return `${url.host}${url.pathname} with ${names.length ? names.join(', ') : 'no parameters'}`;
  } catch {
    return `${text.length} characters, not a web address`;
  }
}

(() => new UiServer())();
