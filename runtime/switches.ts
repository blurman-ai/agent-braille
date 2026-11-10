// Managed by agent-braille: update with `braille install`.
/**
 * What the scenario executor turned off on the page: `localStorage["agent.off"]` -
 * names separated by commas. Read only in a build with the agent object; in a
 * regular build Vite drops the branch and the answer is always false.
 */
export type AgentSwitch = "onboarding";

export const AGENT_OFF_KEY = "agent.off";

export function agentTurnedOff(name: AgentSwitch): boolean {
  if (import.meta.env.VITE_STALKER !== "1") return false;
  try {
    return (window.localStorage.getItem(AGENT_OFF_KEY) ?? "").split(",").includes(name);
  } catch {
    return false;
  }
}
