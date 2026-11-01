// Managed by agent-braille: update with `braille install`.
import type { AgentToolDescriptor } from "./types";

const queryProperties = {
  testid: { type: "string", description: "Exact data-testid; `prefix*` matches by the start." },
  role: { type: "string", description: "ARIA role: button, textbox, tab, link, ..." },
  name: { type: "string", description: "Substring of the accessible name, case-insensitive." },
  text: { type: "string", description: "Substring of the visible text, case-insensitive." },
};

/**
 * Description of the `window.__agent` functions in the form of W3C WebMCP draft
 * tools (name, description, input schema). The name matches the function key in
 * the object.
 */
export const AGENT_TOOLS: ReadonlyArray<AgentToolDescriptor> = [
  {
    name: "screen",
    description:
      "Current screen: testid, data-state (loading|ready|empty|error), role=alert texts and interactive elements with role, name, ARIA state, bounding box, visibility, overlap and clipping.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "busy",
    description:
      "What on the page has not finished yet: navigation, loads without data (queries), submissions (mutations), finite animations (animations) - a count for each. An empty object means the page is at rest.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find",
    description:
      "Page elements by testid, role, name or text (conditions are combined with AND) with the same fields as screen().",
    inputSchema: { type: "object", properties: queryProperties, additionalProperties: false },
  },
  {
    name: "layout",
    description:
      "Relative position of two elements by testid: above/below/left/right, gaps, distance, intersection.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "data-testid of the first element." },
        b: { type: "string", description: "data-testid of the second element." },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "errors",
    description:
      "Console errors, unhandled exceptions and failed requests (status 400 and above, or network) since the current screen was loaded.",
    inputSchema: {
      type: "object",
      properties: { clear: { type: "boolean", description: "Clear the buffer after reading." } },
      additionalProperties: false,
    },
  },
  {
    name: "act",
    description:
      "Action on an element by testid through the same event path as a person. A click on a covered or disabled element is rejected, naming the covering element.",
    inputSchema: {
      type: "object",
      properties: {
        testid: { type: "string", description: "data-testid of the element." },
        action: { enum: ["click", "type", "select", "focus", "clear"] },
        value: { type: "string", description: "Text for type or value for select." },
      },
      required: ["testid", "action"],
      additionalProperties: false,
    },
  },
];
