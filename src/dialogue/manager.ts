import type { ConversationState, CustomerMatch } from './state.js';
import { createInitialState } from './state.js';
import {
  findCustomersByPhone,
  findCustomersBySearch,
  findCustomerIdBySearch,
} from '../blindsbook/appointmentsClient.js';
import { runIdentificationAgent } from '../llm/identificationAgent.js';
import { parseDateTimeFromText, mergeTimeIntoDate } from './dateParser.js';

export interface DialogueTurnResult {
  state: ConversationState;
  replyText: string;
  isFinished: boolean;
  /** Audio MP3 sintetizado (solo se llena en endpoints que lo solicitan) */
  audioBase64?: string;
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

// ─── Helpers ───

function typeLabel(type: number | null, lang: 'es' | 'en'): string {
  if (lang === 'en') return type === 0 ? 'quote' : type === 1 ? 'installation' : 'repair';
  return type === 0 ? 'cotización' : type === 1 ? 'instalación' : 'reparación';
}

function customerDisplayName(match: CustomerMatch): string {
  const parts = [match.firstName, match.lastName].filter(Boolean);
  return parts.join(' ') || match.companyName || `Cliente #${match.id}`;
}

function phoneLastDigits(phone: string | null, digits = 4): string {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  return clean.length > digits ? clean.slice(-digits) : clean;
}

const MAX_IDENTIFICATION_ATTEMPTS = 3;
const MAX_DISAMBIGUATION_DISPLAY = 3;

// ─── Main handler ───

export function handleUserInput(
  callId: string,
  userText: string | null,
): Promise<DialogueTurnResult> {
  const trimmed = (userText || '').trim();
  let state = getConversationState(callId);

  const t = (es: string, en: string) => (state.language === 'en' ? en : es);

  const run = async (): Promise<DialogueTurnResult> => {
    switch (state.step) {
      // ══════════════════════════════════════════
      //  IDIOMA
      // ══════════════════════════════════════════
      case 'askLanguage': {
        const lower = trimmed.toLowerCase();
        if (trimmed === '1' || lower.includes('español') || lower.includes('spanish')) {
          state = { ...state, language: 'es', step: 'identifyByCallerId' };
        } else if (trimmed === '2' || lower.includes('english') || lower.includes('inglés') || lower.includes('ingles')) {
          state = { ...state, language: 'en', step: 'identifyByCallerId' };
        } else {
          return {
            state,
            replyText:
              'Para español, presione 1. For English, press 2.',
            isFinished: false,
          };
        }

        // Ir directamente a identificación por Caller ID (sin esperar input)
        return run();
      }

      // ══════════════════════════════════════════
      //  NIVEL 1: CALLER ID AUTOMÁTICO
      // ══════════════════════════════════════════
      case 'identifyByCallerId': {
        const phone = state.callerPhone;

        // Si no hay caller phone, ir directamente a nivel 2
        if (!phone) {
          state = { ...state, step: 'askCustomerName' };
          return {
            state,
            replyText: t(
              'Bienvenido a BlindsBook. ¿Me podría dar su nombre completo o el número de teléfono con el que se registró?',
              'Welcome to BlindsBook. Could you give me your full name or the phone number you registered with?',
            ),
            isFinished: false,
          };
        }

        // Buscar por teléfono
        let matches: CustomerMatch[] = [];
        try {
          matches = await findCustomersByPhone(phone);
        } catch {
          // Si falla la API, ir a nivel 2
        }

        if (matches.length === 1) {
          // ─── Match único: identificado ───
          const match = matches[0]!;
          const name = customerDisplayName(match);
          state = {
            ...state,
            customerId: match.id,
            customerConfirmedName: name,
            customerNameSpoken: name,
            step: 'greeting',
          };
          return {
            state,
            replyText: t(
              `¡Hola ${name}! Bienvenido de vuelta a BlindsBook. ¿En qué puedo ayudarle hoy?`,
              `Hello ${name}! Welcome back to BlindsBook. How can I help you today?`,
            ),
            isFinished: false,
          };
        }

        if (matches.length > 1 && matches.length <= 5) {
          // ─── Múltiples matches: desambiguar ───
          state = { ...state, customerMatches: matches, step: 'disambiguateCustomer' };
          const nameSummary = matches
            .slice(0, MAX_DISAMBIGUATION_DISPLAY)
            .map((m, i) => {
              const name = customerDisplayName(m);
              const phoneTail = phoneLastDigits(m.phone);
              return `${i + 1}. ${name}${phoneTail ? ` (tel. ***${phoneTail})` : ''}`;
            })
            .join('\n');

          return {
            state,
            replyText: t(
              `Encontré varias cuentas con ese número de teléfono:\n${nameSummary}\n¿Podría decirme su nombre completo para verificar?`,
              `I found multiple accounts with that phone number:\n${nameSummary}\nCould you tell me your full name to verify?`,
            ),
            isFinished: false,
          };
        }

        // ─── 0 matches o +5: ir a nivel 2 ───
        state = { ...state, step: 'askCustomerName' };
        return {
          state,
          replyText: t(
            'Bienvenido a BlindsBook. No reconozco este número de teléfono. ¿Me podría dar su nombre completo o el teléfono con el que se registró?',
            "Welcome to BlindsBook. I don't recognize this phone number. Could you give me your full name or the phone number you registered with?",
          ),
          isFinished: false,
        };
      }

      // ══════════════════════════════════════════
      //  DESAMBIGUAR (múltiples matches)
      // ══════════════════════════════════════════
      case 'disambiguateCustomer': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              'No escuché su respuesta. ¿Podría decirme su nombre completo?',
              "I didn't hear your response. Could you tell me your full name?",
            ),
            isFinished: false,
          };
        }

        const lower = trimmed.toLowerCase();

        // Intentar match por número (1, 2, 3...)
        const numChoice = parseInt(trimmed, 10);
        if (numChoice >= 1 && numChoice <= state.customerMatches.length) {
          const match = state.customerMatches[numChoice - 1]!;
          const name = customerDisplayName(match);
          state = {
            ...state,
            customerId: match.id,
            customerConfirmedName: name,
            customerNameSpoken: name,
            step: 'greeting',
            customerMatches: [],
          };
          return {
            state,
            replyText: t(
              `Perfecto, ${name}. ¿En qué puedo ayudarle hoy?`,
              `Great, ${name}. How can I help you today?`,
            ),
            isFinished: false,
          };
        }

        // Intentar match por nombre dentro de los matches existentes
        const nameMatch = state.customerMatches.find((m) => {
          const fullName = customerDisplayName(m).toLowerCase();
          return fullName.includes(lower) || lower.includes(fullName);
        });

        if (nameMatch) {
          const name = customerDisplayName(nameMatch);
          state = {
            ...state,
            customerId: nameMatch.id,
            customerConfirmedName: name,
            customerNameSpoken: name,
            customerMatches: [],
            step: 'confirmCustomerIdentity',
          };
          return run();
        }

        // No encaja con ninguno de la lista — buscar más amplio
        state = {
          ...state,
          customerNameSpoken: trimmed,
          customerMatches: [],
          step: 'askCustomerName',
        };
        return run();
      }

      // ══════════════════════════════════════════
      //  NIVEL 2: BUSCAR POR NOMBRE/TELÉFONO
      // ══════════════════════════════════════════
      case 'askCustomerName': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              'No escuché el nombre o teléfono. Por favor dígame su nombre completo o el teléfono con el que se registró.',
              "I didn't catch the name or phone. Please tell me your full name or the phone number you registered with.",
            ),
            isFinished: false,
          };
        }

        state = { ...state, identificationAttempts: state.identificationAttempts + 1 };

        let matches: CustomerMatch[] = [];
        try {
          matches = await findCustomersBySearch(trimmed, 5);
        } catch {
          // API error — tratar como 0 matches
        }

        if (matches.length === 1) {
          // ─── 1 match: confirmar identidad ───
          const match = matches[0]!;
          state = {
            ...state,
            customerMatches: [match],
            customerNameSpoken: trimmed,
            step: 'confirmCustomerIdentity',
          };
          return run();
        }

        if (matches.length > 1) {
          // ─── Múltiples: desambiguar ───
          state = { ...state, customerMatches: matches, customerNameSpoken: trimmed, step: 'disambiguateCustomer' };
          const nameSummary = matches
            .slice(0, MAX_DISAMBIGUATION_DISPLAY)
            .map((m, i) => {
              const name = customerDisplayName(m);
              const phoneTail = phoneLastDigits(m.phone);
              return `${i + 1}. ${name}${phoneTail ? ` (tel. ***${phoneTail})` : ''}`;
            })
            .join('\n');

          return {
            state,
            replyText: t(
              `Encontré varios clientes con ese dato:\n${nameSummary}\n¿Cuál es usted? Puede decirme el número o su nombre completo.`,
              `I found several customers matching that:\n${nameSummary}\nWhich one are you? You can tell me the number or your full name.`,
            ),
            isFinished: false,
          };
        }

        // ─── 0 matches ───
        if (state.identificationAttempts >= MAX_IDENTIFICATION_ATTEMPTS) {
          // Agoté intentos — ir a nivel 3 (LLM)
          state = { ...state, step: 'llmFallback', customerNameSpoken: trimmed };
          return run();
        }

        return {
          state,
          replyText: t(
            `No encontré a "${trimmed}" en el sistema. ¿Podría intentar con otro nombre, teléfono o email?`,
            `I couldn't find "${trimmed}" in the system. Could you try with another name, phone number, or email?`,
          ),
          isFinished: false,
        };
      }

      // ══════════════════════════════════════════
      //  CONFIRMAR IDENTIDAD
      // ══════════════════════════════════════════
      case 'confirmCustomerIdentity': {
        const match = state.customerMatches[0];
        if (!match) {
          state = { ...state, step: 'askCustomerName' };
          return run();
        }

        const name = customerDisplayName(match);

        // Si acabamos de llegar (sin input del usuario), preguntar confirmación
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `Encontré a ${name} en el sistema. ¿Es usted?`,
              `I found ${name} in the system. Is that you?`,
            ),
            isFinished: false,
          };
        }

        const lower = trimmed.toLowerCase();
        const isYes = lower.includes('sí') || lower.includes('si') || lower.includes('yes')
          || lower.includes('correcto') || lower.includes('correct') || lower.includes('ok')
          || lower.includes('soy yo') || lower.includes("that's me") || lower.includes('exacto');
        const isNo = lower.includes('no') || lower.includes('not me') || lower.includes('otro');

        if (isYes) {
          state = {
            ...state,
            customerId: match.id,
            customerConfirmedName: name,
            customerNameSpoken: name,
            customerMatches: [],
            step: 'greeting',
          };
          return {
            state,
            replyText: t(
              `Perfecto, ${name}. ¿En qué puedo ayudarle hoy?`,
              `Great, ${name}. How can I help you today?`,
            ),
            isFinished: false,
          };
        }

        if (isNo) {
          state = {
            ...state,
            customerMatches: [],
            identificationAttempts: state.identificationAttempts + 1,
            step: state.identificationAttempts >= MAX_IDENTIFICATION_ATTEMPTS - 1 ? 'llmFallback' : 'askCustomerName',
          };

          if (state.step === 'llmFallback') {
            return run();
          }

          return {
            state,
            replyText: t(
              'Disculpe la confusión. ¿Podría darme su nombre exacto como aparece registrado?',
              'Sorry for the confusion. Could you give me your exact name as registered?',
            ),
            isFinished: false,
          };
        }

        // Respuesta ambigua
        return {
          state,
          replyText: t(
            `¿Es usted ${name}? Diga "sí" o "no".`,
            `Are you ${name}? Say "yes" or "no".`,
          ),
          isFinished: false,
        };
      }

      // ══════════════════════════════════════════
      //  NIVEL 3: LLM FALLBACK (Ollama)
      // ══════════════════════════════════════════
      case 'llmFallback': {
        // Si es la primera entrada al nivel 3, generar respuesta inicial sin input del usuario
        const isFirstEntry = state.llmConversationHistory.length === 0;
        const userInput = isFirstEntry ? '' : trimmed;

        let result;
        try {
          result = await runIdentificationAgent(state, userInput);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('LLM agent error:', err);
          // Fallback directo: ofrecer registrar como nuevo
          state = { ...state, step: 'askCustomerName' };
          return {
            state,
            replyText: t(
              'Disculpe, estoy teniendo problemas técnicos. ¿Me podría dar su nombre completo para registrarlo como cliente nuevo?',
              "I'm sorry, I'm having technical issues. Could you give me your full name so I can register you as a new customer?",
            ),
            isFinished: false,
          };
        }

        state = { ...state, llmConversationHistory: result.updatedHistory };

        if (result.done) {
          if (result.transfer) {
            // No se pudo resolver — informar y terminar
            return {
              state: { ...state, step: 'completed' },
              replyText: result.replyText || t(
                'No pude identificarlo. Lo voy a transferir con un miembro del equipo. Gracias por su paciencia.',
                "I couldn't identify you. I'll transfer you to a team member. Thank you for your patience.",
              ),
              isFinished: true,
            };
          }

          if (result.customerId) {
            // Identificado o creado por el LLM
            const name = result.customerName || state.customerNameSpoken || '';
            state = {
              ...state,
              customerId: result.customerId,
              customerConfirmedName: name,
              customerNameSpoken: name,
              llmConversationHistory: [],
              step: 'greeting',
            };
            return {
              state,
              replyText: result.replyText || t(
                `¡Listo! ${name}, ¿en qué puedo ayudarle hoy?`,
                `All set! ${name}, how can I help you today?`,
              ),
              isFinished: false,
            };
          }
        }

        // El LLM hizo una pregunta — esperar siguiente turno
        return {
          state,
          replyText: result.replyText,
          isFinished: false,
        };
      }

      // ══════════════════════════════════════════
      //  SALUDO (post-identificación)
      // ══════════════════════════════════════════
      case 'greeting': {
        if (trimmed) {
          // El usuario ya dijo algo — intentar parsear como tipo de cita
          state = { ...state, step: 'askType' };
          return run();
        }
        state = { ...state, step: 'askType' };
        const replyText = t(
          'Le ayudaré a agendar una cita. ¿La visita es para una cotización, instalación o reparación?',
          'I will help you schedule an appointment. Is this for a quote, installation, or repair?',
        );
        return { state, replyText, isFinished: false };
      }

      // ══════════════════════════════════════════
      //  TIPO DE CITA
      // ══════════════════════════════════════════
      case 'askType': {
        const lower = trimmed.toLowerCase();
        let typeText = '';
        if (lower.includes('coti') || lower.includes('quote')) {
          state = { ...state, type: 0, step: 'askDate' };
          typeText = t('cotización', 'quote');
        } else if (lower.includes('instal')) {
          state = { ...state, type: 1, step: 'askDate' };
          typeText = t('instalación', 'installation');
        } else if (lower.includes('repar') || lower.includes('repair')) {
          state = { ...state, type: 2, step: 'askDate' };
          typeText = t('reparación', 'repair');
        } else {
          return {
            state,
            replyText: t(
              'Disculpe, no le entendí. ¿La cita es para cotización, instalación o reparación?',
              'Sorry, I did not understand. Is it for a quote, installation, or repair?',
            ),
            isFinished: false,
          };
        }

        const customerName = state.customerConfirmedName || state.customerNameSpoken || '';
        const replyText = t(
          `Perfecto${customerName ? `, ${customerName}` : ''}, agendaremos una cita de ${typeText}. ¿Para qué fecha desea la cita? Por ejemplo, puede decir "mañana", "el lunes" o una fecha específica.`,
          `Great${customerName ? `, ${customerName}` : ''}, we'll schedule a ${typeText} appointment. What date would you like? For example, you can say "tomorrow", "next Monday", or a specific date.`,
        );
        return { state, replyText, isFinished: false };
      }

      // ══════════════════════════════════════════
      //  FECHA
      // ══════════════════════════════════════════
      case 'askDate': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              'No escuché la fecha. ¿Para qué día desea la cita?',
              "I didn't catch the date. What day would you like the appointment?",
            ),
            isFinished: false,
          };
        }

        const parsed = parseDateTimeFromText(trimmed, state.language);

        if (!parsed) {
          return {
            state,
            replyText: t(
              'No pude entender esa fecha. Por favor diga algo como "mañana", "el próximo lunes" o "20 de febrero".',
              'I couldn\'t understand that date. Please say something like "tomorrow", "next Monday", or "February 20th".',
            ),
            isFinished: false,
          };
        }

        state = { ...state, startDateISO: parsed.iso };

        if (parsed.hasTime) {
          state = { ...state, step: 'askDuration' };
          const replyText = t(
            `Perfecto, la cita será el ${parsed.humanReadable}. ¿Cuánto tiempo durará? La duración estándar es una hora. Diga "está bien" para una hora, o indique otra duración.`,
            `Great, the appointment will be on ${parsed.humanReadable}. How long will it be? Standard duration is one hour. Say "okay" for one hour, or specify a different duration.`,
          );
          return { state, replyText, isFinished: false };
        }

        state = { ...state, step: 'askTime' };
        const replyText = t(
          `Bien, anotaré para el ${parsed.humanReadable}. ¿A qué hora desea la cita? Por ejemplo, "a las 10 de la mañana" o "a las 2 de la tarde".`,
          `Okay, I'll note ${parsed.humanReadable}. What time would you like? For example, "10 AM" or "2 PM".`,
        );
        return { state, replyText, isFinished: false };
      }

      // ══════════════════════════════════════════
      //  HORA
      // ══════════════════════════════════════════
      case 'askTime': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              'No escuché la hora. ¿A qué hora desea la cita?',
              "I didn't catch the time. What time would you like?",
            ),
            isFinished: false,
          };
        }

        const baseISO = state.startDateISO ?? new Date().toISOString();
        const merged = mergeTimeIntoDate(baseISO, trimmed, state.language);

        if (!merged) {
          return {
            state,
            replyText: t(
              'No pude entender esa hora. Por favor diga algo como "a las 10" o "2 de la tarde".',
              'I couldn\'t understand that time. Please say something like "10 AM" or "2 PM".',
            ),
            isFinished: false,
          };
        }

        state = { ...state, startDateISO: merged.iso, step: 'askDuration' };
        const replyText = t(
          `Perfecto, la cita será el ${merged.humanReadable}. La duración estándar es una hora. ¿Está bien, o prefiere otra duración?`,
          `Great, the appointment will be on ${merged.humanReadable}. Standard duration is one hour. Is that okay, or would you prefer a different duration?`,
        );
        return { state, replyText, isFinished: false };
      }

      // ══════════════════════════════════════════
      //  DURACIÓN
      // ══════════════════════════════════════════
      case 'askDuration': {
        const lower = trimmed.toLowerCase();
        let duration = state.duration ?? '01:00:00';
        if (lower.includes('media hora') || lower.includes('half hour') || lower.includes('30 min')) {
          duration = '00:30:00';
        } else if (lower.includes('dos horas') || lower.includes('2 horas') || lower.includes('two hours') || lower.includes('2 hours')) {
          duration = '02:00:00';
        } else if (lower.includes('hora y media') || lower.includes('hour and a half') || lower.includes('1.5') || lower.includes('90 min')) {
          duration = '01:30:00';
        }

        state = { ...state, duration, step: 'confirmSummary' };

        const typeStr = typeLabel(state.type, state.language);
        const dateStr = state.startDateISO
          ? new Date(state.startDateISO).toLocaleString(state.language === 'es' ? 'es-ES' : 'en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: state.language === 'en',
            })
          : t('(fecha por confirmar)', '(date to be confirmed)');
        const customerStr = state.customerConfirmedName || state.customerNameSpoken || t('(sin nombre)', '(no name)');

        const replyText = t(
          `Le confirmo los datos de la cita:\n• Tipo: ${typeStr}\n• Cliente: ${customerStr}\n• Fecha: ${dateStr}\n• Duración: ${duration}\n¿Está correcto? Diga "sí" para confirmar o "no" para empezar de nuevo.`,
          `Let me confirm the appointment details:\n• Type: ${typeStr}\n• Customer: ${customerStr}\n• Date: ${dateStr}\n• Duration: ${duration}\nIs this correct? Say "yes" to confirm or "no" to start over.`,
        );
        return { state, replyText, isFinished: false };
      }

      // ══════════════════════════════════════════
      //  CONFIRMACIÓN
      // ══════════════════════════════════════════
      case 'confirmSummary': {
        const lower = trimmed.toLowerCase();
        const isYes = lower.includes('sí') || lower.includes('si') || lower.includes('yes')
          || lower.includes('correcto') || lower.includes('correct') || lower.includes('ok')
          || lower.includes('bien') || lower.includes('confirma');
        const isNo = lower.includes('no') || lower.includes('cancel') || lower.includes('empez');

        if (isNo) {
          const prevLang = state.language;
          state = createInitialState(callId);
          state = { ...state, language: prevLang, step: 'askType' };
          return {
            state,
            replyText: t(
              'De acuerdo, empecemos de nuevo. ¿La cita es para cotización, instalación o reparación?',
              "Alright, let's start over. Is the appointment for a quote, installation, or repair?",
            ),
            isFinished: false,
          };
        }
        if (!isYes) {
          return {
            state,
            replyText: t(
              '¿Confirma los datos? Diga "sí" para confirmar o "no" para empezar de nuevo.',
              'Do you confirm the details? Say "yes" to confirm or "no" to start over.',
            ),
            isFinished: false,
          };
        }

        state = { ...state, step: 'creatingAppointment' };
        const replyText = t(
          'Perfecto, estoy creando su cita en el sistema BlindsBook. Un momento por favor.',
          "Perfect, I'm creating your appointment in BlindsBook. One moment please.",
        );
        return { state, replyText, isFinished: false };
      }

      // ══════════════════════════════════════════
      //  CREACIÓN
      // ══════════════════════════════════════════
      case 'creatingAppointment': {
        state = { ...state, step: 'completed' };
        const replyText = t(
          'Su cita ha sido registrada exitosamente. ¿Hay algo más en lo que pueda ayudarle? Si no, le agradezco su llamada a BlindsBook. ¡Que tenga un excelente día!',
          'Your appointment has been successfully created. Is there anything else I can help you with? If not, thank you for calling BlindsBook. Have a wonderful day!',
        );
        return { state, replyText, isFinished: true };
      }

      // ══════════════════════════════════════════
      //  FALLBACK
      // ══════════════════════════════════════════
      default: {
        const replyText = t(
          'Disculpe, hubo un problema. Vamos a empezar de nuevo. ¿La visita es para cotización, instalación o reparación?',
          "I'm sorry, there was an issue. Let's start again. Is this for a quote, installation, or repair?",
        );
        state = createInitialState(callId);
        state.step = 'askLanguage';
        return { state, replyText, isFinished: false };
      }
    }
  };

  return run();
}
