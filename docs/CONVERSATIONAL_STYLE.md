# Guía de estilo conversacional y tabla de frases

## Reglas de estilo (agente de voz)

- **Respuestas cortas:** 1–2 oraciones por turno. Evitar listas largas; dividir en pasos ("Te haré unas preguntas...").
- **Backchannels:** Cuando hay trabajo interno (p. ej. búsqueda en BlindsBook), usar una frase operativa breve: "Un momentito...", "Déjame checar...", "Dame un segundo..." (ES) / "One sec...", "Let me check...", "Bear with me..." (EN).
- **Tipos de mensaje:** Operativo = "dame un momento" / "give me a moment"; Informativo = confirmaciones, resúmenes, despedida.

## Tabla de frases por contexto (ES / EN)

| Contexto | ES (humanizer / uso) | EN (humanizer / uso) |
|----------|----------------------|----------------------|
| **Saludo (sin Caller ID)** | GREETINGS_ES + "¿Me podrías dar tu nombre...?" | GREETINGS_EN + "Could you give me your full name...?" |
| **Saludo (tras identificar)** | GREETINGS_ES `{name}` + HOW_CAN_HELP_ES | GREETINGS_EN `{name}` + HOW_CAN_HELP_EN |
| **Identificación correcta** | PERFECT_ES + nombre + HOW_CAN_HELP_ES | PERFECT_EN + nombre + HOW_CAN_HELP_EN |
| **Identificación fallida / no encontrado** | "No encontré X. ¿Podrías intentar con otro nombre...?" | "I couldn't find X. Could you try a different name...?" |
| **Espera / carga** | WAIT_ES | WAIT_EN |
| **Disculpa / no entendí** | SORRY_ES + "no te escuché..." | SORRY_EN + "I didn't catch that..." |
| **Confirmación (sí)** | PERFECT_ES / naturalConfirmation | PERFECT_EN / naturalConfirmation |
| **Despedida** | GOODBYE_ES | GOODBYE_EN |
| **Error / técnico** | "Estoy teniendo un problema técnico..." | "I'm having a technical hiccup..." |

Las constantes están en `src/dialogue/humanizer.ts` (GREETINGS_ES/EN, HOW_CAN_HELP_ES/EN, PERFECT_ES/EN, WAIT_ES/EN, SORRY_ES/EN, GOODBYE_ES/EN). Usar `pick()`, `naturalConfirmation()`, `naturalTransition()`, `maybeFiller()` cuando corresponda.
