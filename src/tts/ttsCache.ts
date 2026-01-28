import crypto from 'crypto';

type CachedAudio = {
  contentType: string;
  bytes: Buffer;
  expiresAtMs: number;
};

const cache = new Map<string, CachedAudio>();

function cleanupExpired(nowMs: number) {
  for (const [key, value] of cache.entries()) {
    if (value.expiresAtMs <= nowMs) cache.delete(key);
  }
}

export function putAudio(
  bytes: Buffer,
  contentType: string,
  ttlSeconds = 10 * 60,
): string {
  const id = crypto.randomBytes(16).toString('hex');
  const nowMs = Date.now();
  cleanupExpired(nowMs);
  cache.set(id, {
    bytes,
    contentType,
    expiresAtMs: nowMs + ttlSeconds * 1000,
  });
  return id;
}

export function getAudio(id: string): { contentType: string; bytes: Buffer } | null {
  const nowMs = Date.now();
  cleanupExpired(nowMs);
  const found = cache.get(id);
  if (!found) return null;
  if (found.expiresAtMs <= nowMs) {
    cache.delete(id);
    return null;
  }
  return { contentType: found.contentType, bytes: found.bytes };
}

