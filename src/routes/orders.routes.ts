import { Router } from "express";
import { createOrder, getOrder } from "../controllers/orders.controller";

export const ordersRouter = Router();

ordersRouter.post("/orders", createOrder);
ordersRouter.get("/orders/:id", getOrder);
