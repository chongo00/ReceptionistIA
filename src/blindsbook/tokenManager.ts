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

// Renew when less than this margin remains before expiry
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // 1 hora antes de expirar

// Proactive renewal check interval
const PROACTIVE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // cada 30 min

// Max login retries on network errors
const MAX_LOGIN_RETRIES = 3;

// Delay between login retries
const LOGIN_RETRY_DELAY_MS = 5_000;

export class TokenManager {
  private apiBaseUrl: string;
  private tokens = new Map<string, CachedToken>(); // key: companyId or "default"
  private credentials = new Map<string, CompanyCredentials>(); // key = companyId
  private defaultEmail: string | null = null;
  private defaultPassword: string | null = null;
  private defaultStaticToken: string | null = null;
  private proactiveTimer: ReturnType<typeof setInterval> | null = null;
  private loginLocks = new Map<string, Promise<string | null>>(); // prevents concurrent logins
  // Companies without own credentials — use switch-company instead
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
      console.log(`[TokenManager] Compañía ${companyId} registrada (switch-company via superusuario)`);
    } else {
      console.log(`[TokenManager] Compañía ${companyId} registrada (credenciales propias: ${creds.email})`);
    }
  }

  /** Returns a valid JWT for the given company (or default). Triggers login/switch-company if needed. */
  async getToken(companyId?: number): Promise<string | null> {
    const key = companyId ? String(companyId) : 'default';

    // 1. Check for a cached valid token
    const cached = this.tokens.get(key);
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.jwt;
    }

    // 2. Obtain a fresh token
    let freshToken: string | null = null;

    if (companyId && this.switchCompanyTargets.has(companyId)) {
      // Company without own credentials — use switch-company
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
      // Direct login (default or company with own credentials)
      freshToken = await this.login(key);
    }

    if (freshToken) return freshToken;

    // 3. If cached token hasn't expired yet (but expiring soon), use as fallback
    if (cached && cached.expiresAt > Date.now()) {
      console.warn(`[TokenManager] Token para ${key} próximo a expirar, usando mientras se renueva`);
      return cached.jwt;
    }

    // 4. Last resort: static token from the company or the default
    if (companyId) {
      const creds = this.credentials.get(String(companyId));
      if (creds?.token) return creds.token;
    }
    if (this.defaultStaticToken) return this.defaultStaticToken;

    console.error(`[TokenManager] No se pudo obtener token para ${key}`);
    return null;
  }

  /** Invalidate a company's token, forcing re-login on next call. Use after receiving a 401. */
  invalidateToken(companyId?: number): void {
    const key = companyId ? String(companyId) : 'default';
    this.tokens.delete(key);
    console.log(`[TokenManager] Token invalidado para ${key}`);
  }

  startProactiveRenewal(): void {
    if (this.proactiveTimer) return;

    this.proactiveTimer = setInterval(async () => {
      await this.renewExpiringTokens();
    }, PROACTIVE_CHECK_INTERVAL_MS);

    // Also run an immediate first renewal
    void this.renewExpiringTokens();
    console.log('[TokenManager] Renovación proactiva activada (cada 30 min)');
  }

  stopProactiveRenewal(): void {
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
  }

  /** Initial login for all registered companies + default. Call on service start. */
  async loginAll(): Promise<void> {
    // 1. Superuser login (default)
    if (this.defaultEmail && this.defaultPassword) {
      const baseToken = await this.login('default');
      if (baseToken) {
        console.log('[TokenManager] ✓ Login superusuario OK');
      } else {
        console.warn('[TokenManager] ✗ Login superusuario falló — switch-company no funcionará');
      }
    }

    // 2. Companies with own credentials — direct login
    const directLoginPromises: Promise<void>[] = [];
    for (const [companyId, creds] of this.credentials) {
      if (creds.email && creds.password && !this.switchCompanyTargets.has(Number(companyId))) {
        directLoginPromises.push(
          this.login(companyId).then((t) => {
            if (t) console.log(`[TokenManager] ✓ Login directo compañía ${companyId} OK`);
            else console.warn(`[TokenManager] ✗ Login directo compañía ${companyId} falló`);
          }),
        );
      }
    }
    await Promise.allSettled(directLoginPromises);

    // 3. Companies without credentials — switch-company using superuser token
    const baseJwt = this.tokens.get('default')?.jwt;
    if (baseJwt && this.switchCompanyTargets.size > 0) {
      const switchPromises: Promise<void>[] = [];
      for (const targetCompanyId of this.switchCompanyTargets) {
        switchPromises.push(
          this.doSwitchCompany(baseJwt, targetCompanyId).then((t) => {
            if (t) console.log(`[TokenManager] ✓ Switch-company ${targetCompanyId} OK`);
            else console.warn(`[TokenManager] ✗ Switch-company ${targetCompanyId} falló`);
          }),
        );
      }
      await Promise.allSettled(switchPromises);
    } else if (this.switchCompanyTargets.size > 0) {
      console.warn('[TokenManager] No hay token de superusuario — switch-company omitido');
    }
  }

  /** Uses a lock to prevent concurrent logins for the same key. */
  private async login(key: string): Promise<string | null> {
    // If a login is already in progress for this key, wait for its result
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
          console.error(`[TokenManager] Login ${key}: respuesta sin token (intento ${attempt}/${MAX_LOGIN_RETRIES})`);
          continue;
        }

        // Decode JWT exp
        const expiresAt = this.decodeJwtExp(jwt);
        this.tokens.set(key, {
          jwt,
          expiresAt,
          obtainedAt: Date.now(),
        });

        const minutesLeft = Math.round((expiresAt - Date.now()) / 60_000);
        console.log(`[TokenManager] Login ${key} OK — token válido por ${minutesLeft} min`);
        return jwt;

      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        const message = (err as Error)?.message || 'unknown error';

        if (status === 401 || status === 403) {
          // Invalid credentials — do not retry
          console.error(`[TokenManager] Login ${key} RECHAZADO (${status}): credenciales incorrectas`);
          return null;
        }

        console.warn(`[TokenManager] Login ${key} falló (intento ${attempt}/${MAX_LOGIN_RETRIES}): ${message}`);

        if (attempt < MAX_LOGIN_RETRIES) {
          await this.sleep(LOGIN_RETRY_DELAY_MS);
        }
      }
    }

    console.error(`[TokenManager] Login ${key} falló después de ${MAX_LOGIN_RETRIES} intentos`);
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
    // Fallback to default credentials
    return { email: this.defaultEmail, password: this.defaultPassword };
  }

  private isExpiringSoon(cached: CachedToken): boolean {
    return cached.expiresAt - Date.now() < REFRESH_MARGIN_MS;
  }

  private async renewExpiringTokens(): Promise<void> {
    // 1. Renew the superuser token first (if expiring soon)
    const defaultCached = this.tokens.get('default');
    if (defaultCached && this.isExpiringSoon(defaultCached)) {
      const minutesLeft = Math.round((defaultCached.expiresAt - Date.now()) / 60_000);
      console.log(`[TokenManager] Token superusuario expira en ${minutesLeft} min — renovando...`);

      const refreshed = await this.tryRefresh('default', defaultCached.jwt);
      if (!refreshed) {
        await this.login('default');
      }
    }

    // 2. Renew company tokens
    for (const [key, cached] of this.tokens) {
      if (key === 'default') continue; // already renewed above

      if (this.isExpiringSoon(cached)) {
        const minutesLeft = Math.round((cached.expiresAt - Date.now()) / 60_000);
        console.log(`[TokenManager] Token ${key} expira en ${minutesLeft} min — renovando...`);

        const companyId = Number(key);

        if (this.switchCompanyTargets.has(companyId)) {
          // Switch-company: use the superuser token
          const baseJwt = this.tokens.get('default')?.jwt;
          if (baseJwt) {
            await this.doSwitchCompany(baseJwt, companyId);
          } else {
            console.warn(`[TokenManager] No hay token superusuario para renovar compañía ${key}`);
          }
        } else {
          // Company with own credentials: refresh or login
          const refreshed = await this.tryRefresh(key, cached.jwt);
          if (!refreshed) {
            await this.login(key);
          }
        }
      }
    }
  }

  /** Calls POST /api/auth/switch-company to get a JWT for the target companyId using the superuser JWT. */
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
        console.error(`[TokenManager] switch-company ${targetCompanyId}: respuesta sin token`);
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
      console.log(`[TokenManager] switch-company ${targetCompanyId} OK — token válido por ${minutesLeft} min`);
      return jwt;

    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const message = (err as Error)?.message || 'unknown error';
      console.error(`[TokenManager] switch-company ${targetCompanyId} falló (${status || 'network'}): ${message}`);
      return null;
    }
  }

  /** Attempts token renewal via POST /auth/refresh. Requires non-expired current token. */
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
        console.warn(`[TokenManager] Refresh ${key}: respuesta sin token`);
        return false;
      }

      const expiresAt = this.decodeJwtExp(newJwt);
      this.tokens.set(key, {
        jwt: newJwt,
        expiresAt,
        obtainedAt: Date.now(),
      });

      const minutesLeft = Math.round((expiresAt - Date.now()) / 60_000);
      console.log(`[TokenManager] Refresh ${key} OK — nuevo token válido por ${minutesLeft} min`);
      return true;

    } catch (err: unknown) {
      const message = (err as Error)?.message || 'unknown error';
      console.warn(`[TokenManager] Refresh ${key} falló: ${message} — haré login completo`);
      return false;
    }
  }

  /** Decodes the `exp` field from a JWT (without verifying the signature). Returns timestamp in ms. */
  private decodeJwtExp(jwt: string): number {
    try {
      const payload = jwt.split('.')[1];
      if (!payload) return Date.now() + 24 * 60 * 60 * 1000; // fallback: 24h
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
      if (typeof decoded.exp === 'number') {
        return decoded.exp * 1000; // JWT exp is in seconds
      }
    } catch {
      // ignore decode errors
    }
    // Fallback: assume 24h from now
    return Date.now() + 24 * 60 * 60 * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
