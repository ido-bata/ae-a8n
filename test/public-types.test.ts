/**
 * The package entry exports the types callers write against, together.
 *
 * `npm run typecheck` compiles this file, so a missing or renamed type export
 * fails the gate; the runtime assertions cover the value exports.
 */

import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";
import type {
  OpenProjectOptions,
  OperationOptions,
  PropertyInfo,
  PropertyKind,
  RenderOptions,
} from "../src/index.js";

describe("public types", () => {
  it("lets PropertyKind (#18) and OperationOptions (#22) be used side by side", () => {
    const kinds: PropertyKind[] = ["value", "no-value", "custom-value", "group"];
    const budget: OperationOptions = { timeoutMs: 1_000 };
    const open: OpenProjectOptions = { unsavedChanges: "refuse", ...budget };
    const render: RenderOptions = { prefix: "frame", ...budget };
    const listed: PropertyInfo[] = [
      { name: "Amount", kind: "value", value: 1 },
      { name: "", kind: "no-value" },
    ];
    expect(kinds).toHaveLength(4);
    expect([open.timeoutMs, render.timeoutMs]).toEqual([1_000, 1_000]);
    expect(listed.map((p) => p.kind)).toEqual(["value", "no-value"]);
  });

  it("exports the error and the methods those types belong to", () => {
    expect(typeof api.PropertyHasNoValueError).toBe("function");
    expect(new api.PropertyHasNoValueError("group", "x", "op")).toBeInstanceOf(api.AfterEffectsError);
    expect(typeof api.AfterEffects.prototype.project).toBe("function");
  });
});
