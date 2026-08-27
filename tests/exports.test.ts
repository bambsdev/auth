// tests/exports.test.ts
import { describe, test, expect } from "bun:test";
import * as rootExport from "../src/index";
import * as pgExport from "../src/pg/index";
import * as d1Export from "../src/d1/index";

describe("Subpath & Root Package Exports", () => {
  describe("Root Export (@bambsdev/auth)", () => {
    test("exports shared utilities and services", () => {
      expect(rootExport.ImageFilterService).toBeDefined();
      expect(rootExport.parseBody).toBeDefined();
      expect(rootExport.AuthService).toBeDefined();
      expect(rootExport.RegisterService).toBeDefined();
      expect(rootExport.VerificationService).toBeDefined();
      expect(rootExport.SettingService).toBeDefined();
      expect(rootExport.GoogleOAuthService).toBeDefined();
      expect(rootExport.createAuthDbAdapter).toBeDefined();
    });

    test("exports backward-compatible pg schema and routes", () => {
      expect(rootExport.authRoutes).toBeDefined();
      expect(rootExport.settingRoutes).toBeDefined();
      expect(rootExport.dbMiddleware).toBeDefined();
      expect(rootExport.schema).toBeDefined();
    });
  });

  describe("PostgreSQL Subpath Export (@bambsdev/auth/pg)", () => {
    test("exports PG specific middleware, routes, and schema", () => {
      expect(pgExport.authRoutes).toBeDefined();
      expect(pgExport.settingRoutes).toBeDefined();
      expect(pgExport.dbMiddleware).toBeDefined();
      expect(pgExport.pgMiddleware).toBeDefined();
      expect(pgExport.createDb).toBeDefined();
      expect(pgExport.schema.users).toBeDefined();
      expect(pgExport.schema.refreshTokens).toBeDefined();
      expect(pgExport.cleanupExpiredTokens).toBeDefined();
    });
  });

  describe("Cloudflare D1 Subpath Export (@bambsdev/auth/d1)", () => {
    test("exports D1 specific middleware, routes, and schema", () => {
      expect(d1Export.authRoutes).toBeDefined();
      expect(d1Export.settingRoutes).toBeDefined();
      expect(d1Export.dbMiddleware).toBeDefined();
      expect(d1Export.d1Middleware).toBeDefined();
      expect(d1Export.createD1Db).toBeDefined();
      expect(d1Export.schema.users).toBeDefined();
      expect(d1Export.schema.refreshTokens).toBeDefined();
      expect(d1Export.cleanupExpiredTokensD1).toBeDefined();
    });
  });
});
