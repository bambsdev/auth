// src/services/audit.service.ts
//
// Menggunakan Cloudflare Analytics Engine — gratis, tidak makan storage PostgreSQL.
// writeDataPoint adalah synchronous + non-blocking, tidak perlu await/waitUntil.

import type { AuditEvent } from "../types/index";
import type { ClientType } from "../config/token.config";

export interface AuditPayload {
  event: AuditEvent;
  userId?: string;
  clientType?: ClientType;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly analytics: AnalyticsEngineDataset) {}

  log(payload: AuditPayload): void {
    this.analytics.writeDataPoint({
      // blobs = string fields (maks 20)
      blobs: [
        payload.event, // [0] nama event
        payload.userId ?? "", // [1] user id
        payload.clientType ?? "", // [2] client type
        payload.ip ?? "", // [3] ip address
        JSON.stringify(payload.metadata ?? {}), // [4] metadata tambahan
      ],
      // doubles = numeric (untuk SUM / COUNT query)
      doubles: [1],
      // indexes = untuk filter/group-by di SQL Analytics Engine
      indexes: [payload.event],
    });
  }
}
