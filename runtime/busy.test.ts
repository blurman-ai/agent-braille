// Managed by agent-braille: update with `braille install`.
import { describe, expect, it } from "vitest";

import { busyOf, dataOf, registerBusySource, registerDataSource } from "./busy";

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

describe("dataOf", () => {
  it("hands over each source's snapshot at the moment of the call", () => {
    const writes: string[] = [];
    registerDataSource("test-writes", () => writes.slice());
    expect(dataOf()).toMatchObject({ "test-writes": [] });
    writes.push("POST /x -> 403");
    expect(dataOf()).toMatchObject({ "test-writes": ["POST /x -> 403"] });
  });
});
