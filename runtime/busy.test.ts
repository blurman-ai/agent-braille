// Managed by agent-braille: update with `braille install`.
import { describe, expect, it } from "vitest";

import { busyOf, registerBusySource } from "./busy";

describe("busyOf", () => {
  it("names a source with unfinished work and stays silent about idle ones", () => {
    let pending = 2;
    registerBusySource("test-pending", () => pending);
    registerBusySource("test-free", () => 0);
    expect(busyOf(document)).toMatchObject({ "test-pending": 2 });
    expect(busyOf(document)).not.toHaveProperty("test-free");
    pending = 0;
    expect(busyOf(document)).not.toHaveProperty("test-pending");
  });
});
