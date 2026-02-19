# Plan de Implementacion - Opcion D: Identificacion Hibrida de Cliente

> **Proyecto**: Receptionist IA - BlindsBook
> **Version**: 1.0
> **Fecha**: 2026-02-19
> **Alcance**: Identificacion automatica de clientes en llamadas entrantes

---

## 1. CONTEXTO Y PROBLEMA ACTUAL

### 1.1 Estado actual del sistema

El flujo actual de identificacion de cliente en `src/dialogue/manager.ts` (linea 126-168) tiene estas limitaciones:

1. **No usa Caller ID (`From`)** — el numero de telefono del que llama se ignora para busqueda
2. **Sin cascade** — si `findCustomerIdBySearch()` no encuentra, loop infinito en `askCustomer`
3. **Toma el primer resultado** sin confirmar identidad con el llamante
4. **Sin manejo de multiples matches** — si hay 3 "Juan", toma el primero ciego
5. **Sin registro de clientes nuevos** — no puede capturar leads nuevos
6. **`findCustomerIdBySearch()`** retorna solo `id`, no nombre para confirmar

### 1.2 Arquitectura de los 3 proyectos

```
+---------------------------+     +---------------------------+     +---------------------------+
| Receptionist IA           |     | App-BlindsBook API        |     | Drapery-Calculator-Vue    |
| (Este proyecto)           |     | (NestJS + SQL Server)     |     | (Ionic/Vue + OCR)         |
| Puerto: 4000              |     | Puerto: 3000              |     |                           |
+---------------------------+     +---------------------------+     +---------------------------+
| - Express server          |     | - [Customer].Customers    |     | - App movil               |
| - Dialogo state machine   |---->| - [Customer].PhoneNumbers |     | - OCR de medidas          |
| - Twilio voice webhook    |     | - [Schedule].Events       |     | - Usa misma API           |
| - Piper TTS (Docker)      |     | - [Schedule].Appointments |     |                           |
| - Mini LLM (Ollama)  NEW |     | - [User].Users (team)     |     |                           |
+---------------------------+     +---------------------------+     +---------------------------+
        |                                    ^
        | HTTP REST                          |
        +-------- Bearer JWT (por compania) -+
```

### 1.3 Datos clave del schema

**Tabla `[Customer].PhoneNumbers`** (busqueda por Caller ID):
- `Id` (PK), `CustomerId` (FK), `Type` (int), `Number` (NVARCHAR(20))
- La API ya normaliza: quita `()-. ` y busca con `LIKE` + `REPLACE`

**Tabla `[Customer].Customers`**:
- `Id`, `CompanyId`, `FirstName`, `LastName`, `CompanyName`, `Email`, `AccountManagerId`
- Filtrado por `CompanyId` en cada query (multi-tenancy via JWT)

**Tabla `[User].Users`** (vendedores/team):
- `Id`, `CompanyId`, `FirstName`, `LastName`, `Username`, `Email`

**Endpoint existente `GET /api/customers?search=<term>`**:
- Busca en: FirstName, LastName, CompanyName, Email, PhoneNumbers
- Normaliza telefonos automaticamente
- Retorna: `{ data: { customers: [{id, firstName, lastName, ...}] } }`

---

## 2. SOLUCION: OPCION D — HIBRIDO PRAGMATICO

### 2.1 Principio de diseno

```
COSTO = $0 por llamada
LATENCIA OBJETIVO = <2 segundos por turno (niveles 1-2), <4 segundos (nivel 3 LLM)
```

- **Niveles 1-2**: Maquina de estados pura (TypeScript, 0 costo, <100ms)
- **Nivel 3**: Mini LLM local via Ollama (0 costo, corre en mismo servidor)
- **Sin dependencias de APIs pagadas** (no OpenAI, no Claude, no Azure AI)

### 2.2 Mini LLM: Ollama + Qwen2.5-3B

#### Por que Qwen2.5-3B-Instruct:

| Criterio | Qwen2.5-3B | Llama 3.1-8B | Phi-3.5-mini |
|---|---|---|---|
| **Espanol** | Excelente (entrenado multilingue) | Bueno | Regular |
| **RAM necesaria** | ~2.5 GB (Q4_K_M) | ~5.5 GB | ~3 GB |
| **Tool/Function calling** | Soportado nativo | Soportado nativo | Limitado |
| **Velocidad en CPU** | ~15-25 tokens/s | ~8-12 tokens/s | ~12-18 tokens/s |
| **Calidad para tarea simple** | Suficiente | Sobrado | Suficiente |

Qwen2.5-3B es el mejor balance entre calidad en espanol, velocidad y RAM para esta tarea especifica (identificar un cliente en 2-5 turnos de conversacion corta).

#### Requisitos del servidor:
- **RAM minima**: 4 GB libres (2.5 GB modelo + overhead)
- **CPU**: Cualquier CPU moderno (x64). Mas nucleos = mas rapido
- **Disco**: ~2 GB para el modelo cuantizado
- **GPU**: NO requerida (CPU es suficiente para 3B a <50 tokens/respuesta)

#### Instalacion de Ollama:

```bash
# Windows (descarga installer)
# https://ollama.com/download/windows

# O con Docker (recomendado para produccion)
docker run -d --name ollama -p 11434:11434 -v ollama_data:/root/.ollama ollama/ollama

# Descargar el modelo
ollama pull qwen2.5:3b

# Verificar que funciona
curl http://localhost:11434/api/generate -d '{"model":"qwen2.5:3b","prompt":"Hola","stream":false}'
```

#### Alternativa economica aun mas ligera (si RAM es limitada):
```bash
# Qwen2.5-1.5B — solo 1.2 GB RAM, calidad inferior pero funcional
ollama pull qwen2.5:1.5b

# Qwen2.5-0.5B — 500 MB RAM, minimo viable
ollama pull qwen2.5:0.5b
```

---

## 3. FLUJO COMPLETO DEL SISTEMA

### 3.1 Diagrama de flujo maestro

```
 LLAMADA ENTRANTE (Twilio o voice-test.html)
 ============================================
          |
          v
 +------------------+
 | IDENTIFICAR      |  To number -> TWILIO_NUMBER_TO_COMPANY_MAP
 | COMPANIA         |  -> CompanyId + JWT Token
 +------------------+  (Ya implementado en voiceWebhook.ts:24-32)
          |
          v
 +------------------+
 | SELECCION DE     |  "Para espanol presione 1. For English press 2."
 | IDIOMA           |  (Ya implementado - paso askLanguage)
 +------------------+
          |
          v
 +-----------------------------------------------+
 | NIVEL 1: CALLER ID AUTOMATICO                 |  <-- NUEVO
 | (Paso: identifyByCallerId)                     |
 |                                                |
 | From = "+15551234567"                          |
 | -> GET /api/customers?search=5551234567        |
 |                                                |
 | Resultado:                                     |
 |  0 matches -> ir a NIVEL 2                     |
 |  1 match   -> "Hola [nombre]! En que puedo     |
 |               ayudarle?" -> IDENTIFICADO        |
 |  N matches -> ir a DESAMBIGUAR                  |
 +-----------------------------------------------+
          |                    |                    |
     0 matches            1 match              N matches
          |                    |                    |
          v                    v                    v
 +-----------------+  +----------------+  +--------------------+
 | NIVEL 2:        |  | IDENTIFICADO   |  | DESAMBIGUAR        | <-- NUEVO
 | BUSCAR POR      |  | -> continuar   |  | (disambiguate)     |
 | NOMBRE/TELEFONO |  |    flujo cita  |  |                    |
 | (askCustomerName)|  +----------------+  | "Encontre varias   |
 |                 |                       |  cuentas. Me dice  |
 | "Podria darme   |                       |  su nombre?"       |
 |  su nombre o    |                       |                    |
 |  telefono?"     |                       | Usuario dice nombre|
 |                 |                       | -> filtrar matches |
 | -> buscar       |                       | -> confirmar       |
 | -> si 1 match:  |                       +--------------------+
 |    confirmar    |                                 |
 |    identidad    |                                 v
 | -> si N matches:|                       +--------------------+
 |    desambiguar  |                       | CONFIRMAR IDENTIDAD| <-- NUEVO
 | -> si 0 matches:|                       | (confirmIdentity)  |
 |    ir a NIVEL 3 |                       |                    |
 +-----------------+                       | "Es usted [Nombre  |
          |                                |  Apellido]?"       |
     0 matches                             | Si -> IDENTIFICADO |
          |                                | No -> volver atras |
          v                                +--------------------+
 +-----------------------------------------------+
 | NIVEL 3: MINI LLM (Ollama)                    |  <-- NUEVO
 | (Paso: llmFallback)                            |
 |                                                |
 | Conversacion libre con herramientas:           |
 | - searchCustomers(query)                       |
 | - searchTeamMembers(query)                     |
 | - createCustomer(firstName, lastName, phone)   |
 |                                                |
 | El LLM decide que preguntar:                   |
 | - "Recuerda quien le atendio?"                 |
 | - "Tiene otro numero de telefono?"             |
 | - "Desea registrarse como cliente nuevo?"      |
 |                                                |
 | Salidas posibles:                              |
 | -> Cliente encontrado -> IDENTIFICADO          |
 | -> Cliente nuevo creado -> IDENTIFICADO        |
 | -> No se pudo resolver -> transferir a humano  |
 +-----------------------------------------------+
          |
          v
 +----------------+
 | IDENTIFICADO   |
 | customerId OK  |
 +----------------+
          |
          v
 +------------------+
 | FLUJO NORMAL     |  (Ya implementado)
 | DE CITA          |
 | askType          |
 | askDate          |
 | askTime          |
 | askDuration      |
 | confirmSummary   |
 | createAppointment|
 | completed        |
 +------------------+
```

### 3.2 Cambio en el orden del flujo

**ANTES** (actual):
```
askLanguage -> greeting -> askType -> askCustomer -> askDate -> askTime -> ...
```

**DESPUES** (nuevo):
```
askLanguage -> identifyByCallerId -> [disambiguate|askCustomerName|llmFallback]
           -> confirmIdentity -> greeting (personalizado) -> askType -> askDate -> ...
```

El cambio fundamental es: **identificar al cliente ANTES de preguntar que tipo de cita quiere**. Esto permite:
- Saludo personalizado: "Hola Juan, bienvenido de vuelta"
- Si es cliente repetido, posiblemente ya sabemos que tipo de cita suele pedir
- Mejor experiencia de usuario

### 3.3 Nuevos estados de la conversacion

```typescript
export type ConversationStep =
  // ---- NUEVOS: Identificacion ----
  | 'askLanguage'              // (existente) idioma
  | 'identifyByCallerId'       // NUEVO: buscar por From automatico
  | 'disambiguateCustomer'     // NUEVO: multiples matches, pedir nombre
  | 'askCustomerName'          // NUEVO: pedir nombre/telefono (nivel 2)
  | 'confirmCustomerIdentity'  // NUEVO: "Es usted X?"
  | 'llmFallback'             // NUEVO: conversacion con mini LLM (nivel 3)
  // ---- EXISTENTES: Cita ----
  | 'greeting'                 // saludo personalizado
  | 'askType'                  // tipo de cita
  | 'askDate'                  // fecha
  | 'askTime'                  // hora
  | 'askDuration'              // duracion
  | 'askSaleOrderIfNeeded'     // orden de venta (instalacion)
  | 'askInstallationContact'   // contacto instalacion
  | 'askRemarks'               // notas
  | 'confirmSummary'           // confirmar resumen
  | 'creatingAppointment'      // creando cita
  | 'completed'                // terminado
  | 'fallback';               // error/reset
```

### 3.4 Nuevos campos en ConversationState

```typescript
export interface ConversationState {
  callId: string;
  language: 'es' | 'en';
  step: ConversationStep;

  // ---- NUEVOS: Identificacion ----
  callerPhone: string | null;           // From number de la llamada
  customerMatches: CustomerMatch[];     // Resultados de busqueda (cache)
  customerConfirmedName: string | null; // Nombre confirmado por el cliente
  identificationAttempts: number;       // Contador de intentos (max 3)
  llmConversationHistory: LlmMessage[]; // Historial para el LLM (nivel 3)

  // ---- EXISTENTES: Cita ----
  type: AppointmentType | null;
  customerId: number | null;
  customerNameSpoken: string | null;
  startDateISO: string | null;
  duration: string | null;
  status: AppointmentStatus;
  userId: number | null;
  saleOrderId: number | null;
  installationContactId: number | null;
  remarks: string | null;
}

export interface CustomerMatch {
  id: number;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  accountManagerId: number | null;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}
```

---

## 4. DETALLE DE CADA NIVEL

### 4.1 NIVEL 1 — Caller ID Automatico

**Trigger**: Inmediatamente despues de seleccionar idioma
**Input**: `From` number de Twilio (ej: `+15551234567`)
**Accion**: `GET /api/customers?search=5551234567` (sin +, sin formato)
**Costo**: $0 (llamada HTTP a tu propia API)
**Latencia**: ~50-200ms

```
Escenario A: 0 resultados
  -> state.step = 'askCustomerName' (nivel 2)
  -> "Bienvenido a [Compania]. No reconozco este numero.
      Podria darme su nombre completo o el telefono con el que se registro?"

Escenario B: 1 resultado
  -> state.customerId = match.id
  -> state.customerConfirmedName = "Juan Perez"
  -> state.step = 'greeting'
  -> "Hola Juan! Bienvenido de vuelta a [Compania]. En que puedo ayudarle hoy?"

Escenario C: 2-5 resultados
  -> state.customerMatches = matches
  -> state.step = 'disambiguateCustomer'
  -> "Encontre varias cuentas con ese numero.
      Podria decirme su nombre completo para verificar?"

Escenario D: +5 resultados (raro pero posible)
  -> Tratar como escenario A (demasiados para desambiguar por voz)
```

### 4.2 NIVEL 2 — Busqueda por nombre/telefono

**Trigger**: El caller ID no encontro match o necesita desambiguar
**Input**: Lo que el usuario diga (nombre, telefono, email)
**Accion**: `GET /api/customers?search=<lo_que_dijo>`
**Costo**: $0

```
El usuario dice: "Juan Perez" o "305-555-1234"

  -> Buscar en API
  -> 1 resultado: ir a confirmIdentity
     "Encontre a Juan Alberto Perez Rodriguez. Es usted?"
  -> N resultados: mostrar opciones
     "Encontre varios clientes con ese nombre:
      1. Juan Perez - telefono terminado en 4567
      2. Juan Perez Martinez - telefono terminado en 8901
      Cual es usted?"
  -> 0 resultados + attempts < 3: pedir de nuevo
     "No lo encontre. Puede intentar con otro nombre o numero?"
  -> 0 resultados + attempts >= 3: ir a nivel 3 (LLM)
```

### 4.3 CONFIRMAR IDENTIDAD

**Trigger**: Se encontro un posible match
**Input**: "si" / "no" del usuario

```
"Si" -> state.customerId = match.id
     -> state.step = 'greeting'
     -> "Perfecto, Juan. En que puedo ayudarle hoy?"

"No" -> volver a askCustomerName con attempts++
     -> "Disculpe la confusion. Podria darme su nombre exacto
        como aparece registrado?"
```

### 4.4 NIVEL 3 — Mini LLM (Ollama)

**Trigger**: Los niveles 1 y 2 no lograron identificar al cliente
**Motor**: Ollama + Qwen2.5-3B corriendo en `localhost:11434`
**Costo**: $0 (modelo local)
**Latencia esperada**: 2-4 segundos por turno (CPU)

#### System prompt para el LLM:

```
Eres la recepcionista virtual de una empresa de cortinas y persianas.
Tu UNICA tarea en este momento es identificar al cliente que esta llamando.

NO has podido encontrarlo por su numero de telefono ni por su nombre.

Herramientas disponibles:
- searchCustomers(query): Busca clientes por nombre, telefono o email
- searchTeamMembers(query): Busca vendedores/asesores del equipo
- createCustomer(firstName, lastName, phone): Registra un cliente nuevo

Reglas:
1. Pregunta cosas utiles: otro telefono, nombre del vendedor que le atendio, email
2. Usa las herramientas para buscar despues de cada respuesta
3. Si encuentras al cliente, responde con: [IDENTIFIED:customerId]
4. Si el cliente quiere registrarse como nuevo, usa createCustomer y responde con: [CREATED:customerId]
5. Si despues de 3 turnos no puedes resolver, responde con: [TRANSFER]
6. Se BREVE. Maximo 2 oraciones por respuesta.
7. Habla en {language}.
```

#### Tools disponibles para el LLM:

```json
[
  {
    "type": "function",
    "function": {
      "name": "searchCustomers",
      "description": "Busca clientes por nombre, telefono o email",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Termino de busqueda" }
        },
        "required": ["query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "searchTeamMembers",
      "description": "Busca vendedores o asesores del equipo por nombre",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Nombre del vendedor" }
        },
        "required": ["query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "createCustomer",
      "description": "Registra un cliente nuevo en el sistema",
      "parameters": {
        "type": "object",
        "properties": {
          "firstName": { "type": "string" },
          "lastName": { "type": "string" },
          "phone": { "type": "string" }
        },
        "required": ["firstName", "lastName", "phone"]
      }
    }
  }
]
```

#### Flujo del LLM:

```
Turno 1 (automatico, sin input de usuario):
  LLM: "No pude encontrarlo con la informacion anterior.
        Recuerda el nombre de su vendedor o asesor?"

  Usuario: "Me atendio Carlos"
  -> LLM llama: searchTeamMembers("Carlos")
  -> Resultado: [{id: 5, name: "Carlos Rodriguez"}]
  -> LLM llama: searchCustomers("Carlos Rodriguez AccountManager")
     (internamente filtramos por AccountManagerId=5)
  -> Resultado: [{id:101, name:"Maria Lopez"}, {id:102, name:"Pedro Ruiz"}]
  -> LLM: "Encontre clientes atendidos por Carlos: Maria Lopez y Pedro Ruiz.
           Es usted alguno de ellos?"

Turno 2:
  Usuario: "Soy Maria"
  -> LLM: [IDENTIFIED:101]
  -> Sistema extrae customerId=101, sale del nivel 3

--- O alternativamente ---

Turno 1:
  LLM: "No pude encontrarlo. Tiene otro numero de telefono o email?"
  Usuario: "No, es primera vez que llamo"
  LLM: "Entendido. Le gustaria que lo registre como cliente nuevo?
        Necesitaria su nombre completo."
  Usuario: "Si, soy Roberto Gonzalez"
  -> LLM llama: createCustomer("Roberto", "Gonzalez", "+15551234567")
  -> LLM: [CREATED:203]
```

---

## 5. ENDPOINTS NECESARIOS (App-BlindsBook API)

### 5.1 Endpoints que ya existen y se pueden usar directamente

| Endpoint | Uso | Estado |
|---|---|---|
| `GET /api/customers?search=<term>` | Buscar clientes por nombre/telefono | EXISTENTE - funciona para niveles 1-2 |
| `POST /api/customers` | Crear cliente nuevo | EXISTENTE - funciona para nivel 3 |
| `POST /api/customers/:id/phones` | Agregar telefono a cliente | EXISTENTE |
| `GET /api/appointments` | Buscar citas | EXISTENTE |
| `POST /api/appointments` | Crear cita | EXISTENTE |
| `POST /api/auth/login` | Obtener JWT | EXISTENTE |

### 5.2 Endpoint nuevo recomendado (opcional pero mejora rendimiento)

```
GET /api/customers/by-phone?phone=+15551234567
```

**Por que**: El endpoint actual `?search=` busca en 6 campos (nombre, email, etc.) y hace JOINs innecesarios cuando SOLO queremos buscar por telefono. Un endpoint dedicado seria:

```sql
SELECT c.Id, c.FirstName, c.LastName, c.CompanyName, c.AccountManagerId,
       p.Number as Phone
FROM [Customer].PhoneNumbers p
JOIN [Customer].Customers c ON p.CustomerId = c.Id
WHERE c.CompanyId = @companyId
  AND c.Enabled = 1
  AND REPLACE(REPLACE(REPLACE(REPLACE(p.Number,'-',''),'(',''),')',''),' ','')
      LIKE '%' + @normalizedPhone + '%'
```

**Impacto**: Query mas rapida (~2x), menos carga en BD. No es bloqueante — se puede usar `?search=` mientras se implementa.

### 5.3 Endpoint nuevo para buscar team members por nombre

```
GET /api/team/members?search=<nombre>
```

Ya existe `GET /api/team/members` pero necesita verificar que soporte filtro por nombre. Si no, agregar parametro `search` que busque en `FirstName + LastName`.

---

## 6. CAMBIOS EN EL CODIGO DE RECEPTIONIST IA

### 6.1 Archivos a modificar

| Archivo | Cambio | Complejidad |
|---|---|---|
| `src/dialogue/state.ts` | Nuevos tipos de step, nuevos campos en state | Baja |
| `src/dialogue/manager.ts` | Nuevos cases en switch: 5 pasos nuevos | Media-Alta |
| `src/blindsbook/appointmentsClient.ts` | Nuevos metodos: `findCustomersByPhone()`, `searchTeamMembers()`, etc. | Media |
| `src/config/env.ts` | Nueva variable `OLLAMA_URL` | Baja |
| `src/twilio/voiceWebhook.ts` | Pasar `From` number al state al inicio | Baja |
| `src/server.ts` | Pasar `callerPhone` simulado en debug endpoints | Baja |
| `public/voice-test.html` | Campo para simular caller phone | Baja |

### 6.2 Archivo nuevo

| Archivo | Proposito |
|---|---|
| `src/llm/ollamaClient.ts` | Cliente HTTP para Ollama API con function calling |
| `src/llm/identificationAgent.ts` | Logica del agente LLM para nivel 3 |

### 6.3 Variables de entorno nuevas

```env
# Ollama (Mini LLM local)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b

# (Sin API key — Ollama es local y sin autenticacion)
```

---

## 7. DETALLES TECNICOS DEL CLIENTE OLLAMA

### 7.1 API de Ollama para function calling

Ollama expone una API compatible con OpenAI en `POST /api/chat`:

```typescript
// src/llm/ollamaClient.ts

interface OllamaChatRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }>;
  tools?: Tool[];
  stream: false;
}

interface OllamaChatResponse {
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: ToolCall[];
  };
  done: boolean;
}

// Llamada:
const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
  model: 'qwen2.5:3b',
  messages: conversationHistory,
  tools: customerIdentificationTools,
  stream: false,
});
```

### 7.2 Ciclo tool-calling del LLM

```
1. Enviar historial + tools a Ollama
2. Si respuesta tiene tool_calls:
   a. Ejecutar cada tool (llamada HTTP a App-BlindsBook API)
   b. Agregar resultado como mensaje role=tool
   c. Volver a paso 1 (max 3 iteraciones)
3. Si respuesta es texto plano:
   a. Parsear marcadores [IDENTIFIED:id], [CREATED:id], [TRANSFER]
   b. Si marcador encontrado: resolver y salir del nivel 3
   c. Si texto normal: devolver como respuesta al usuario, esperar siguiente turno
```

### 7.3 Limites de seguridad

```typescript
const LLM_LIMITS = {
  maxTurnsPerCall: 5,          // Max turnos de conversacion en nivel 3
  maxToolCallsPerTurn: 3,      // Max herramientas por respuesta del LLM
  maxTotalToolCalls: 10,       // Max total de herramientas en toda la sesion
  timeoutPerRequest: 15_000,   // 15 segundos timeout para Ollama
  maxResponseTokens: 150,      // Respuestas cortas (es voz, no chat)
};
```

---

## 8. PRUEBAS LOCALES CON voice-test.html

### 8.1 Cambios en voice-test.html

Agregar campo para simular el numero del llamante (Caller ID):

```html
<div class="row">
  <label>Caller ID:</label>
  <input type="text" id="callerPhone" value="+15551234567"
         placeholder="+1XXXXXXXXXX (simula el From)" />
</div>
```

Modificar `sendToServer()` para enviar el callerPhone:

```javascript
const body = {
  callId,
  text,
  toNumber: getToNumber(),
  fromNumber: document.getElementById('callerPhone').value || null  // NUEVO
};
```

### 8.2 Cambios en POST /debug/voice-chat

```typescript
// server.ts - agregar fromNumber al flujo
const fromNumber = typeof req.body?.fromNumber === 'string' ? req.body.fromNumber : null;

// Pasar fromNumber al state para que el nivel 1 lo use
if (fromNumber) {
  const state = getConversationState(callId);
  if (!state.callerPhone) {
    state.callerPhone = fromNumber;
    setConversationState(callId, state);
  }
}
```

### 8.3 Escenarios de prueba

| # | Escenario | Caller ID | Input esperado | Resultado esperado |
|---|---|---|---|---|
| 1 | Cliente existente, 1 match por telefono | +1XXXX (registrado) | (ninguno) | "Hola [nombre]!" |
| 2 | Telefono con multiples clientes | +1XXXX (compartido) | Nombre | Desambiguacion |
| 3 | Telefono no registrado, cliente existe | +1YYYY (nuevo) | Nombre correcto | Encontrado via nombre |
| 4 | Cliente totalmente nuevo | +1ZZZZ | "Es primera vez" | Nivel 3 LLM -> registrar |
| 5 | Cliente conoce vendedor | +1ZZZZ | Nombre vendedor | Nivel 3 -> buscar por vendedor |
| 6 | Timeout del LLM | +1ZZZZ | (cualquiera) | Fallback: "Registrar como nuevo?" |

### 8.4 Como ejecutar pruebas

```bash
# Terminal 1: Ollama (si no esta como servicio)
ollama serve

# Terminal 2: App-BlindsBook API
cd "D:\Disco E trabajos\repositorio_blindsbook\App-BlindsBook\api"
npm run start:dev

# Terminal 3: Receptionist IA
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
npm run dev

# Terminal 4: Piper TTS Docker (opcional, para audio)
docker start blindsbook-ia

# Navegador: http://localhost:4000/test/voice-test.html
```

---

## 9. PLAN DE TRABAJO — FASES DE IMPLEMENTACION

### FASE 1: Infraestructura (Cimientos)

**Que se hace:**
- Instalar Ollama en la maquina de desarrollo
- Descargar modelo `qwen2.5:3b`
- Crear `src/llm/ollamaClient.ts` con cliente HTTP basico
- Agregar `OLLAMA_URL` y `OLLAMA_MODEL` a `env.ts`
- Test unitario: verificar que Ollama responde

**Archivos:**
- `src/config/env.ts` (modificar)
- `src/llm/ollamaClient.ts` (nuevo)
- `.env.example` (modificar)

**Criterio de aceptacion:** `curl localhost:11434/api/chat` devuelve respuesta coherente en espanol.

---

### FASE 2: Expandir estado y client API

**Que se hace:**
- Expandir `ConversationState` con nuevos campos
- Expandir `ConversationStep` con nuevos pasos
- Agregar metodos en `appointmentsClient.ts`:
  - `findCustomersByPhone(phone)` -> retorna array de CustomerMatch
  - `searchCustomers(query)` -> retorna array de CustomerMatch (refactor del existente)
  - `searchTeamMembers(query)` -> retorna array de {id, name}
  - `createNewCustomer(firstName, lastName, phone)` -> retorna {id}
- Agregar funcion `normalizePhoneForSearch(phone)` (quitar +, espacios, guiones)

**Archivos:**
- `src/dialogue/state.ts` (modificar)
- `src/blindsbook/appointmentsClient.ts` (modificar)

**Criterio de aceptacion:** Llamar `findCustomersByPhone('+15551234567')` retorna array correcto contra la API real.

---

### FASE 3: Nivel 1 — Caller ID automatico

**Que se hace:**
- Agregar paso `identifyByCallerId` en `manager.ts`
- Capturar `From` en `voiceWebhook.ts` y guardarlo en state
- Capturar `fromNumber` en `server.ts` endpoints de debug
- Logica: buscar por telefono -> 0/1/N matches -> decidir siguiente paso
- Agregar campo callerPhone en `voice-test.html`

**Archivos:**
- `src/dialogue/manager.ts` (modificar — nuevo case)
- `src/twilio/voiceWebhook.ts` (modificar — guardar From en state)
- `src/server.ts` (modificar — pasar fromNumber)
- `public/voice-test.html` (modificar — campo Caller ID)

**Criterio de aceptacion:** Con un telefono registrado en la BD, la IA saluda por nombre automaticamente.

---

### FASE 4: Nivel 2 — Busqueda por nombre + desambiguacion + confirmacion

**Que se hace:**
- Agregar pasos `askCustomerName`, `disambiguateCustomer`, `confirmCustomerIdentity` en `manager.ts`
- Logica de desambiguacion: si hay N matches, listar los primeros 3 con datos parciales
- Logica de confirmacion: "Es usted X?" -> si/no
- Contador de intentos (max 3 antes de ir a nivel 3)
- Reemplazar el antiguo paso `askCustomer` con la nueva logica

**Archivos:**
- `src/dialogue/manager.ts` (modificar — 3 nuevos cases)

**Criterio de aceptacion:**
- Buscar "Juan" devuelve lista si hay multiples Juanes
- Confirmar "si" identifica correctamente
- Despues de 3 intentos fallidos, pasa a nivel 3

---

### FASE 5: Nivel 3 — Agente LLM con tools

**Que se hace:**
- Crear `src/llm/identificationAgent.ts` con:
  - System prompt (seccion 4.4 de este documento)
  - Tool definitions (searchCustomers, searchTeamMembers, createCustomer)
  - Ciclo de tool-calling (llamar Ollama -> ejecutar tools -> repetir)
  - Parseo de marcadores [IDENTIFIED:id], [CREATED:id], [TRANSFER]
  - Limites de seguridad (max turnos, max tools, timeout)
- Agregar paso `llmFallback` en `manager.ts`
- Integrar historial de conversacion LLM en el state

**Archivos:**
- `src/llm/identificationAgent.ts` (nuevo)
- `src/dialogue/manager.ts` (modificar — nuevo case llmFallback)

**Criterio de aceptacion:**
- El LLM puede encontrar un cliente buscando por vendedor
- El LLM puede registrar un cliente nuevo
- Si Ollama no esta disponible, fallback a "registrar como nuevo"

---

### FASE 6: Integracion completa + pruebas end-to-end

**Que se hace:**
- Conectar todos los niveles en secuencia fluida
- Probar los 6 escenarios de la seccion 8.3
- Verificar que el flujo de cita completo funciona despues de identificacion
- Probar con Twilio real (ngrok + numero de prueba)
- Ajustar prompts del LLM segun resultados
- Probar con datos reales de la BD de produccion (en staging)

**Archivos:**
- Todos los anteriores (ajustes finos)

**Criterio de aceptacion:**
- Los 6 escenarios de prueba pasan correctamente
- Flujo completo: llamada -> identificacion -> cita creada en BD
- audio TTS suena natural en cada paso

---

### FASE 7: Limpieza para produccion

**Que se hace:**
- Eliminar `public/voice-test.html` (o moverlo a rama de dev)
- Configurar Ollama como servicio del sistema o contenedor Docker
- Agregar health check de Ollama en `/health`
- Agregar logs estructurados: nivel de identificacion usado, tiempo de respuesta
- Agregar metricas: % de llamadas resueltas en nivel 1, 2, 3
- Documentar configuracion de produccion

**Archivos:**
- `src/server.ts`
- `docker-compose.yml` (nuevo o modificar existente)
- `.env.production.example` (nuevo)

---

## 10. DOCKER COMPOSE — STACK COMPLETO (PRODUCCION)

```yaml
version: '3.8'

services:
  blindsbook-ia:
    build: .
    ports:
      - "4000:4000"
    environment:
      - PORT=4000
      - BLINDSBOOK_API_BASE_URL=http://host.docker.internal:3000
      - OLLAMA_URL=http://ollama:11434
      - OLLAMA_MODEL=qwen2.5:3b
      - DOCKER_TTS_URL=http://blindsbook-tts:8000
      # ... resto de variables
    depends_on:
      - ollama

  ollama:
    build:
      context: .
      dockerfile: Dockerfile.ollama-preloaded
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    deploy:
      resources:
        limits:
          memory: 4G

  # blindsbook-tts:
  #   image: blindsbook-ia:latest  # Piper TTS + OCR existente
  #   ports:
  #     - "8000:8000"

volumes:
  ollama_data:
```

---

## 11. ESTIMACION DE RECURSOS EN PRODUCCION

### Por llamada:

| Componente | Nivel 1 | Nivel 2 | Nivel 3 |
|---|---|---|---|
| **CPU** | ~1ms | ~1ms | ~2-8s (inferencia LLM) |
| **RAM** | 0 MB extra | 0 MB extra | 0 MB extra (modelo ya cargado) |
| **Red** | 1 HTTP call | 1-3 HTTP calls | 3-10 HTTP calls |
| **Costo** | $0 | $0 | $0 |
| **% llamadas estimado** | ~70% | ~20% | ~10% |

### Servidor (siempre on):

| Recurso | Cantidad |
|---|---|
| **RAM total** | ~4 GB (Ollama 2.5GB + Node 500MB + TTS 1GB) |
| **CPU** | 2-4 cores recomendado |
| **Disco** | ~5 GB (modelo + TTS voices + app) |
| **Llamadas simultaneas** | ~5-10 (limitado por LLM en CPU) |

---

## 12. PLAN DE CONTINGENCIA

### Si Ollama no responde (timeout/crash):

```typescript
// En identificationAgent.ts
try {
  const llmResponse = await callOllama(messages, tools);
  // ... procesar
} catch (error) {
  // Fallback: ofrecer registrar como nuevo directamente
  return {
    replyText: t(
      'Disculpe, estoy teniendo dificultades. Le gustaria que lo registre como cliente nuevo?',
      'Sorry, I am having difficulties. Would you like me to register you as a new customer?'
    ),
    nextStep: 'offerNewRegistration'
  };
}
```

### Si la API de BlindsBook no responde:

```typescript
// En appointmentsClient.ts - ya existe try/catch
// Agregar retry con backoff exponencial: 1s -> 2s -> 4s
// Max 2 retries antes de informar al usuario
```

### Si el modelo no cabe en RAM:

```bash
# Bajar a modelo mas pequeno
ollama pull qwen2.5:1.5b
# O usar cuantizacion mas agresiva
ollama pull qwen2.5:3b-q4_0  # ~2GB en vez de 2.5GB
```

---

## 13. METRICAS A RASTREAR

Una vez en produccion, loguear estas metricas para optimizar:

```typescript
interface CallMetrics {
  callId: string;
  companyId: number;
  identificationLevel: 1 | 2 | 3;      // En que nivel se resolvio
  identificationMethod: 'callerId' | 'nameSearch' | 'llm' | 'newCustomer';
  identificationTimeMs: number;          // Tiempo total de identificacion
  llmTurns?: number;                     // Si nivel 3: cuantos turnos
  llmToolCalls?: number;                 // Si nivel 3: cuantas tools
  totalCallDurationMs: number;           //  Duracion total de la llamada
  appointmentCreated: boolean;           // Si se creo cita exitosamente
  language: 'es' | 'en';
}
```

Objetivo: >90% de llamadas resueltas en nivel 1 dentro del primer mes (a medida que se registran telefonos de clientes).

---

## 14. DOCKERIZACION COMPLETA — COMANDOS DE SETUP

> **IMPORTANTE**: Esta seccion contiene los comandos que debes ejecutar manualmente
> para montar todo el stack en Docker. El codigo ya esta implementado.

### 14.1 Ollama en Docker — Confirmado que funciona

Ollama tiene imagen oficial Docker (`ollama/ollama`) que funciona en Linux containers.
El modelo se puede pre-descargar al iniciar el contenedor.

### 14.2 Dockerfile para BlindsBook IA

Crear `Dockerfile` en la raiz del proyecto:

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

RUN npm run build

EXPOSE 4000

CMD ["node", "dist/index.js"]
```

### 14.3 docker-compose.yml completo

Crear `docker-compose.yml` en la raiz del proyecto:

```yaml
version: '3.8'

services:
  # ── BlindsBook IA - CallCenter (Node.js) ──
  blindsbook-ia:
    build: .
    ports:
      - "4000:4000"
    environment:
      - PORT=4000
      - BLINDSBOOK_API_BASE_URL=${BLINDSBOOK_API_BASE_URL:-http://host.docker.internal:3000}
      - BLINDSBOOK_API_TOKEN=${BLINDSBOOK_API_TOKEN:-}
      - BLINDSBOOK_LOGIN_EMAIL=${BLINDSBOOK_LOGIN_EMAIL:-}
      - BLINDSBOOK_LOGIN_PASSWORD=${BLINDSBOOK_LOGIN_PASSWORD:-}
      - TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN:-}
      - TWILIO_NUMBER_TO_COMPANY_MAP=${TWILIO_NUMBER_TO_COMPANY_MAP:-}
      - TWILIO_VALIDATE_SIGNATURE=false
      - PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:4000}
      - DOCKER_TTS_URL=http://blindsbook-tts:8000
      - OLLAMA_URL=http://ollama:11434
      - OLLAMA_MODEL=${OLLAMA_MODEL:-qwen2.5:3b}
      - AZURE_SPEECH_KEY=${AZURE_SPEECH_KEY:-}
      - AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION:-}
    depends_on:
      ollama:
        condition: service_started
    restart: unless-stopped

  # ── Ollama + Qwen2.5-3B (modelo pre-cargado en la imagen) ──
  ollama:
    build:
      context: .
      dockerfile: Dockerfile.ollama-preloaded
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    deploy:
      resources:
        limits:
          memory: 4G
    restart: unless-stopped

  # ── Piper TTS (descomentar si quieres incluirlo en este compose) ──
  # blindsbook-tts:
  #   image: blindsbook-ia:latest
  #   ports:
  #     - "8000:8000"
  #   restart: unless-stopped

volumes:
  ollama_data:
```

### 14.4 Comandos para levantar todo

```bash
# ── PASO 1: Construir y levantar el stack ──
# (La primera vez construira la imagen de Ollama con el modelo pre-cargado, tarda ~5-10 min)
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
docker compose up -d --build

# ── PASO 2: Verificar que los contenedores estan corriendo ──
docker compose ps
# Deben aparecer: blindsbook-ia y ollama

# ── PASO 3: Verificar que todo esta corriendo ──
# Health check de BlindsBook IA:
curl http://localhost:4000/health
# -> {"ok":true,"service":"blindsbook-ia","status":"healthy","ollama":"connected"}

# Health check de Ollama:
curl http://localhost:11434/api/tags
# -> Debe listar qwen2.5:3b (ya viene pre-cargado en la imagen)

# Test rapido del modelo:
curl http://localhost:11434/api/generate -d "{\"model\":\"qwen2.5:3b\",\"prompt\":\"Hola\",\"stream\":false}"

# ── PASO 4: Abrir la interfaz de prueba ──
# Navegador: http://localhost:4000/test/voice-test.html
```

### 14.5 Dockerfile con modelo pre-cargado

El modelo LLM ya viene incluido en la imagen Docker de Ollama gracias a `Dockerfile.ollama-preloaded`:

```dockerfile
# Dockerfile.ollama-preloaded
FROM ollama/ollama:latest

# Iniciar ollama en background, descargar modelo, y parar
RUN ollama serve & \
    sleep 5 && \
    ollama pull qwen2.5:3b && \
    sleep 2 && \
    kill %1

EXPOSE 11434
ENTRYPOINT ["/bin/ollama"]
CMD ["serve"]
```

Esto genera una imagen mas grande (~3GB) pero elimina completamente la necesidad de descargar el modelo manualmente. Al hacer `docker compose up -d --build`, todo queda listo.

### 14.6 Variables de entorno (.env)

Crear archivo `.env` en la raiz del proyecto:

```env
# ── BlindsBook API ──
BLINDSBOOK_API_BASE_URL=http://host.docker.internal:3000
BLINDSBOOK_API_TOKEN=
BLINDSBOOK_LOGIN_EMAIL=karla1@blindsbook.com
BLINDSBOOK_LOGIN_PASSWORD=tu_password_aqui

# ── Twilio ──
TWILIO_AUTH_TOKEN=
TWILIO_NUMBER_TO_COMPANY_MAP={"\\"+15550000001\\"":{"token":"tu_jwt_token","companyId":387}}
TWILIO_VALIDATE_SIGNATURE=false

# ── Ollama (no necesita API key) ──
OLLAMA_URL=http://ollama:11434
OLLAMA_MODEL=qwen2.5:3b

# ── TTS ──
DOCKER_TTS_URL=http://blindsbook-tts:8000
PUBLIC_BASE_URL=http://localhost:4000
```

### 14.7 Comandos utiles de mantenimiento

```bash
# Ver logs de todos los servicios
docker compose logs -f

# Ver logs solo de Ollama
docker compose logs -f ollama

# Reiniciar solo el servicio de IA (despues de cambios de codigo)
docker compose up -d --build blindsbook-ia

# Cambiar el modelo de LLM sin reconstruir
docker compose exec ollama ollama pull qwen2.5:1.5b
# Luego cambiar OLLAMA_MODEL en .env y reiniciar blindsbook-ia

# Detener todo
docker compose down

# Detener todo Y borrar volumenes (elimina modelo descargado)
docker compose down -v
```

