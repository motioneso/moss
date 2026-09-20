import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { waitForBreakpointReadiness } from "../../tests/uat/visual-parity/shell-navigation-matrix.js";

describe("P1 breakpoint readiness", () => {
  it("waits for Today population before asserting the expanded shell", async () => {
    let mounted = false;
    let release!: () => void;
    const order: string[] = [];
    const routeReady = new Promise<void>((resolve) => {
      release = () => {
        mounted = true;
        resolve();
      };
    });

    const readiness = waitForBreakpointReadiness({} as Page, {
      waitForRoutePopulated: async (_page, route) => {
        order.push(route);
        await routeReady;
        return {
          route,
          matched: [],
          loadingAbsent: true,
          fontsReady: true,
          elapsedMs: 0
        };
      },
      expectAttr: async () => {
        order.push("expanded");
        expect(mounted).toBe(true);
      }
    });

    await Promise.resolve();
    expect(order).toEqual(["today"]);
    release();
    await readiness;
    expect(order).toEqual(["today", "expanded"]);
  });
});
