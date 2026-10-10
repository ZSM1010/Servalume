import { describe, expect, it } from "vitest";
import { decideIncidentAction } from "../src/incidentStateMachine.js";

describe("decideIncidentAction: no existing incident", () => {
  it("does nothing when a check succeeds and there is no incident", () => {
    expect(decideIncidentAction({ currentIncidentStatus: null, newCheckStatus: "success" })).toEqual({
      type: "no_action",
    });
  });

  it.each(["failure", "error", "timeout"] as const)(
    "starts confirming on a %s check when there is no incident",
    (status) => {
      expect(decideIncidentAction({ currentIncidentStatus: null, newCheckStatus: status })).toEqual({
        type: "create_confirming",
      });
    },
  );

  it("does nothing on a skipped check even with no incident", () => {
    expect(decideIncidentAction({ currentIncidentStatus: null, newCheckStatus: "skipped" })).toEqual({
      type: "no_action",
    });
  });
});

describe("decideIncidentAction: currently confirming", () => {
  it("opens the incident (with notification) when the confirmation check also fails", () => {
    expect(decideIncidentAction({ currentIncidentStatus: "confirming", newCheckStatus: "failure" })).toEqual({
      type: "confirm_open",
      notify: "incident_opened",
    });
  });

  it("discards as resolved (no notification) when the confirmation check succeeds — a flaky blip", () => {
    expect(decideIncidentAction({ currentIncidentStatus: "confirming", newCheckStatus: "success" })).toEqual({
      type: "discard_as_resolved",
    });
  });

  it("does nothing on a skipped confirmation check — not evidence either way", () => {
    expect(decideIncidentAction({ currentIncidentStatus: "confirming", newCheckStatus: "skipped" })).toEqual({
      type: "no_action",
    });
  });
});

describe("decideIncidentAction: currently open", () => {
  it("resolves the incident (with notification) on a successful check", () => {
    expect(decideIncidentAction({ currentIncidentStatus: "open", newCheckStatus: "success" })).toEqual({
      type: "mark_resolved",
      notify: "incident_resolved",
    });
  });

  it("does nothing (no duplicate notification) when still failing while open", () => {
    expect(decideIncidentAction({ currentIncidentStatus: "open", newCheckStatus: "failure" })).toEqual({
      type: "no_action",
    });
  });

  it("does nothing on a skipped check while open — does not resolve on missing data", () => {
    expect(decideIncidentAction({ currentIncidentStatus: "open", newCheckStatus: "skipped" })).toEqual({
      type: "no_action",
    });
  });
});

describe("decideIncidentAction: currently resolved is treated the same as no incident by the caller", () => {
  it("the caller passes null (not 'resolved') once an incident has resolved, starting a fresh confirming cycle on a new failure", () => {
    // This documents the contract: callers never pass currentIncidentStatus:
    // "resolved" — a resolved incident is historical, and the monitor's
    // "current" incident for this purpose is null. Enforced by the db query
    // layer (src/db/queries.ts), not by this pure function.
    expect(decideIncidentAction({ currentIncidentStatus: null, newCheckStatus: "failure" })).toEqual({
      type: "create_confirming",
    });
  });
});
