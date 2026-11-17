import { Router } from "express";
import { createOrder, getOrder, getOrderHistory } from "../controllers/orders.controller";

export const ordersRouter = Router();

ordersRouter.post("/orders", createOrder);
ordersRouter.get("/orders/:id", getOrder);
ordersRouter.get("/orders/:id/history", getOrderHistory);
