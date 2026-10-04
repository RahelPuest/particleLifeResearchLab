import { expect, it } from "vitest";
import { DEFAULT, parseConfig } from "../src/engine/simulation";
import { DEFAULT_VISUALS, parseVisuals } from "../src/visuals";
it("migrates old settings and round-trips visualization options", () => {
  const { visuals: _, ...legacy } = DEFAULT;
  expect(parseConfig(legacy).visuals).toEqual(DEFAULT_VISUALS);
  const c = {
    ...DEFAULT,
    visuals: {
      ...DEFAULT_VISUALS,
      mode: "glow",
      color: "speed",
      trails: true,
      persistence: 0.9,
    },
  };
  expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
});
it("rejects malformed visual settings instead of passing them to shaders", () => {
  for (const patch of [
    { mode: "invalid" },
    { color: "invalid" },
    { size: Infinity },
    { intensity: 3 },
    { persistence: -1 },
    { trails: "yes" },
  ])
    expect(() => parseVisuals({ ...DEFAULT_VISUALS, ...patch })).toThrow();
});
