import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  FaultRegistry,
  FAKE_SERVICES,
  injectFaults,
  maybeDropResponse,
  type FakeServiceName,
} from "./faults";

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
  emails: Email[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.stock = new Map(Object.entries(DEFAULT_STOCK));
    this.reservations.clear();
    this.charges.clear();
    this.emails = [];
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
        refunds: charges.filter((c) => c.status === "refunded").length,
        emails: this.emails.length,
      },
      reservations,
      charges,
      emails: this.emails,
    };
  }
}

export function createFakeProviderApp(faults = new FaultRegistry(), state = new FakeProviderState()) {
  const app = express();
  app.use(express.json());

  // ---------- Inventory ----------
  app.post("/inventory/reservations", injectFaults(faults, "inventory"), (req: Request, res: Response) => {
    const { sku, quantity } = req.body ?? {};
    if (typeof sku !== "string" || !Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "invalid_request" });
    }
    const available = state.stock.get(sku);
    if (available === undefined) return res.status(404).json({ error: "unknown_sku" });
    if (available < quantity) return res.status(409).json({ error: "out_of_stock", available });

    state.stock.set(sku, available - quantity);
    const reservation: Reservation = { id: randomUUID(), sku, quantity, status: "reserved" };
    state.reservations.set(reservation.id, reservation);

    if (maybeDropResponse(faults, "inventory", res)) return;
    res.status(201).json({ reservationId: reservation.id });
  });

  app.post("/inventory/reservations/:id/release", injectFaults(faults, "inventory"), (req: Request, res: Response) => {
    const reservation = state.reservations.get(String(req.params.id));
    if (!reservation) return res.status(404).json({ error: "unknown_reservation" });

    // Releasing twice must not put the stock back twice.
    if (reservation.status === "reserved") {
      reservation.status = "released";
      state.stock.set(reservation.sku, (state.stock.get(reservation.sku) ?? 0) + reservation.quantity);
    }

    if (maybeDropResponse(faults, "inventory", res)) return;
    res.json({ reservationId: reservation.id, status: reservation.status });
  });

  // ---------- Payment ----------
  app.post("/payments/charges", injectFaults(faults, "payment"), (req: Request, res: Response) => {
    const { amountCents, customerEmail } = req.body ?? {};
    if (!Number.isInteger(amountCents) || amountCents <= 0 || typeof customerEmail !== "string") {
      return res.status(400).json({ error: "invalid_request" });
    }
    const charge: Charge = { id: randomUUID(), amountCents, customerEmail, status: "captured" };
    state.charges.set(charge.id, charge);

    if (maybeDropResponse(faults, "payment", res)) return;
    res.status(201).json({ chargeId: charge.id });
  });

  app.post("/payments/charges/:id/refund", injectFaults(faults, "payment"), (req: Request, res: Response) => {
    const charge = state.charges.get(String(req.params.id));
    if (!charge) return res.status(404).json({ error: "unknown_charge" });

    // Refunding twice must not pay the customer back twice.
    charge.status = "refunded";

    if (maybeDropResponse(faults, "payment", res)) return;
    res.json({ chargeId: charge.id, status: charge.status });
  });

  // ---------- Email ----------
  app.post("/emails", injectFaults(faults, "email"), (req: Request, res: Response) => {
    const { to, subject, body } = req.body ?? {};
    if (typeof to !== "string" || typeof subject !== "string") {
      return res.status(400).json({ error: "invalid_request" });
    }
    const email: Email = { id: randomUUID(), to, subject, body: String(body ?? "") };
    state.emails.push(email);

    if (maybeDropResponse(faults, "email", res)) return;
    res.status(202).json({ messageId: email.id });
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
