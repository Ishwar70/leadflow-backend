import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { averageDealValue, conversionRate, weightedForecast, winRate } from "../src/lib/metrics";
import { normalizeEmail, normalizePhone } from "../src/lib/normalize";
import { can, scopeFilter, type Role } from "../src/lib/permissions";
import { toCsv } from "../src/lib/csv";

describe("permission matrix", () => {
  const cases: Array<[Role, string, boolean]> = [
    ["owner", "billing:manage", true],
    ["admin", "billing:manage", false],
    ["admin", "members:manage", true],
    ["manager", "members:manage", false],
    ["manager", "pipeline:configure", true],
    ["sales_rep", "pipeline:configure", false],
    ["sales_rep", "records:create", true],
    ["sales_rep", "records:assign", false],
    ["sales_rep", "records:read_all", false],
    ["viewer", "records:read_all", true],
    ["viewer", "records:create", false],
    ["viewer", "records:update", false],
    ["viewer", "reports:view", true],
  ];
  it.each(cases)("%s / %s => %s", (role, perm, expected) => {
    expect(can(role, perm as never)).toBe(expected);
  });

  it("scopes sales reps to their own records", () => {
    const ctx = { userId: new Types.ObjectId(), workspaceId: new Types.ObjectId(), role: "sales_rep" as Role };
    expect(scopeFilter(ctx)).toEqual({ workspaceId: ctx.workspaceId, ownerId: ctx.userId });
    expect(scopeFilter({ ...ctx, role: "manager" })).toEqual({ workspaceId: ctx.workspaceId });
  });
});

describe("normalization", () => {
  it("normalizes emails", () => {
    expect(normalizeEmail("  Rahul@Example.COM ")).toBe("rahul@example.com");
    expect(normalizeEmail("")).toBeNull();
  });
  it("normalizes phones", () => {
    expect(normalizePhone("98765 43210")).toBe("+919876543210");
    expect(normalizePhone("+91-98765-43210")).toBe("+919876543210");
    expect(normalizePhone("098765 43210")).toBe("+919876543210");
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("")).toBeNull();
  });
});

describe("metrics", () => {
  it("computes win and conversion rates", () => {
    expect(winRate(3, 1)).toBe(75);
    expect(winRate(0, 0)).toBe(0);
    expect(conversionRate(1, 3)).toBe(33.3);
  });
  it("computes weighted forecast and average deal value", () => {
    expect(weightedForecast([{ value: 100000, probability: 50 }, { value: 20000, probability: 10 }])).toBe(52000);
    expect(averageDealValue(300000, 3)).toBe(100000);
    expect(averageDealValue(0, 0)).toBe(0);
  });
});

describe("csv export", () => {
  it("escapes values and neutralises formulas", () => {
    const csv = toCsv(["a", "b"], [{ a: "=SUM(A1)", b: 'say "hi", ok' }]);
    expect(csv).toBe(`a,b\n'=SUM(A1),"say ""hi"", ok"`);
  });
});
