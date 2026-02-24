import type { ConversationState, LlmMessage } from '../dialogue/state.js';
import {
  findCustomersBySearch,
  searchTeamMembers,
  createNewCustomer,
  findCustomersByAccountManager,
} from '../blindsbook/appointmentsClient.js';
import {
  chatWithLlm,
  isLlmAvailable,
} from './llmClient.js';
import type {
  ChatMessage,
  ToolDefinition,
  ToolCall,
} from './ollamaClient.js';

export interface IdentificationAgentResult {
  replyText: string;
  customerId: number | null;
  customerName: string | null;
  done: boolean; // true = identified or transferred, exit level 3
  transfer: boolean; // true = unresolved, transfer to human
  updatedHistory: LlmMessage[];
}

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'searchCustomers',
      description: 'Busca clientes en el sistema por nombre, teléfono o email. Retorna una lista de coincidencias.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Término de búsqueda: nombre, teléfono o email del cliente' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchTeamMembers',
      description: 'Busca vendedores o asesores del equipo por nombre. Útil cuando el cliente recuerda quién le atendió.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nombre del vendedor o asesor' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchByAccountManager',
      description: 'Busca clientes que son atendidos por un vendedor específico. Usa esto después de encontrar al vendedor con searchTeamMembers.',
      parameters: {
        type: 'object',
        properties: {
          customerQuery: { type: 'string', description: 'Nombre o dato del cliente para filtrar' },
          accountManagerId: { type: 'string', description: 'ID del vendedor encontrado con searchTeamMembers' },
        },
        required: ['customerQuery', 'accountManagerId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createCustomer',
      description: 'Registra un cliente nuevo en el sistema. Solo usar cuando el cliente confirma que quiere registrarse.',
      parameters: {
        type: 'object',
        properties: {
          firstName: { type: 'string', description: 'Nombre del cliente' },
          lastName: { type: 'string', description: 'Apellido del cliente' },
          phone: { type: 'string', description: 'Teléfono del cliente' },
        },
        required: ['firstName', 'lastName', 'phone'],
      },
    },
  },
];

function buildSystemPrompt(language: 'es' | 'en', callerPhone: string | null): string {
  if (language === 'en') {
    return `You are a virtual receptionist for a blinds and shutters company.
Your ONLY task right now is to identify the calling customer.
You could NOT find them by their phone number (${callerPhone || 'unknown'}) or by their name.

Available tools:
- searchCustomers: Search customers by name, phone or email
- searchTeamMembers: Search sales team members by name
- searchByAccountManager: Search customers assigned to a specific salesperson
- createCustomer: Register a new customer (only when they explicitly agree)

Rules:
1. Ask helpful questions: another phone number, the salesperson who helped them, email
2. Use tools to search after each response
3. When you find the customer, respond EXACTLY with: [IDENTIFIED:customerId:Full Name]
4. When the customer wants to register as new, use createCustomer and respond with: [CREATED:customerId:Full Name]
5. If after 3 turns you cannot resolve, respond with: [TRANSFER]
6. Be BRIEF. Maximum 2 sentences per response. This is a phone call, not a chat.
7. Speak in English.
8. NEVER invent customer data. Only use information from tool results.`;
  }

  return `Eres la recepcionista virtual de una empresa de cortinas y persianas.
Tu ÚNICA tarea en este momento es identificar al cliente que está llamando.
NO pudiste encontrarlo por su número de teléfono (${callerPhone || 'desconocido'}) ni por su nombre.

Herramientas disponibles:
- searchCustomers: Buscar clientes por nombre, teléfono o email
- searchTeamMembers: Buscar vendedores/asesores del equipo por nombre
- searchByAccountManager: Buscar clientes asignados a un vendedor específico
- createCustomer: Registrar un cliente nuevo (solo cuando confirme explícitamente)

Reglas:
1. Pregunta cosas útiles: otro teléfono, nombre del vendedor que le atendió, email
2. Usa herramientas para buscar después de cada respuesta del cliente
3. Cuando encuentres al cliente, responde EXACTAMENTE con: [IDENTIFIED:customerId:Nombre Completo]
4. Cuando el cliente quiera registrarse como nuevo, usa createCustomer y responde con: [CREATED:customerId:Nombre Completo]
5. Si después de 3 turnos no puedes resolver, responde con: [TRANSFER]
6. Sé BREVE. Máximo 2 oraciones por respuesta. Esto es una llamada, no un chat.
7. Habla en español.
8. NUNCA inventes datos de clientes. Solo usa información de los resultados de herramientas.`;
}

async function executeTool(
  toolCall: ToolCall,
): Promise<string> {
  const args = JSON.parse(toolCall.function.arguments);

  switch (toolCall.function.name) {
    case 'searchCustomers': {
      const results = await findCustomersBySearch(args.query, 5);
      if (results.length === 0) return JSON.stringify({ found: 0, customers: [] });
      return JSON.stringify({
        found: results.length,
        customers: results.map((c) => ({
          id: c.id,
          name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          company: c.companyName,
          phone: c.phone ? `***${c.phone.slice(-4)}` : null,
        })),
      });
    }

    case 'searchTeamMembers': {
      const members = await searchTeamMembers(args.query);
      if (members.length === 0) return JSON.stringify({ found: 0, members: [] });
      return JSON.stringify({
        found: members.length,
        members: members.map((m) => ({
          id: m.id,
          name: m.displayName,
        })),
      });
    }

    case 'searchByAccountManager': {
      const managerId = Number(args.accountManagerId);
      if (isNaN(managerId)) return JSON.stringify({ error: 'Invalid accountManagerId' });
      const results = await findCustomersByAccountManager(args.customerQuery || '', managerId);
      if (results.length === 0) return JSON.stringify({ found: 0, customers: [] });
      return JSON.stringify({
        found: results.length,
        customers: results.map((c) => ({
          id: c.id,
          name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          phone: c.phone ? `***${c.phone.slice(-4)}` : null,
        })),
      });
    }

    case 'createCustomer': {
      const result = await createNewCustomer(args.firstName, args.lastName, args.phone);
      return JSON.stringify({ success: true, customerId: result.id });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` });
  }
}

interface ParsedMarker {
  type: 'identified' | 'created' | 'transfer' | 'none';
  customerId?: number;
  customerName?: string;
}

function parseMarkers(text: string): ParsedMarker {
  const identifiedMatch = text.match(/\[IDENTIFIED:(\d+):([^\]]+)\]/);
  if (identifiedMatch) {
    return { type: 'identified', customerId: Number(identifiedMatch[1]), customerName: identifiedMatch[2]!.trim() };
  }

  const createdMatch = text.match(/\[CREATED:(\d+):([^\]]+)\]/);
  if (createdMatch) {
    return { type: 'created', customerId: Number(createdMatch[1]), customerName: createdMatch[2]!.trim() };
  }

  if (text.includes('[TRANSFER]')) {
    return { type: 'transfer' };
  }

  return { type: 'none' };
}

function cleanMarkers(text: string): string {
  return text
    .replace(/\[IDENTIFIED:\d+:[^\]]+\]/g, '')
    .replace(/\[CREATED:\d+:[^\]]+\]/g, '')
    .replace(/\[TRANSFER\]/g, '')
    .trim();
}

const MAX_TOOL_CALLS_PER_TURN = 3;
const MAX_TOOL_CALL_LOOPS = 3; // Max tool call loops per turn

export async function runIdentificationAgent(
  state: ConversationState,
  userText: string,
): Promise<IdentificationAgentResult> {
  const history = [...state.llmConversationHistory];

  if (history.length === 0) {
    history.push({
      role: 'system',
      content: buildSystemPrompt(state.language, state.callerPhone),
    });
  }

  if (userText) {
    history.push({ role: 'user', content: userText });
  }

  const available = await isLlmAvailable();
  if (!available) {
    return {
      replyText: state.language === 'en'
        ? "I'm having technical difficulties. Would you like me to register you as a new customer? Please tell me your full name."
        : 'Estoy teniendo dificultades técnicas. ¿Le gustaría que lo registre como cliente nuevo? Dígame su nombre completo.',
      customerId: null,
      customerName: null,
      done: false,
      transfer: false,
      updatedHistory: history,
    };
  }

  let loopCount = 0;
  let lastContent = '';

  while (loopCount < MAX_TOOL_CALL_LOOPS) {
    loopCount++;

    const response = await chatWithLlm(history as ChatMessage[], TOOLS);

    if (response.toolCalls.length > 0) {
      history.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      });

      const callsToProcess = response.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
      for (const tc of callsToProcess) {
        let toolResult: string;
        try {
          toolResult = await executeTool(tc);
        } catch (err) {
          toolResult = JSON.stringify({ error: String(err) });
        }
        history.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: tc.id,
        });
      }

      continue;
    }

    lastContent = response.content;
    history.push({ role: 'assistant', content: lastContent });
    break;
  }

  const marker = parseMarkers(lastContent);
  const cleanReply = cleanMarkers(lastContent);

  switch (marker.type) {
    case 'identified':
      return {
        replyText: cleanReply || (state.language === 'en'
          ? `I found you, ${marker.customerName}!`
          : `¡Lo encontré, ${marker.customerName}!`),
        customerId: marker.customerId ?? null,
        customerName: marker.customerName ?? null,
        done: true,
        transfer: false,
        updatedHistory: history,
      };

    case 'created':
      return {
        replyText: cleanReply || (state.language === 'en'
          ? `I've registered you as a new customer, ${marker.customerName}.`
          : `Lo he registrado como cliente nuevo, ${marker.customerName}.`),
        customerId: marker.customerId ?? null,
        customerName: marker.customerName ?? null,
        done: true,
        transfer: false,
        updatedHistory: history,
      };

    case 'transfer':
      return {
        replyText: cleanReply || (state.language === 'en'
          ? 'I will transfer you to a team member who can help you directly.'
          : 'Lo voy a transferir con un miembro del equipo que pueda ayudarle directamente.'),
        customerId: null,
        customerName: null,
        done: true,
        transfer: true,
        updatedHistory: history,
      };

    default:
      return {
        replyText: lastContent,
        customerId: null,
        customerName: null,
        done: false,
        transfer: false,
        updatedHistory: history,
      };
  }
}
