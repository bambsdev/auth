// src/routes/pg/setting.ts
import { createSettingRoutes } from "../factory/setting.factory";
import type { PgBindings, PgVariables } from "../../types/index";

export const settingRoutes = createSettingRoutes<PgBindings, PgVariables>("pg");
