import { isAzureOpenAIConfigured, chatWithAzureOpenAI } from './azureOpenaiClient.js';
import type { ChatMessage, ToolCall, ToolDefinition } from './types.js';

export type LlmProvider = 'azure-openai' | 'none';

export async function getAvailableLlmProvider(): Promise<LlmProvider> {
  return isAzureOpenAIConfigured() ? 'azure-openai' : 'none';
}

export async function isLlmAvailable(): Promise<boolean> {
  return isAzureOpenAIConfigured();
}

export async function chatWithLlm(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
): Promise<{ content: string; toolCalls: ToolCall[]; provider: LlmProvider }> {
  if (isAzureOpenAIConfigured()) {
    const result = await chatWithAzureOpenAI(messages, tools);
    return { ...result, provider: 'azure-openai' };
  }
  throw new Error('No LLM provider available. Configure AZURE_OPENAI_* env vars.');
}
