/**
 * Parseo de fechas y horas en lenguaje natural (español e inglés).
 * Usa chrono-node como motor.
 */
import * as chrono from 'chrono-node';

export interface ParsedDateTime {
  /** Fecha completa en ISO 8601 (ej. "2026-02-16T10:00:00.000Z") */
  iso: string;
  /** Texto legible para confirmar al usuario */
  humanReadable: string;
  /** true si chrono pudo extraer tanto fecha como hora */
  hasTime: boolean;
}

/**
 * Intenta extraer una fecha/hora del texto usando chrono-node.
 * Soporta español e inglés: "mañana a las 3", "next Monday at 2 PM", etc.
 *
 * @param text   Lo que dijo el usuario
 * @param lang   Idioma de la conversación
 * @param refDate Fecha de referencia — por defecto ahora
 * @returns ParsedDateTime si se pudo parsear, null si no.
 */
export function parseDateTimeFromText(
  text: string,
  lang: 'es' | 'en',
  refDate?: Date,
): ParsedDateTime | null {
  const ref = refDate ?? new Date();

  // chrono-node tiene parsers dedicados para ES y EN
  const results =
    lang === 'es'
      ? chrono.es.parse(text, ref, { forwardDate: true })
      : chrono.en.parse(text, ref, { forwardDate: true });

  if (results.length === 0) return null;

  const best = results[0]!;
  const startComp = best.start;

  const date = startComp.date();
  const hasTime = startComp.isCertain('hour');

  // Texto legible
  const humanReadable = formatHumanDate(date, lang, hasTime);

  return {
    iso: date.toISOString(),
    humanReadable,
    hasTime,
  };
}

/**
 * Combina una fecha ya parseada con una hora del siguiente turno.
 * Útil cuando askDate capturó solo fecha y askTime capturó hora.
 */
export function mergeTimeIntoDate(
  existingISO: string,
  timeText: string,
  lang: 'es' | 'en',
): ParsedDateTime | null {
  const existingDate = new Date(existingISO);

  // Usar la fecha existente como referencia para que chrono solo extraiga la hora
  const results =
    lang === 'es'
      ? chrono.es.parse(timeText, existingDate, { forwardDate: true })
      : chrono.en.parse(timeText, existingDate, { forwardDate: true });

  if (results.length === 0) {
    // Intentar formatos directos: "10", "10:30", "3 pm", "15:00"
    const directTime = parseDirectTime(timeText);
    if (directTime) {
      const merged = new Date(existingDate);
      merged.setHours(directTime.hours, directTime.minutes, 0, 0);
      return {
        iso: merged.toISOString(),
        humanReadable: formatHumanDate(merged, lang, true),
        hasTime: true,
      };
    }
    return null;
  }

  const best = results[0]!;
  const date = best.start.date();
  return {
    iso: date.toISOString(),
    humanReadable: formatHumanDate(date, lang, true),
    hasTime: best.start.isCertain('hour'),
  };
}

/** Parse directo para "10", "10:30", "3pm", "15:00", "a las 10" */
function parseDirectTime(text: string): { hours: number; minutes: number } | null {
  const cleaned = text
    .toLowerCase()
    .replace(/a las/g, '')
    .replace(/at/g, '')
    .replace(/de la mañana/g, 'am')
    .replace(/de la tarde/g, 'pm')
    .replace(/de la noche/g, 'pm')
    .trim();

  // "3:30 pm", "10:00 am", "15:00"
  const match = cleaned.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1]!, 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridian = match[3]?.toLowerCase();

  if (meridian === 'pm' && hours < 12) hours += 12;
  if (meridian === 'am' && hours === 12) hours = 0;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return { hours, minutes };
}

function formatHumanDate(date: Date, lang: 'es' | 'en', includeTime: boolean): string {
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: lang === 'en',
  };

  const locale = lang === 'es' ? 'es-ES' : 'en-US';
  const datePart = date.toLocaleDateString(locale, dateOpts);

  if (!includeTime) return datePart;

  const timePart = date.toLocaleTimeString(locale, timeOpts);
  return lang === 'es' ? `${datePart} a las ${timePart}` : `${datePart} at ${timePart}`;
}
