export type AppointmentType = 0 | 1 | 2; // 0=Quote, 1=Install, 2=Repair
export type AppointmentStatus = 0 | 1 | 2; // 0=Pending, 1=Attended, 2=Canceled

export interface CreateAppointmentPayload {
  customerId: number;
  type: AppointmentType;
  startDate: string; // ISO 8601
  status?: AppointmentStatus;
  duration?: string; // HH:MM:SS
  userId?: number;
  saleOrderId?: number;
  installationContactId?: number;
  remarks?: string;
}

export interface Appointment extends CreateAppointmentPayload {
  id: number;
}

