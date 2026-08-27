// src/routes/d1/setting.ts
import { createSettingRoutes } from "../factory/setting.factory";
import type { D1Bindings, D1Variables } from "../../types/index";

export const settingRoutes = createSettingRoutes<D1Bindings, D1Variables>("d1");
