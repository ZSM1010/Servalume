import { describe, expect, it } from "vitest";
import {
  canAddTeamMember,
  canAddWebsite,
  clampMonitorInterval,
  getPlan,
  isEntitlementActive,
} from "../src/plans.js";

describe("isEntitlementActive", () => {
  it("treats trialing and active as entitled", () => {
    expect(isEntitlementActive("trialing")).toBe(true);
    expect(isEntitlementActive("active")).toBe(true);
  });

  it("treats past_due, canceled and incomplete as not entitled", () => {
    expect(isEntitlementActive("past_due")).toBe(false);
    expect(isEntitlementActive("canceled")).toBe(false);
    expect(isEntitlementActive("incomplete")).toBe(false);
  });
});

describe("canAddWebsite", () => {
  const solo = getPlan("solo");

  it("allows adding a website under the cap on an active subscription", () => {
    expect(canAddWebsite(solo, "active", 5).allowed).toBe(true);
  });

  it("rejects at the plan's website cap", () => {
    const result = canAddWebsite(solo, "active", 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/10 websites/);
  });

  it("rejects regardless of count when the subscription is past_due", () => {
    const result = canAddWebsite(solo, "past_due", 0);
    expect(result.allowed).toBe(false);
  });

  it("rejects regardless of count when the subscription is canceled", () => {
    const result = canAddWebsite(solo, "canceled", 0);
    expect(result.allowed).toBe(false);
  });
});

describe("canAddTeamMember", () => {
  const agency = getPlan("agency");

  it("allows under the cap", () => {
    expect(canAddTeamMember(agency, "active", 3).allowed).toBe(true);
  });

  it("rejects at the cap", () => {
    expect(canAddTeamMember(agency, "active", 15).allowed).toBe(false);
  });
});

describe("clampMonitorInterval", () => {
  it("raises a too-frequent request up to the plan floor", () => {
    const solo = getPlan("solo");
    expect(clampMonitorInterval(solo, 30)).toBe(solo.minMonitorIntervalSeconds);
  });

  it("leaves a compliant interval unchanged", () => {
    const agency = getPlan("agency");
    expect(clampMonitorInterval(agency, 600)).toBe(600);
  });
});
