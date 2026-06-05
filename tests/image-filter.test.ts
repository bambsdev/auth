// tests/image-filter.test.ts
//
// Unit tests for ImageFilterService
// Validates that default rules, custom rules, substring matches, and fail-safe logic work.

import { describe, test, expect } from "bun:test";
import { ImageFilterService } from "../src/utils/image-filter";

describe("ImageFilterService Unit Tests (TDD)", () => {
  // Helper to create mock AI instance
  const createMockAi = (detections: { label: string; score: number }[] | Error) => {
    return {
      run: async (model: string, input: any) => {
        if (detections instanceof Error) {
          throw detections;
        }
        return detections;
      }
    } as any;
  };

  test("should allow image if classification does not contain blocked labels", async () => {
    const mockAi = createMockAi([
      { label: "golden retriever", score: 0.95 },
      { label: "tennis racket", score: 0.88 }
    ]);
    const service = new ImageFilterService(mockAi);

    // Mock global fetch for this test
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: new Map([["content-type", "image/jpeg"]]),
      arrayBuffer: async () => new ArrayBuffer(8)
    } as any);

    try {
      const result = await service.isImageAllowed("https://example.com/dog.jpg");
      expect(result.allowed).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("should block image if classification contains a default blocked label (substring match)", async () => {
    const mockAi = createMockAi([
      { label: "bikini, two-piece", score: 0.92 }
    ]);
    const service = new ImageFilterService(mockAi);

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: new Map([["content-type", "image/jpeg"]]),
      arrayBuffer: async () => new ArrayBuffer(8)
    } as any);

    try {
      const result = await service.isImageAllowed("https://example.com/bikini.jpg");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("bikini, two-piece");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("should allow image if blocked label detection is below confidence threshold", async () => {
    const mockAi = createMockAi([
      { label: "bikini, two-piece", score: 0.05 } // below default 0.15
    ]);
    const service = new ImageFilterService(mockAi);

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: new Map([["content-type", "image/jpeg"]]),
      arrayBuffer: async () => new ArrayBuffer(8)
    } as any);

    try {
      const result = await service.isImageAllowed("https://example.com/bikini.jpg");
      expect(result.allowed).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("should block image based on custom config blocked labels", async () => {
    const mockAi = createMockAi([
      { label: "person", score: 0.85 }
    ]);
    const service = new ImageFilterService(mockAi, {
      blockedLabels: ["person"],
      confidenceThreshold: 0.5
    });

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: new Map([["content-type", "image/jpeg"]]),
      arrayBuffer: async () => new ArrayBuffer(8)
    } as any);

    try {
      const result = await service.isImageAllowed("https://example.com/person.jpg");
      expect(result.allowed).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("should block image based on custom keywords (like sex, sexy, vulgar)", async () => {
    const mockAi = createMockAi([
      { label: "very sexy outfit", score: 0.80 }
    ]);
    const service = new ImageFilterService(mockAi, {
      blockedLabels: ["sexy"],
      confidenceThreshold: 0.5
    });

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: new Map([["content-type", "image/jpeg"]]),
      arrayBuffer: async () => new ArrayBuffer(8)
    } as any);

    try {
      const result = await service.isImageAllowed("https://example.com/vulgar.jpg");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("very sexy outfit");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("should fail-open and allow image if AI model throws error", async () => {
    const mockAi = createMockAi(new Error("Model quota exceeded (429)"));
    const service = new ImageFilterService(mockAi);

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: new Map([["content-type", "image/jpeg"]]),
      arrayBuffer: async () => new ArrayBuffer(8)
    } as any);

    try {
      const result = await service.isImageAllowed("https://example.com/image.jpg");
      expect(result.allowed).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("should support isImageBufferAllowed with ArrayBuffer", async () => {
    const mockAi = createMockAi([
      { label: "brassiere, bra, bandeau", score: 0.75 }
    ]);
    const service = new ImageFilterService(mockAi);

    const result = await service.isImageBufferAllowed(new ArrayBuffer(8), "image/png");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("brassiere, bra, bandeau");
  });
});
