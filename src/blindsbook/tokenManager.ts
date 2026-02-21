/**
 * TokenManager — Gestión automática de JWT para Receptionist IA
 *
 * Problema: Receptionist IA es un sistema de call center automatizado.
 * Nadie se "loguea" manualmente. Los JWT de la API BlindsBook expiran en 24h.
 *
 * Solución (flujo switch-company):
 *   1. Un superusuario (charlie) hace login → obtiene JWT base
 *   2. Para cada compañía objetivo, llama a POST /api/auth/switch-company
 *      → obtiene JWT específico con ese companyId
 *   3. Renovación proactiva: renueva tokens cuando queden < 1h de vida
 *   4. Retry en 401: si una llamada falla por token expirado, re-obtiene token
 *
 * Fallback: si una compañía tiene email/password propios, hace login directo.
 */

import axios from 'axios';

// ─── Tipos ───

export interface CompanyCredentials {
  companyId: number;
  /** Credenciales propias de la compañía (legacy — login directo) */
  email?: string;
  password?: string;
  /** Token estático opcional (fallback si no hay credenciales) */
  token?: string;
}

interface CachedToken {
  jwt: string;
  /** Timestamp (ms) cuando expira */
  expiresAt: number;
  /** Timestamp (ms) cuando fue obtenido */
  obtainedAt: number;
}

// ─── Constantes ───

/** Renovar cuando falte menos de este margen (ms) para expirar */
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // 1 hora antes de expirar

/** Intervalo del timer de renovación proactiva (ms) */
const PROACTIVE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // cada 30 min

/** Máximo de reintentos de login ante errores de red */
const MAX_LOGIN_RETRIES = 3;

/** Delay entre reintentos (ms) */
const LOGIN_RETRY_DELAY_MS = 5_000;

// ─── Clase TokenManager ───

export class TokenManager {
  private apiBaseUrl: string;
  private tokens = new Map<string, CachedToken>(); // key = companyId o "default"
  private credentials = new Map<string, CompanyCredentials>(); // key = companyId
  private defaultEmail: string | null = null;
  private defaultPassword: string | null = null;
  private defaultStaticToken: string | null = null;
  private proactiveTimer: ReturnType<typeof setInterval> | null = null;
  private loginLocks = new Map<string, Promise<string | null>>(); // evitar login concurrentes
  /** CompanyIds registradas que NO tienen credenciales propias → usan switch-company */
  private switchCompanyTargets = new Set<number>();

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
  }

  /**
   * Configura credenciales del superusuario (BLINDSBOOK_LOGIN_EMAIL/PASSWORD).
   * Estas credenciales se usan para login base + switch-company.
   */
  setDefaultCredentials(email: string | null, password: string | null): void {
    this.defaultEmail = email;
    this.defaultPassword = password;
  }

  /**
   * Configura un token estático por defecto (BLINDSBOOK_API_TOKEN).
   * Solo se usa como último fallback si no hay credenciales.
   */
  setDefaultStaticToken(token: string | null): void {
    this.defaultStaticToken = token || null;
  }

  /**
   * Registra una compañía. Si tiene email/password propios → login directo.
   * Si no tiene → se usará switch-company con el superusuario.
   */
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

  /**
   * Obtiene un JWT válido para la compañía dada (o default).
   * Si el token está por expirar o no existe, hace login o switch-company.
   */
  async getToken(companyId?: number): Promise<string | null> {
    const key = companyId ? String(companyId) : 'default';

    // 1. Verificar si hay un token cacheado y válido
    const cached = this.tokens.get(key);
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.jwt;
    }

    // 2. Obtener token fresco
    let freshToken: string | null = null;

    if (companyId && this.switchCompanyTargets.has(companyId)) {
      // Compañía sin credenciales propias → switch-company
      const baseJwt = this.tokens.get('default')?.jwt;
      if (baseJwt) {
        freshToken = await this.doSwitchCompany(baseJwt, companyId);
      }
      // Si switch-company falla y no hay base token, intentar re-login del superusuario
      if (!freshToken && this.defaultEmail && this.defaultPassword) {
        const newBase = await this.login('default');
        if (newBase) {
          freshToken = await this.doSwitchCompany(newBase, companyId);
        }
      }
    } else {
      // Login directo (default o compañía con credenciales propias)
      freshToken = await this.login(key);
    }

    if (freshToken) return freshToken;

    // 3. Si el token cacheado AÚN no expiró (pero está por expirar), usarlo como fallback
    if (cached && cached.expiresAt > Date.now()) {
      console.warn(`[TokenManager] Token para ${key} próximo a expirar, usando mientras se renueva`);
      return cached.jwt;
    }

    // 4. Último fallback: token estático de la compañía o el default
    if (companyId) {
      const creds = this.credentials.get(String(companyId));
      if (creds?.token) return creds.token;
    }
    if (this.defaultStaticToken) return this.defaultStaticToken;

    console.error(`[TokenManager] No se pudo obtener token para ${key}`);
    return null;
  }

  /**
   * Invalida el token de una compañía (forzar re-login en la próxima llamada).
   * Llamar cuando se recibe un 401.
   */
  invalidateToken(companyId?: number): void {
    const key = companyId ? String(companyId) : 'default';
    this.tokens.delete(key);
    console.log(`[TokenManager] Token invalidado para ${key}`);
  }

  /**
   * Inicia el timer de renovación proactiva.
   * Revisa cada 30 min si algún token está por expirar y lo renueva.
   */
  startProactiveRenewal(): void {
    if (this.proactiveTimer) return;

    this.proactiveTimer = setInterval(async () => {
      await this.renewExpiringTokens();
    }, PROACTIVE_CHECK_INTERVAL_MS);

    // También hacer una primera renovación inmediata
    void this.renewExpiringTokens();
    console.log('[TokenManager] Renovación proactiva activada (cada 30 min)');
  }

  /**
   * Detiene el timer de renovación proactiva.
   */
  stopProactiveRenewal(): void {
    if (this.proactiveTimer) {
      clearInterval(this.proactiveTimer);
      this.proactiveTimer = null;
    }
  }

  /**
   * Hace login inicial para todas las compañías registradas + default.
   * Para compañías sin credenciales propias, usa switch-company.
   * Llamar al iniciar el servicio.
   */
  async loginAll(): Promise<void> {
    // 1. Login del superusuario (default)
    if (this.defaultEmail && this.defaultPassword) {
      const baseToken = await this.login('default');
      if (baseToken) {
        console.log('[TokenManager] ✓ Login superusuario OK');
      } else {
        console.warn('[TokenManager] ✗ Login superusuario falló — switch-company no funcionará');
      }
    }

    // 2. Compañías con credenciales propias → login directo
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

    // 3. Compañías sin credenciales → switch-company usando el token del superusuario
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

  // ─── Internos ───

  /**
   * Ejecuta login para un key dado (companyId o "default").
   * Usa un lock para evitar logins concurrentes para la misma key.
   */
  private async login(key: string): Promise<string | null> {
    // Si ya hay un login en progreso para este key, esperar el resultado
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

        // Decodificar exp del JWT
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
          // Credenciales incorrectas → no reintentar
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
    // Fallback a credenciales default
    return { email: this.defaultEmail, password: this.defaultPassword };
  }

  private isExpiringSoon(cached: CachedToken): boolean {
    return cached.expiresAt - Date.now() < REFRESH_MARGIN_MS;
  }

  private async renewExpiringTokens(): Promise<void> {
    // 1. Renovar el token del superusuario primero (si expira pronto)
    const defaultCached = this.tokens.get('default');
    if (defaultCached && this.isExpiringSoon(defaultCached)) {
      const minutesLeft = Math.round((defaultCached.expiresAt - Date.now()) / 60_000);
      console.log(`[TokenManager] Token superusuario expira en ${minutesLeft} min — renovando...`);

      const refreshed = await this.tryRefresh('default', defaultCached.jwt);
      if (!refreshed) {
        await this.login('default');
      }
    }

    // 2. Renovar tokens de compañías
    for (const [key, cached] of this.tokens) {
      if (key === 'default') continue; // ya renovado arriba

      if (this.isExpiringSoon(cached)) {
        const minutesLeft = Math.round((cached.expiresAt - Date.now()) / 60_000);
        console.log(`[TokenManager] Token ${key} expira en ${minutesLeft} min — renovando...`);

        const companyId = Number(key);

        if (this.switchCompanyTargets.has(companyId)) {
          // Compañía switch-company: usar el token del superusuario
          const baseJwt = this.tokens.get('default')?.jwt;
          if (baseJwt) {
            await this.doSwitchCompany(baseJwt, companyId);
          } else {
            console.warn(`[TokenManager] No hay token superusuario para renovar compañía ${key}`);
          }
        } else {
          // Compañía con credenciales propias: refresh o login
          const refreshed = await this.tryRefresh(key, cached.jwt);
          if (!refreshed) {
            await this.login(key);
          }
        }
      }
    }
  }

  /**
   * Llama a POST /api/auth/switch-company para obtener un JWT
   * con el companyId deseado, usando el JWT del superusuario.
   */
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

  /**
   * Intenta renovar un token usando POST /auth/refresh.
   * Requiere que el token actual aún sea válido (no expirado).
   */
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

  /**
   * Decodifica el campo `exp` de un JWT (sin verificar firma).
   * Retorna timestamp en ms.
   */
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
    // Fallback: asumir 24h desde ahora
    return Date.now() + 24 * 60 * 60 * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
