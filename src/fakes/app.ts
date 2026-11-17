import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  FaultRegistry,
  FAKE_SERVICES,
  injectNetworkFaults,
  injectServiceFaults,
  maybeDropResponse,
  send,
  type FakeServiceName,
} from "./faults";
import { IdempotencyStore } from "./idempotency";

/**
 * A stand-in for three external companies: an inventory system, a payment
 * provider and an email provider. It runs as its own process, so killing the
 * API does not wipe what the "outside world" has recorded. That is what lets us
 * check for duplicate charges after a crash.
 */

interface Reservation {
  id: string;
  sku: string;
  quantity: number;
  status: "reserved" | "released";
}
interface Charge {
  id: string;
  amountCents: number;
  customerEmail: string;
  status: "captured" | "refunded";
}
interface Refund {
  id: string;
  chargeId: string;
  amountCents: number;
}
interface Email {
  id: string;
  to: string;
  subject: string;
  body: string;
}

export const DEFAULT_STOCK: Record<string, number> = {
  "SKU-BOOK": 100,
  "SKU-MUG": 100,
  "SKU-LIMITED": 1,
};

export class FakeProviderState {
  stock = new Map<string, number>();
  reservations = new Map<string, Reservation>();
  charges = new Map<string, Charge>();
  refunds: Refund[] = [];
  emails: Email[] = [];
  idempotency = new IdempotencyStore();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.stock = new Map(Object.entries(DEFAULT_STOCK));
    this.reservations.clear();
    this.charges.clear();
    this.refunds = [];
    this.emails = [];
    this.idempotency.clear();
  }

  snapshot() {
    const charges = [...this.charges.values()];
    const reservations = [...this.reservations.values()];
    return {
      stock: Object.fromEntries(this.stock),
      totals: {
        reservations: reservations.length,
        activeReservations: reservations.filter((r) => r.status === "reserved").length,
        charges: charges.length,
        capturedCents: charges.filter((c) => c.status === "captured").reduce((s, c) => s + c.amountCents, 0),
        refunds: this.refunds.length,
        refundedCents: this.refunds.reduce((s, r) => s + r.amountCents, 0),
        emails: this.emails.length,
        idempotencyKeys: this.idempotency.size(),
      },
      reservations,
      charges,
      refunds: this.refunds,
      emails: this.emails,
    };
  }
}

export function createFakeProviderApp(faults = new FaultRegistry(), state = new FakeProviderState()) {
  const app = express();
  app.use(express.json());

  // Request pipeline for every service endpoint:
  //   network faults (latency, hang) → idempotency replay → service faults (503/422) → handler
  const guard = (service: FakeServiceName) => [
    injectNetworkFaults(faults, service),
    state.idempotency.middleware(),
    injectServiceFaults(faults, service),
  ];

  /** Records the result, possibly drops the connection (the work is already done), then replies. */
  const reply = (service: FakeServiceName, res: Response, status: number, body: unknown) => {
    (res.locals.recordIdempotentResult as ((s: number, b: unknown) => void) | undefined)?.(status, body);
    if (maybeDropResponse(faults, service, res)) return;
    res.status(status).json(body);
  };

  // ---------- Inventory ----------
  app.post("/inventory/reservations", ...guard("inventory"), (req: Request, res: Response) => {
    const { sku, quantity } = req.body ?? {};
    if (typeof sku !== "string" || !Number.isInteger(quantity) || quantity <= 0) {
      return send(res, 400, { error: "invalid_request" });
    }
    const available = state.stock.get(sku);
    if (available === undefined) return send(res, 404, { error: "unknown_sku" });
    if (available < quantity) return send(res, 409, { error: "out_of_stock", available });

    state.stock.set(sku, available - quantity);
    const reservation: Reservation = { id: randomUUID(), sku, quantity, status: "reserved" };
    state.reservations.set(reservation.id, reservation);
    reply("inventory", res, 201, { reservationId: reservation.id });
  });

  app.post("/inventory/reservations/:id/release", ...guard("inventory"), (req: Request, res: Response) => {
    const reservation = state.reservations.get(String(req.params.id));
    if (!reservation) return send(res, 404, { error: "unknown_reservation" });

    // Like a real system, a second release is an error, not a silent no-op.
    // Only a repeat with the same Idempotency-Key gets the original success back.
    if (reservation.status === "released") return send(res, 409, { error: "already_released" });

    reservation.status = "released";
    state.stock.set(reservation.sku, (state.stock.get(reservation.sku) ?? 0) + reservation.quantity);
    reply("inventory", res, 200, { reservationId: reservation.id, status: reservation.status });
  });

  // ---------- Payment ----------
  app.post("/payments/charges", ...guard("payment"), (req: Request, res: Response) => {
    const { amountCents, customerEmail } = req.body ?? {};
    if (!Number.isInteger(amountCents) || amountCents <= 0 || typeof customerEmail !== "string") {
      return send(res, 400, { error: "invalid_request" });
    }
    const charge: Charge = { id: randomUUID(), amountCents, customerEmail, status: "captured" };
    state.charges.set(charge.id, charge);
    reply("payment", res, 201, { chargeId: charge.id });
  });

  app.post("/payments/charges/:id/refund", ...guard("payment"), (req: Request, res: Response) => {
    const charge = state.charges.get(String(req.params.id));
    if (!charge) return send(res, 404, { error: "unknown_charge" });

    // Like Stripe: each refund is a separate record, and refunding an
    // already-refunded charge is an error. Only a repeat with the same
    // Idempotency-Key gets the original refund back.
    if (charge.status === "refunded") return send(res, 409, { error: "charge_already_refunded" });

    charge.status = "refunded";
    const refund: Refund = { id: randomUUID(), chargeId: charge.id, amountCents: charge.amountCents };
    state.refunds.push(refund);
    reply("payment", res, 200, { refundId: refund.id, chargeId: charge.id });
  });

  // ---------- Email ----------
  app.post("/emails", ...guard("email"), (req: Request, res: Response) => {
    const { to, subject, body } = req.body ?? {};
    if (typeof to !== "string" || typeof subject !== "string") {
      return send(res, 400, { error: "invalid_request" });
    }
    const email: Email = { id: randomUUID(), to, subject, body: String(body ?? "") };
    state.emails.push(email);
    reply("email", res, 202, { messageId: email.id });
  });

  // ---------- Admin (for experiments and tests) ----------
  app.get("/admin/state", (_req, res) => {
    res.json({ ...state.snapshot(), faults: faults.all() });
  });

  app.put("/admin/faults/:service", (req: Request, res: Response) => {
    const service = String(req.params.service) as FakeServiceName;
    if (!FAKE_SERVICES.includes(service)) return res.status(404).json({ error: "unknown_service" });
    try {
      res.json(faults.update(service, req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/admin/reset", (_req, res) => {
    faults.reset();
    state.reset();
    res.json({ ok: true });
  });

  return app;
}
