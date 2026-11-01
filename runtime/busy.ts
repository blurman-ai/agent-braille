// Managed by agent-braille: update with `braille install`.
/**
 * What on the page has not finished yet. Sources are declared by those who know
 * their own state: the router - a navigation, the request client - loads and
 * submissions. The module has no dependencies: registration is cheap even in a
 * build without the agent object.
 */
type BusySource = () => number;

const sources = new Map<string, BusySource>();

/** A source returns the number of unfinished items; 0 means idle. */
export function registerBusySource(name: string, source: BusySource): void {
  sources.set(name, source);
}

/** Unfinished items per source; an empty object means the page is at rest. */
export function busyOf(doc: Document): Record<string, number> {
  const busy: Record<string, number> = {};
  for (const [name, source] of sources) {
    const count = source();
    if (count > 0) busy[name] = count;
  }
  const animations = doc.getAnimations?.().filter(a => a.playState === "running" && isFinite(endOf(a))).length ?? 0;
  if (animations > 0) busy.animations = animations;
  return busy;
}

/** An infinite animation (spinner) is not unfinished work, it is how the element looks. */
function endOf(animation: Animation): number {
  const end = animation.effect?.getComputedTiming().endTime;
  return typeof end === "number" ? end : Number.POSITIVE_INFINITY;
}
