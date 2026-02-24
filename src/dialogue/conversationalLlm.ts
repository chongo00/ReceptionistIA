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
  const available = isAzureOpenAIConfigured() || await isOllamaAvailable();
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
      result = await chatWithOllama(messages);
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
          ? 'Determinar si la cita es para COTIZACIÓN (0), INSTALACIÓN (1), o REPARACIÓN (2)'
          : 'Determine if the appointment is for QUOTE (0), INSTALLATION (1), or REPAIR (2)',
        extractFields: '{"appointmentType": 0|1|2|null}',
        extra: customerName ? (lang === 'es' ? `Cliente: ${customerName}` : `Customer: ${customerName}`) : undefined,
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
          ? 'El cliente fue identificado. Si dice algo sobre agendar cita, pasar a askType. Si pregunta otra cosa, responder amablemente y guiarlo'
          : 'Customer identified. If they mention scheduling, move to askType. If they ask something else, respond kindly and guide them',
        extractFields: '{"wantsAppointment": true|false, "appointmentType": 0|1|2|null}',
        extra: customerName ? (lang === 'es' ? `Cliente: ${customerName}` : `Customer: ${customerName}`) : undefined,
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
You are on a PHONE CALL. Be brief (max 2 sentences), warm, and professional.

CURRENT STEP: ${ctx.step}
GOAL: ${ctx.goal}
${ctx.extra ? `CONTEXT: ${ctx.extra}` : ''}

IMPORTANT RULES:
1. If the user says something OFF-TOPIC (unrelated to the goal), briefly answer their question and then GENTLY guide them back to the topic. Example: "That's a great question! We do offer custom blinds. Now, regarding your appointment — is this for a quote, installation, or repair?"
2. If the user gives the information you need, acknowledge it warmly.
3. If the user is confused or unsure, explain patiently what you need.
4. NEVER make up information about the company's services, prices, or policies.

RESPONSE FORMAT — you MUST respond with EXACTLY this JSON structure, nothing else:
{"reply": "your natural response here", "data": ${ctx.extractFields}}

The "reply" is what will be spoken aloud to the customer.
The "data" contains the structured extraction. Use null for fields you couldn't extract.
Respond ONLY with the JSON object, no markdown, no backticks.`;
  }

  return `Eres la recepcionista virtual de BlindsBook, una empresa de cortinas y persianas.
Estás en una LLAMADA TELEFÓNICA. Sé breve (máximo 2 oraciones), cálida y profesional.

PASO ACTUAL: ${ctx.step}
OBJETIVO: ${ctx.goal}
${ctx.extra ? `CONTEXTO: ${ctx.extra}` : ''}

REGLAS IMPORTANTES:
1. Si el usuario dice algo FUERA DE TEMA (no relacionado con el objetivo), responde brevemente su pregunta y GENTILMENTE redirige la conversación. Ejemplo: "¡Excelente pregunta! Sí ofrecemos cortinas a medida. Ahora, respecto a su cita — ¿es para cotización, instalación o reparación?"
2. Si el usuario da la información que necesitas, reconócelo con calidez.
3. Si el usuario está confundido, explica pacientemente qué necesitas.
4. NUNCA inventes información sobre servicios, precios o políticas de la empresa.

FORMATO DE RESPUESTA — DEBES responder con EXACTAMENTE esta estructura JSON, nada más:
{"reply": "tu respuesta natural aquí", "data": ${ctx.extractFields}}

El "reply" es lo que se le dirá al cliente por teléfono.
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
