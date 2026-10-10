import { describe, expect, it } from "vitest";
import {
  isClientApprovalTransitionAllowed,
  isIncidentTransitionAllowed,
  isWorkItemTransitionAllowed,
  isWorkItemTransitionAllowedForItem,
} from "../src/statusMachines.js";

describe("work item state machine", () => {
  it("allows the documented happy path", () => {
    expect(isWorkItemTransitionAllowed("detected", "recommended")).toBe(true);
    expect(isWorkItemTransitionAllowed("recommended", "awaiting_approval")).toBe(true);
    expect(isWorkItemTransitionAllowed("awaiting_approval", "approved")).toBe(true);
    expect(isWorkItemTransitionAllowed("approved", "in_progress")).toBe(true);
    expect(isWorkItemTransitionAllowed("in_progress", "completed")).toBe(true);
    expect(isWorkItemTransitionAllowed("completed", "verified")).toBe(true);
    expect(isWorkItemTransitionAllowed("verified", "closed")).toBe(true);
  });

  it("rejects skipping straight from detected to completed", () => {
    expect(isWorkItemTransitionAllowed("detected", "completed")).toBe(false);
  });

  it("rejects any transition out of closed", () => {
    expect(isWorkItemTransitionAllowed("closed", "detected")).toBe(false);
    expect(isWorkItemTransitionAllowed("closed", "in_progress")).toBe(false);
  });

  it("allows a failed verification to loop back to in_progress", () => {
    expect(isWorkItemTransitionAllowed("verification_failed", "in_progress")).toBe(true);
  });

  it("requires approval-gated items to pass through awaiting_approval", () => {
    expect(
      isWorkItemTransitionAllowedForItem("recommended", "in_progress", true),
    ).toBe(false);
  });

  it("lets requires_client_approval=false items skip straight to in_progress", () => {
    expect(
      isWorkItemTransitionAllowedForItem("recommended", "in_progress", false),
    ).toBe(true);
  });

  it("still rejects an otherwise-illegal transition even when approval is not required", () => {
    expect(
      isWorkItemTransitionAllowedForItem("detected", "completed", false),
    ).toBe(false);
  });
});

describe("incident state machine", () => {
  it("allows confirming -> open and confirming -> resolved", () => {
    expect(isIncidentTransitionAllowed("confirming", "open")).toBe(true);
    expect(isIncidentTransitionAllowed("confirming", "resolved")).toBe(true);
  });

  it("allows open -> resolved only", () => {
    expect(isIncidentTransitionAllowed("open", "resolved")).toBe(true);
    expect(isIncidentTransitionAllowed("open", "confirming")).toBe(false);
  });

  it("rejects any transition out of resolved", () => {
    expect(isIncidentTransitionAllowed("resolved", "open")).toBe(false);
  });
});

describe("client approval state machine", () => {
  it("allows pending to move to any terminal decision", () => {
    expect(isClientApprovalTransitionAllowed("pending", "approved")).toBe(true);
    expect(isClientApprovalTransitionAllowed("pending", "declined")).toBe(true);
    expect(isClientApprovalTransitionAllowed("pending", "clarification_requested")).toBe(
      true,
    );
  });

  it("allows clarification_requested to still resolve to approved/declined", () => {
    expect(
      isClientApprovalTransitionAllowed("clarification_requested", "approved"),
    ).toBe(true);
  });

  it("rejects any transition out of a terminal state", () => {
    expect(isClientApprovalTransitionAllowed("approved", "declined")).toBe(false);
    expect(isClientApprovalTransitionAllowed("revoked", "pending")).toBe(false);
  });
});
