export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export const GREETINGS_ES = [
  '¡Hola, {name}! Qué gusto escucharte.',
  '¡Hey, {name}! Bienvenido de vuelta a BlindsBook.',
  '¡Hola, {name}! Me da mucho gusto atenderte.',
  '¡Qué tal, {name}! Bienvenido a BlindsBook.',
  '¡Hola, {name}! Qué bueno que nos llamas.',
  'Hola, {name}. Un placer saludarte de nuevo.',
] as const;

export const GREETINGS_EN = [
  'Hey {name}! Great to hear from you.',
  'Hi {name}! Welcome back to BlindsBook.',
  'Hello {name}! So glad you called.',
  'Hey there, {name}! Good to have you back.',
  'Hi {name}! Nice to hear from you again.',
  '{name}, hi! Thanks for calling BlindsBook.',
] as const;

export const HOW_CAN_HELP_ES = [
  '¿En qué te puedo ayudar hoy?',
  '¿Qué puedo hacer por ti?',
  '¿Cómo te puedo ayudar?',
  '¿En qué te ayudo?',
  'Dime, ¿qué necesitas?',
] as const;

export const HOW_CAN_HELP_EN = [
  'What can I do for you today?',
  'How can I help?',
  "What's on your mind?",
  'What can I help you with?',
  'How can I help you out today?',
] as const;

export const PERFECT_ES = [
  '¡Perfecto!',
  '¡Listo!',
  '¡Muy bien!',
  '¡Genial!',
  '¡Sale!',
  'De acuerdo.',
  '¡Órale!',
  '¡Excelente!',
] as const;

export const PERFECT_EN = [
  'Perfect!',
  'Great!',
  'Awesome!',
  'Sounds good!',
  'Got it!',
  'Alright!',
  'Sure thing!',
  'Wonderful!',
] as const;

export const WAIT_ES = [
  'Un momentito...',
  'Dame un segundo...',
  'Déjame checar...',
  'Un momento, por favor...',
  'Permíteme verificar...',
] as const;

export const WAIT_EN = [
  'One sec...',
  'Just a moment...',
  'Let me check...',
  'Bear with me...',
  'Hang on a sec...',
] as const;

export const SORRY_ES = [
  'Disculpa',
  'Perdona',
  'Lo siento',
  'Ay, disculpa',
  'Perdón',
] as const;

export const SORRY_EN = [
  'Sorry about that',
  'My apologies',
  "Oh, I'm sorry",
  'Sorry',
  'Pardon me',
] as const;

export const GOODBYE_ES = [
  '¡Que te vaya muy bien! Hasta luego.',
  '¡Gracias por llamar! Que tengas un excelente día.',
  '¡Fue un placer ayudarte! Cuídate mucho.',
  '¡Gracias por comunicarte con BlindsBook! Que te vaya bonito.',
  '¡Hasta pronto! Que tengas un gran día.',
] as const;

export const GOODBYE_EN = [
  'Have a great one! Bye!',
  'Thanks so much for calling! Take care.',
  "It was great chatting with you! Have an awesome day.",
  'Thanks for reaching out! Talk soon.',
  'Have a wonderful day! Bye-bye.',
] as const;

export function maybeFiller(lang: 'es' | 'en', probability = 0.45): string {
  if (Math.random() > probability) return '';
  const fillers =
    lang === 'es'
      ? ['Mira, ', 'Bueno, ', 'A ver... ', 'Oye, ', 'Entonces, ', 'Pues mira, ']
      : ['So, ', 'Well, ', "Let's see... ", 'Alright, ', 'Now then, ', 'Okay so, '];
  return pick(fillers);
}

export function naturalConfirmation(lang: 'es' | 'en'): string {
  return pick(lang === 'es' ? PERFECT_ES : PERFECT_EN);
}

export function naturalTransition(lang: 'es' | 'en'): string {
  const esOptions = ['Ahora bien,', 'Entonces,', 'Bueno, ahora', 'Oye, y', 'Mira,', 'Siguiente cosa:'];
  const enOptions = ['Now then,', 'So,', 'Alright, next up', "Moving on,", 'Okay so,', 'And now,'];
  return pick(lang === 'es' ? esOptions : enOptions);
}

// ── Backchanneling phrases ──────────────────────────────────────────
export const BACKCHANNEL_ES = [
  'Ajá',
  'Mm-hmm',
  'Entiendo',
  'Claro',
  'Sí, sí',
  'Ok',
  'Mhm',
] as const;

export const BACKCHANNEL_EN = [
  'Uh-huh',
  'Mm-hmm',
  'I see',
  'Right',
  'Okay',
  'Got it',
  'Mhm',
] as const;

// ── Reminder phrases (contextual nudges after silence) ──────────────
export const REMINDER_ES: Record<string, readonly string[]> = {
  askType: [
    '¿Sigues ahí? ¿Qué tipo de cita necesitas?',
    '¿Estás ahí? Puedo ayudarte con cotización, instalación o reparación.',
  ],
  askDate: [
    '¿Sigues ahí? ¿Para qué fecha quieres la cita?',
    'Cuando estés listo, dime qué fecha te conviene.',
  ],
  askTime: [
    '¿Sigues ahí? ¿A qué hora te gustaría?',
    'Tómate tu tiempo, dime la hora cuando estés listo.',
  ],
  askDuration: [
    '¿Todo bien? Lo estándar es una hora, ¿te parece bien?',
    '¿Sigues ahí? ¿Te parece bien una hora de duración?',
  ],
  confirmSummary: [
    '¿Entonces confirmamos la cita? Dime sí o no.',
    '¿Sigues ahí? Solo necesito que me confirmes.',
  ],
  askCustomerName: [
    '¿Sigues ahí? Necesito tu nombre para continuar.',
    'Cuando puedas, dime tu nombre completo.',
  ],
  default: [
    '¿Sigues ahí? Estoy aquí cuando estés listo.',
    '¿Todo bien? Tómate tu tiempo.',
  ],
};

export const REMINDER_EN: Record<string, readonly string[]> = {
  askType: [
    'Still there? What type of appointment do you need?',
    'Just checking — would you like a quote, installation, or repair?',
  ],
  askDate: [
    'Still there? What date works for you?',
    'Take your time — just let me know the date when you\'re ready.',
  ],
  askTime: [
    'Still there? What time would you like?',
    'No rush — just tell me the time when you\'re ready.',
  ],
  askDuration: [
    'Everything okay? Standard is one hour — does that work?',
    'Still there? One hour is the default — is that good?',
  ],
  confirmSummary: [
    'So, shall we confirm? Just say yes or no.',
    'Still there? I just need your confirmation.',
  ],
  askCustomerName: [
    'Still there? I need your name to continue.',
    'Whenever you\'re ready, just give me your full name.',
  ],
  default: [
    'Still there? I\'m here whenever you\'re ready.',
    'Everything okay? Take your time.',
  ],
};

export function getReminder(step: string, lang: 'es' | 'en'): string {
  const bank = lang === 'en' ? REMINDER_EN : REMINDER_ES;
  const phrases = bank[step] || bank['default']!;
  return pick(phrases);
}

export function enrichSsmlBody(text: string): string {
  let result = text;

  result = result.replace(/^[•\-\*]\s*/gm, '');
  result = result.replace(/^\d+\.\s*/gm, '');
  result = result.replace(/([A-Za-zÁÉÍÓÚáéíóúñÑ]+):\s+/g, '$1, ');

  result = result.replace(/\n\n/g, ' <break time="300ms"/> ');
  result = result.replace(/\n/g, ' <break time="150ms"/> ');

  result = result.replace(/\.\s+(?!<break)/g, '. <break time="250ms"/> ');
  result = result.replace(/!\s+(?!<break)/g, '! <break time="120ms"/> ');
  result = result.replace(/\?\s+(?!<break)/g, '? <break time="100ms"/> ');

  result = result.replace(/,\s+(?!<break)/g, ', <break time="150ms"/> ');

  result = result.replace(/\s+(pero|however|but|aunque|although)\s+/gi, ' <break time="80ms"/> $1 ');
  result = result.replace(/\s+(entonces|so|pues)\s+/gi, ' <break time="60ms"/> $1 ');

  result = result.replace(
    /(¡?Hola|Hello|Hi there|Hey|Buenos días|Good morning)/gi,
    '<emphasis level="moderate">$1</emphasis>',
  );

  result = result.replace(
    /(Perfecto|Perfect|Genial|Great|Awesome|Listo|Excelente|Excellent|Got it)/gi,
    '<emphasis level="moderate">$1</emphasis>',
  );

  result = result.replace(/(¿[^?]+\?)/g, '<prosody pitch="+2%">$1</prosody>');

  result = result.replace(/\b(\d{4,})\b/g, '<say-as interpret-as="telephone">$1</say-as>');

  result = result.replace(/(\d{1,2}:\d{2})/g, '<say-as interpret-as="time" format="hms24">$1</say-as>');

  return result;
}
