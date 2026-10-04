import { expect, it } from "vitest";
import { DEFAULT, parseConfig } from "../src/engine/simulation";

it("round-trips particle-mesh settings and supplies the legacy resolution", () => {
  for (const meshResolution of [64, 128, 256]) {
    const c = { ...DEFAULT, solver: "mesh-gpu", meshResolution };
    expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
  }
  const { meshResolution: _, ...legacy } = DEFAULT;
  expect(parseConfig(legacy).meshResolution).toBe(128);
});
it("rejects unsupported and malformed mesh sizes", () => {
  for (const meshResolution of [0, 32, 129, 512, null, "128", NaN])
    expect(() => parseConfig({ ...DEFAULT, meshResolution })).toThrow(
      "Invalid mesh resolution",
    );
});
