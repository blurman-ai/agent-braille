// Managed by agent-braille: update with `braille install`.
/**
 * The single entry point of the agent object into the application.
 *
 * Vite substitutes `import.meta.env.VITE_AGENT_API` as a literal at build time,
 * and when the value is not "1" the branch with the dynamic import is dropped
 * entirely: the object module ends up neither in the main bundle nor in a
 * separate chunk. `braille check-build` checks this.
 */
export function maybeInstallAgentApi(): void {
  if (import.meta.env.VITE_AGENT_API === "1") {
    void import("./install").then(m => m.installAgentApi());
  }
}
