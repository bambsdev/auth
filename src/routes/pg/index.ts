// src/routes/pg/index.ts
import { createAuthRoutes } from "../factory/auth.factory";
import type { PgBindings, PgVariables } from "../../types/index";

export const authRoutes = createAuthRoutes<PgBindings, PgVariables>("pg");
