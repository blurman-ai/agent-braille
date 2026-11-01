// Managed by agent-braille: update with `braille install`.
import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_OFF_KEY, agentTurnedOff } from "./switches";

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.removeItem(AGENT_OFF_KEY);
});

describe("agentTurnedOff", () => {
  it("in a build with the agent object, whatever agent.off names is turned off", () => {
    vi.stubEnv("VITE_AGENT_API", "1");
    expect(agentTurnedOff("onboarding")).toBe(false);
    window.localStorage.setItem(AGENT_OFF_KEY, "onboarding");
    expect(agentTurnedOff("onboarding")).toBe(true);
  });

  it("control case: in a regular build the storage key turns nothing off", () => {
    vi.stubEnv("VITE_AGENT_API", "");
    window.localStorage.setItem(AGENT_OFF_KEY, "onboarding");
    expect(agentTurnedOff("onboarding")).toBe(false);
  });
});
