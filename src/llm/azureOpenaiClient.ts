/**
 * Azure OpenAI client — replaces Ollama as primary LLM.
 * Uses the OpenAI-compatible REST API exposed by Azure OpenAI Service.
 *
 * Required env vars:
 *   AZURE_OPENAI_ENDPOINT   – e.g. https://my-resource.openai.azure.com
 *   AZURE_OPENAI_API_KEY    – the key from Azure portal
 *   AZURE_OPENAI_DEPLOYMENT – deployment name (e.g. "gpt-4o-mini")
 *   AZURE_OPENAI_API_VERSION – optional, defaults to 2024-10-21
 */
import axios from 'axios';
import { loadEnv } from '../config/env.js';
import type { ChatMessage, ToolCall, ToolDefinition } from './ollamaClient.js';

const LLM_TIMEOUT = 15_000; // 15s — voice calls need fast responses

export function isAzureOpenAIConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.azureOpenaiEndpoint && env.azureOpenaiApiKey && env.azureOpenaiDeployment);
}

export async function isAzureOpenAIAvailable(): Promise<boolean> {
  if (!isAzureOpenAIConfigured()) return false;
  // Azure OpenAI doesn't have a lightweight ping endpoint — we just verify config
  return true;
}

interface AzureOpenAIChatResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string; // always JSON string in OpenAI API
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function chatWithAzureOpenAI(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const env = loadEnv();
  const endpoint = env.azureOpenaiEndpoint;
  const apiKey = env.azureOpenaiApiKey;
  const deployment = env.azureOpenaiDeployment;
  const apiVersion = env.azureOpenaiApiVersion || '2024-10-21';

  if (!endpoint || !apiKey || !deployment) {
    throw new Error('Azure OpenAI not configured (AZURE_OPENAI_ENDPOINT/API_KEY/DEPLOYMENT)');
  }

  // Build the URL for Azure OpenAI chat completions
  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  // Convert messages to OpenAI format
  const openaiMessages = messages.map((m) => {
    const msg: Record<string, unknown> = {
      role: m.role,
      content: m.content,
    };
    if (m.tool_calls && m.tool_calls.length > 0) {
      msg.tool_calls = m.tool_calls;
    }
    if (m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    return msg;
  });

  const body: Record<string, unknown> = {
    messages: openaiMessages,
    max_tokens: 150,    // Voice replies are ≤2 sentences — less tokens = faster first token
    temperature: 0.3,   // Low temperature for consistent responses
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await axios.post<AzureOpenAIChatResponse>(url, body, {
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    timeout: LLM_TIMEOUT,
  });

  const choice = response.data.choices?.[0];
  if (!choice) {
    throw new Error('Azure OpenAI returned no choices');
  }

  const msg = choice.message;

  // Tool calls from OpenAI are already in the correct format
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments, // Already JSON string in OpenAI
    },
  }));

  const usage = response.data.usage;
  if (usage) {
    console.log(
      `[Azure OpenAI] tokens: ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion = ${usage.total_tokens} total`,
    );
  }

  return {
    content: msg.content || '',
    toolCalls,
  };
}
