import { isAzureOpenAIConfigured, chatWithAzureOpenAI, streamChatWithAzureOpenAI } from '../llm/azureOpenaiClient.js';
import type { ChatMessage } from '../llm/types.js';
import type { ConversationState } from './state.js';

export interface LlmExtraction {
  reply: string;
  data: Record<string, unknown>;
}

export async function isConversationalLlmAvailable(): Promise<boolean> {
  return isAzureOpenAIConfigured();
}

export async function llmProcessStep(
  state: ConversationState,
  userText: string,
  stepContext: StepContext,
): Promise<LlmExtraction | null> {
  if (!isAzureOpenAIConfigured()) return null;

  const messages = buildLlmMessages(state, userText, stepContext);

  try {
    const result = await chatWithAzureOpenAI(messages);
    return parseStructuredResponse(result.content);
  } catch (err) {
    console.warn('[ConversationalLLM] Error:', (err as Error).message);
    return null;
  }
}

export interface StepContext {
  step: string;
  goal: string;
  extractFields: string;
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
          ? 'El cliente fue identificado. Solo pregunta "¿en qué te puedo ayudar?". NO expliques tipos de cita a menos que el cliente pregunte explícitamente.'
          : 'Customer identified. Simply ask "how can I help you?". Do NOT explain appointment types unless the customer explicitly asks.',
        extractFields: '{"wantsAppointment": true|false, "appointmentType": 0|1|2|null, "dateText": "date if mentioned"|null}',
        extra: customerName
          ? (lang === 'es'
            ? `Cliente: ${customerName}. Si quiere cita pero no especifica tipo, pregúntale qué tipo de servicio necesita.`
            : `Customer: ${customerName}. If they want an appointment but don't specify the type, ask what kind of service they need.`)
          : undefined,
      };

    default:
      return { step: state.step, goal: 'General conversation', extractFields: '{}' };
  }
}

/**
 * Build the full message array for LLM calls, including conversation history.
 * Places system prompt first, then recent turns, then current user input.
 */
function buildLlmMessages(state: ConversationState, userText: string, stepContext: StepContext): ChatMessage[] {
  const systemPrompt = buildStepSystemPrompt(state, stepContext);
  const history = (state.conversationTurns || []).slice(-10).map(turn => ({
    role: turn.role as 'user' | 'assistant',
    content: turn.text,
  }));
  return [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userText || '(silence — the user did not say anything)' },
  ];
}

function buildStepSystemPrompt(state: ConversationState, ctx: StepContext): string {
  const lang = state.language === 'en' ? 'en' : 'es';

  if (lang === 'en') {
    return `You are Sarah, a friendly virtual receptionist at BlindsBook (blinds & shutters company).
You're on a PHONE CALL. Speak like a real person — warm, casual yet professional.

PERSONALITY:
- Use contractions naturally: "I'll", "we'll", "that's", "you're"
- Use natural filler phrases: "Sure thing!", "Absolutely!", "No worries!"
- Vary your sentence structure — don't repeat the same pattern twice
- React to what the customer says before asking the next question
- Sound genuinely interested, not scripted
- Use casual transitions: "So...", "Alright, so...", "Great, now..."

CURRENT STEP: ${ctx.step}
GOAL: ${ctx.goal}
${ctx.extra ? `CONTEXT: ${ctx.extra}` : ''}

STYLE: Short answers (1–2 sentences). Use backchannels when something is happening in the background (e.g. "One sec, let me look that up...", "Bear with me..."). Operational = "give me a moment"; Informative = confirmations, summaries, goodbye.
RULES:
1. ALWAYS move the conversation forward — acknowledge + ask next logical question in the SAME reply.
2. If the user gives partial info, acknowledge it AND ask for what's missing.
3. If the user seems lost, give them clear options with brief explanations.
4. Keep it to 1-2 sentences max. This is a phone call, not an essay.
5. If they go off-topic, answer in ONE short phrase then redirect.
6. NEVER make up info about services, prices, or policies.
7. Sound like a real person. Avoid: "I understand your request", "I'd be happy to assist you with that", "Thank you for providing that information."
8. NEVER proactively list or explain appointment types (quote/installation/repair) unless the customer asks. Just ask "how can I help?" and wait for their response.

CONVERSATION AWARENESS:
- The conversation history is included above. Use it to maintain continuity.
- NEVER re-ask for information the customer already provided.
- Reference what the customer said earlier when relevant ("like you mentioned...").
- If the customer seems frustrated or repeats themselves, acknowledge it and move forward.
- Adapt your tone to match the customer's energy — if they're brief, be brief; if chatty, engage a bit.

RESPONSE FORMAT — respond with EXACTLY this JSON:
{"reply": "your natural response", "data": ${ctx.extractFields}}

Respond ONLY with the JSON object, no markdown, no backticks.`;
  }

  return `Eres Sara, la recepcionista virtual de BlindsBook (empresa de cortinas y persianas).
Estás en una LLAMADA TELEFÓNICA. Habla como una persona real — cálida, cercana y profesional.

PERSONALIDAD:
- Usa expresiones naturales del habla: "¡Claro que sí!", "¡Por supuesto!", "¡Con todo gusto!", "¡Dale!"
- No repitas la misma estructura dos veces seguidas, varía cómo dices las cosas
- Reacciona genuinamente a lo que dice el cliente antes de hacer la siguiente pregunta
- Usa transiciones casuales: "Bueno...", "Entonces...", "Órale, pues...", "Mire..."
- Suena como una persona real que de verdad está escuchando

PASO ACTUAL: ${ctx.step}
OBJETIVO: ${ctx.goal}
${ctx.extra ? `CONTEXTO: ${ctx.extra}` : ''}

ESTILO: Respuestas cortas (1–2 oraciones). Usa muletillas cuando algo pasa en segundo plano (ej. "Dame un segundo que busco...", "Un momentito..."). Operativo = "dame un momento"; Informativo = confirmaciones, resúmenes, despedida.
REGLAS:
1. SIEMPRE avanza la conversación — reconoce + pregunta lo siguiente en la MISMA respuesta.
2. Si el usuario da info parcial, reconócela Y pregunta lo que falta.
3. Si parece confundido, dale opciones claras con explicaciones breves.
4. Máximo 1-2 oraciones. Esto es una llamada, no un ensayo.
5. Si se sale del tema, responde en UNA frase corta y redirige.
6. NUNCA inventes información sobre servicios, precios o políticas.
7. Suena como una persona real. Evita: "Entiendo su solicitud", "Con mucho gusto le atenderé", "Gracias por proporcionar esa información."
8. NUNCA listes o expliques los tipos de cita (cotización/instalación/reparación) de forma proactiva a menos que el cliente pregunte. Solo pregunta "¿en qué te puedo ayudar?" y espera su respuesta.

CONCIENCIA DE CONVERSACIÓN:
- El historial de la conversación está incluido arriba. Úsalo para mantener continuidad.
- NUNCA vuelvas a pedir información que el cliente ya proporcionó.
- Haz referencia a lo que el cliente dijo antes cuando sea relevante ("como me comentaste...").
- Si el cliente parece frustrado o se repite, reconócelo y avanza.
- Adapta tu tono al del cliente — si es breve, sé breve; si es conversador, engancha un poco.

FORMATO DE RESPUESTA — responde con EXACTAMENTE este JSON:
{"reply": "tu respuesta natural", "data": ${ctx.extractFields}}

Responde SOLO con el objeto JSON, sin markdown, sin backticks.`;
}

function parseStructuredResponse(content: string): LlmExtraction | null {
  const trimmed = content.trim();
  const cleaned = trimmed.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.reply === 'string') {
      return { reply: parsed.reply, data: parsed.data || {} };
    }
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*"reply"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed.reply === 'string') {
          return { reply: parsed.reply, data: parsed.data || {} };
        }
      } catch { /* give up */ }
    }
  }

  if (trimmed.length > 0 && trimmed.length < 500) {
    return { reply: trimmed, data: {} };
  }

  return null;
}

// Sentence boundary regex: splits on . ! ? or newline followed by space/end
const SENTENCE_BOUNDARY = /[.!?\n](?:\s|$)/;

/**
 * Streaming variant of llmProcessStep.
 * Yields individual sentences as they accumulate from the LLM token stream.
 * After the stream completes, yields a final extraction with parsed data.
 */
export async function* llmProcessStepStreaming(
  state: ConversationState,
  userText: string,
  stepContext: StepContext,
): AsyncGenerator<{ type: 'sentence' | 'extraction'; text?: string; data?: Record<string, unknown> }> {
  if (!isAzureOpenAIConfigured()) return;

  const messages = buildLlmMessages(state, userText, stepContext);

  let fullContent = '';
  let sentenceBuffer = '';
  let insideJson = false;
  let braceDepth = 0;

  try {
    for await (const { delta, done } of streamChatWithAzureOpenAI(messages)) {
      if (done) break;
      fullContent += delta;

      // Track JSON brace depth to avoid splitting mid-JSON
      for (const ch of delta) {
        if (ch === '{') { insideJson = true; braceDepth++; }
        if (ch === '}') { braceDepth--; if (braceDepth <= 0) insideJson = false; }
      }

      // Only try to extract sentences from the "reply" field value
      if (insideJson) continue;

      sentenceBuffer += delta;

      // Check for sentence boundaries
      while (SENTENCE_BOUNDARY.test(sentenceBuffer)) {
        const match = sentenceBuffer.match(SENTENCE_BOUNDARY);
        if (!match || match.index === undefined) break;
        const endIdx = match.index + match[0].length;
        const sentence = sentenceBuffer.slice(0, endIdx).trim();
        sentenceBuffer = sentenceBuffer.slice(endIdx);
        if (sentence.length > 0) {
          yield { type: 'sentence', text: sentence };
        }
      }
    }

    // Flush remaining buffer as last sentence
    if (sentenceBuffer.trim().length > 0) {
      yield { type: 'sentence', text: sentenceBuffer.trim() };
    }

    // Parse full response for data extraction
    const extraction = parseStructuredResponse(fullContent);
    yield {
      type: 'extraction',
      data: extraction?.data || {},
    };
  } catch (err) {
    console.warn('[ConversationalLLM] Streaming error:', (err as Error).message);
    // Fall back: yield whatever we accumulated as a single sentence
    if (fullContent.trim()) {
      const extraction = parseStructuredResponse(fullContent);
      if (extraction) {
        yield { type: 'sentence', text: extraction.reply };
        yield { type: 'extraction', data: extraction.data };
      }
    }
  }
}
