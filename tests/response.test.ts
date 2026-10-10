import { describe, it, expect } from "bun:test";
import { success, fail } from "../src/utils/response";

describe("Response utilities", () => {
  it("success should return correct format", () => {
    const result = success({ data: "test" }, "Success message");

    expect(result.success).toBe(true);
    expect(result.message).toBe("Success message");
    expect(result.payload).toEqual({ data: "test" });
  });

  it("success should use default message", () => {
    const result = success({ data: "test" });

    expect(result.success).toBe(true);
    expect(result.message).toBe("OK");
    expect(result.payload).toEqual({ data: "test" });
  });

  it("fail should return correct format", () => {
    const result = fail("Error message");

    expect(result.success).toBe(false);
    expect(result.message).toBe("Error message");
    expect(result.payload).toBeNull();
  });
});
