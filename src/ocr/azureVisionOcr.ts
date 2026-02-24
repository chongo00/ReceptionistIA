/**
 * Azure OpenAI Vision — Window frame detection using GPT-4o vision.
 *
 * Sends the image to Azure OpenAI with a prompt asking the model to
 * identify the window frame rectangle coordinates.
 *
 * Much higher accuracy than edge-detection for complex window photos:
 * handles shadows, reflections, curtains, furniture, etc.
 *
 * Falls back to null so the caller can use edge detection as a backup.
 */

import { loadEnv } from '../config/env.js';

export interface VisionRectangle {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
  width: number;
  height: number;
}

export interface VisionOcrResult {
  rectangle: VisionRectangle;
  confidence: number;
  provider: 'azure-openai-vision';
}

/**
 * Check if Azure OpenAI is configured for vision calls.
 * Vision uses the same endpoint but needs a model that supports images (gpt-4o, gpt-4o-mini).
 */
export function isAzureVisionConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.azureOpenaiEndpoint && env.azureOpenaiApiKey && env.azureOpenaiDeployment);
}

/**
 * Detect the primary window frame using Azure OpenAI Vision (GPT-4o).
 * Returns null if not configured, request fails, or model can't find a window.
 */
export async function detectWindowFrameWithVision(
  imageBase64: string,
  imageWidth: number,
  imageHeight: number,
): Promise<VisionOcrResult | null> {
  if (!isAzureVisionConfigured()) return null;

  const env = loadEnv();
  const endpoint = env.azureOpenaiEndpoint!.replace(/\/$/, '');
  const deployment = env.azureOpenaiDeployment!;
  const apiKey = env.azureOpenaiApiKey!;
  const apiVersion = env.azureOpenaiApiVersion || '2024-10-21';

  // Ensure we have a proper data URL for the image
  let imageUrl = imageBase64;
  if (!imageUrl.startsWith('data:')) {
    imageUrl = `data:image/jpeg;base64,${imageUrl}`;
  }

  const systemPrompt = `You are an expert computer vision system specialized in detecting window frames in photographs.

TASK: Analyze the provided image and identify the primary window frame rectangle.
The image dimensions are ${imageWidth}x${imageHeight} pixels.

RULES:
1. Find the OUTER EDGES of the main window frame (the architectural frame, not the glass or blinds).
2. If there are multiple windows, pick the largest/most prominent one.
3. Return pixel coordinates relative to the original image dimensions (${imageWidth}x${imageHeight}).
4. If you can see a clear window frame, return its coordinates.
5. If NO window frame is visible, respond with: {"found": false}

RESPONSE FORMAT — respond with EXACTLY this JSON, nothing else:
If found:
{"found": true, "x1": <left>, "y1": <top>, "x2": <right>, "y2": <bottom>, "confidence": <0.0-1.0>}

If not found:
{"found": false}

x1,y1 = top-left corner; x2,y2 = bottom-right corner. All values in pixels.
Respond ONLY with the JSON object.`;

  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const body = {
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
              detail: 'high',
            },
          },
          {
            type: 'text',
            text: 'Detect the window frame in this image. Return the rectangle coordinates.',
          },
        ],
      },
    ],
    max_tokens: 200,
    temperature: 0.1,
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[AzureVisionOCR] API error ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const json = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    // Parse the JSON response
    const cleaned = content
      .replace(/^```json?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed.found) return null;

    const x1 = Number(parsed.x1);
    const y1 = Number(parsed.y1);
    const x2 = Number(parsed.x2);
    const y2 = Number(parsed.y2);
    const confidence = Number(parsed.confidence) || 0.85;

    // Validate coordinates
    if (
      isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)
      || x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1
      || x2 > imageWidth * 1.05 || y2 > imageHeight * 1.05 // small tolerance
    ) {
      console.warn('[AzureVisionOCR] Invalid coordinates from model:', { x1, y1, x2, y2 });
      return null;
    }

    // Clamp to image bounds
    const cx1 = Math.max(0, Math.round(x1));
    const cy1 = Math.max(0, Math.round(y1));
    const cx2 = Math.min(imageWidth, Math.round(x2));
    const cy2 = Math.min(imageHeight, Math.round(y2));

    const w = cx2 - cx1;
    const h = cy2 - cy1;

    // Frame should be at least 10% of image
    if (w < imageWidth * 0.1 || h < imageHeight * 0.1) {
      return null;
    }

    return {
      rectangle: {
        topLeft: { x: cx1, y: cy1 },
        topRight: { x: cx2, y: cy1 },
        bottomLeft: { x: cx1, y: cy2 },
        bottomRight: { x: cx2, y: cy2 },
        width: w,
        height: h,
      },
      confidence: Math.min(0.99, Math.max(0.3, confidence)),
      provider: 'azure-openai-vision',
    };
  } catch (err) {
    console.warn('[AzureVisionOCR] Error:', (err as Error).message);
    return null;
  }
}
