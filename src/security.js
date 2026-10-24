/** HMAC-signed, expiring card payloads plus replay protection. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function fromB64url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function createSigner(secret) {
  if (!secret) throw new Error("signer requires a secret");

  const sign = (payload) => {
    const body = b64url(JSON.stringify({ ...payload, exp: payload.exp ?? Date.now() + 600_000 }));
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  };

  const verify = (token) => {
    if (typeof token !== "string") return undefined;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return undefined;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac("sha256", secret).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    try {
      const payload = JSON.parse(fromB64url(body));
      if (typeof payload.exp !== "number" || payload.exp < Date.now()) return undefined;
      return payload;
    } catch {
      return undefined;
    }
  };

  return { sign, verify };
}

/** Replay protection for inbound Feishu event ids and message ids. */
export class Dedup {
  constructor(ttlMs = 10 * 60_000, limit = 4_000) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.seen = new Map();
  }

  /** true when this id is new; false when it was already handled. */
  take(id) {
    if (!id) return true;
    const now = Date.now();
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    if (this.seen.size > this.limit) {
      for (const [key, at] of this.seen) {
        if (now - at > this.ttlMs || this.seen.size > this.limit) this.seen.delete(key);
        if (this.seen.size <= this.limit) break;
      }
    }
    return true;
  }
}

export function newRequestId(prefix = "feishu") {
  return `${prefix}-${randomUUID()}`;
}
