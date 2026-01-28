import axios from 'axios';
import type { CreateAppointmentPayload, Appointment } from '../models/appointments.js';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const api = axios.create({
  baseURL: env.blindsbookApiBaseUrl,
  timeout: 10_000,
});

let cachedToken: string | null = null;

async function getBearerToken(): Promise<string | null> {
  // 1) Prefer token fijo si está configurado
  if (env.blindsbookApiToken) return env.blindsbookApiToken;

  // 2) Si ya hicimos login en runtime, reutilizar
  if (cachedToken) return cachedToken;

  // 3) Auto-login opcional (para desarrollo): POST /auth/login
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

export async function createAppointment(
  payload: CreateAppointmentPayload,
): Promise<Appointment> {
  const token = await getBearerToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await api.post<Appointment>('/appointments', payload, { headers });
  return response.data;
}

type CustomersListResponse = {
  success: boolean;
  data?: {
    customers?: Array<{
      id: number;
      firstName?: string | null;
      lastName?: string | null;
      companyName?: string | null;
      email?: string | null;
      phone?: string | null;
    }>;
    count?: number;
    page?: number;
    pageSize?: number;
    total?: number;
    totalPages?: number;
  };
};

export async function findCustomerIdBySearch(
  search: string,
): Promise<number | null> {
  const term = search.trim();
  if (!term) return null;

  const token = await getBearerToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const response = await api.get<CustomersListResponse>('/customers', {
    params: { search: term, page: 1, pageSize: 5 },
    headers,
  });

  const customers = response.data?.data?.customers ?? [];
  if (customers.length === 0) return null;
  return customers[0]!.id;
}

