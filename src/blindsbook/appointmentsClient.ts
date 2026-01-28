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

