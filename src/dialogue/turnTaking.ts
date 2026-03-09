import type { ConversationStep } from './state.js';

/**
 * Returns the appropriate silence duration (in ms) for the current dialogue step.
 * Short for yes/no confirmations, longer for steps that require thinking.
 */
export function getSilenceDurationForStep(step: ConversationStep, baseMs: number): number {
  switch (step) {
    case 'confirmSummary':
    case 'confirmCustomerIdentity':
      // Quick yes/no — respond faster
      return Math.max(300, baseMs - 300);

    case 'askDate':
    case 'askTime':
      // User needs to think about dates/times — be more patient
      return baseMs + 500;

    case 'greeting':
    case 'askCustomerName':
      // Greeting / name recall — moderate extra patience
      return baseMs + 300;

    case 'askType':
    case 'askDuration':
    case 'disambiguateCustomer':
      // Standard patience
      return baseMs;

    default:
      return baseMs;
  }
}
