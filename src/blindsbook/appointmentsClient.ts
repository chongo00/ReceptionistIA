import axios from 'axios';
import type { CreateAppointmentPayload, Appointment } from '../models/appointments.js';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const api = axios.create({
  baseURL: env.blindsbookApiBaseUrl,
  timeout: 10_000,
});

api.interceptors.request.use((config) => {
  const headers = config.headers ?? {};
  if (env.blindsbookApiToken) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (headers as any).Authorization = `Bearer ${env.blindsbookApiToken}`;
  }
  config.headers = headers;
  return config;
});

export async function createAppointment(
  payload: CreateAppointmentPayload,
): Promise<Appointment> {
  const response = await api.post<Appointment>('/appointments', payload);
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

  const response = await api.get<CustomersListResponse>('/customers', {
    params: { search: term, page: 1, pageSize: 5 },
  });

  const customers = response.data?.data?.customers ?? [];
  if (customers.length === 0) return null;
  return customers[0]!.id;
}

