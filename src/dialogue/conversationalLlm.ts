/**
 * Conversational LLM — powers ALL steps of the dialogue with natural language understanding.
 *
 * Instead of hardcoded keyword matching, the LLM:
 *   1. Understands what the user MEANS even if they go off-topic
 *   2. Extracts structured data (type, date, yes/no, name) from natural language
 *   3. Generates human-like responses that guide the user back to the flow
 *   4. Handles unexpected questions gracefully
 *
 * Falls back to rule-based logic if no LLM is available.
 */
import { isAzureOpenAIConfigured, chatWithAzureOpenAI } from '../llm/azureOpenaiClient.js';
import { isOllamaAvailable, chatWithOllama } from '../llm/ollamaClient.js';
import type { ChatMessage, ToolCall } from '../llm/ollamaClient.js';
import type { ConversationState, CustomerMatch } from './state.js';

// ─── Types ───

export interface LlmExtraction {
  /** The natural language reply to say to the user */
  reply: string;
  /** Extracted structured data, if any */
  data: Record<string, unknown>;
}

// ─── LLM availability check (cached for 30s) ───

let _llmAvailableCache: { value: boolean; ts: number } | null = null;
const CACHE_TTL = 30_000;

export async function isConversationalLlmAvailable(): Promise<boolean> {
  if (_llmAvailableCache && Date.now() - _llmAvailableCache.ts < CACHE_TTL) {
    return _llmAvailableCache.value;
  }
  // PERF: skip Ollama availability check (3s HTTP call) when Azure is configured
  const available = isAzureOpenAIConfigured() /* || await isOllamaAvailable() */;
  _llmAvailableCache = { value: available, ts: Date.now() };
  return available;
}

// ─── Core function: ask the LLM to understand + respond ───

/**
 * Send user input + conversation context to the LLM.
 * Returns a natural reply + extracted structured data.
 */
export async function llmProcessStep(
  state: ConversationState,
  userText: string,
  stepContext: StepContext,
): Promise<LlmExtraction | null> {
  const available = await isConversationalLlmAvailable();
  if (!available) return null;

  const systemPrompt = buildStepSystemPrompt(state, stepContext);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText || '(silencio — el usuario no dijo nada)' },
  ];

  try {
    let result: { content: string; toolCalls: ToolCall[] };

    if (isAzureOpenAIConfigured()) {
      result = await chatWithAzureOpenAI(messages);
    } else {
      // PERF: Ollama fallback commented out — using Azure only in production
      // result = await chatWithOllama(messages);
      return null;
    }

    return parseStructuredResponse(result.content);
  } catch (err) {
    console.warn('[ConversationalLLM] Error:', (err as Error).message);
    return null;
  }
}

// ─── Step Context (what the LLM needs to know for each step) ───

export interface StepContext {
  step: string;
  /** What data we need from the user at this step */
  goal: string;
  /** What structured fields to extract */
  extractFields: string;
  /** Extra context (customer name, date so far, etc.) */
  extra?: string;
}

export function buildStepContext(state: ConversationState): StepContext {
  const lang = state.language === 'en' ? 'en' : 'es';
  const customerName = state.customerConfirmedName || state.customerNameSpoken || '';

  switch (state.step) {
    case 'askType':
      return {
        step: 'askType',
        goal: lang === 'es'
          ? 'Determinar si la cita es para COTIZACIÓN (0), INSTALACIÓN (1), o REPARACIÓN (2). Si el usuario no sabe, explica las opciones brevemente y vuelve a preguntar.'
          : 'Determine if appointment is for QUOTE (0), INSTALLATION (1), or REPAIR (2). If user is unsure, briefly explain options and ask again.',
        extractFields: '{"appointmentType": 0|1|2|null}',
        extra: lang === 'es' 
          ? `${customerName ? `Cliente: ${customerName}. ` : ''}Cotización=ver precios sin compromiso, Instalación=poner cortinas nuevas, Reparación=arreglar existentes.`
          : `${customerName ? `Customer: ${customerName}. ` : ''}Quote=pricing without commitment, Installation=new blinds, Repair=fix existing.`,
      };

    case 'askDate':
      return {
        step: 'askDate',
        goal: lang === 'es'
          ? 'Obtener la FECHA para la cita. Puede ser relativa ("mañana", "el lunes") o absoluta ("20 de marzo")'
          : 'Get the DATE for the appointment. Can be relative ("tomorrow", "next Monday") or absolute ("March 20th")',
        extractFields: '{"dateText": "raw date text from user"|null}',
        extra: lang === 'es'
          ? `Tipo de cita: ${['cotización', 'instalación', 'reparación'][state.type ?? 0]}`
          : `Appointment type: ${['quote', 'installation', 'repair'][state.type ?? 0]}`,
      };

    case 'askTime':
      return {
        step: 'askTime',
        goal: lang === 'es'
          ? 'Obtener la HORA para la cita. Ej: "a las 10", "2 de la tarde", "10 AM"'
          : 'Get the TIME for the appointment. E.g. "at 10", "2 PM", "10 o\'clock"',
        extractFields: '{"timeText": "raw time text"|null}',
        extra: lang === 'es'
          ? `Fecha seleccionada: ${state.startDateISO ? new Date(state.startDateISO).toLocaleDateString('es-ES') : '?'}`
          : `Selected date: ${state.startDateISO ? new Date(state.startDateISO).toLocaleDateString('en-US') : '?'}`,
      };

    case 'askDuration':
      return {
        step: 'askDuration',
        goal: lang === 'es'
          ? 'Confirmar la DURACIÓN: 30 min, 1 hora (estándar), 1.5 horas, o 2 horas. Si dice "sí/ok/está bien" = 1 hora'
          : 'Confirm DURATION: 30 min, 1 hour (standard), 1.5 hours, or 2 hours. If they say "yes/ok/fine" = 1 hour',
        extractFields: '{"duration": "00:30:00"|"01:00:00"|"01:30:00"|"02:00:00"|null}',
      };

    case 'confirmSummary':
      return {
        step: 'confirmSummary',
        goal: lang === 'es'
          ? 'El usuario debe CONFIRMAR (sí) o RECHAZAR (no) el resumen de la cita'
          : 'User must CONFIRM (yes) or REJECT (no) the appointment summary',
        extractFields: '{"confirmed": true|false|null}',
        extra: lang === 'es'
          ? `Resumen: ${['cotización', 'instalación', 'reparación'][state.type ?? 0]}, ${customerName}, ${state.startDateISO ? new Date(state.startDateISO).toLocaleString('es-ES') : '?'}, ${state.duration}`
          : `Summary: ${['quote', 'installation', 'repair'][state.type ?? 0]}, ${customerName}, ${state.startDateISO ? new Date(state.startDateISO).toLocaleString('en-US') : '?'}, ${state.duration}`,
      };

    case 'confirmCustomerIdentity': {
      const match = state.customerMatches[0];
      const matchName = match ? [match.firstName, match.lastName].filter(Boolean).join(' ') : '?';
      return {
        step: 'confirmCustomerIdentity',
        goal: lang === 'es'
          ? `Confirmar si el usuario ES "${matchName}". Respuesta: sí o no`
          : `Confirm if the user IS "${matchName}". Answer: yes or no`,
        extractFields: '{"confirmed": true|false|null}',
      };
    }

    case 'disambiguateCustomer': {
      const options = state.customerMatches
        .slice(0, 5)
        .map((m, i) => `${i + 1}. ${[m.firstName, m.lastName].filter(Boolean).join(' ')} (tel: ***${(m.phone || '').slice(-4)})`)
        .join(', ');
      return {
        step: 'disambiguateCustomer',
        goal: lang === 'es'
          ? `El usuario debe elegir entre estas opciones: ${options}. Puede decir el número o su nombre`
          : `User must choose from: ${options}. They can say the number or their name`,
        extractFields: '{"choiceNumber": 1-5|null, "nameSpoken": "name"|null}',
      };
    }

    case 'askCustomerName':
      return {
        step: 'askCustomerName',
        goal: lang === 'es'
          ? 'Obtener el NOMBRE COMPLETO del cliente, o su teléfono/email para buscarlo en el sistema'
          : 'Get the customer\'s FULL NAME, or their phone/email to search the system',
        extractFields: '{"searchQuery": "the name/phone/email they said"|null}',
        extra: state.identificationAttempts > 0
          ? (lang === 'es' ? `Intento ${state.identificationAttempts + 1}/3` : `Attempt ${state.identificationAttempts + 1}/3`)
          : undefined,
      };

    case 'greeting':
      return {
        step: 'greeting',
        goal: lang === 'es'
          ? 'El cliente fue identificado. IMPORTANTE: Si menciona cita/appointment/agendar, INMEDIATAMENTE pregunta si es cotización, instalación o reparación. NO esperes a que lo diga — sé proactiva.'
          : 'Customer identified. IMPORTANT: If they mention appointment/schedule/booking, IMMEDIATELY ask if it\'s for quote, installation, or repair. DON\'T wait — be proactive.',
        extractFields: '{"wantsAppointment": true|false, "appointmentType": 0|1|2|null}',
        extra: customerName 
          ? (lang === 'es' 
            ? `Cliente: ${customerName}. Si quiere cita pero no especifica tipo, PREGÚNTALE: "¿Es para cotización, instalación o reparación?"`
            : `Customer: ${customerName}. If they want appointment but don't specify type, ASK: "Is this for a quote, installation, or repair?"`)
          : undefined,
      };

    default:
      return {
        step: state.step,
        goal: 'General conversation',
        extractFields: '{}',
      };
  }
}

// ─── System Prompt Builder ───

function buildStepSystemPrompt(state: ConversationState, ctx: StepContext): string {
  const lang = state.language === 'en' ? 'en' : 'es';

  if (lang === 'en') {
    return `You are a virtual receptionist for BlindsBook, a blinds and shutters company.
You are on a PHONE CALL. Be brief (max 2 sentences), warm, professional, and PROACTIVE.

CURRENT STEP: ${ctx.step}
GOAL: ${ctx.goal}
${ctx.extra ? `CONTEXT: ${ctx.extra}` : ''}

CRITICAL BEHAVIOR RULES:
1. BE PROACTIVE: Your reply MUST always move the conversation forward. NEVER just acknowledge — always follow up with the next logical question.
   - BAD: "I'll help you with that." (stops there)
   - GOOD: "I'll help you with that! Is this for a quote, installation, or repair?"
   
2. EXTRACT AND ASK: If the user provides partial info, acknowledge it AND ask for what's missing.
   - User: "I want an appointment for tomorrow"
   - GOOD: "Perfect, tomorrow! Is this for a quote, installation, or repair?" (extracts date, asks for type)
   
3. GUIDE CONFUSED USERS: If the user seems lost or says something vague, give them clear options.
   - User: "I don't know"
   - GOOD: "No problem! Most customers schedule quotes to get pricing, installations for new blinds, or repairs for existing ones. Which sounds right for you?"

4. HANDLE OFF-TOPIC: If they ask something unrelated, answer BRIEFLY (1 sentence max) then redirect with a question.
   - User: "What are your hours?"
   - GOOD: "We're open 9 AM to 6 PM. Now, for your appointment — is this for a quote, installation, or repair?"

5. NEVER just say "okay" or "understood" without following up with the next question.
6. NEVER make up information about services, prices, or policies.

RESPONSE FORMAT — respond with EXACTLY this JSON structure:
{"reply": "your natural response WITH a follow-up question", "data": ${ctx.extractFields}}

The "reply" MUST end with a question or call-to-action unless the goal is already complete.
The "data" contains the structured extraction. Use null for fields you couldn't extract.
Respond ONLY with the JSON object, no markdown, no backticks.`;
  }

  return `Eres la recepcionista virtual de BlindsBook, una empresa de cortinas y persianas.
Estás en una LLAMADA TELEFÓNICA. Sé breve (máx 2 oraciones), cálida, profesional y PROACTIVA.

PASO ACTUAL: ${ctx.step}
OBJETIVO: ${ctx.goal}
${ctx.extra ? `CONTEXTO: ${ctx.extra}` : ''}

REGLAS CRÍTICAS DE COMPORTAMIENTO:
1. SÉ PROACTIVA: Tu respuesta SIEMPRE debe avanzar la conversación. NUNCA solo reconozcas — siempre haz la siguiente pregunta lógica.
   - MAL: "Con gusto le ayudo." (se detiene ahí)
   - BIEN: "¡Con gusto le ayudo! ¿La cita es para cotización, instalación o reparación?"
   
2. EXTRAE Y PREGUNTA: Si el usuario da info parcial, reconócela Y pregunta lo que falta.
   - Usuario: "Quiero una cita para mañana"
   - BIEN: "¡Perfecto, mañana! ¿Es para cotización, instalación o reparación?" (extrae fecha, pregunta tipo)
   
3. GUÍA A USUARIOS CONFUNDIDOS: Si parece perdido o dice algo vago, dale opciones claras.
   - Usuario: "No sé"
   - BIEN: "¡No hay problema! La mayoría agenda cotizaciones para ver precios, instalaciones para cortinas nuevas, o reparaciones. ¿Cuál le suena mejor?"

4. MANEJA TEMAS EXTERNOS: Si preguntan algo no relacionado, responde BREVEMENTE (1 oración máx) y redirige con pregunta.
   - Usuario: "¿Cuál es su horario?"
   - BIEN: "Atendemos de 9am a 6pm. Ahora, para su cita — ¿es para cotización, instalación o reparación?"

5. NUNCA digas solo "ok" o "entendido" sin hacer una pregunta de seguimiento.
6. NUNCA inventes información sobre servicios, precios o políticas.

FORMATO DE RESPUESTA — responde con EXACTAMENTE esta estructura JSON:
{"reply": "tu respuesta natural CON pregunta de seguimiento", "data": ${ctx.extractFields}}

El "reply" DEBE terminar con una pregunta o llamado a acción, a menos que el objetivo ya esté completo.
El "data" contiene la extracción estructurada. Usa null para campos que no pudiste extraer.
Responde SOLO con el objeto JSON, sin markdown, sin backticks.`;
}

// ─── Response Parser ───

function parseStructuredResponse(content: string): LlmExtraction | null {
  // Try to extract JSON from the response
  const trimmed = content.trim();

  // Remove markdown code fences if present
  const cleaned = trimmed
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.reply === 'string') {
      return {
        reply: parsed.reply,
        data: parsed.data || {},
      };
    }
  } catch {
    // Try to find JSON in the response
    const jsonMatch = content.match(/\{[\s\S]*"reply"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed.reply === 'string') {
          return {
            reply: parsed.reply,
            data: parsed.data || {},
          };
        }
      } catch {
        // Give up on structured extraction
      }
    }
  }

  // If no valid JSON, return the raw text as reply with empty data
  if (trimmed.length > 0 && trimmed.length < 500) {
    return { reply: trimmed, data: {} };
  }

  return null;
}
