import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

interface StoredResult {
  fingerprint: string;
  status: number;
  body: unknown;
}

/**
 * Provider-side idempotency, modelled on how payment APIs such as Stripe work:
 *
 * - The first request with a given `Idempotency-Key` is processed normally and
 *   its response is saved.
 * - A repeat with the same key and the same body gets the saved response
 *   back, without doing the work again. It is marked `Idempotent-Replayed: true`.
 * - A repeat with the same key but a different body is rejected with 422:
 *   reusing a key for a different operation is a client bug.
 * - 5xx responses are not saved, so a key that hit a transient failure can be
 *   retried for real.
 *
 * Real providers also lock a key while its first request is in progress. Our
 * handlers are synchronous once they start, so two requests can't interleave
 * here and that lock isn't needed.
 */
export class IdempotencyStore {
  private results = new Map<string, StoredResult>();

  clear() {
    this.results.clear();
  }

  size() {
    return this.results.size;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = req.header("idempotency-key");
      if (!key) return next(); // no key: no protection, every call does the work

      const scope = `${req.method} ${req.path} ${key}`;
      const fingerprint = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
      const saved = this.results.get(scope);

      if (saved) {
        if (saved.fingerprint !== fingerprint) {
          return res.status(422).json({ error: "idempotency_key_reused", detail: "same key, different request" });
        }
        res.setHeader("Idempotent-Replayed", "true");
        return res.status(saved.status).json(saved.body);
      }

      res.locals.recordIdempotentResult = (status: number, body: unknown) => {
        if (status < 500) this.results.set(scope, { fingerprint, status, body });
      };
      next();
    };
  }
}
