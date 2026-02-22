/**
 * Utilidades de humanización para hacer que las respuestas del agente suenen
 * más naturales y menos robóticas.
 *
 * Dos niveles:
 *   1. Texto — variaciones de frases, fillers, interjecciones
 *   2. SSML  — pausas, prosodia y énfasis para TTS neural
 */

// ── Helpers ──────────────────────────────────────────────

/** Selección aleatoria de un array */
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ── Variaciones de frases comunes ────────────────────────

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

// ── Fillers naturales ────────────────────────────────────

/** Agrega un filler casual al inicio de una frase (con cierta probabilidad) */
export function maybeFiller(lang: 'es' | 'en', probability = 0.3): string {
  if (Math.random() > probability) return '';
  const fillers =
    lang === 'es'
      ? ['Mmm... ', 'Ah, ', 'Bueno, ', 'Veamos... ', 'Bien, ']
      : ['Hmm... ', 'Ah, ', 'Well, ', "Let's see... ", 'Alright, '];
  return pick(fillers);
}

// ── SSML Enhancement ─────────────────────────────────────

/**
 * Transforma texto plano en SSML enriquecido con pausas naturales y prosodia.
 * Diseñado para voces neurales de Azure Speech.
 *
 * - Inserta <break> entre oraciones
 * - Envuelve en <prosody> con rate ligeramente bajo para claridad
 * - Agrega pausas más largas en saltos de línea
 */
export function enrichSsmlBody(text: string): string {
  // 1) Reemplazar saltos de línea explícitos con break largo
  let result = text.replace(/\n/g, ' <break time="500ms"/> ');

  // 2) Después de puntos seguidos de espacio, insertar break corto
  //    Pero no tocar los que ya tienen break inyectado
  result = result.replace(/([.!?])\s+(?!<break)/g, '$1 <break time="300ms"/> ');

  // 3) Después de comas, insertar micro-break para ritmo natural
  result = result.replace(/,\s+/g, ', <break time="150ms"/> ');

  // 4) Envolver en prosody para hablar un poquito más lento y con tono cálido
  return `<prosody rate="95%" pitch="+1%">${result}</prosody>`;
}
