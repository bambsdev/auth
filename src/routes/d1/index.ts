// src/routes/d1/index.ts
import { createAuthRoutes } from "../factory/auth.factory";
import type { D1Bindings, D1Variables } from "../../types/index";

export const authRoutes = createAuthRoutes<D1Bindings, D1Variables>("d1");
