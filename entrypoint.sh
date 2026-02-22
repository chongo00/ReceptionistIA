#!/bin/bash
# Starts Ollama and then the Node.js app

set -e

echo "╔═══════════════════════════════════════════════╗"
echo "║  BlindsBook Receptionist IA (Unified Container) ║"
echo "╚═══════════════════════════════════════════════╝"

# 1. Start Ollama in background
echo "[1/3] Starting Ollama..."
OLLAMA_HOST=0.0.0.0:11434 ollama serve &
OLLAMA_PID=$!

# 2. Wait for Ollama to be ready (up to 5 min)
echo "[2/3] Waiting for Ollama to respond..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "  ✓ Ollama ready (attempt $i)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "  ⚠ Ollama did not respond after 5 min, continuing anyway..."
  fi
  sleep 5
done

# Verify model availability
echo "  Available models:"
curl -sf http://localhost:11434/api/tags | grep -o '"name":"[^"]*"' || echo "  (could not list models)"

# 3. Start Node.js app
echo "[3/3] Starting Receptionist IA on port ${PORT:-4000}..."
exec node /app/dist/index.js
