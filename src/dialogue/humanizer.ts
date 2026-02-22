// Humanization utilities for natural-sounding agent responses

/** Pick a random element from an array */
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export const GREETINGS_ES = [
  '¡Hola, {name}! Bienvenido de nuevo a BlindsBook.',
  '¡Qué gusto saludarlo, {name}! Bienvenido a BlindsBook.',
  '¡Hola, {name}! Me alegra escucharlo de nuevo.',
  'Hola, {name}, bienvenido. Un placer atenderle.',
] as const;

export const GREETINGS_EN = [
  'Hi {name}! Welcome back to BlindsBook.',
  'Hello {name}! Great to hear from you again.',
  'Hey {name}! Welcome back to BlindsBook.',
  'Hi there, {name}! Good to hear from you.',
] as const;

export const HOW_CAN_HELP_ES = [
  '¿En qué puedo ayudarle hoy?',
  '¿Cómo le puedo ayudar?',
  '¿Qué puedo hacer por usted hoy?',
  '¿En qué le puedo servir?',
] as const;

export const HOW_CAN_HELP_EN = [
  'How can I help you today?',
  'What can I do for you?',
  'How may I assist you?',
  'What can I help you with today?',
] as const;

export const PERFECT_ES = [
  'Perfecto',
  '¡Excelente!',
  '¡Muy bien!',
  'Entendido',
  'De acuerdo',
] as const;

export const PERFECT_EN = [
  'Perfect',
  'Great',
  'Excellent',
  'Sounds good',
  'Got it',
] as const;

export const WAIT_ES = [
  'Un momento por favor...',
  'Un momentito, por favor...',
  'Déjeme verificar... un segundo.',
  'Permítame un momento...',
] as const;

export const WAIT_EN = [
  'One moment please...',
  'Just a moment...',
  'Let me check... one second.',
  'Bear with me for a moment...',
] as const;

export const SORRY_ES = [
  'Disculpe',
  'Lo siento',
  'Perdone',
  'Disculpe la molestia',
] as const;

export const SORRY_EN = [
  'Sorry',
  "I'm sorry",
  'My apologies',
  'Pardon me',
] as const;

export const GOODBYE_ES = [
  '¡Que tenga un excelente día!',
  '¡Muchas gracias por llamar! Que le vaya muy bien.',
  '¡Gracias por comunicarse con BlindsBook! Que tenga buen día.',
  'Fue un placer atenderle. ¡Que tenga un gran día!',
] as const;

export const GOODBYE_EN = [
  'Have a wonderful day!',
  'Thank you so much for calling! Have a great one.',
  'Thanks for reaching out to BlindsBook! Have a great day.',
  'It was a pleasure helping you. Have a wonderful day!',
] as const;

/** Optionally prepend a casual filler to a phrase */
export function maybeFiller(lang: 'es' | 'en', probability = 0.3): string {
  if (Math.random() > probability) return '';
  const fillers =
    lang === 'es'
      ? ['Mmm... ', 'Ah, ', 'Bueno, ', 'Veamos... ', 'Bien, ']
      : ['Hmm... ', 'Ah, ', 'Well, ', "Let's see... ", 'Alright, '];
  return pick(fillers);
}

/** Transform plain text into SSML with natural pauses and prosody for Azure Speech neural voices. */
export function enrichSsmlBody(text: string): string {
  let result = text.replace(/\n/g, ' <break time="500ms"/> ');

  result = result.replace(/([.!?])\s+(?!<break)/g, '$1 <break time="300ms"/> ');

  result = result.replace(/,\s+/g, ', <break time="150ms"/> ');

  return `<prosody rate="95%" pitch="+1%">${result}</prosody>`;
}
