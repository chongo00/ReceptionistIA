import axios from 'axios';
import type { CreateAppointmentPayload, Appointment } from '../models/appointments.js';
import type { CustomerMatch } from '../dialogue/state.js';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const api = axios.create({
  // La API NestJS expone rutas bajo /api (ver swagger: /api-docs-json)
  baseURL: `${env.blindsbookApiBaseUrl.replace(/\/$/, '')}/api`,
  timeout: 10_000,
});

let cachedToken: string | null = null;
let currentTokenOverride: string | null = null;

export function setTokenForCompany(token: string): void {
  currentTokenOverride = token;
}

export function clearTokenOverride(): void {
  currentTokenOverride = null;
}

async function getBearerToken(): Promise<string | null> {
  // 1) Prefer token override (por número Twilio)
  if (currentTokenOverride) return currentTokenOverride;

  // 2) Prefer token fijo si está configurado
  if (env.blindsbookApiToken) return env.blindsbookApiToken;

  // 3) Si ya hicimos login en runtime, reutilizar
  if (cachedToken) return cachedToken;

  // 4) Auto-login opcional (para desarrollo): POST /api/auth/login
  if (env.blindsbookLoginEmail && env.blindsbookLoginPassword) {
    const res = await api.post<{
      success: boolean;
      data?: { token?: string };
    }>('/auth/login', {
      email: env.blindsbookLoginEmail,
      password: env.blindsbookLoginPassword,
    });

    const token = res.data?.data?.token;
    if (token) {
      cachedToken = token;
      return token;
    }
  }

  return null;
}

api.interceptors.request.use((config) => {
  const headers = config.headers ?? {};
  config.headers = headers;
  return config;
});

// ─── Helpers ───

function normalizePhoneForSearch(phone: string): string {
  return phone.replace(/[\s\-\(\)\.\+]/g, '');
}

function mapCustomer(c: RawCustomer): CustomerMatch {
  return {
    id: (c.id ?? c.Id) as number,
    firstName: (c.firstName ?? c.FirstName ?? null) as string | null,
    lastName: (c.lastName ?? c.LastName ?? null) as string | null,
    companyName: (c.companyName ?? c.CompanyName ?? null) as string | null,
    phone: (c.phone ?? c.Phone ?? null) as string | null,
    accountManagerId: (c.accountManagerId ?? c.AccountManagerId ?? null) as number | null,
  };
}

type RawCustomer = Record<string, unknown>;

// ─── Appointments ───

export async function createAppointment(
  payload: CreateAppointmentPayload,
): Promise<Appointment> {
  const token = await getBearerToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await api.post<Appointment>('/appointments', payload, { headers });
  return response.data;
}

// ─── Customer search (retorna array completo) ───

type CustomersListResponse = {
  success: boolean;
  data?: {
    customers?: RawCustomer[];
    data?: RawCustomer[];
    count?: number;
    page?: number;
    pageSize?: number;
    total?: number;
    totalPages?: number;
  };
};

export async function findCustomersBySearch(
  search: string,
  pageSize = 5,
): Promise<CustomerMatch[]> {
  const term = search.trim();
  if (!term) return [];

  const token = await getBearerToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await api.get<CustomersListResponse>('/customers', {
    params: { search: term, page: 1, pageSize },
    headers,
  });

  const raw = response.data?.data?.customers ?? response.data?.data?.data ?? [];
  return raw.map(mapCustomer);
}

/** Retrocompatibilidad: retorna solo el primer ID */
export async function findCustomerIdBySearch(
  search: string,
): Promise<number | null> {
  const matches = await findCustomersBySearch(search, 5);
  return matches.length > 0 ? matches[0]!.id : null;
}

// ─── Búsqueda por teléfono (Caller ID) ───

export async function findCustomersByPhone(
  phone: string,
): Promise<CustomerMatch[]> {
  const normalized = normalizePhoneForSearch(phone);
  if (normalized.length < 3) return [];
  return findCustomersBySearch(normalized, 5);
}

// ─── Team members (vendedores/asesores) ───

type TeamListResponse = {
  success: boolean;
  data?: {
    members?: Array<Record<string, unknown>>;
    data?: Array<Record<string, unknown>>;
  };
};

export interface TeamMemberMatch {
  id: number;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
}

export async function searchTeamMembers(
  search: string,
): Promise<TeamMemberMatch[]> {
  const term = search.trim();
  if (!term) return [];

  const token = await getBearerToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await api.get<TeamListResponse>('/team/members', {
    params: { search: term, page: 1, pageSize: 5 },
    headers,
  });

  const raw = response.data?.data?.members ?? response.data?.data?.data ?? [];
  return raw.map((m) => {
    const firstName = (m.firstName ?? m.FirstName ?? '') as string;
    const lastName = (m.lastName ?? m.LastName ?? '') as string;
    return {
      id: (m.id ?? m.Id) as number,
      firstName: firstName || null,
      lastName: lastName || null,
      displayName: `${firstName} ${lastName}`.trim() || String(m.username ?? m.Username ?? ''),
    };
  });
}

// ─── Crear cliente nuevo ───

export async function createNewCustomer(
  firstName: string,
  lastName: string,
  phone: string,
): Promise<{ id: number }> {
  const token = await getBearerToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await api.post<{ success: boolean; data?: { id: number } }>(
    '/customers',
    { firstName, lastName, phone },
    { headers },
  );
  const id = response.data?.data?.id ?? (response.data as unknown as { id: number })?.id;
  if (!id) throw new Error('Failed to create customer: no id returned');
  return { id };
}

// ─── Buscar clientes filtrados por AccountManagerId ───

export async function findCustomersByAccountManager(
  search: string,
  accountManagerId: number,
): Promise<CustomerMatch[]> {
  // Usamos la búsqueda general y filtramos en cliente por accountManagerId
  const all = await findCustomersBySearch(search, 20);
  return all.filter((c) => c.accountManagerId === accountManagerId);
}
