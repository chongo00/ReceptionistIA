import type { ConversationState, CustomerMatch } from './state.js';
import { createInitialState } from './state.js';
import {
  findCustomersByPhone,
  findCustomersBySearch,
  findCustomerIdBySearch,
} from '../blindsbook/appointmentsClient.js';
import { runIdentificationAgent } from '../llm/identificationAgent.js';
import { parseDateTimeFromText, mergeTimeIntoDate } from './dateParser.js';
import {
  pick,
  maybeFiller,
  GREETINGS_ES, GREETINGS_EN,
  HOW_CAN_HELP_ES, HOW_CAN_HELP_EN,
  PERFECT_ES, PERFECT_EN,
  WAIT_ES, WAIT_EN,
  SORRY_ES, SORRY_EN,
  GOODBYE_ES, GOODBYE_EN,
} from './humanizer.js';
import { llmProcessStep, buildStepContext, isConversationalLlmAvailable } from './conversationalLlm.js';

export interface DialogueTurnResult {
  state: ConversationState;
  replyText: string;
  isFinished: boolean;
  /** Synthesized MP3 audio (only populated by endpoints that request it) */
  audioBase64?: string;
}

// In-memory store; use Redis in production
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

        return run();
      }

      case 'identifyByCallerId': {
        const phone = state.callerPhone;

        if (!phone) {
          state = { ...state, step: 'askCustomerName' };
          return {
            state,
            replyText: t(
              '¡Bienvenido a BlindsBook! Soy su asistente virtual. ¿Me podría dar su nombre completo o el número de teléfono con el que se registró?',
              'Welcome to BlindsBook! I\'m your virtual assistant. Could you give me your full name or the phone number you registered with?',
            ),
            isFinished: false,
          };
        }

        let matches: CustomerMatch[] = [];
        try {
          matches = await findCustomersByPhone(phone);
        } catch {
        }

        if (matches.length === 1) {
          const match = matches[0]!;
          const name = customerDisplayName(match);
          state = {
            ...state,
            customerId: match.id,
            customerConfirmedName: name,
            customerNameSpoken: name,
            step: 'greeting',
          };
          const greeting = t(
            pick(GREETINGS_ES).replace('{name}', name),
            pick(GREETINGS_EN).replace('{name}', name),
          );
          const helpQ = t(pick(HOW_CAN_HELP_ES), pick(HOW_CAN_HELP_EN));
          return {
            state,
            replyText: `${greeting} ${helpQ}`,
            isFinished: false,
          };
        }

        if (matches.length > 1 && matches.length <= 5) {
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

        state = { ...state, step: 'askCustomerName' };
        return {
          state,
          replyText: t(
            '¡Bienvenido a BlindsBook! Soy su asistente virtual. No logré reconocer este número de teléfono. ¿Me podría dar su nombre completo o el número con el que se registró?',
            "Welcome to BlindsBook! I'm your virtual assistant. I wasn't able to recognize this phone number. Could you give me your full name or the number you registered with?",
          ),
          isFinished: false,
        };
      }

      case 'disambiguateCustomer': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no alcancé a escuchar su respuesta. ¿Podría decirme su nombre completo?`,
              `${pick(SORRY_EN)}, I didn't catch your response. Could you tell me your full name?`,
            ),
            isFinished: false,
          };
        }

        // Try LLM to understand choice (number or name)
        const llmDisambig = await llmProcessStep(state, trimmed, buildStepContext(state));

        let numChoice = NaN;
        let nameMatch: CustomerMatch | undefined;

        if (llmDisambig?.data?.choiceNumber != null) {
          numChoice = Number(llmDisambig.data.choiceNumber);
        } else if (llmDisambig?.data?.nameSpoken) {
          const spokenName = String(llmDisambig.data.nameSpoken).toLowerCase();
          nameMatch = state.customerMatches.find((m) => {
            const fullName = customerDisplayName(m).toLowerCase();
            return fullName.includes(spokenName) || spokenName.includes(fullName);
          });
        }

        if (isNaN(numChoice)) {
          // Rule-based fallback: try parsing number or name match
          numChoice = parseInt(trimmed, 10);
          if (isNaN(numChoice) && !nameMatch) {
            const lower = trimmed.toLowerCase();
            nameMatch = state.customerMatches.find((m) => {
              const fullName = customerDisplayName(m).toLowerCase();
              return fullName.includes(lower) || lower.includes(fullName);
            });
          }
        }

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
            replyText: llmDisambig?.reply || t(
              `${pick(PERFECT_ES)}, ${name}. ${pick(HOW_CAN_HELP_ES)}`,
              `${pick(PERFECT_EN)}, ${name}. ${pick(HOW_CAN_HELP_EN)}`,
            ),
            isFinished: false,
          };
        }

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

        // If LLM answered off-topic, return its reply
        if (llmDisambig && !llmDisambig.data.choiceNumber && !llmDisambig.data.nameSpoken) {
          return { state, replyText: llmDisambig.reply, isFinished: false };
        }

        state = {
          ...state,
          customerNameSpoken: trimmed,
          customerMatches: [],
          step: 'askCustomerName',
        };
        return run();
      }

      case 'askCustomerName': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no alcancé a escuchar. ¿Me podría dar su nombre completo o el teléfono con el que se registró?`,
              `${pick(SORRY_EN)}, I didn't quite catch that. Could you give me your full name or the phone number you registered with?`,
            ),
            isFinished: false,
          };
        }

        // ── Launch LLM extraction and raw-text API search IN PARALLEL ────────
        // This saves the full LLM round-trip time on the critical path.
        const [llmName, rawMatches] = await Promise.all([
          llmProcessStep(state, trimmed, buildStepContext(state)).catch(() => null),
          findCustomersBySearch(trimmed, 5).catch(() => [] as CustomerMatch[]),
        ]);

        const searchText = (llmName?.data?.searchQuery as string) || trimmed;

        state = { ...state, identificationAttempts: state.identificationAttempts + 1 };

        // If LLM detected off-topic and couldn't extract searchQuery, show its reply
        if (llmName && !llmName.data.searchQuery) {
          return { state, replyText: llmName.reply, isFinished: false };
        }

        // Use raw matches if searchText === trimmed, otherwise re-query with refined term
        let matches: CustomerMatch[] = rawMatches;
        if (searchText.toLowerCase() !== trimmed.toLowerCase()) {
          try {
            matches = await findCustomersBySearch(searchText, 5);
          } catch {
            matches = rawMatches; // fall back to what we already have
          }
        }

        if (matches.length === 1) {
          const match = matches[0]!;
          state = {
            ...state,
            customerMatches: [match],
            customerNameSpoken: searchText,
            step: 'confirmCustomerIdentity',
          };
          return run();
        }

        if (matches.length > 1) {
          state = { ...state, customerMatches: matches, customerNameSpoken: searchText, step: 'disambiguateCustomer' };
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

        if (state.identificationAttempts >= MAX_IDENTIFICATION_ATTEMPTS) {
          state = { ...state, step: 'llmFallback', customerNameSpoken: searchText };
          return run();
        }

        return {
          state,
          replyText: t(
            `No encontré a "${searchText}" en el sistema. ¿Podría intentar con otro nombre, teléfono o email?`,
            `I couldn't find "${searchText}" in the system. Could you try with another name, phone number, or email?`,
          ),
          isFinished: false,
        };
      }

      case 'confirmCustomerIdentity': {
        const match = state.customerMatches[0];
        if (!match) {
          state = { ...state, step: 'askCustomerName' };
          return run();
        }

        const name = customerDisplayName(match);

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

        // Try LLM for natural yes/no + off-topic handling
        const llmConfirmId = await llmProcessStep(state, trimmed, buildStepContext(state));
        let isYes = false;
        let isNo = false;

        if (llmConfirmId?.data?.confirmed === true) {
          isYes = true;
        } else if (llmConfirmId?.data?.confirmed === false) {
          isNo = true;
        } else {
          // Rule-based fallback
          const lower = trimmed.toLowerCase();
          isYes = lower.includes('sí') || lower.includes('si') || lower.includes('yes')
            || lower.includes('correcto') || lower.includes('correct') || lower.includes('ok')
            || lower.includes('soy yo') || lower.includes("that's me") || lower.includes('exacto');
          isNo = lower.includes('no') || lower.includes('not me') || lower.includes('otro');
        }

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
              `${pick(PERFECT_ES)}, ${name}. ${pick(HOW_CAN_HELP_ES)}`,
              `${pick(PERFECT_EN)}, ${name}. ${pick(HOW_CAN_HELP_EN)}`,
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
              `${pick(SORRY_ES)} la confusión. ¿Podría darme su nombre exacto como aparece registrado?`,
              `${pick(SORRY_EN)} for the confusion. Could you give me your exact name as registered?`,
            ),
            isFinished: false,
          };
        }

        return {
          state,
          replyText: t(
            `¿Es usted ${name}? Diga "sí" o "no".`,
            `Are you ${name}? Say "yes" or "no".`,
          ),
          isFinished: false,
        };
      }

      case 'llmFallback': {
        const isFirstEntry = state.llmConversationHistory.length === 0;
        const userInput = isFirstEntry ? '' : trimmed;

        let result;
        try {
          result = await runIdentificationAgent(state, userInput);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('LLM agent error:', err);
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

        return {
          state,
          replyText: result.replyText,
          isFinished: false,
        };
      }

      case 'greeting': {
        // If user already said something, try LLM to understand intent
        if (trimmed) {
          const llm = await llmProcessStep(state, trimmed, buildStepContext(state));
          if (llm && llm.data.appointmentType != null) {
            const aType = Number(llm.data.appointmentType);
            if ([0, 1, 2].includes(aType)) {
              state = { ...state, type: aType as 0 | 1 | 2, step: 'askDate' };
              return { state, replyText: llm.reply, isFinished: false };
            }
          }
          if (llm && llm.data.wantsAppointment) {
            state = { ...state, step: 'askType' };
            return { state, replyText: llm.reply, isFinished: false };
          }
          if (llm) {
            // Off-topic — LLM answered and steered back
            return { state, replyText: llm.reply, isFinished: false };
          }
          // Fallback: just advance
          state = { ...state, step: 'askType' };
          return run();
        }
        state = { ...state, step: 'askType' };
        const replyText = t(
          `${maybeFiller('es')}Con mucho gusto le ayudaré a agendar una cita. ¿La visita es para una cotización, instalación o reparación?`,
          `${maybeFiller('en')}I'd be happy to help you schedule an appointment. Is this for a quote, installation, or repair?`,
        );
        return { state, replyText, isFinished: false };
      }

      case 'askType': {
        // Try LLM first for natural understanding
        const llmType = await llmProcessStep(state, trimmed, buildStepContext(state));
        if (llmType && llmType.data.appointmentType != null) {
          const aType = Number(llmType.data.appointmentType);
          if ([0, 1, 2].includes(aType)) {
            state = { ...state, type: aType as 0 | 1 | 2, step: 'askDate' };
            return { state, replyText: llmType.reply, isFinished: false };
          }
        }
        if (llmType) {
          // LLM understood but couldn't extract type — user went off-topic, LLM steers back
          return { state, replyText: llmType.reply, isFinished: false };
        }

        // Rule-based fallback
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
              `${pick(SORRY_ES)}, no le entendí bien. ¿La cita es para cotización, instalación o reparación?`,
              `${pick(SORRY_EN)}, I didn't quite understand. Is it for a quote, installation, or repair?`,
            ),
            isFinished: false,
          };
        }

        const customerName = state.customerConfirmedName || state.customerNameSpoken || '';
        const replyText = t(
          `${pick(PERFECT_ES)}${customerName ? `, ${customerName}` : ''}. Agendaremos una cita de ${typeText}. ¿Para qué fecha le gustaría? Puede decir "mañana", "el lunes" o una fecha específica.`,
          `${pick(PERFECT_EN)}${customerName ? `, ${customerName}` : ''}. We'll schedule a ${typeText} appointment. What date works for you? You can say "tomorrow", "next Monday", or a specific date.`,
        );
        return { state, replyText, isFinished: false };
      }

      case 'askDate': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no alcancé a escuchar la fecha. ¿Para qué día le gustaría la cita?`,
              `${pick(SORRY_EN)}, I didn't catch the date. What day would you like the appointment?`,
            ),
            isFinished: false,
          };
        }

        // Try LLM for off-topic handling — the date extraction still uses chrono-node
        const llmDate = await llmProcessStep(state, trimmed, buildStepContext(state));
        const dateTextForParsing = (llmDate?.data?.dateText as string) || trimmed;

        const parsed = parseDateTimeFromText(dateTextForParsing, state.language);

        if (!parsed) {
          // If LLM gave a reply (user was off-topic), use it
          if (llmDate && !llmDate.data.dateText) {
            return { state, replyText: llmDate.reply, isFinished: false };
          }
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
            `${pick(PERFECT_ES)}, la cita será el ${parsed.humanReadable}. ¿Cuánto tiempo durará la visita? Lo estándar es una hora. Diga "está bien" para una hora, o indíqueme otra duración.`,
            `${pick(PERFECT_EN)}, the appointment will be on ${parsed.humanReadable}. How long will it take? Standard duration is one hour. Say "okay" for one hour, or let me know a different duration.`,
          );
          return { state, replyText, isFinished: false };
        }

        state = { ...state, step: 'askTime' };
        const replyText = t(
          `${maybeFiller('es')}Bien, anotaré para el ${parsed.humanReadable}. ¿A qué hora le gustaría? Por ejemplo, "a las 10 de la mañana" o "a las 2 de la tarde".`,
          `${maybeFiller('en')}Okay, I'll note ${parsed.humanReadable}. What time works for you? For example, "10 AM" or "2 PM".`,
        );
        return { state, replyText, isFinished: false };
      }

      case 'askTime': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no alcancé a escuchar la hora. ¿A qué hora le gustaría la cita?`,
              `${pick(SORRY_EN)}, I didn't catch the time. What time would you like?`,
            ),
            isFinished: false,
          };
        }

        // Try LLM to extract time text + handle off-topic
        const llmTime = await llmProcessStep(state, trimmed, buildStepContext(state));
        const timeTextForParsing = (llmTime?.data?.timeText as string) || trimmed;

        const baseISO = state.startDateISO ?? new Date().toISOString();
        const merged = mergeTimeIntoDate(baseISO, timeTextForParsing, state.language);

        if (!merged) {
          // If LLM gave a reply (user was off-topic), use it
          if (llmTime && !llmTime.data.timeText) {
            return { state, replyText: llmTime.reply, isFinished: false };
          }
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
        if (llmTime?.reply) {
          return { state, replyText: llmTime.reply, isFinished: false };
        }
        const replyText = t(
          `${pick(PERFECT_ES)}, la cita será el ${merged.humanReadable}. La duración estándar es una hora. ¿Le parece bien, o prefiere otra duración?`,
          `${pick(PERFECT_EN)}, the appointment will be on ${merged.humanReadable}. Standard duration is one hour. Does that work, or would you prefer a different duration?`,
        );
        return { state, replyText, isFinished: false };
      }

      case 'askDuration': {
        // Try LLM first
        const llmDur = await llmProcessStep(state, trimmed, buildStepContext(state));
        let duration = state.duration ?? '01:00:00';

        if (llmDur?.data?.duration && typeof llmDur.data.duration === 'string') {
          duration = llmDur.data.duration;
        } else {
          // Rule-based fallback
          const lower = trimmed.toLowerCase();
          if (lower.includes('media hora') || lower.includes('half hour') || lower.includes('30 min')) {
            duration = '00:30:00';
          } else if (lower.includes('dos horas') || lower.includes('2 horas') || lower.includes('two hours') || lower.includes('2 hours')) {
            duration = '02:00:00';
          } else if (lower.includes('hora y media') || lower.includes('hour and a half') || lower.includes('1.5') || lower.includes('90 min')) {
            duration = '01:30:00';
          }
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

      case 'confirmSummary': {
        // Try LLM first for natural yes/no understanding
        const llmConfirm = await llmProcessStep(state, trimmed, buildStepContext(state));
        let isYes = false;
        let isNo = false;

        if (llmConfirm?.data?.confirmed === true) {
          isYes = true;
        } else if (llmConfirm?.data?.confirmed === false) {
          isNo = true;
        } else {
          // Rule-based fallback
          const lower = trimmed.toLowerCase();
          isYes = lower.includes('sí') || lower.includes('si') || lower.includes('yes')
            || lower.includes('correcto') || lower.includes('correct') || lower.includes('ok')
            || lower.includes('bien') || lower.includes('confirma');
          isNo = lower.includes('no') || lower.includes('cancel') || lower.includes('empez');
        }

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
          `${pick(PERFECT_ES)}, ${pick(WAIT_ES).replace('...', '.')} Estoy registrando su cita en el sistema BlindsBook.`,
          `${pick(PERFECT_EN)}, ${pick(WAIT_EN).replace('...', '.')} I'm creating your appointment in BlindsBook.`,
        );
        return { state, replyText, isFinished: false };
      }

      case 'creatingAppointment': {
        state = { ...state, step: 'completed' };
        const goodbye = t(pick(GOODBYE_ES), pick(GOODBYE_EN));
        const replyText = t(
          `¡Su cita ha sido registrada exitosamente! ¿Hay algo más en lo que pueda ayudarle? Si no, le agradezco mucho su llamada a BlindsBook. ${goodbye}`,
          `Your appointment has been successfully created! Is there anything else I can help with? If not, thank you so much for calling BlindsBook. ${goodbye}`,
        );
        return { state, replyText, isFinished: true };
      }

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
