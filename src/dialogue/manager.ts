import type { ConversationState } from './state.js';
import { createInitialState } from './state.js';

export interface DialogueTurnResult {
  state: ConversationState;
  replyText: string;
  isFinished: boolean;
}

// En memoria para ejemplo; en producción usar Redis u otro almacén
const conversationStore = new Map<string, ConversationState>();

export function getConversationState(callId: string): ConversationState {
  let state = conversationStore.get(callId);
  if (!state) {
    state = createInitialState(callId);
    conversationStore.set(callId, state);
  }
  return state;
}

export function setConversationState(
  callId: string,
  state: ConversationState,
): void {
  conversationStore.set(callId, state);
}

export function clearConversationState(callId: string): void {
  conversationStore.delete(callId);
}

export function handleUserInput(
  callId: string,
  userText: string | null,
): DialogueTurnResult {
  const trimmed = (userText || '').trim();
  let state = getConversationState(callId);

  switch (state.step) {
    case 'greeting': {
      state = { ...state, step: 'askType' };
      const replyText =
        'Bienvenido a BlindsBook. Te ayudaré a agendar una cita. ¿La visita es para una cotización, instalación o reparación?';
      return { state, replyText, isFinished: false };
    }
    case 'askType': {
      const lower = trimmed.toLowerCase();
      let typeText = '';
      if (lower.includes('coti')) {
        state = { ...state, type: 0, step: 'askCustomer' };
        typeText = 'cotización';
      } else if (lower.includes('instal')) {
        state = { ...state, type: 1, step: 'askCustomer' };
        typeText = 'instalación';
      } else if (lower.includes('repar')) {
        state = { ...state, type: 2, step: 'askCustomer' };
        typeText = 'reparación';
      } else {
        return {
          state,
          replyText:
            'No he entendido el tipo de cita. ¿Es para cotización, instalación o reparación?',
          isFinished: false,
        };
      }

      const replyText = `Perfecto, agendaremos una cita de ${typeText}. ¿A nombre de qué cliente debe quedar la cita? Puedes decirme el nombre completo.`;
      return { state, replyText, isFinished: false };
    }
    case 'askCustomer': {
      if (!trimmed) {
        return {
          state,
          replyText:
            'No escuché el nombre del cliente. Por favor dime el nombre completo.',
          isFinished: false,
        };
      }

      state = {
        ...state,
        customerNameSpoken: trimmed,
        step: 'askDate',
      };
      const replyText =
        'Gracias. ¿Para qué día quieres la cita? Por favor indica la fecha, por ejemplo “el próximo lunes a las 10 de la mañana”.';
      return { state, replyText, isFinished: false };
    }
    case 'askDate': {
      // Aquí idealmente llamaríamos a IA externa para extraer fecha/hora;
      // por ahora solo avanzamos y pedimos la hora explícita.
      state = { ...state, step: 'askTime' };
      const replyText =
        'Perfecto. Ahora dime la hora exacta de la cita, por ejemplo “a las 10 de la mañana”.';
      return { state, replyText, isFinished: false };
    }
    case 'askTime': {
      // En una implementación real se convertiría a startDateISO.
      // Para este esqueleto asumimos que se resolverá más adelante
      // y pasamos a confirmación básica.
      state = { ...state, step: 'askDuration' };
      const replyText =
        'Anotaré la cita con una duración estándar de 1 hora. Si quieres otra duración, dime cuánto tiempo aproximado requiere; si no, di “está bien”.';
      return { state, replyText, isFinished: false };
    }
    case 'askDuration': {
      const lower = trimmed.toLowerCase();
      let duration = state.duration ?? '01:00:00';
      if (lower.includes('media hora') || lower.includes('30')) {
        duration = '00:30:00';
      } else if (lower.includes('dos horas') || lower.includes('2 horas')) {
        duration = '02:00:00';
      }

      state = { ...state, duration, step: 'confirmSummary' };
      const replyText =
        'Perfecto. Voy a confirmar los datos y luego crearé tu cita en el sistema.';
      return { state, replyText, isFinished: false };
    }
    case 'confirmSummary': {
      state = { ...state, step: 'creatingAppointment' };
      const replyText =
        'Ahora crearé tu cita en el sistema BlindsBook. Un momento por favor.';
      return { state, replyText, isFinished: false };
    }
    case 'creatingAppointment': {
      state = { ...state, step: 'completed' };
      const replyText =
        'Tu cita ha sido registrada. Recibirás la confirmación en tu aplicación o por el canal habitual de la empresa. Gracias por llamar a BlindsBook.';
      return { state, replyText, isFinished: true };
    }
    default: {
      const replyText =
        'Gracias por comunicarte con BlindsBook. Vamos a empezar de nuevo. ¿La visita es para cotización, instalación o reparación?';
      state = createInitialState(callId);
      state.step = 'askType';
      return { state, replyText, isFinished: false };
    }
  }
}

