import { expect, it } from "vitest";
import {
  MutationRequestSchema,
  NavigateEventSchema,
  SelectImageResultSchema,
} from "../shared/contracts";
it("rejects forged quote and temporal evidence in public candidate updates", () => {
  for (const values of [{ sourceQuote: "伪造原文" }, { temporalEvidence: [] }])
    expect(
      MutationRequestSchema.safeParse({
        operationId: "forge",
        origin: "manual",
        mutations: [
          {
            type: "update",
            entity: "candidate",
            id: "c1",
            expectedVersion: 1,
            values,
          },
        ],
        confirmed: false,
      }).success,
    ).toBe(false);
});
it("allows image chooser cancellation but rejects extra capabilities", () => {
  expect(
    SelectImageResultSchema.safeParse({ ok: true, data: null }).success,
  ).toBe(true);
  expect(
    NavigateEventSchema.safeParse({
      entity: "task",
      id: "t1",
      path: "C:/private",
    }).success,
  ).toBe(false);
});
