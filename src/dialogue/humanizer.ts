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

/**
 * Transform plain text into advanced SSML for natural-sounding Azure Neural voices.
 * 
 * Key techniques for natural speech:
 * 1. Strategic pauses (shorter than written punctuation implies)
 * 2. Emphasis on key words without being robotic
 * 3. Natural prosody variations (rate, pitch)
 * 4. Contractions and flow improvements
 */
export function enrichSsmlBody(text: string): string {
  let result = text;
  
  // ═══════════════════════════════════════════════════════════════
  // STEP 1: Clean up text for spoken delivery
  // ═══════════════════════════════════════════════════════════════
  
  // Remove bullet points and list markers (they don't speak well)
  result = result.replace(/^[•\-\*]\s*/gm, '');
  result = result.replace(/^\d+\.\s*/gm, '');
  
  // Convert written-style text to spoken-style
  // "Cliente: Juan" → "Cliente, Juan"
  result = result.replace(/([A-Za-zÁÉÍÓÚáéíóúñÑ]+):\s+/g, '$1, ');
  
  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Strategic pauses (make it flow like conversation)
  // ═══════════════════════════════════════════════════════════════
  
  // Replace newlines with natural pauses (not too long)
  result = result.replace(/\n\n/g, ' <break time="350ms"/> ');
  result = result.replace(/\n/g, ' <break time="200ms"/> ');

  // Pause after sentences - shorter for flowing conversation
  result = result.replace(/\.\s+(?!<break)/g, '. <break time="180ms"/> ');
  
  // Exclamations - brief pause, energy continues
  result = result.replace(/!\s+(?!<break)/g, '! <break time="150ms"/> ');
  
  // Questions - very brief pause (expectant)
  result = result.replace(/\?\s+(?!<break)/g, '? <break time="120ms"/> ');

  // Commas - tiny pause, keeps flow
  result = result.replace(/,\s+(?!<break)/g, ', <break time="80ms"/> ');
  
  // Semicolons/colons - medium pause
  result = result.replace(/[;:]\s+(?!<break)/g, '; <break time="150ms"/> ');
  
  // Natural thinking pauses before conjunctions (Spanish and English)
  result = result.replace(/\s+(pero|however|but|aunque|although)\s+/gi, 
    ' <break time="100ms"/> $1 ');
  result = result.replace(/\s+(o|or)\s+/gi, ' <break time="60ms"/> $1 ');
  result = result.replace(/\s+(y|and)\s+/gi, ' $1 ');
  
  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Emphasis on key conversational words
  // ═══════════════════════════════════════════════════════════════
  
  // Greetings - warm emphasis
  result = result.replace(
    /(¡?Hola|Hello|Hi there|Buenos días|Good morning)/gi,
    '<emphasis level="moderate">$1</emphasis>'
  );
  
  // Confirmations - confident emphasis
  result = result.replace(
    /(Perfecto|Perfect|Excelente|Excellent|Great|Muy bien|Entendido|Got it)/gi,
    '<emphasis level="moderate">$1</emphasis>'
  );
  
  // Important information markers
  result = result.replace(
    /(Tipo|Type|Fecha|Date|Cliente|Customer|Duración|Duration)/gi,
    '<emphasis level="reduced">$1</emphasis>'
  );
  
  // Questions - slight emphasis to make them clear
  result = result.replace(
    /(¿[^?]+\?)/g,
    '<prosody pitch="+3%">$1</prosody>'
  );
  
  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Say-as for special content (numbers, dates)
  // ═══════════════════════════════════════════════════════════════
  
  // Phone-like numbers (4+ digits) - speak as digits
  result = result.replace(
    /\b(\d{4,})\b/g,
    '<say-as interpret-as="telephone">$1</say-as>'
  );
  
  // Time expressions - keep natural
  result = result.replace(
    /(\d{1,2}:\d{2})/g,
    '<say-as interpret-as="time" format="hms24">$1</say-as>'
  );
  
  // ═══════════════════════════════════════════════════════════════
  // STEP 5: Wrap with natural prosody (conversational, not robotic)
  // ═══════════════════════════════════════════════════════════════
  
  // Slightly faster than default (more natural conversation pace)
  // Tiny pitch variation to avoid monotone
  return result;
}

/**
 * Generate natural-sounding confirmation phrases
 */
export function naturalConfirmation(lang: 'es' | 'en'): string {
  const esOptions = [
    'Perfecto.',
    'Muy bien.',
    'Entendido.',
    'De acuerdo.',
    'Listo.',
  ];
  const enOptions = [
    'Perfect.',
    'Great.',
    'Got it.',
    'Alright.',
    'Sounds good.',
  ];
  return pick(lang === 'es' ? esOptions : enOptions);
}

/**
 * Generate natural transition phrases
 */
export function naturalTransition(lang: 'es' | 'en'): string {
  const esOptions = [
    'Ahora bien,',
    'Entonces,',
    'Muy bien, ahora',
    'Continuemos.',
  ];
  const enOptions = [
    'Now then,',
    'So,',
    'Alright, now',
    "Let's continue.",
  ];
  return pick(lang === 'es' ? esOptions : enOptions);
}
