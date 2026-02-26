/**
 * Unified LLM client — dispatches to Azure OpenAI (primary) or Ollama (fallback).
 *
 * Priority:
 *   1. Azure OpenAI  (cloud, fast, GPT-4o-mini)
 *   2. Ollama        (local, fallback, qwen2.5:3b)
 *   3. Error         (no provider available)
 */
import { isAzureOpenAIConfigured, isAzureOpenAIAvailable, chatWithAzureOpenAI } from './azureOpenaiClient.js';
import { isOllamaAvailable, chatWithOllama } from './ollamaClient.js';
import type { ChatMessage, ToolCall, ToolDefinition } from './ollamaClient.js';

export type LlmProvider = 'azure-openai' | 'ollama' | 'none';

/**
 * Check which LLM provider is available. Returns the best one.
 */
export async function getAvailableLlmProvider(): Promise<LlmProvider> {
  if (isAzureOpenAIConfigured()) {
    const ok = await isAzureOpenAIAvailable();
    if (ok) return 'azure-openai';
  }
  // PERF: skip Ollama availability check (3s HTTP call) — Azure is primary
  // const ollamaOk = await isOllamaAvailable();
  // if (ollamaOk) return 'ollama';
  return 'none';
}

/**
 * Check if ANY LLM provider is available.
 */
export async function isLlmAvailable(): Promise<boolean> {
  const provider = await getAvailableLlmProvider();
  return provider !== 'none';
}

/**
 * Chat with the best available LLM provider.
 * Azure OpenAI is tried first; if not configured or fails, falls back to Ollama.
 */
export async function chatWithLlm(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<{ content: string; toolCalls: ToolCall[]; provider: LlmProvider }> {

  // Try Azure OpenAI first
  if (isAzureOpenAIConfigured()) {
    try {
      const result = await chatWithAzureOpenAI(messages, tools);
      return { ...result, provider: 'azure-openai' };
    } catch (err) {
      console.warn('[LLM] Azure OpenAI failed, trying Ollama fallback:', (err as Error).message);
    }
  }

  // PERF: Ollama fallback commented out — using Azure only in production
  // const ollamaOk = await isOllamaAvailable();
  // if (ollamaOk) {
  //   try {
  //     const result = await chatWithOllama(messages, tools);
  //     return { ...result, provider: 'ollama' };
  //   } catch (err) {
  //     console.warn('[LLM] Ollama also failed:', (err as Error).message);
  //     throw err;
  //   }
  // }

  throw new Error('No LLM provider available. Configure AZURE_OPENAI_* or OLLAMA_URL.');
}
