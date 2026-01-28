import type { AppointmentType, AppointmentStatus } from '../models/appointments.js';

export type ConversationStep =
  | 'greeting'
  | 'askType'
  | 'askCustomer'
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

export interface ConversationState {
  callId: string;
  language: 'es' | 'en';
  step: ConversationStep;
  // Datos de la cita en construcción
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
    step: 'greeting',
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

