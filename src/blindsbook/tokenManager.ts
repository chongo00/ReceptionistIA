// JWT token manager with auto-login, switch-company support, and proactive renewal

import axios from 'axios';

export interface CompanyCredentials {
  companyId: number;
  email?: string;
  password?: string;
  token?: string;
}

interface CachedToken {
  jwt: string;
  expiresAt: number;
  obtainedAt: number;
}

const REFRESH_MARGIN_MS = 60 * 60 * 1000; // 1 hour before expiry
const PROACTIVE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const MAX_LOGIN_RETRIES = 3;
const LOGIN_RETRY_DELAY_MS = 5_000;

export class TokenManager {
  private apiBaseUrl: string;
  private tokens = new Map<string, CachedToken>();
  private credentials = new Map<string, CompanyCredentials>();
  private defaultEmail: string | null = null;
  private defaultPassword: string | null = null;
  private defaultStaticToken: string | null = null;
  private proactiveTimer: ReturnType<typeof setInterval> | null = null;
  private loginLocks = new Map<string, Promise<string | null>>();
  // Companies without own credentials use switch-company instead
  private switchCompanyTargets = new Set<number>();

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
  }

  setDefaultCredentials(email: string | null, password: string | null): void {
    this.defaultEmail = email;
    this.defaultPassword = password;
  }

  setDefaultStaticToken(token: string | null): void {
    this.defaultStaticToken = token || null;
  }

  /** If company has own email/password, uses direct login; otherwise uses switch-company. */
  registerCompany(companyId: number, creds: CompanyCredentials): void {
    const hasOwnCreds = !!(creds.email && creds.password);
    this.credentials.set(String(companyId), creds);

    if (!hasOwnCreds) {
      this.switchCompanyTargets.add(companyId);
      console.log(`[TokenManager] Company ${companyId} registered (switch-company via superuser)`);
    } else {
      console.log(`[TokenManager] Company ${companyId} registered (own credentials: ${creds.email})`);
    }
  }

  /** Returns a valid JWT for the given company (or default). Triggers login/switch-company if needed. */
  async getToken(companyId?: number): Promise<string | null> {
    const key = companyId ? String(companyId) : 'default';

    const cached = this.tokens.get(key);
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.jwt;
    }

    let freshToken: string | null = null;

    if (companyId && this.switchCompanyTargets.has(companyId)) {
      const baseJwt = this.tokens.get('default')?.jwt;
      if (baseJwt) {
        freshToken = await this.doSwitchCompany(baseJwt, companyId);
      }
      // If switch-company fails and no base token, retry superuser login
      if (!freshToken && this.defaultEmail && this.defaultPassword) {
        const newBase = await this.login('default');
        if (newBase) {
          freshToken = await this.doSwitchCompany(newBase, companyId);
        }
      }
    } else {
      freshToken = await this.login(key);
    }

    if (freshToken) return freshToken;

    // Fallback: use expiring-but-not-expired token while renewal is attempted
    if (cached && cached.expiresAt > Date.now()) {
      console.warn(`[TokenManager] Token for ${key} expiring soon, using while renewing`);
      return cached.jwt;
    }

    if (companyId) {
      const creds = this.credentials.get(String(companyId));
      if (creds?.token) return creds.token;
    }
    if (this.defaultStaticToken) return this.defaultStaticToken;

    console.error(`[TokenManager] Could not obtain token for ${key}`);
    return null;
  }

  /** Invalidate a company's token, forcing re-login on next call. Use after receiving a 401. */
  invalidateToken(companyId?: number): void {
    const key = companyId ? String(companyId) : 'default';
    this.tokens.delete(key);
    console.log(`[TokenManager] Token invalidated for ${key}`);
  }

  startProactiveRenewal(): void {
    if (this.proactiveTimer) return;

    this.proactiveTimer = setInterval(async () => {
      await this.renewExpiringTokens();
    }, PROACTIVE_CHECK_INTERVAL_MS);

    void this.renewExpiringTokens();
    console.log('[TokenManager] Proactive renewal enabled (every 30 min)');
  }

  stopProactiveRenewal(): void {
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
  }

  /** Initial login for all registered companies + default. Call on service start. */
  async loginAll(): Promise<void> {
    if (this.defaultEmail && this.defaultPassword) {
      const baseToken = await this.login('default');
      if (baseToken) {
        console.log('[TokenManager] Superuser login OK');
      } else {
        console.warn('[TokenManager] Superuser login failed — switch-company will not work');
      }
    }

    const directLoginPromises: Promise<void>[] = [];
    for (const [companyId, creds] of this.credentials) {
      if (creds.email && creds.password && !this.switchCompanyTargets.has(Number(companyId))) {
        directLoginPromises.push(
          this.login(companyId).then((t) => {
            if (t) console.log(`[TokenManager] Direct login company ${companyId} OK`);
            else console.warn(`[TokenManager] Direct login company ${companyId} failed`);
          }),
        );
      }
    }
    await Promise.allSettled(directLoginPromises);

    const baseJwt = this.tokens.get('default')?.jwt;
    if (baseJwt && this.switchCompanyTargets.size > 0) {
      const switchPromises: Promise<void>[] = [];
      for (const targetCompanyId of this.switchCompanyTargets) {
        switchPromises.push(
          this.doSwitchCompany(baseJwt, targetCompanyId).then((t) => {
            if (t) console.log(`[TokenManager] Switch-company ${targetCompanyId} OK`);
            else console.warn(`[TokenManager] Switch-company ${targetCompanyId} failed`);
          }),
        );
      }
      await Promise.allSettled(switchPromises);
    } else if (this.switchCompanyTargets.size > 0) {
      console.warn('[TokenManager] No superuser token — switch-company skipped');
    }
  }

  /** Lock prevents concurrent logins for the same key. */
  private async login(key: string): Promise<string | null> {
    const existingLock = this.loginLocks.get(key);
    if (existingLock) return existingLock;

    const loginPromise = this.doLogin(key);
    this.loginLocks.set(key, loginPromise);

    try {
      return await loginPromise;
    } finally {
      this.loginLocks.delete(key);
    }
  }

  private async doLogin(key: string): Promise<string | null> {
    const { email, password } = this.getCredentialsForKey(key);
    if (!email || !password) return null;

    for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
      try {
        const response = await axios.post<{
          success: boolean;
          data?: { token?: string };
        }>(
          `${this.apiBaseUrl}/api/auth/login`,
          { email, password },
          { timeout: 15_000 },
        );

        const jwt = response.data?.data?.token;
        if (!jwt) {
          console.error(`[TokenManager] Login ${key}: response missing token (attempt ${attempt}/${MAX_LOGIN_RETRIES})`);
          continue;
        }

        const expiresAt = this.decodeJwtExp(jwt);
        this.tokens.set(key, {
          jwt,
          expiresAt,
          obtainedAt: Date.now(),
        });

        const minutesLeft = Math.round((expiresAt - Date.now()) / 60_000);
        console.log(`[TokenManager] Login ${key} OK — token valid for ${minutesLeft} min`);
        return jwt;

      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        const message = (err as Error)?.message || 'unknown error';

        if (status === 401 || status === 403) {
          console.error(`[TokenManager] Login ${key} REJECTED (${status}): invalid credentials`);
          return null;
        }

        console.warn(`[TokenManager] Login ${key} failed (attempt ${attempt}/${MAX_LOGIN_RETRIES}): ${message}`);

        if (attempt < MAX_LOGIN_RETRIES) {
          await this.sleep(LOGIN_RETRY_DELAY_MS);
        }
      }
    }

    console.error(`[TokenManager] Login ${key} failed after ${MAX_LOGIN_RETRIES} attempts`);
    return null;
  }

  private getCredentialsForKey(key: string): { email: string | null; password: string | null } {
    if (key === 'default') {
      return { email: this.defaultEmail, password: this.defaultPassword };
    }
    const creds = this.credentials.get(key);
    if (creds?.email && creds?.password) {
      return { email: creds.email, password: creds.password };
    }
    return { email: this.defaultEmail, password: this.defaultPassword };
  }

  private isExpiringSoon(cached: CachedToken): boolean {
    return cached.expiresAt - Date.now() < REFRESH_MARGIN_MS;
  }

  private async renewExpiringTokens(): Promise<void> {
    // Renew superuser token first since switch-company depends on it
    const defaultCached = this.tokens.get('default');
    if (defaultCached && this.isExpiringSoon(defaultCached)) {
      const minutesLeft = Math.round((defaultCached.expiresAt - Date.now()) / 60_000);
      console.log(`[TokenManager] Superuser token expires in ${minutesLeft} min — renewing...`);

      const refreshed = await this.tryRefresh('default', defaultCached.jwt);
      if (!refreshed) {
        await this.login('default');
      }
    }

    for (const [key, cached] of this.tokens) {
      if (key === 'default') continue;

      if (this.isExpiringSoon(cached)) {
        const minutesLeft = Math.round((cached.expiresAt - Date.now()) / 60_000);
        console.log(`[TokenManager] Token ${key} expires in ${minutesLeft} min — renewing...`);

        const companyId = Number(key);

        if (this.switchCompanyTargets.has(companyId)) {
          const baseJwt = this.tokens.get('default')?.jwt;
          if (baseJwt) {
            await this.doSwitchCompany(baseJwt, companyId);
          } else {
            console.warn(`[TokenManager] No superuser token to renew company ${key}`);
          }
        } else {
          const refreshed = await this.tryRefresh(key, cached.jwt);
          if (!refreshed) {
            await this.login(key);
          }
        }
      }
    }
  }

  /** Uses POST /api/auth/switch-company to get a JWT for the target company via the superuser JWT. */
  private async doSwitchCompany(superuserJwt: string, targetCompanyId: number): Promise<string | null> {
    try {
      const response = await axios.post<{
        success: boolean;
        data?: { token?: string };
      }>(
        `${this.apiBaseUrl}/api/auth/switch-company`,
        { companyId: targetCompanyId },
        {
          headers: { Authorization: `Bearer ${superuserJwt}` },
          timeout: 15_000,
        },
      );

      const jwt = response.data?.data?.token;
      if (!jwt) {
        console.error(`[TokenManager] switch-company ${targetCompanyId}: response missing token`);
        return null;
      }

      const expiresAt = this.decodeJwtExp(jwt);
      const key = String(targetCompanyId);
      this.tokens.set(key, {
        jwt,
        expiresAt,
        obtainedAt: Date.now(),
      });

      const minutesLeft = Math.round((expiresAt - Date.now()) / 60_000);
      console.log(`[TokenManager] switch-company ${targetCompanyId} OK — token valid for ${minutesLeft} min`);
      return jwt;

    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const message = (err as Error)?.message || 'unknown error';
      console.error(`[TokenManager] switch-company ${targetCompanyId} failed (${status || 'network'}): ${message}`);
      return null;
    }
  }

  /** Attempts token renewal via POST /auth/refresh. Falls back to full login on failure. */
  private async tryRefresh(key: string, currentJwt: string): Promise<boolean> {
    try {
      const response = await axios.post<{
        accessToken?: string;
        data?: { accessToken?: string };
      }>(
        `${this.apiBaseUrl}/api/auth/refresh`,
        {},
        {
          headers: { Authorization: `Bearer ${currentJwt}` },
          timeout: 10_000,
        },
      );

      const newJwt =
        response.data?.accessToken ??
        response.data?.data?.accessToken ??
        (response.data as unknown as { token?: string })?.token;

      if (!newJwt) {
        console.warn(`[TokenManager] Refresh ${key}: response missing token`);
        return false;
      }

      const expiresAt = this.decodeJwtExp(newJwt);
      this.tokens.set(key, {
        jwt: newJwt,
        expiresAt,
        obtainedAt: Date.now(),
      });

      const minutesLeft = Math.round((expiresAt - Date.now()) / 60_000);
      console.log(`[TokenManager] Refresh ${key} OK — new token valid for ${minutesLeft} min`);
      return true;

    } catch (err: unknown) {
      const message = (err as Error)?.message || 'unknown error';
      console.warn(`[TokenManager] Refresh ${key} failed: ${message} — will do full login`);
      return false;
    }
  }

  /** Decodes `exp` from JWT payload without signature verification. */
  private decodeJwtExp(jwt: string): number {
    try {
      const payload = jwt.split('.')[1];
      if (!payload) return Date.now() + 24 * 60 * 60 * 1000;
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      if (typeof decoded.exp === 'number') {
        return decoded.exp * 1000; // JWT exp is in seconds
      }
    } catch {
      // Decode failed; use fallback
    }
    // Fallback: assume 24h validity
    return Date.now() + 24 * 60 * 60 * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
