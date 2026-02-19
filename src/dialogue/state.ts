import type { AppointmentType, AppointmentStatus } from '../models/appointments.js';

export type ConversationStep =
  // ── Identificación del cliente (nuevo flujo híbrido) ──
  | 'askLanguage'
  | 'identifyByCallerId'
  | 'disambiguateCustomer'
  | 'askCustomerName'
  | 'confirmCustomerIdentity'
  | 'llmFallback'
  // ── Flujo de cita (existente) ──
  | 'greeting'
  | 'askType'
  | 'askDate'
  | 'askTime'
  | 'askDuration'
  | 'askSaleOrderIfNeeded'
  | 'askInstallationContact'
  | 'askRemarks'
  | 'confirmSummary'
  | 'creatingAppointment'
  | 'completed'
  | 'fallback';

export interface CustomerMatch {
  id: number;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  accountManagerId: number | null;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ConversationState {
  callId: string;
  language: 'es' | 'en';
  step: ConversationStep;

  // ── Identificación del cliente ──
  callerPhone: string | null;
  customerMatches: CustomerMatch[];
  customerConfirmedName: string | null;
  identificationAttempts: number;
  llmConversationHistory: LlmMessage[];

  // ── Datos de la cita ──
  type: AppointmentType | null;
  customerId: number | null;
  customerNameSpoken: string | null;
  startDateISO: string | null;
  duration: string | null;
  status: AppointmentStatus;
  userId: number | null;
  saleOrderId: number | null;
  installationContactId: number | null;
  remarks: string | null;
}

export function createInitialState(callId: string): ConversationState {
  return {
    callId,
    language: 'es',
    step: 'askLanguage',
    // Identificación
    callerPhone: null,
    customerMatches: [],
    customerConfirmedName: null,
    identificationAttempts: 0,
    llmConversationHistory: [],
    // Cita
    type: null,
    customerId: null,
    customerNameSpoken: null,
    startDateISO: null,
    duration: '01:00:00',
    status: 0,
    userId: null,
    saleOrderId: null,
    installationContactId: null,
    remarks: null,
  };
}
