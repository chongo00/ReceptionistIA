# Guía de Pruebas Manuales de Voz — Receptionist IA

> **Fecha:** Marzo 2026  
> **URL del simulador:** `http://localhost:4100/test/voice-test-v2.html`  
> **Navegador recomendado:** Chrome o Edge  

---

## Instrucciones generales

1. Abrir `http://localhost:4100/test/voice-test-v2.html` en Chrome/Edge
2. En cada guion se indica la **Configuracion** (compania, Caller ID)
3. Puedes usar **modo Voz** (microfono) o **modo Texto** (escribir en el campo de texto)
4. La barra inferior muestra en tiempo real: paso actual (`step`), cliente identificado, intentos

**Leyenda:**
- 🤖 = lo que dice la IA
- 🧑 = lo que tu dices/escribes
- ✅ = verificacion en la barra de estado

---

## Compañías y datos de prueba

| Selector (toNumber) | CompanyId | Compañía | Clientes |
|---|---|---|---|
| `+15550000001` | 2 | All Blinds Inc | ~7,747 |
| `+15550000002` | 163 | Sophie Blinds LLC | ~7,022 |
| `+15550000003` | 387 | Miami's Best Blinds | ~1,258 |

---

## GUION 1: Identificación automática por Caller ID (español)

**Cliente:** Maria Elena Rodriguez — Tel: `305-545-2936` — Compañía 2 (All Blinds Inc)

**Configuración:**
1. Escribir `305-545-2936` en el campo de búsqueda → **Buscar**
2. La tarjeta muestra: *Maria Elena Rodriguez, Compañía 2*
3. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 *"¡Hola, María Elena! Qué gusto escucharte. ¿En qué te puedo ayudar hoy?"*

**Verificación:**
- ✅ `step = greeting` — saludo directo sin pedir nombre
- ✅ `customerId` con valor numérico
- ✅ `customerConfirmedName = Maria Elena Rodriguez`

---

## GUION 2: Identificación automática (inglés)

**Cliente:** Brian Williams — Tel: `786-853-4538` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `786-853-4538` → tarjeta: *Brian Williams, Compañía 2*
3. Click en **Llamar**

**Diálogo:**

> 🤖 *"Welcome to BlindsBook. Para español presione 1, for English press 2."*

> 🧑 *(Click en **🇺🇸 English — Press 2**)*

> 🤖 *"Hey Brian! Great to hear from you. What can I do for you today?"*

> 🧑 `I need to schedule an appointment`

> 🤖 *"Of course! Is this visit for a quote, an installation, or a repair?"*

**Verificación:**
- ✅ `lang = en`
- ✅ `step = askType`
- ✅ `customerId` con valor — identificación automática

---

## GUION 3: Teléfono no registrado → búsqueda por nombre (Nivel 2)

**Cliente real:** Maria Elena Rodriguez — Compañía 2  
**Teléfono simulado:** `999-999-9999`

**Configuración:**
1. Click en **Nueva conversación**
2. Compañía: **All Blinds Inc (+15550000001)**
3. Caller ID: `999-999-9999`
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 *(Click en **🇪🇸 Español**)*

> 🤖 *"¡Hola! Bienvenido a BlindsBook, soy Sara. ¿Me podrías dar tu nombre completo o el número con el que te registraste?"*

> 🧑 `Maria Elena Rodriguez`

> 🤖 *"Encontré a María Elena Rodríguez. ¿Eres tú?"*

> 🧑 `sí`

> 🤖 *"¡Perfecto, María Elena! ¿En qué te puedo ayudar?"*

**Verificación:**
- ✅ `step = greeting`
- ✅ `customerId` con valor
- ✅ `identificationAttempts = 1`

---

## GUION 4: Nombre común con múltiples resultados (desambiguación)

**Cliente real:** Jorge Lopez — Tel: `786-239-4584` — Compañía 2  
**Caller ID simulado:** `999-888-7777`

**Configuración:**
1. Click en **Nueva conversación**
2. Compañía: **All Blinds Inc (+15550000001)**
3. Caller ID: `999-888-7777`
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook..."*

> 🧑 *(Español)*

> 🤖 *"Bienvenido. No reconozco este número. ¿Me podrías dar tu nombre completo?"*

> 🧑 `Jorge Lopez`

*(Si hay múltiples Jorge Lopez:)*

> 🤖 *"Encontré varios clientes con ese nombre: 1. Jorge Lopez (tel. ***4584), 2. Jorge Lopez (tel. ***2390). ¿Cuál eres tú?"*

> 🧑 `1`

> 🤖 *"¡Perfecto, Jorge López! ¿En qué te puedo ayudar?"*

*(Si solo hay uno:)*

> 🤖 *"Encontré a Jorge López. ¿Eres tú?"*

> 🧑 `sí`

**Verificación:**
- ✅ `step = greeting`
- ✅ `customerId` correcto para Jorge Lopez

---

## GUION 5: 3 intentos fallidos → Nivel 3 LLM (cliente nuevo)

**Compañía:** All Blinds Inc — Caller ID: `999-111-2222`

**Configuración:**
1. Click en **Nueva conversación**
2. Compañía: **All Blinds Inc (+15550000001)**
3. Caller ID: `999-111-2222`
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook..."*

> 🧑 *(Español)*

> 🤖 *"No reconozco este número. ¿Me podrías dar tu nombre completo?"*

> 🧑 `ZZZZZZ XXXXXX`

> 🤖 *"No encontré a ZZZZZZ XXXXXX. ¿Podrías intentar con otro nombre o teléfono?"*

> 🧑 `YYYYYY WWWWWW`

> 🤖 *"Tampoco encontré ese nombre..."*

> 🧑 `AAAAAA BBBBBB`

*(Activa Nivel 3 - Agente LLM)*

> 🤖 *"No he podido encontrarte. ¿Recuerdas el nombre de tu asesor de ventas, o es la primera vez que nos contactas?"*

> 🧑 `Es mi primera vez`

> 🤖 *"¿Te gustaría que te registre como cliente nuevo? Necesitaría tu nombre completo."*

> 🧑 `Sí, me llamo Roberto Gonzalez`

> 🤖 *"Te he registrado en el sistema, Roberto. ¿En qué te puedo ayudar?"*

**Verificación:**
- ✅ `step = llmFallback` activado en el 3er intento
- ✅ Nuevo `customerId` asignado
- ✅ `identificationAttempts = 3`

---

## GUION 6: Sin Caller ID → pide nombre directo

**Cliente real:** Mabel Mendoza — Compañía 163  
**Caller ID:** vacío

**Configuración:**
1. Click en **Nueva conversación**
2. Compañía: **Sophie Blinds LLC (+15550000002)**
3. Caller ID: **dejar en blanco**
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook..."*

> 🧑 *(Español)*

> 🤖 *"¡Hola! Bienvenido a BlindsBook, soy Sara. ¿Me podrías dar tu nombre completo o el número con el que te registraste?"*

> 🧑 `Mabel Mendoza`

> 🤖 *"Encontré a Mabel Mendoza. ¿Eres tú?"*

> 🧑 `sí`

> 🤖 *"¡Perfecto, Mabel! ¿En qué te puedo ayudar?"*

**Verificación:**
- ✅ Sin Caller ID → directo a Nivel 2
- ✅ `customerId` para compañía 163

---

## GUION 7: Multi-tenant — Compañía 163 (Sophie Blinds LLC)

**Cliente:** Paulino Hernandez — Tel: `786-236-0929` — Compañía 163

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `786-236-0929` → tarjeta: *Paulino Hernandez, Compañía 163*
3. Verificar que el dropdown cambió a Sophie Blinds LLC
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook..."*

> 🧑 *(Español)*

> 🤖 *"¡Hola, Paulino! Bienvenido a BlindsBook. ¿En qué te puedo ayudar?"*

**Verificación:**
- ✅ Cliente de compañía 163, NO de compañía 2
- ✅ `step = greeting` — identificación automática

---

## GUION 8: Flujo COMPLETO de cita — español

**Cliente:** Diosdado Fernandez — Tel: `305-362-1270` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `305-362-1270` → tarjeta: *Diosdado Fernandez, Compañía 2*
3. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook..."*

> 🧑 *(Español)*

> 🤖 *"¡Hola, Diosdado! ¿En qué te puedo ayudar hoy?"*

> 🧑 `quiero agendar una cita`

> 🤖 *"Con gusto. ¿La visita es para cotización, instalación o reparación?"*

> 🧑 `cotización`

> 🤖 *"Perfecto, agendaremos una cotización. ¿Para qué fecha te gustaría?"*

> 🧑 `mañana`

> 🤖 *"Anotado, [fecha de mañana]. ¿A qué hora te gustaría?"*

> 🧑 `a las 10 de la mañana`

> 🤖 *"La cita será el [fecha] a las 10:00 AM. La duración estándar es una hora. ¿Te parece bien?"*

> 🧑 `sí`

> 🤖 *"Perfecto, déjame confirmarte: Cotización para Diosdado Fernández el [fecha] a las 10:00 AM, 1 hora. ¿Todo bien?"*

> 🧑 `sí`

> 🤖 *"¡Listo, tu cita quedó registrada! Gracias por llamar a BlindsBook. ¡Que te vaya muy bien!"*

**Verificación:**
- ✅ `step = completed`
- ✅ Ejecutar `node scripts/check-appointments.cjs --last 1` — debe aparecer la cita

---

## GUION 9: Flujo completo en INGLÉS (fecha y hora juntas)

**Cliente:** Althea Mcmillan — Tel: `305-904-2387` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `305-904-2387` → tarjeta: *Althea Mcmillan, Compañía 2*
3. Click en **Llamar**

**Diálogo:**

> 🤖 *"Welcome to BlindsBook..."*

> 🧑 *(English)*

> 🤖 *"Hello, Althea! Welcome back. How can I help you?"*

> 🧑 `I need to schedule an appointment`

> 🤖 *"Of course! Is this for a quote, an installation, or a repair?"*

> 🧑 `installation`

> 🤖 *"Great, we'll schedule an installation. What date works for you?"*

> 🧑 `next Monday at 2 PM`

*(La IA detecta fecha y hora juntas — salta askTime)*

> 🤖 *"Perfect, next Monday at 2:00 PM. Standard duration is one hour. Sound good?"*

> 🧑 `yes`

> 🤖 *"Let me confirm: Installation for Althea McMillan on [date] at 2:00 PM, 1 hour. Is everything correct?"*

> 🧑 `yes`

> 🤖 *"All done — your appointment is set! Thanks for calling BlindsBook!"*

**Verificación:**
- ✅ `step = completed`
- ✅ `lang = en` en todo el flujo
- ✅ El paso `askTime` NO apareció

---

## GUION 10: Cancelar en confirmación y reiniciar

**Cliente:** Sonia Iglesias — Tel: `954-438-4043` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `954-438-4043` → tarjeta: *Sonia Iglesias, Compañía 2*
3. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook..."*

> 🧑 *(Español)*

> 🤖 *"¡Hola, Sonia! ¿En qué te puedo ayudar?"*

> 🧑 `necesito una cita`

> 🤖 *"¿La visita es para cotización, instalación o reparación?"*

> 🧑 `reparación`

> 🤖 *"¿Para qué fecha necesitas la reparación?"*

> 🧑 `el viernes`

> 🤖 *"El viernes [fecha]. ¿A qué hora?"*

> 🧑 `a las 3 de la tarde`

> 🤖 *"El viernes a las 3:00 PM, 1 hora. ¿Te parece bien?"*

> 🧑 `sí`

> 🤖 *"Reparación para Sonia Iglesias el viernes a las 3:00 PM, 1 hora. ¿Está correcto?"*

> 🧑 `no, quiero cambiarlo`

> 🤖 *"Sin problema, empecemos de nuevo. ¿La cita es para cotización, instalación o reparación?"*

*(El flujo vuelve a askType — NO se creó ninguna cita)*

> 🧑 `cotización`

> 🤖 *"Agendaremos una cotización. ¿Para qué fecha?"*

> 🧑 `el lunes`

> 🤖 *"El lunes [fecha]. ¿A qué hora?"*

> 🧑 `a las 11`

> 🤖 *"El lunes a las 11:00 AM, 1 hora. ¿Te parece bien?"*

> 🧑 `sí`

> 🤖 *"Cotización para Sonia Iglesias el lunes a las 11:00 AM. ¿Está correcto?"*

> 🧑 `sí`

> 🤖 *"¡Tu cita quedó registrada! Que tengas un buen día, Sonia."*

**Verificación:**
- ✅ Al decir "no" en confirmación → volvió a `askType` sin crear cita
- ✅ Se conservó la información del cliente (Sonia Iglesias, customerId)
- ✅ La segunda cita SÍ se creó en la BD
- ✅ `step = completed`

---

## GUION 11: Área code fuera de Florida (404 — Atlanta)

**Cliente:** Russ Nordahl — Tel: `404-384-2663` — Compañía 163

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `404-384-2663` → tarjeta: *Russ Nordahl, Compañía 163*
3. Click en **Llamar**

**Diálogo:**

> 🤖 *"Welcome to BlindsBook..."*

> 🧑 *(English)*

> 🤖 *"Hello, Russ! Welcome back. How can I help you today?"*

> 🧑 `I'd like to schedule a quote`

> 🤖 *"What date works for you?"*

> 🧑 `this Friday`

> 🤖 *"This Friday [date]. What time would you prefer?"*

> 🧑 `at 9 in the morning`

> 🤖 *"Friday at 9:00 AM, 1 hour. Does that work?"*

> 🧑 `yes`

> 🤖 *"Quote for Russ Nordahl on Friday at 9:00 AM. Is everything correct?"*

> 🧑 `yes`

> 🤖 *"Your appointment has been registered. Have a great day, Russ!"*

**Verificación:**
- ✅ Área code 404 no causó problemas
- ✅ Cliente de compañía 163 correctamente identificado
- ✅ `step = completed`

---

## GUION 12: Apellido difícil — test de calidad TTS

**Cliente:** Blake Lickteig — Tel: `305-522-1365` — Compañía 163

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `305-522-1365` → tarjeta: *Blake Lickteig, Compañía 163*
3. Asegurar que el audio/parlantes estén activos
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Welcome to BlindsBook..."*

> 🧑 *(English)*

> 🤖 *"Hello, Blake! Welcome back. How can I help you today?"*

> 🧑 `just checking in`

> 🤖 *"Of course! Is there anything I can help you with, like scheduling a quote, installation, or repair?"*

**Verificación:**
- ✅ La voz pronuncia "Blake" claramente
- ✅ "Lickteig" es inteligible
- ✅ Velocidad natural, pausas naturales entre oraciones

---

## GUION 13: Cliente en 2 compañías — compañía correcta

**Teléfono:** `305-323-2397` — Mabel Mendoza — Compañía 163

**Configuración:**
1. Escribir `305-323-2397` en búsqueda → **Buscar**
2. Verificar tarjeta y `toNumber` autocompletado para compañía 163
3. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido a BlindsBook..."*

> 🧑 *(Español)*

> 🤖 *"¡Hola, Mabel! ¿En qué te puedo ayudar?"*

> 🧑 `quiero una cita para cotizar`

> 🤖 *"Con gusto. ¿Para qué fecha?"*

> 🧑 `el miércoles en la tarde`

> 🤖 *"El miércoles [fecha]. ¿A qué hora exactamente?"*

> 🧑 `a las 2`

> 🤖 *"El miércoles a las 2:00 PM, 1 hora. ¿Te parece bien?"*

> 🧑 `sí`

> 🤖 *"Cotización para Mabel Mendoza el miércoles a las 2:00 PM. ¿Está correcto?"*

> 🧑 `sí`

> 🤖 *"¡Tu cita quedó registrada! Que tengas un buen día, Mabel."*

**Verificación:**
- ✅ `toNumber = +15550000002` (compañía 163)
- ✅ `customerId` para compañía 163
- ✅ `step = completed`

---

## GUION 14: Preguntas fuera de contexto durante el flujo

**Cliente:** Maria Elena Rodriguez — Tel: `305-545-2936` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `305-545-2936`, Click en **Llamar**
3. Español → identificación automática → `step = greeting`

**Diálogo — desvío en askType:**

> 🤖 *"¿En qué te puedo ayudar?"*

> 🧑 `¿Cuánto cuestan las cortinas?`

> 🤖 *"Nuestros precios dependen del tipo de cortina y medidas. Un asesor te puede dar todos los detalles. ¿Te gustaría agendar una cita de cotización, instalación o reparación?"*

**Verificación:** ✅ La IA respondió brevemente y redirigió al flujo

**Diálogo — desvío en askDate:**

> 🧑 `cotización`

> 🤖 *"¿Para qué fecha te gustaría?"*

> 🧑 `¿Tienen garantía en los productos?`

> 🤖 *"Sí, todos nuestros productos tienen garantía. Tu asesor te dará los detalles. Entonces, ¿para qué fecha te vendría bien la cotización?"*

**Verificación:** ✅ Respuesta breve + redirige a elegir fecha

**Diálogo — desvío en askTime:**

> 🧑 `mañana`

> 🤖 *"¿A qué hora te gustaría?"*

> 🧑 `¿Puedo ir en persona a la tienda?`

> 🤖 *"Claro, también puedes visitarnos. Pero para esta cita de cotización, ¿a qué hora te queda bien mañana?"*

**Verificación:** ✅ Responde y solicita la hora

**Diálogo — desvío en confirmSummary:**

> 🧑 `a las 10`

> 🤖 *"... 1 hora. ¿Te parece bien?"*

> 🧑 `sí`

> 🤖 *"Cotización para Maria Elena Rodriguez el [fecha] a las 10:00 AM. ¿Está correcto?"*

> 🧑 `espera, ¿puedo cambiar la fecha?`

> 🤖 *"Claro, dime 'no' para empezar de nuevo y podemos elegir otra fecha."*

**Verificación:** ✅ No confirmó ni rechazó hasta recibir respuesta clara

---

## GUION 15: Silencios y falta de respuesta

**Cliente:** Brian Williams — Tel: `786-853-4538` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `786-853-4538`, Click en **Llamar**
3. English → identificación automática

**Diálogo — primer silencio en askType:**

> 🤖 *"How can I help you today?"*

> 🧑 *(No decir nada por 5-8 segundos)*

> 🤖 *"Still there? What type of appointment do you need?"*

**Diálogo — segundo silencio:**

> 🧑 *(Silencio de nuevo)*

> 🤖 *"We offer quotes, installations, and repairs. Which one are you looking for?"*

**Diálogo — tercer silencio:**

> 🧑 *(Silencio)*

> 🤖 *"If you're having audio issues, you can type to me. I'm here whenever you're ready."*

**Verificación:**
- ✅ La IA maneja hasta 3 silencios con mensajes progresivos
- ✅ Sugiere modo texto como alternativa

---

## GUION 16: Barge-in — interrumpir la IA mientras habla

**Cliente:** Diosdado Fernandez — Tel: `305-362-1270` — Compañía 2

> **Requisito:** Este guion SOLO funciona con micrófono activo (modo voz)

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `305-362-1270`, Click en **Llamar**
3. Español → identificación automática

**Diálogo:**

> 🤖 *"¡Hola, Diosdado! Qué gusto escucharte..."* (la IA está hablando)

> 🧑 *(INTERRUMPIR hablando mientras la IA habla)* `quiero una cita de cotización para mañana a las 3`

> 🤖 *(Deja de hablar inmediatamente)* → Procesa tu mensaje → Responde

**Verificación:**
- ✅ La IA dejó de hablar cuando empezaste a hablar (barge-in)
- ✅ Tu texto fue procesado correctamente
- ✅ La barra de estado cambió de "speaking" a "listening" durante la interrupción
- ✅ No hubo audio superpuesto

---

## GUION 17: Cliente da su teléfono en vez de nombre (Nivel 2)

**Cliente real:** Paulino Hernandez — Tel real: `786-236-0929` — Compañía 163  
**Caller ID simulado:** vacío

**Configuración:**
1. Click en **Nueva conversación**
2. Compañía: **Sophie Blinds LLC (+15550000002)**
3. Caller ID: **vacío**
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido..."*

> 🧑 *(Español)*

> 🤖 *"¿Me podrías dar tu nombre completo o el número con el que te registraste?"*

> 🧑 `786-236-0929`

> 🤖 *"Encontré a Paulino Hernandez. ¿Eres tú?"*

> 🧑 `sí`

> 🤖 *"¡Perfecto, Paulino! ¿En qué te puedo ayudar?"*

**Verificación:**
- ✅ El sistema buscó por teléfono cuando el usuario dio un número
- ✅ `customerId` correcto

---

## GUION 18: Tipo + fecha + hora en una sola frase (flujo rápido)

**Cliente:** Maria Elena Rodriguez — Tel: `305-545-2936` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `305-545-2936`, Click en **Llamar**
3. Español → identificación automática

**Diálogo:**

> 🤖 *"¡Hola, María Elena! ¿En qué te puedo ayudar?"*

> 🧑 `necesito agendar una cotización para el lunes a las 2 de la tarde`

> 🤖 *"Perfecto, cotización el lunes [fecha] a las 2:00 PM. La duración estándar es 1 hora. ¿Te parece bien?"*

> 🧑 `sí`

> 🤖 *"Cotización para María Elena Rodriguez el lunes a las 2:00 PM. ¿Todo correcto?"*

> 🧑 `sí`

> 🤖 *"¡Tu cita quedó registrada! ¡Que te vaya bien!"*

**Verificación:**
- ✅ La IA extrajo tipo + fecha + hora de una sola frase
- ✅ Saltó `askType`, `askDate`, `askTime` → fue directo a duración
- ✅ `step = completed`

---

## GUION 19: Cita de reparación con duración personalizada

**Cliente:** Althea Mcmillan — Tel: `305-904-2387` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `305-904-2387`, Click en **Llamar**
3. English → identificación automática

**Diálogo:**

> 🤖 *"Hello, Althea! How can I help you?"*

> 🧑 `I need a repair appointment`

> 🤖 *"We'll schedule a repair. What date works for you?"*

> 🧑 `tomorrow at 10 AM`

> 🤖 *"Tomorrow at 10:00 AM. Standard duration is one hour. Sound good?"*

> 🧑 `actually I need two hours`

> 🤖 *"Repair for Althea McMillan on [date] at 10:00 AM, 2 hours. Is that correct?"*

> 🧑 `yes`

> 🤖 *"Your appointment is set! Have a great day, Althea!"*

**Verificación:**
- ✅ `duration = 02:00:00`
- ✅ El resumen muestra 2 horas
- ✅ `step = completed`

---

## GUION 20: Cita de instalación (tipo 1)

**Cliente:** Sonia Iglesias — Tel: `954-438-4043` — Compañía 2

**Configuración:**
1. Click en **Nueva conversación**
2. Buscar `954-438-4043`, Click en **Llamar**
3. Español → identificación automática

**Diálogo:**

> 🤖 *"¡Hola, Sonia! ¿En qué te puedo ayudar?"*

> 🧑 `quiero agendar la instalación`

> 🤖 *"Perfecto, agendaremos una instalación. ¿Para qué fecha?"*

> 🧑 `el próximo jueves`

> 🤖 *"El jueves [fecha]. ¿A qué hora?"*

> 🧑 `por la mañana, como a las 9`

> 🤖 *"El jueves a las 9:00 AM, 1 hora. ¿Te parece bien?"*

> 🧑 `sí`

> 🤖 *"Instalación para Sonia Iglesias el jueves a las 9:00 AM. ¿Está correcto?"*

> 🧑 `sí`

> 🤖 *"¡Tu cita quedó registrada! Que te vaya muy bien."*

**Verificación:**
- ✅ `type = 1` (instalación)
- ✅ `step = completed`

---

## GUION 21: Nivel 3 LLM — buscar por nombre del vendedor

**Compañía:** All Blinds Inc — Caller ID: `999-222-3333`

**Configuración:**
1. Click en **Nueva conversación**
2. Compañía: **All Blinds Inc (+15550000001)**
3. Caller ID: `999-222-3333`
4. Click en **Llamar**

**Diálogo:**

> 🤖 *"Bienvenido..."*

> 🧑 *(Español)*

> 🤖 *"No reconozco este número. ¿Me podrías dar tu nombre completo?"*

> 🧑 `Fernando Garcia` *(nombre que no existe o no coincide)*

> 🤖 *"No encontré a Fernando Garcia..."*

> 🧑 `Fernando Lopez` *(otro intento fallido)*

> 🤖 *"Tampoco encontré ese nombre..."*

> 🧑 `no sé cómo estoy registrado` *(3er intento → Nivel 3)*

> 🤖 *"No te preocupes. ¿Recuerdas el nombre de tu asesor de ventas?"*

> 🧑 `sí, me atendió [nombre de un asesor real del equipo]`

> 🤖 *(Busca al asesor, luego busca clientes de ese asesor)*

**Verificación:**
- ✅ `step = llmFallback`
- ✅ El agente LLM usó `searchTeamMembers` → `searchByAccountManager`
- ✅ Si encontró al cliente → `step = greeting`
- ✅ Si no → ofrece registrar como nuevo o transferir

---

## GUION 22: Reconexión — misma sesión

> **Objetivo:** Verificar que hacer una nueva conversación no deja sesiones colgadas

**Configuración:**
1. Iniciar cualquier guion anterior y llegar hasta `askType`
2. Click en **Nueva conversación** (sin colgar)
3. Iniciar una nueva sesión con otro cliente

**Verificación:**
- ✅ La sesión anterior se cerró limpiamente
- ✅ La nueva sesión funciona correctamente
- ✅ En los logs no hay errores de sesión huérfana

---

## Resumen de cobertura

| Guion | Nivel | Escenario | Idioma |
|---|---|---|---|
| 1 | Nivel 1 | Caller ID match único | ES |
| 2 | Nivel 1 | Caller ID match único | EN |
| 3 | Nivel 2 | Teléfono falso → nombre → 1 resultado | ES |
| 4 | Nivel 2 | Nombre común → desambiguación | ES |
| 5 | Nivel 3 | 3 fallos → LLM → cliente nuevo | ES |
| 6 | Nivel 2 | Sin Caller ID → pide nombre | ES |
| 7 | Nivel 1 | Multi-tenant — compañía 163 | ES |
| 8 | Completo | Cita completa español — todos los pasos | ES |
| 9 | Completo | Cita completa inglés — fecha+hora juntas | EN |
| 10 | Completo | Cancelar confirmación y reiniciar | ES |
| 11 | Completo | Área code fuera FL (404 Atlanta) | EN |
| 12 | TTS | Apellido difícil — calidad de voz | EN |
| 13 | Búsqueda | Cliente en 2 compañías | ES |
| 14 | Off-topic | Preguntas fuera de contexto en cada paso | ES |
| 15 | Silencio | Manejo de silencios progresivo | EN |
| 16 | Barge-in | Interrumpir la IA mientras habla | ES |
| 17 | Nivel 2 | Cliente da teléfono en vez de nombre | ES |
| 18 | Flujo rápido | Tipo + fecha + hora en una frase | ES |
| 19 | Duración | Reparación con duración personalizada (2h) | EN |
| 20 | Tipo | Instalación completa | ES |
| 21 | Nivel 3 | Buscar por nombre del vendedor | ES |
| 22 | Sesión | Reconexión — nueva conversación | — |

---

*Última actualización: Marzo 2026*
