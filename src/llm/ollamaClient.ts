import axios from 'axios';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

interface OllamaChatResponse {
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown> | string;
      };
    }>;
  };
  done: boolean;
}

const LLM_TIMEOUT = 30_000; // 30s — small CPU models can be slow

export async function isOllamaAvailable(): Promise<boolean> {
  if (!env.ollamaUrl) return false;
  try {
    const res = await axios.get(`${env.ollamaUrl}/api/tags`, { timeout: 3_000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function chatWithOllama(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  if (!env.ollamaUrl) {
    throw new Error('OLLAMA_URL not configured');
  }

  const body: Record<string, unknown> = {
    model: env.ollamaModel,
    messages,
    stream: false,
    options: {
      num_predict: 200,   // Max response tokens (short for voice)
      temperature: 0.3,   // Low temperature for consistent responses
    },
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await axios.post<OllamaChatResponse>(
    `${env.ollamaUrl}/api/chat`,
    body,
    { timeout: LLM_TIMEOUT },
  );

  const msg = response.data.message;

  // Normalize tool_calls: Ollama returns arguments as object, OpenAI as JSON string
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc, i) => ({
    id: `call_${i}`,
    type: 'function' as const,
    function: {
      name: tc.function.name,
      arguments:
        typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments),
    },
  }));

  return {
    content: msg.content || '',
    toolCalls,
  };
}
