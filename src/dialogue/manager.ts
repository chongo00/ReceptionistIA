import type { ConversationState } from './state.js';
import { createInitialState } from './state.js';
import { findCustomerIdBySearch } from '../blindsbook/appointmentsClient.js';

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
): Promise<DialogueTurnResult> {
  const trimmed = (userText || '').trim();
  let state = getConversationState(callId);

  const t = (es: string, en: string) => (state.language === 'en' ? en : es);

  const run = async (): Promise<DialogueTurnResult> => {
    switch (state.step) {
      case 'askLanguage': {
        const lower = trimmed.toLowerCase();
        if (trimmed === '1' || lower.includes('español') || lower.includes('spanish')) {
          state = { ...state, language: 'es', step: 'greeting' };
        } else if (trimmed === '2' || lower.includes('english') || lower.includes('inglés') || lower.includes('ingles')) {
          state = { ...state, language: 'en', step: 'greeting' };
        } else {
          return {
            state,
            replyText:
              'Para español, presione 1. For English, press 2.',
            isFinished: false,
          };
        }

        return {
          state,
          replyText: t(
            'Perfecto. Bienvenido a BlindsBook.',
            'Great. Welcome to BlindsBook.',
          ),
          isFinished: false,
        };
      }
      case 'greeting': {
        // Si hay input, intentar procesarlo como tipo de cita directamente
        if (trimmed) {
          // Avanzar a askType y procesar el input
          state = { ...state, step: 'askType' };
          // Continuar procesando en askType (recursivo)
          return run();
        }
        // Si no hay input, solo avanzar y preguntar
        state = { ...state, step: 'askType' };
        const replyText = t(
          'Te ayudaré a agendar una cita. ¿La visita es para una cotización, instalación o reparación?',
          'I will help you schedule an appointment. Is this for a quote, installation, or repair?',
        );
        return { state, replyText, isFinished: false };
      }
    case 'askType': {
      const lower = trimmed.toLowerCase();
      let typeText = '';
      if (lower.includes('coti')) {
        state = { ...state, type: 0, step: 'askCustomer' };
        typeText = t('cotización', 'quote');
      } else if (lower.includes('instal')) {
        state = { ...state, type: 1, step: 'askCustomer' };
        typeText = t('instalación', 'installation');
      } else if (lower.includes('repar')) {
        state = { ...state, type: 2, step: 'askCustomer' };
        typeText = t('reparación', 'repair');
      } else if (lower.includes('quote')) {
        state = { ...state, type: 0, step: 'askCustomer' };
        typeText = 'quote';
      } else if (lower.includes('install')) {
        state = { ...state, type: 1, step: 'askCustomer' };
        typeText = 'installation';
      } else if (lower.includes('repair')) {
        state = { ...state, type: 2, step: 'askCustomer' };
        typeText = 'repair';
      } else {
        return {
          state,
          replyText: t(
            'No he entendido el tipo de cita. ¿Es para cotización, instalación o reparación?',
            'Sorry, I did not understand. Is it for a quote, installation, or repair?',
          ),
          isFinished: false,
        };
      }

      const replyText = t(
        `Perfecto, agendaremos una cita de ${typeText}. ¿A nombre de qué cliente debe quedar la cita? Puedes decirme el nombre completo o el teléfono.`,
        `Great, we'll schedule a ${typeText} appointment. What is the customer's name? You can also say the phone number.`,
      );
      return { state, replyText, isFinished: false };
    }
    case 'askCustomer': {
      if (!trimmed) {
        return {
          state,
          replyText: t(
            'No escuché el nombre o teléfono del cliente. Por favor dime el nombre completo o el teléfono.',
            "I didn't catch the customer name or phone. Please tell me the full name or the phone number.",
          ),
          isFinished: false,
        };
      }

      let customerId: number | null = null;
      try {
        customerId = await findCustomerIdBySearch(trimmed);
      } catch {
        // si falla la búsqueda, seguimos con customerId null y pedimos confirmación o reintento
      }

      state = {
        ...state,
        customerNameSpoken: trimmed,
        customerId,
        step: 'askDate',
      };

      const foundMsg = customerId
        ? t('He encontrado al cliente en el sistema.', 'I found the customer in the system.')
        : t(
            'No pude identificar al cliente en el sistema con ese dato. Puedes decirme el nombre exacto como aparece o el teléfono.',
            "I couldn't find that customer in the system. Please tell me the exact name as it appears or the phone number.",
          );

      const replyText = `${foundMsg} ${t(
        '¿Para qué día quieres la cita? Por favor indica la fecha.',
        'What day would you like the appointment? Please tell me the date.',
      )}`;
      return { state, replyText, isFinished: false };
    }
    case 'askDate': {
      // Aquí idealmente llamaríamos a IA externa para extraer fecha/hora;
      // por ahora solo avanzamos y pedimos la hora explícita.
      state = { ...state, step: 'askTime' };
      const replyText = t(
        'Perfecto. Ahora dime la hora exacta de la cita, por ejemplo “a las 10 de la mañana”.',
        'Great. Now tell me the exact time, for example “10 AM”.',
      );
      return { state, replyText, isFinished: false };
    }
    case 'askTime': {
      // En una implementación real se convertiría a startDateISO.
      // Para este esqueleto asumimos que se resolverá más adelante
      // y pasamos a confirmación básica.
      state = { ...state, step: 'askDuration' };
      const replyText = t(
        'Anotaré la cita con una duración estándar de 1 hora. Si quieres otra duración, dime cuánto tiempo requiere; si no, di “está bien”.',
        'I will set the appointment for the standard duration of 1 hour. If you need a different duration, tell me how long; otherwise say “okay”.',
      );
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
      const replyText = t(
        'Perfecto. Voy a confirmar los datos y luego crearé tu cita en el sistema.',
        "Perfect. I'll confirm the details and then create your appointment in the system.",
      );
      return { state, replyText, isFinished: false };
    }
    case 'confirmSummary': {
      state = { ...state, step: 'creatingAppointment' };
      const replyText = t(
        'Ahora crearé tu cita en el sistema BlindsBook. Un momento por favor.',
        "Now I'll create your appointment in BlindsBook. One moment please.",
      );
      return { state, replyText, isFinished: false };
    }
    case 'creatingAppointment': {
      state = { ...state, step: 'completed' };
      const replyText = t(
        'Tu cita ha sido registrada. Gracias por llamar a BlindsBook.',
        'Your appointment has been created. Thank you for calling BlindsBook.',
      );
      return { state, replyText, isFinished: true };
    }
    default: {
      const replyText = t(
        'Gracias por comunicarte con BlindsBook. Vamos a empezar de nuevo. ¿La visita es para cotización, instalación o reparación?',
        "Thanks for contacting BlindsBook. Let's start again. Is this for a quote, installation, or repair?",
      );
      state = createInitialState(callId);
      state.step = 'askLanguage';
      return { state, replyText, isFinished: false };
    }
    }
  };

  return run();
}

