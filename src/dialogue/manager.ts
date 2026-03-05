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
  naturalConfirmation,
  naturalTransition,
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
  audioBase64?: string;
}

// In-memory store — swap with Redis for multi-instance production
const conversationStore = new Map<string, ConversationState>();

export function getConversationState(callId: string): ConversationState {
  let state = conversationStore.get(callId);
  if (!state) {
    state = createInitialState(callId);
    conversationStore.set(callId, state);
  }
  return state;
}

export function setConversationState(callId: string, state: ConversationState): void {
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
  return parts.join(' ') || match.companyName || `Customer #${match.id}`;
}

function phoneLastDigits(phone: string | null, digits = 4): string {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  return clean.length > digits ? clean.slice(-digits) : clean;
}

const MAX_ID_ATTEMPTS = 3;
const MAX_DISAMBIG_DISPLAY = 3;
const LLM_STEP_TIMEOUT_MS = 5000;
const SEARCH_STEP_TIMEOUT_MS = 6000;
const PHONE_LOOKUP_TIMEOUT_MS = 6000;

// Race a promise with un timeout, devolviendo el fallback si expira
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
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

      // ── Language selection ──────────────────────────────────────────
      case 'askLanguage': {
        const lower = trimmed.toLowerCase();
        if (trimmed === '1' || lower.includes('español') || lower.includes('spanish')) {
          state = { ...state, language: 'es', step: 'identifyByCallerId' };
        } else if (trimmed === '2' || lower.includes('english') || lower.includes('inglés') || lower.includes('ingles')) {
          state = { ...state, language: 'en', step: 'identifyByCallerId' };
        } else {
          return { state, replyText: 'Para español, presione 1. For English, press 2.', isFinished: false };
        }
        return run();
      }

      // ── Caller ID lookup ───────────────────────────────────────────
      case 'identifyByCallerId': {
        const phone = state.callerPhone;

        if (!phone) {
          state = { ...state, step: 'askCustomerName' };
          return {
            state,
            replyText: t(
              '¡Hola! Bienvenido a BlindsBook, soy Sara, tu asistente virtual. ¿Me podrías dar tu nombre completo o el número de teléfono con el que te registraste?',
              "Hey there! Welcome to BlindsBook, I'm Sarah, your virtual assistant. Could you give me your full name or the phone number you registered with?",
            ),
            isFinished: false,
          };
        }

        console.log(`[Identify] Phone lookup: ${phone}`);

        let matches: CustomerMatch[] = [];
        try {
          matches = await withTimeout(findCustomersByPhone(phone), PHONE_LOOKUP_TIMEOUT_MS, []);
          console.log(`[Identify] Phone lookup: ${matches.length} matches`);
        } catch (err) {
          console.warn('[Identify] Phone lookup failed:', err);
        }

        if (matches.length === 1) {
          const match = matches[0]!;
          const name = customerDisplayName(match);
          state = {
            ...state,
            customerId: match.id,
            customerConfirmedName: name,
            customerNameSpoken: name,
            userId: match.accountManagerId ?? state.userId,
            step: 'greeting',
          };
          const greeting = t(pick(GREETINGS_ES).replace('{name}', name), pick(GREETINGS_EN).replace('{name}', name));
          return { state, replyText: `${greeting} ${t(pick(HOW_CAN_HELP_ES), pick(HOW_CAN_HELP_EN))}`, isFinished: false };
        }

        if (matches.length > 1 && matches.length <= 5) {
          state = { ...state, customerMatches: matches, step: 'disambiguateCustomer' };
          const listing = matches.slice(0, MAX_DISAMBIG_DISPLAY)
            .map((m, i) => {
              const name = customerDisplayName(m);
              const tail = phoneLastDigits(m.phone);
              return `${i + 1}. ${name}${tail ? ` (tel. ***${tail})` : ''}`;
            }).join('\n');
          return {
            state,
            replyText: t(
              `Encontré varias cuentas con ese número:\n${listing}\n¿Me podrías decir tu nombre para saber cuál eres?`,
              `I found a few accounts with that number:\n${listing}\nCould you tell me your name so I know which one is you?`,
            ),
            isFinished: false,
          };
        }

        state = { ...state, step: 'askCustomerName' };
        return {
          state,
          replyText: t(
            '¡Hola! Bienvenido a BlindsBook, soy Sara. ¿Me podrías dar tu nombre completo o el número con el que te registraste?',
            "Hey! Welcome to BlindsBook, I'm Sarah. Could you give me your full name or the phone number you registered with?",
          ),
          isFinished: false,
        };
      }

      // ── Disambiguate multiple customers ────────────────────────────
      case 'disambiguateCustomer': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no te escuché bien. ¿Me podrías decir tu nombre completo?`,
              `${pick(SORRY_EN)}, I didn't quite catch that. Could you tell me your full name?`,
            ),
            isFinished: false,
          };
        }

        const llmResult = await llmProcessStep(state, trimmed, buildStepContext(state));

        let numChoice = NaN;
        let nameMatch: CustomerMatch | undefined;

        if (llmResult?.data?.choiceNumber != null) {
          numChoice = Number(llmResult.data.choiceNumber);
        } else if (llmResult?.data?.nameSpoken) {
          const spoken = String(llmResult.data.nameSpoken).toLowerCase();
          nameMatch = state.customerMatches.find((m) => {
            const full = customerDisplayName(m).toLowerCase();
            return full.includes(spoken) || spoken.includes(full);
          });
        }

        // Rule-based fallback
        if (isNaN(numChoice)) {
          numChoice = parseInt(trimmed, 10);
          if (isNaN(numChoice) && !nameMatch) {
            const lower = trimmed.toLowerCase();
            nameMatch = state.customerMatches.find((m) => {
              const full = customerDisplayName(m).toLowerCase();
              return full.includes(lower) || lower.includes(full);
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
            userId: match.accountManagerId ?? state.userId,
            step: 'greeting',
            customerMatches: [],
          };
          return {
            state,
            replyText: llmResult?.reply || t(
              `${naturalConfirmation('es')} ${name}. ${pick(HOW_CAN_HELP_ES)}`,
              `${naturalConfirmation('en')}, ${name}. ${pick(HOW_CAN_HELP_EN)}`,
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
            userId: nameMatch.accountManagerId ?? state.userId,
            customerMatches: [],
            step: 'confirmCustomerIdentity',
          };
          return run();
        }

        if (llmResult && !llmResult.data.choiceNumber && !llmResult.data.nameSpoken) {
          return { state, replyText: llmResult.reply, isFinished: false };
        }

        state = { ...state, customerNameSpoken: trimmed, customerMatches: [], step: 'askCustomerName' };
        return run();
      }

      // ── Ask customer name / search ─────────────────────────────────
      case 'askCustomerName': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no te escuché. ¿Me podrías dar tu nombre completo o el teléfono con el que te registraste?`,
              `${pick(SORRY_EN)}, I didn't catch that. Could you give me your full name or the phone number you registered with?`,
            ),
            isFinished: false,
          };
        }

        console.log(`[CustomerName] Processing: "${trimmed}"`);

        // Launch LLM + API search in parallel for speed
        const [llmResult, rawMatches] = await Promise.all([
          withTimeout(llmProcessStep(state, trimmed, buildStepContext(state)).catch(() => null), LLM_STEP_TIMEOUT_MS, null),
          withTimeout(findCustomersBySearch(trimmed, 5).catch(() => [] as CustomerMatch[]), SEARCH_STEP_TIMEOUT_MS, []),
        ]);

        const searchText = (llmResult?.data?.searchQuery as string) || trimmed;
        state = { ...state, identificationAttempts: state.identificationAttempts + 1 };

        // If LLM detected off-topic (no search query extracted), use its reply
        if (llmResult && !llmResult.data.searchQuery) {
          return { state, replyText: llmResult.reply, isFinished: false };
        }

        // Use raw matches or re-query with LLM-refined term
        let matches: CustomerMatch[] = rawMatches;
        if (searchText.toLowerCase() !== trimmed.toLowerCase() && rawMatches.length === 0) {
          matches = await withTimeout(findCustomersBySearch(searchText, 5).catch(() => []), SEARCH_STEP_TIMEOUT_MS, []);
        }

        if (matches.length === 1) {
          const match = matches[0]!;
          state = { ...state, customerMatches: [match], customerNameSpoken: searchText, step: 'confirmCustomerIdentity' };
          return run();
        }

        if (matches.length > 1) {
          state = { ...state, customerMatches: matches, customerNameSpoken: searchText, step: 'disambiguateCustomer' };
          const listing = matches.slice(0, MAX_DISAMBIG_DISPLAY)
            .map((m, i) => {
              const name = customerDisplayName(m);
              const tail = phoneLastDigits(m.phone);
              return `${i + 1}. ${name}${tail ? ` (tel. ***${tail})` : ''}`;
            }).join('\n');
          return {
            state,
            replyText: t(
              `Encontré varios clientes con ese dato:\n${listing}\n¿Cuál eres tú? Puedes decirme el número o tu nombre completo.`,
              `I found a few customers matching that:\n${listing}\nWhich one are you? You can tell me the number or your full name.`,
            ),
            isFinished: false,
          };
        }

        if (state.identificationAttempts >= MAX_ID_ATTEMPTS) {
          state = { ...state, step: 'llmFallback', customerNameSpoken: searchText };
          return run();
        }

        return {
          state,
          replyText: t(
            `Hmm, no encontré "${searchText}" en el sistema. ¿Podrías intentar con otro nombre, teléfono o email?`,
            `Hmm, I couldn't find "${searchText}" in our system. Could you try a different name, phone number, or email?`,
          ),
          isFinished: false,
        };
      }

      // ── Confirm identified customer ────────────────────────────────
      case 'confirmCustomerIdentity': {
        const match = state.customerMatches[0];
        if (!match) {
          state = { ...state, step: 'askCustomerName' };
          return run();
        }

        const name = customerDisplayName(match);

        // First time entering this step — ask the question
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `Encontré a ${name} en el sistema. ¿Eres tú?`,
              `I found ${name} in the system. Is that you?`,
            ),
            isFinished: false,
          };
        }

        const llmConfirm = await llmProcessStep(state, trimmed, buildStepContext(state));
        let isYes = false;
        let isNo = false;

        if (llmConfirm?.data?.confirmed === true) {
          isYes = true;
        } else if (llmConfirm?.data?.confirmed === false) {
          isNo = true;
        } else {
          const lower = trimmed.toLowerCase();
          isYes = /\b(s[ií]|yes|correct[oa]?|ok|soy yo|that'?s me|exacto|afirmativo)\b/.test(lower);
          isNo = /\b(no|not me|otr[oa]|nope)\b/.test(lower);
        }

        if (isYes) {
          state = {
            ...state,
            customerId: match.id,
            customerConfirmedName: name,
            customerNameSpoken: name,
            userId: match.accountManagerId ?? state.userId,
            customerMatches: [],
            step: 'greeting',
          };
          return {
            state,
            replyText: t(
              `${naturalConfirmation('es')} ${name}! ${pick(HOW_CAN_HELP_ES)}`,
              `${naturalConfirmation('en')}, ${name}! ${pick(HOW_CAN_HELP_EN)}`,
            ),
            isFinished: false,
          };
        }

        if (isNo) {
          state = {
            ...state,
            customerMatches: [],
            identificationAttempts: state.identificationAttempts + 1,
            step: state.identificationAttempts >= MAX_ID_ATTEMPTS - 1 ? 'llmFallback' : 'askCustomerName',
          };
          if (state.step === 'llmFallback') return run();
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)} la confusión. ¿Me podrías dar tu nombre exacto como aparece registrado?`,
              `${pick(SORRY_EN)} for the mix-up. Could you give me your exact name as it's registered?`,
            ),
            isFinished: false,
          };
        }

        return {
          state,
          replyText: t(`¿Eres ${name}? Dime "sí" o "no".`, `Are you ${name}? Just say "yes" or "no".`),
          isFinished: false,
        };
      }

      // ── LLM agent fallback for identification ──────────────────────
      case 'llmFallback': {
        const isFirstEntry = state.llmConversationHistory.length === 0;
        const userInput = isFirstEntry ? '' : trimmed;

        let result;
        try {
          result = await runIdentificationAgent(state, userInput);
        } catch (err) {
          console.error('[LLM Agent] Error:', err);
          state = { ...state, step: 'askCustomerName' };
          return {
            state,
            replyText: t(
              'Ay, disculpa, estoy teniendo un problema técnico. ¿Me podrías dar tu nombre completo para registrarte como cliente nuevo?',
              "Oh, sorry about that — I'm having a technical hiccup. Could you give me your full name so I can register you as a new customer?",
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
                'No logré identificarte, pero no te preocupes. Te voy a pasar con un compañero del equipo que te puede ayudar directamente. Gracias por tu paciencia.',
                "I wasn't able to find your account, but don't worry. I'll connect you with a team member who can help directly. Thanks for your patience.",
              ),
              isFinished: true,
            };
          }

          if (result.customerId) {
            const name = result.customerName || state.customerNameSpoken || '';
            state = { ...state, customerId: result.customerId, customerConfirmedName: name, customerNameSpoken: name, llmConversationHistory: [], step: 'greeting' };
            return {
              state,
              replyText: result.replyText || t(
                `¡Te encontré, ${name}! ¿En qué te puedo ayudar hoy?`,
                `Found you, ${name}! What can I help you with today?`,
              ),
              isFinished: false,
            };
          }
        }

        return { state, replyText: result.replyText, isFinished: false };
      }

      // ── Greeting (customer identified, ask what they need) ─────────
      case 'greeting': {
        if (trimmed) {
          const llm = await llmProcessStep(state, trimmed, buildStepContext(state));

          // User may have mentioned type + date in one sentence
          if (llm && llm.data.appointmentType != null) {
            const aType = Number(llm.data.appointmentType);
            if ([0, 1, 2].includes(aType)) {
              state = { ...state, type: aType as 0 | 1 | 2, askedAboutType: true };

              if (llm.data.dateText) {
                const parsed = parseDateTimeFromText(llm.data.dateText as string, state.language);
                if (parsed) {
                  state = { ...state, startDateISO: parsed.iso, askedAboutDate: true };
                  state = { ...state, step: parsed.hasTime ? 'askDuration' : 'askTime' };
                  return { state, replyText: llm.reply, isFinished: false };
                }
              }

              state = { ...state, step: 'askDate' };
              return { state, replyText: llm.reply, isFinished: false };
            }
          }

          if (llm?.data.wantsAppointment) {
            state = { ...state, step: 'askType', askedAboutType: true };
            let reply = llm.reply;
            const mentionsOptions = /cotización|instalación|reparación|quote|installation|repair/i.test(reply);
            if (!mentionsOptions) {
              reply += ' ' + t('¿Es para cotización, instalación o reparación?', 'Is this for a quote, installation, or repair?');
            }
            return { state, replyText: reply, isFinished: false };
          }

          if (llm) {
            const hintType = /cotización|instalación|quote|installation/i.test(llm.reply);
            if (hintType) state = { ...state, step: 'askType', askedAboutType: true };
            return { state, replyText: llm.reply, isFinished: false };
          }

          state = { ...state, step: 'askType' };
          return run();
        }

        // No input yet — proactively move to type selection
        state = { ...state, step: 'askType', askedAboutType: true };
        return {
          state,
          replyText: t(
            `${maybeFiller('es')}Con gusto te ayudo. ¿Qué tipo de cita necesitas: cotización, instalación o reparación?`,
            `${maybeFiller('en')}Happy to help! What kind of appointment do you need: quote, installation, or repair?`,
          ),
          isFinished: false,
        };
      }

      // ── Ask appointment type ───────────────────────────────────────
      case 'askType': {
        if (!trimmed) {
          state = { ...state, silenceCount: (state.silenceCount || 0) + 1 };

          if (state.silenceCount === 1) {
            return { state, replyText: t('¿Sigues ahí? ¿Qué tipo de cita necesitas?', 'Still there? What type of appointment do you need?'), isFinished: false };
          }
          if (state.silenceCount === 2) {
            return { state, replyText: t('Tenemos cotización, instalación y reparación. ¿Cuál te interesa?', 'We offer quotes, installations, and repairs. Which one are you looking for?'), isFinished: false };
          }
          return {
            state,
            replyText: t(
              'Si tienes problemas de audio, puedes escribirme. Estoy aquí cuando estés listo.',
              "If you're having audio issues, you can type to me. I'm here whenever you're ready.",
            ),
            isFinished: false,
          };
        }

        state = { ...state, silenceCount: 0 };

        const llmType = await llmProcessStep(state, trimmed, buildStepContext(state));
        if (llmType?.data?.appointmentType != null) {
          const aType = Number(llmType.data.appointmentType);
          if ([0, 1, 2].includes(aType)) {
            state = { ...state, type: aType as 0 | 1 | 2, step: 'askDate' };
            return { state, replyText: llmType.reply, isFinished: false };
          }
        }
        if (llmType) {
          let reply = llmType.reply;
          if (!/cotización|instalación|reparación|quote|installation|repair/i.test(reply)) {
            reply += ' ' + t('¿Es cotización, instalación o reparación?', 'Is this a quote, installation, or repair?');
          }
          return { state, replyText: reply, isFinished: false };
        }

        // Rule-based fallback
        const lower = trimmed.toLowerCase();
        let typeText = '';
        if (/coti|quote|precio|price/.test(lower)) {
          state = { ...state, type: 0, step: 'askDate' };
          typeText = t('cotización', 'quote');
        } else if (/instal|nueva|new/.test(lower)) {
          state = { ...state, type: 1, step: 'askDate' };
          typeText = t('instalación', 'installation');
        } else if (/repar|repair|arregl|fix/.test(lower)) {
          state = { ...state, type: 2, step: 'askDate' };
          typeText = t('reparación', 'repair');
        } else {
          return {
            state,
            replyText: t(
              'Déjame explicarte: una COTIZACIÓN es para ver precios sin compromiso, una INSTALACIÓN para cortinas nuevas, y una REPARACIÓN para arreglar las que ya tienes. ¿Cuál necesitas?',
              "Let me break it down: a QUOTE is to check pricing with no commitment, an INSTALLATION is for new blinds, and a REPAIR is to fix existing ones. Which do you need?",
            ),
            isFinished: false,
          };
        }

        const cname = state.customerConfirmedName || '';
        return {
          state,
          replyText: t(
            `${naturalConfirmation('es')}${cname ? `, ${cname}` : ''}. Agendaremos una cita de ${typeText}. ¿Para qué fecha te gustaría? Puedes decir "mañana", "el lunes" o una fecha específica.`,
            `${naturalConfirmation('en')}${cname ? `, ${cname}` : ''}. We'll set up a ${typeText} appointment. What date works for you? You can say "tomorrow", "next Monday", or a specific date.`,
          ),
          isFinished: false,
        };
      }

      // ── Ask date ───────────────────────────────────────────────────
      case 'askDate': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no te escuché. ¿Para qué día quieres la cita?`,
              `${pick(SORRY_EN)}, I didn't catch that. What day would you like the appointment?`,
            ),
            isFinished: false,
          };
        }

        const llmDate = await llmProcessStep(state, trimmed, buildStepContext(state));
        const dateText = (llmDate?.data?.dateText as string) || trimmed;
        const parsed = parseDateTimeFromText(dateText, state.language);

        if (!parsed) {
          if (llmDate && !llmDate.data.dateText) return { state, replyText: llmDate.reply, isFinished: false };
          return {
            state,
            replyText: t(
              'No entendí esa fecha. Puedes decir algo como "mañana", "el próximo lunes" o "20 de febrero".',
              'I didn\'t quite get that date. You can say something like "tomorrow", "next Monday", or "February 20th".',
            ),
            isFinished: false,
          };
        }

        state = { ...state, startDateISO: parsed.iso };

        if (parsed.hasTime) {
          state = { ...state, step: 'askDuration' };
          return {
            state,
            replyText: t(
              `${naturalConfirmation('es')}, la cita será el ${parsed.humanReadable}. Lo estándar es una hora de duración. ¿Te parece bien o prefieres otra duración?`,
              `${naturalConfirmation('en')}, the appointment will be on ${parsed.humanReadable}. Standard duration is one hour. Does that work or would you prefer something different?`,
            ),
            isFinished: false,
          };
        }

        state = { ...state, step: 'askTime' };
        return {
          state,
          replyText: t(
            `${maybeFiller('es')}Anotado, ${parsed.humanReadable}. ¿A qué hora te gustaría? Por ejemplo, "a las 10 de la mañana" o "2 de la tarde".`,
            `${maybeFiller('en')}Got it, ${parsed.humanReadable}. What time works for you? For example, "10 AM" or "2 PM".`,
          ),
          isFinished: false,
        };
      }

      // ── Ask time ───────────────────────────────────────────────────
      case 'askTime': {
        if (!trimmed) {
          return {
            state,
            replyText: t(
              `${pick(SORRY_ES)}, no escuché la hora. ¿A qué hora quieres la cita?`,
              `${pick(SORRY_EN)}, I missed the time. What time would you like?`,
            ),
            isFinished: false,
          };
        }

        const llmTime = await llmProcessStep(state, trimmed, buildStepContext(state));
        const timeText = (llmTime?.data?.timeText as string) || trimmed;
        const baseISO = state.startDateISO ?? new Date().toISOString();
        const merged = mergeTimeIntoDate(baseISO, timeText, state.language);

        if (!merged) {
          if (llmTime && !llmTime.data.timeText) return { state, replyText: llmTime.reply, isFinished: false };
          return {
            state,
            replyText: t(
              'No entendí la hora. Puedes decir algo como "a las 10" o "2 de la tarde".',
              'I didn\'t catch the time. You can say something like "10 AM" or "2 PM".',
            ),
            isFinished: false,
          };
        }

        state = { ...state, startDateISO: merged.iso, step: 'askDuration' };
        if (llmTime?.reply) return { state, replyText: llmTime.reply, isFinished: false };
        return {
          state,
          replyText: t(
            `${naturalConfirmation('es')}, la cita será el ${merged.humanReadable}. La duración estándar es una hora. ¿Está bien o prefieres otra duración?`,
            `${naturalConfirmation('en')}, appointment set for ${merged.humanReadable}. Standard duration is one hour. Sound good, or would you prefer a different length?`,
          ),
          isFinished: false,
        };
      }

      // ── Ask duration ───────────────────────────────────────────────
      case 'askDuration': {
        const llmDur = await llmProcessStep(state, trimmed, buildStepContext(state));
        let duration = state.duration ?? '01:00:00';

        if (llmDur?.data?.duration && typeof llmDur.data.duration === 'string') {
          duration = llmDur.data.duration;
        } else {
          const lower = trimmed.toLowerCase();
          if (/media hora|half hour|30 min/.test(lower)) duration = '00:30:00';
          else if (/dos horas|2 horas|two hours|2 hours/.test(lower)) duration = '02:00:00';
          else if (/hora y media|hour and a half|1\.5|90 min/.test(lower)) duration = '01:30:00';
        }

        state = { ...state, duration, step: 'confirmSummary' };

        const typeStr = typeLabel(state.type, state.language);
        const dateStr = state.startDateISO
          ? new Date(state.startDateISO).toLocaleString(state.language === 'es' ? 'es-ES' : 'en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: state.language === 'en',
            })
          : t('(fecha por confirmar)', '(date TBD)');
        const customerStr = state.customerConfirmedName || state.customerNameSpoken || t('(sin nombre)', '(no name)');

        return {
          state,
          replyText: t(
            `Perfecto, déjame confirmarte los datos:\n• Tipo: ${typeStr}\n• Cliente: ${customerStr}\n• Fecha: ${dateStr}\n• Duración: ${duration}\n¿Todo bien? Dime "sí" para confirmar o "no" para empezar de nuevo.`,
            `Great, let me confirm the details:\n• Type: ${typeStr}\n• Customer: ${customerStr}\n• Date: ${dateStr}\n• Duration: ${duration}\nLook good? Say "yes" to confirm or "no" to start over.`,
          ),
          isFinished: false,
        };
      }

      // ── Confirm appointment summary ────────────────────────────────
      case 'confirmSummary': {
        const llmConfirm = await llmProcessStep(state, trimmed, buildStepContext(state));
        let isYes = false;
        let isNo = false;

        if (llmConfirm?.data?.confirmed === true) isYes = true;
        else if (llmConfirm?.data?.confirmed === false) isNo = true;
        else {
          const lower = trimmed.toLowerCase();
          isYes = /\b(s[ií]|yes|correct[oa]?|ok|bien|confirma)\b/.test(lower);
          isNo = /\b(no|cancel|empez)\b/.test(lower);
        }

        if (isNo) {
          // Preserve customer & session fields; only reset appointment-specific data
          state = {
            ...state,
            step: 'askType',
            type: null,
            startDateISO: null,
            duration: '01:00:00',
            status: 0,
            saleOrderId: null,
            installationContactId: null,
            remarks: null,
            askedAboutType: false,
            askedAboutDate: false,
            askedAboutTime: false,
            lastQuestion: null,
            silenceCount: 0,
          };
          return {
            state,
            replyText: t(
              'Sin problema, empecemos de nuevo. ¿La cita es para cotización, instalación o reparación?',
              "No problem, let's start fresh. Is this for a quote, installation, or repair?",
            ),
            isFinished: false,
          };
        }

        if (!isYes) {
          return {
            state,
            replyText: t(
              '¿Entonces confirmamos? Dime "sí" o "no".',
              'So, shall we confirm? Just say "yes" or "no".',
            ),
            isFinished: false,
          };
        }

        state = { ...state, step: 'creatingAppointment' };
        return {
          state,
          replyText: t(
            `${naturalConfirmation('es')} ${pick(WAIT_ES).replace('...', ',')} estoy registrando tu cita ahora mismo.`,
            `${naturalConfirmation('en')}! ${pick(WAIT_EN).replace('...', ',')} I'm creating your appointment right now.`,
          ),
          isFinished: false,
        };
      }

      // ── Creating appointment (API call) ────────────────────────────
      case 'creatingAppointment': {
        state = { ...state, step: 'completed' };
        const goodbye = t(pick(GOODBYE_ES), pick(GOODBYE_EN));
        return {
          state,
          replyText: t(
            `¡Listo, tu cita quedó registrada! ¿Necesitas algo más? Si no, muchísimas gracias por llamar a BlindsBook. ${goodbye}`,
            `All done — your appointment is set! Anything else I can help with? If not, thanks so much for calling BlindsBook. ${goodbye}`,
          ),
          isFinished: true,
        };
      }

      // ── Fallback / error recovery ──────────────────────────────────
      default: {
        state = createInitialState(callId);
        state.step = 'askLanguage';
        return {
          state,
          replyText: t(
            'Disculpa, tuve un problema. Empecemos de nuevo. ¿La cita es para cotización, instalación o reparación?',
            "Sorry about that, I hit a snag. Let's start over. Is this for a quote, installation, or repair?",
          ),
          isFinished: false,
        };
      }
    }
  };

  return run();
}
