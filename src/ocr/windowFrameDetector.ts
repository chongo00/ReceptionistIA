/**
 * Window frame detection using edge projection histograms.
 *
 * Pipeline:
 *   1. Resize to manageable dimensions (max 512px)
 *   2. Convert to grayscale
 *   3. Apply Laplacian kernel (edge detection)
 *   4. Threshold to binary edge map
 *   5. Build row/column projection histograms
 *   6. Find dominant horizontal and vertical edges → rectangle
 *
 * Returns the detected rectangle in original-image pixel coordinates.
 */

import sharp from 'sharp';

export interface OcrRectangle {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
  width: number;
  height: number;
}

export interface OcrResult {
  rectangle: OcrRectangle;
  confidence: number;
}

const MAX_PROCESSING_SIZE = 512;

/**
 * Detect the primary window frame in a base64-encoded image.
 * Returns null when no clear rectangular frame is found.
 */
export async function detectWindowFrame(
  imageBase64: string,
  originalWidth: number,
  originalHeight: number,
): Promise<OcrResult | null> {
  // Strip data-URL prefix if present
  const raw = imageBase64.replace(/^data:image\/[a-z+]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');

  // Determine resize dimensions keeping aspect ratio
  const scale = Math.min(1, MAX_PROCESSING_SIZE / Math.max(originalWidth, originalHeight));
  const procW = Math.round(originalWidth * scale);
  const procH = Math.round(originalHeight * scale);

  // 1-2: Resize + greyscale
  const grey = await sharp(buf)
    .resize(procW, procH, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  // 3: Laplacian edge detection (3x3 kernel) on raw greyscale pixels
  const edges = new Uint8Array(procW * procH);
  for (let y = 1; y < procH - 1; y++) {
    for (let x = 1; x < procW - 1; x++) {
      const idx = y * procW + x;
      const laplacian =
        -grey[idx - procW - 1] - grey[idx - procW] - grey[idx - procW + 1]
        - grey[idx - 1] + 8 * grey[idx] - grey[idx + 1]
        - grey[idx + procW - 1] - grey[idx + procW] - grey[idx + procW + 1];
      edges[idx] = Math.min(255, Math.abs(laplacian));
    }
  }

  // 4: Threshold (Otsu-like: use mean * 1.5 as threshold)
  let sum = 0;
  for (let i = 0; i < edges.length; i++) sum += edges[i];
  const mean = sum / edges.length;
  const threshold = Math.max(30, mean * 1.5);

  const binary = new Uint8Array(procW * procH);
  for (let i = 0; i < edges.length; i++) {
    binary[i] = edges[i] >= threshold ? 1 : 0;
  }

  // 5: Build projection histograms
  const rowHist = new Float64Array(procH);
  const colHist = new Float64Array(procW);
  for (let y = 0; y < procH; y++) {
    for (let x = 0; x < procW; x++) {
      const v = binary[y * procW + x];
      rowHist[y] += v;
      colHist[x] += v;
    }
  }

  // Normalize
  const maxRow = Math.max(...rowHist) || 1;
  const maxCol = Math.max(...colHist) || 1;
  for (let i = 0; i < procH; i++) rowHist[i] /= maxRow;
  for (let i = 0; i < procW; i++) colHist[i] /= maxCol;

  // 6: Find dominant edge bands
  const peakThreshold = 0.35;
  const minGap = 0.15; // minimum gap between edges as fraction of dimension

  const hPeaks = findEdgePeaks(rowHist, peakThreshold, Math.round(procH * minGap));
  const vPeaks = findEdgePeaks(colHist, peakThreshold, Math.round(procW * minGap));

  if (hPeaks.length < 2 || vPeaks.length < 2) {
    return null;
  }

  // Pick the outermost pair for each axis (most likely to be the window frame)
  const top = hPeaks[0];
  const bottom = hPeaks[hPeaks.length - 1];
  const left = vPeaks[0];
  const right = vPeaks[vPeaks.length - 1];

  // Validate: frame should be at least 20% of image in each dimension
  const frameW = right - left;
  const frameH = bottom - top;
  if (frameW < procW * 0.2 || frameH < procH * 0.2) {
    return null;
  }

  // Map back to original coordinates
  const sX = originalWidth / procW;
  const sY = originalHeight / procH;

  const x1 = Math.round(left * sX);
  const y1 = Math.round(top * sY);
  const x2 = Math.round(right * sX);
  const y2 = Math.round(bottom * sY);
  const w = x2 - x1;
  const h = y2 - y1;

  // Confidence: based on how prominent the edges are and frame proportions
  const edgeStrength = (rowHist[top] + rowHist[bottom] + colHist[left] + colHist[right]) / 4;
  const areaRatio = (frameW * frameH) / (procW * procH);
  const confidence = Math.min(0.95, Math.max(0.3, edgeStrength * 0.6 + areaRatio * 0.4));

  return {
    rectangle: {
      topLeft: { x: x1, y: y1 },
      topRight: { x: x2, y: y1 },
      bottomLeft: { x: x1, y: y2 },
      bottomRight: { x: x2, y: y2 },
      width: w,
      height: h,
    },
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Find peaks in a 1-d histogram that are above `threshold` and separated by at least `minDist`.
 */
function findEdgePeaks(hist: Float64Array, threshold: number, minDist: number): number[] {
  const peaks: number[] = [];
  const len = hist.length;

  for (let i = 1; i < len - 1; i++) {
    if (hist[i] >= threshold && hist[i] >= hist[i - 1] && hist[i] >= hist[i + 1]) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDist) {
        peaks.push(i);
      } else if (hist[i] > hist[peaks[peaks.length - 1]]) {
        // Replace last peak if this one is stronger and too close
        peaks[peaks.length - 1] = i;
      }
    }
  }

  return peaks;
}
