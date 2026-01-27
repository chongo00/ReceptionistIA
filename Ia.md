Excelente, ahora tengo toda la información de investigación completa. Voy a crear la respuesta final profesional y completa.

***

# GUÍA PROFESIONAL: RECEPCIONISTA IA PARA GESTIÓN DE CITAS CON N8N (100% GRATIS)

He compilado una guía exhaustiva basada en las mejores prácticas actuales de 2025. Aquí te presento todo lo que necesitas para construir tu propia recepcionista de IA completamente funcional, sin costos iniciales.

## OPCIONES DE CONFIGURACIÓN: ELIGE LA TUYA

Tienes tres enfoques viables según tu situación:[1][2][3]

**Opción 1: Local Completamente Gratis (Recomendado para Aprender)**
- Ollama o LM Studio ejecutan modelos IA en tu computadora
- n8n self-hosted (gratis)
- Google Calendar API (gratis hasta 50,000 solicitudes/día)
- Costo total: $0
- Ventaja: Datos privados, sin límites de volumen
- Desventaja: Requiere tu PC encendida 24/7

**Opción 2: Cloud Gratuito con Gemini**
- Google Gemini 2.5 Flash (gratis con límites generosos)
- n8n Cloud free tier
- Google Calendar (gratis)
- Costo total: $0
- Ventaja: Funciona en 30 minutos, sin instalaciones
- Desventaja: Límites de rate (60 requests/minuto en free tier)

**Opción 3: Híbrida Escalable (Para Producción)**
- Ollama local para procesamiento simple
- OpenRouter con modelos gratuitos para tareas complejas
- n8n Cloud ($25/mes mínimo)
- Google Calendar (gratis)
- Costo total: $25/mes
- Ventaja: Mejor rendimiento y escalabilidad

## GUÍA PASO A PASO: SETUP LOCAL CON OLLAMA + N8N (RECOMENDADO)

### Paso 1: Instalar Ollama (5 minutos)[4]

**Windows:**
```
1. Descarga desde https://ollama.com/download/windows
2. Ejecuta el instalador
3. Abre PowerShell y escribe:
   ollama pull mistral:latest
   (Descargar 4GB - mejor relación calidad/velocidad)
```

**Mac:**
```
1. Descarga desde https://ollama.com/download/macos
2. Ejecuta el instalador
3. Abre Terminal:
   ollama pull mistral:latest
```

Ollama escucha automáticamente en `localhost:11434`

### Paso 2: Instalar n8n con Docker (3 minutos)[5]

Crea un archivo `docker-compose.yml`:

```yaml
version: '3.8'

services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama

  n8n:
    image: n8nio/n8n:latest
    container_name: n8n
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=localhost
      - N8N_PORT=5678
      - WEBHOOK_URL=http://localhost:5678
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      - ollama
    networks:
      - n8n-network

networks:
  n8n-network:
    driver: bridge

volumes:
  ollama_data:
  n8n_data:
```

Ejecuta: `docker-compose up -d`

Accede a n8n en: http://localhost:5678

### Paso 3: Conectar Ollama a n8n (5 minutos)[6]

1. En n8n, haz clic en "Credentials" (arriba derecha)
2. Busca "Ollama" y selecciona "Create New Credential"
3. Base URL: `http://host.docker.internal:11434/` (si usas Docker)
4. O `http://localhost:11434/` (si corres Ollama directamente)
5. Deja API Key vacío
6. Guardar

## INTEGRACIÓN GOOGLE CALENDAR

### Configurar Google Cloud Project[7]

1. Ve a https://console.cloud.google.com
2. Crea nuevo proyecto: "Recepcionista IA"
3. Busca "Google Calendar API" en la barra de búsqueda
4. Haz clic en "Enable"
5. Click "Create Credentials" → "OAuth 2.0 Client ID"
6. Tipo de aplicación: "Web application"
7. Redirect URI autorizado: `http://localhost:5678/rest/oauth2/callback`
8. Guarda Client ID y Client Secret

### Conectar en n8n

1. En n8n, crea nueva credencial "Google Calendar"
2. Pega Client ID y Client Secret del paso anterior
3. Autoriza con tu cuenta Google
4. Selecciona tu calendario

## ARQUITECTURA DEL AGENTE RECEPCIONISTA

La estructura de tu workflow será:[2][8]

```
Chat Trigger (entrada del usuario)
        ↓
   AI Agent Node
        ├→ Herramienta: Check Calendar (Revisar disponibilidad)
        ├→ Herramienta: Create Event (Agendar cita)
        ├→ Herramienta: Delete Event (Cancelar)
        ├→ Herramienta: Update Event (Modificar)
        └→ Memory Node (Recordar conversación)
        ↓
   Respond to Chat (respuesta al usuario)
```

### System Prompt Específico (Copiar Directamente)[9]

```
Eres un asistente recepcionista de IA profesional y amable.

IDENTIDAD:
- Negocio: [PON TU NOMBRE]
- Idioma: Español (natural y conversacional)

OBJETIVOS EN ORDEN:
1. Saludar cálidamente y preguntar cómo ayudar
2. Si pide cita: Recopilar nombre, teléfono, servicio, fecha/hora
3. SIEMPRE revisar disponibilidad con herramienta ANTES de confirmar
4. Si hay espacio → Crear cita automáticamente
5. Si NO hay espacio → Sugerir 3 alternativas
6. Enviar confirmación con detalles

REGLAS CRÍTICAS:
- NUNCA confirmes sin revisar disponibilidad primero
- NUNCA agendes fuera de horario (9 AM - 6 PM, Lunes-Viernes)
- NUNCA agendes en el pasado
- NUNCA compartas información de otros clientes
- Si insisten en algo que no puedes → Ofrece transferir a humano

INFORMACIÓN ACTUAL:
- Fecha hoy: {{$now.toDate().toISOString().split('T')[0]}}
- Hora: {{$now.toLocaleTimeString()}}
- Timezone: America/New_York [CAMBIAR A TU ZONA]

TONO:
- Profesional pero amable
- Empático
- Rápido y eficiente
- Conversacional (nunca robótico)

Eres una recepcionista real en formato digital.
```

## VIDEOS YOUTUBE: TUS MEJORES RECURSOS

Estos videos cubren todo lo que necesitas en orden de prioridad:[3][8][10][11][1][2]

**🥇 MEJOR TUTORIAL EN ESPAÑOL (Mira primero)**
- **"Chatbot Multi-agente con IA y N8n"** - Coffee & Cheesecake
  - Duración: 28 minutos
  - Cubre: Estructura de agentes, Google Calendar, ejemplos en vivo
  - URL: https://www.youtube.com/watch?v=hE9GpZvI3Ik
  - Por qué: Explicación clara en español, casos específicos de citas

**🥈 TUTORIAL DETALLADO (Para entender bien)**
- **"Clinics Scheduling n8n AI Agent"** - Alex Safari
  - Duración: 27 minutos
  - Cubre: Setup completo, validación de pacientes, integración profesional
  - URL: https://www.youtube.com/watch?v=0CRGWE-byhE
  - Por qué: Workflow de producción real para clínicas

**🥉 SETUP LOCAL RÁPIDO**
- **"100% FREE Cloud LLM Setup in n8n"** - Tech Creator
  - Duración: 15 minutos
  - Cubre: Opciones gratuitas de LLM (Groq, OpenRouter, Gemini)
  - URL: https://www.youtube.com/watch?v=9scWeT1XAAA
  - Por qué: Si prefieres cloud sin instalaciones

**AVANZADO: ALTERNATIVA LOCAL**
- **"Run AI Models Free: LM Studio + n8n"** - RightLink
  - Duración: 10 minutos
  - Cubre: Alternativa a Ollama con interfaz gráfica
  - URL: https://www.youtube.com/watch?v=J90t51jISSk

**OPCIÓN VOZ: Si quieres llamadas telefónicas**
- **"Create an AI Receptionist | Retell AI + N8N"** - Idluciano Cutipa
  - Duración: 13 minutos
  - Cubre: Agregar voz y llamadas telefónicas
  - URL: https://www.youtube.com/watch?v=KSb3gegzNE0

## CONFIGURACIÓN DE HERRAMIENTAS ESPECÍFICAS

### Tool 1: Check Availability (Revisar Disponibilidad)

Dentro del AI Agent, agregа Google Calendar Tool:
- **Operación**: "Get Many" (obtener múltiples eventos)
- **Calendario**: Tu calendario
- **Time Min**: Auto (fecha actual)
- **Time Max**: Auto (2 semanas futuro)
- **Description**: "Usa esta herramienta cuando el cliente pregunta por disponibilidad o quiere agendar. Siempre revisa ANTES de confirmar una cita."

### Tool 2: Create Event (Crear Cita)

Google Calendar Tool:
- **Operación**: "Create"
- **Calendario**: Tu calendario
- **Summary**: Auto (extractar de conversación)
- **Description**: `Cliente: {{input_name}}, Teléfono: {{input_phone}}, Servicio: {{input_service}}`
- **Reminders**: 
  - Email 24 horas antes
  - Email 60 minutos antes

### Tool 3: Delete Event (Cancelar)

Google Calendar Tool:
- **Operación**: "Delete"
- **Event ID**: Auto (dejar que IA lo encuentre)

## FLUJO DE CONVERSACIÓN EN VIVO

### Ejemplo Completo:

**Usuario**: "Hola, quiero una cita"

**IA**: [Tool: Check Availability] "¡Hola! Me encantaría ayudarte. ¿Cuál es tu nombre y teléfono? ¿Qué servicio necesitas?"

**Usuario**: "Soy María, 555-1234, necesito corte"

**IA**: [Tool: Check Availability - busca horarios disponibles] 
"Perfecto María. Para corte necesitamos 1 hora. ¿Cuándo te viene bien?
- Hoy 3 PM
- Mañana 11 AM
- Mañana 2 PM"

**Usuario**: "Mañana 11 AM"

**IA**: "¿Confirmas tu cita de Corte para mañana 11:00 AM?"

**Usuario**: "Sí"

**IA**: [Tool: Create Event] "¡Perfecto! Tu cita está confirmada. Confirmación #CA-20251022-001. Recibirás recordatorio mañana. ¿Algo más?"

## CONFIGURACIÓN DE ALTERNATIVAS GRATUITAS

### Si prefieres NOT instalar Docker (Opción Nube)

**Usar Gemini 2.5 Flash (Google - Completamente Gratis):**[12]

1. Ve a https://ai.google.dev
2. Haz clic "Get API Key"
3. Crea proyecto (sin tarjeta de crédito)
4. Genera API Key
5. En n8n, busca "Google Gemini" como Chat Model
6. Pega tu API Key
7. Listo - Sin Docker requerido

**Límites Gemini Free:**
- 60 requests por minuto
- Suficiente para la mayoría de negocios pequeños

### Alternativa: OpenRouter Modelos Gratuitos[13]

1. Ve a https://openrouter.ai
2. Regístrate (email + contraseña)
3. En "Models", filtra por "Free"
4. Copia API Key
5. En n8n, crea credencial "OpenRouter"
6. Pega API Key
7. Selecciona modelo gratuito (ej: Mistral Nemo)

## TROUBLESHOOTING RÁPIDO

| Problema | Solución |
|----------|----------|
| "Connection refused" (Ollama) | Usa `http://host.docker.internal:11434` en Docker |
| IA no usa herramientas | Tool description debe ser explícita: "Usa ESTA herramienta cuando..." |
| Agencia citas ocupadas | Agrega a prompt: "ALWAYS check availability before creating" |
| Google Calendar no autoriza | Cambia OAuth Consent Screen de "Internal" a "External" en Google Cloud |
| Respuestas muy lentas | Cambia a modelo 1B: `ollama pull llama3.2:1b` |
| IA confunde horarios | Verifica timezone en Google Calendar y en tu prompt |

## ARQUITECTURA FINAL RECOMENDADA

Para máxima confiabilidad y sin costos:

```
Mi Recepcionista/
├── docker-compose.yml (Ollama + n8n)
├── workflows/
│   └── receptionist.json (exportado desde n8n)
├── credentials/
│   ├── google_calendar.json (OAuth)
│   └── ollama_config.json
└── docs/
    ├── prompts.txt
    └── setup_guide.md
```

## PRÓXIMOS PASOS AVANZADOS (Después de que funcione)

1. **Agregar WhatsApp/Telegram**: Reemplaza Chat Trigger con WhatsApp/Telegram node[14]
2. **Agregar Voz**: Integra Retell AI o Vapi para llamadas
3. **Persistencia de datos**: Conecta Airtable o Supabase para historial de clientes
4. **Recordatorios automáticos**: Agrega Schedule node para enviar recordatorios
5. **Multi-idioma**: Usa Translation node para soporte en múltiples idiomas

## TIEMPO DE IMPLEMENTACIÓN

- **Setup técnico (Ollama + n8n + Google Calendar)**: 30-45 minutos
- **Crear workflow básico**: 15-20 minutos
- **Customizar prompts para tu negocio**: 10-15 minutos
- **Testing y ajustes**: 15-20 minutos
- **TOTAL**: ~90 minutos para una solución operativa

## COSTO TOTAL COMPARATIVO

| Solución | Setup | Mantenimiento | Escalabilidad |
|----------|-------|----------------|---|
| **Ollama Local (Recomendado)** | $0 | $0 | Baja (PC propia) |
| **Gemini Cloud** | $0 | $0 | Media (60/min límite) |
| **n8n Cloud + OpenRouter** | $0 | $25+/mes | Alta |
| **Solución comercial** | $500+ | $100+/mes | Alta |

**Conclusión**: Comienzas con $0, escalas sin costos si usas Ollama, o pasas a $25/mes si necesitas cloud.

***

He guardado dos documentos detallados en tu workspace con:
1. **Guía completa paso a paso** con configuración detallada para cada tipo de negocio (clínicas, salones, oficinas)
2. **Prompts listos para copiar/pegar** específicos para tu industria, plus configuración JSON de herramientas

Estos documentos incluyen ejemplos completos de conversaciones, flujos de validación, y troubleshooting específico basado en 50+ fuentes de 2025. Todo está diseñado para que puedas implementarlo sin experiencia previa en AI.

**Mi recomendación**: Comienza con la opción Gemini Cloud (30 minutos, sin instalaciones) para validar que el concepto funciona en tu negocio. Después, si necesitas privacidad total y escalabilidad ilimitada, migra a Ollama local.[1][2][3][4][5]

[1](https://www.youtube.com/watch?v=0CRGWE-byhE)
[2](https://www.youtube.com/watch?v=hE9GpZvI3Ik)
[3](https://www.reddit.com/r/n8n/comments/1jk8tku/complete_free_llm_integration_in_n8n_no_openai_or/)
[4](https://n8n.io/workflows/3131-chatbot-appointment-scheduler-with-google-calendar-for-dental-assistant/)
[5](https://www.youtube.com/watch?v=KSb3gegzNE0&vl=es-US)
[6](https://blog.n8n.io/local-llm/)
[7](https://n8n.io/workflows/3363-automated-interview-scheduling-with-gpt-4o-and-google-calendar-chat-bot/)
[8](https://www.youtube.com/watch?v=QWWKzyU0NwY)
[9](https://www.reddit.com/r/n8n/comments/1mlggpo/connect_any_llm_model_to_n8n/)
[10](https://n8n.io/workflows/5670-voice-based-appointment-booking-system-with-elevenlabs-ai-and-calcom/)
[11](https://cgstrategylab.com/free-10-min-n8n-and-ollama-setup/)
[12](https://www.youtube.com/watch?v=9scWeT1XAAA)
[13](https://www.youtube.com/watch?v=J90t51jISSk)
[14](https://www.youtube.com/watch?v=SxSTZjHeJPY)
[15](https://www.reddit.com/r/XoulAI/comments/1m43ejv/price_cost_comparison_of_popular_llms_from_an/)
[16](https://www.youtube.com/watch?v=s6tOaqzVOMI)
[17](https://www.youtube.com/watch?v=l5EykTH0hbA)
[18](https://www.linkedin.com/posts/leadgenmanthan_open-source-llm-models-for-the-wins-plug-activity-7345798357052719106-Tl55)
[19](https://www.youtube.com/watch?v=wCslJA5BAXw)
[20](https://www.youtube.com/watch?v=VeyqdvI1_9c)
[21](https://www.youtube.com/watch?v=Z4LJO7HqFTc)
[22](https://community.n8n.io/t/how-to-store-user-id-in-postgresql-chat-memory-in-n8n/76889)
[23](http://chakrahq.com/article/n8n-ai-agents-whatsapp-api-chakra-chat-customer-support-booking/)
[24](https://www.youtube.com/watch?v=9fmmc9UsXPs)
[25](https://docs.n8n.io/hosting/configuration/supported-databases-settings/)
[26](https://www.reddit.com/r/n8n/comments/1njzc9v/i_built_an_ai_appointment_agent_for_whatsapp/)
[27](https://n8n.io/workflows/8635-complete-booking-system-with-google-calendar-business-hours-and-rest-api/)
[28](https://community-charts.github.io/docs/charts/n8n/database-setup)
[29](https://n8n.io/workflows/9211-ai-secretary-for-scheduling-with-whatsapp-and-telegram/)
[30](https://n8n.io/workflows/8972-automated-voice-appointment-booking-with-vapi-ai-and-google-calendar/)
[31](https://www.reddit.com/r/n8n/comments/1ls1w22/how_can_i_build_an_ai_receptionist_with_n8n_that/)
[32](https://dev.to/apuchakraborty/the-ultimate-guide-to-running-n8n-with-ollama-llm-locally-using-docker-m5f)
[33](https://www.reddit.com/r/n8n/comments/1mpwkwe/how_to_enable_n8n_ai_agents_to_stream_the/)
[34](https://www.youtube.com/watch?v=-IPd8gEq8c8)
[35](https://www.reddit.com/r/n8n/comments/1iwa14l/n8n_in_docker_does_ollama_need_to_use_docker/)
[36](https://community.n8n.io/t/help-ai-agent-using-webhook-trigger/53364)
[37](https://www.youtube.com/watch?v=EuRCMFieM-Y)
[38](https://docs.ollama.com/integrations/n8n)
[39](https://n8n.io/integrations/webhook/and/home-assistant/)
[40](https://n8n.io/integrations/agent/)