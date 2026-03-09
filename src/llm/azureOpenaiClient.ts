import axios from 'axios';
import { loadEnv } from '../config/env.js';
import type { ChatMessage, ToolCall, ToolDefinition } from './types.js';

const LLM_TIMEOUT = 10_000;

let _config: { apiKey: string; url: string } | null = null;

function getConfig() {
  if (_config) return _config;
  const env = loadEnv();
  const { azureOpenaiEndpoint: endpoint, azureOpenaiApiKey: apiKey, azureOpenaiDeployment: deployment } = env;
  const apiVersion = env.azureOpenaiApiVersion || '2024-10-21';
  if (!endpoint || !apiKey || !deployment) {
    throw new Error('Azure OpenAI not configured (AZURE_OPENAI_ENDPOINT/API_KEY/DEPLOYMENT)');
  }
  _config = {
    apiKey,
    url: `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
  };
  return _config;
}

export function isAzureOpenAIConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.azureOpenaiEndpoint && env.azureOpenaiApiKey && env.azureOpenaiDeployment);
}

export async function isAzureOpenAIAvailable(): Promise<boolean> {
  return isAzureOpenAIConfigured();
}

interface AzureOpenAIChatResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Streaming variant — yields token deltas as they arrive from Azure OpenAI.
 * The caller reassembles text and decides when to flush sentences.
 */
export async function* streamChatWithAzureOpenAI(
  messages: ChatMessage[],
  options?: { maxTokens?: number },
): AsyncGenerator<{ delta: string; done: boolean }> {
  const cfg = getConfig();

  const openaiMessages = messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls?.length) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });

  const body: Record<string, unknown> = {
    messages: openaiMessages,
    max_tokens: options?.maxTokens ?? 120,
    temperature: 0.4,
    stream: true,
  };

  const response = await axios.post(cfg.url, body, {
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    timeout: LLM_TIMEOUT,
    responseType: 'stream',
  });

  const stream = response.data as import('stream').Readable;
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    // Keep incomplete last line in buffer
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        yield { delta: '', done: true };
        return;
      }
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          yield { delta, done: false };
        }
      } catch {
        // Skip malformed SSE lines
      }
    }
  }
  // Stream ended without [DONE]
  yield { delta: '', done: true };
}

export async function chatWithAzureOpenAI(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: { maxTokens?: number },
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const cfg = getConfig();

  const openaiMessages = messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls?.length) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });

  const body: Record<string, unknown> = {
    messages: openaiMessages,
    max_tokens: options?.maxTokens ?? 120,
    temperature: 0.4,
  };

  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await axios.post<AzureOpenAIChatResponse>(cfg.url, body, {
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    timeout: LLM_TIMEOUT,
  });

  const choice = response.data.choices?.[0];
  if (!choice) throw new Error('Azure OpenAI returned no choices');

  const msg = choice.message;
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));

  return { content: msg.content || '', toolCalls };
}
