import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const keyLength = 64;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, scryptOptions, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ['scrypt', scryptOptions.N, scryptOptions.r, scryptOptions.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parts = encoded?.split('$') ?? [];
  const valid = parts.length === 6 && parts[0] === 'scrypt' &&
    parts[1] === String(scryptOptions.N) && parts[2] === String(scryptOptions.r) && parts[3] === String(scryptOptions.p) &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[4] ?? '') && /^[A-Za-z0-9_-]{86}$/.test(parts[5] ?? '');
  // Unknown accounts still perform the same expensive derivation.
  const salt = valid ? Buffer.from(parts[4]!, 'base64url') : Buffer.alloc(16);
  const expected = valid ? Buffer.from(parts[5]!, 'base64url') : Buffer.alloc(keyLength);
  const candidate = await derive(password, salt);
  return timingSafeEqual(candidate, expected) && valid;
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class RateLimiter {
  private readonly buckets = new Map<string, { start: number; attempts: number }>();
  constructor(private readonly windowMs: number, private readonly maxAttempts: number, private readonly maxBuckets = 10000) {}

  consume(key: string, now: number): boolean {
    let bucket = this.buckets.get(key);
    if (bucket && now - bucket.start >= this.windowMs) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        for (const [existingKey, value] of this.buckets) {
          if (now - value.start >= this.windowMs) this.buckets.delete(existingKey);
        }
        if (this.buckets.size >= this.maxBuckets) return false;
      }
      bucket = { start: now, attempts: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.attempts += 1;
    return bucket.attempts <= this.maxAttempts;
  }
}
