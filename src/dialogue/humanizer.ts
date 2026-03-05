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
