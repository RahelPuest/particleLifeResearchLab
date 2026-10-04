export type VisualSettings = {
  mode: "dots" | "glow" | "rings" | "field";
  color: "species" | "speed" | "mono";
  size: number;
  intensity: number;
  trails: boolean;
  persistence: number;
};
export const DEFAULT_VISUALS: VisualSettings = {
  mode: "dots",
  color: "species",
  size: 1,
  intensity: 1,
  trails: false,
  persistence: 0.57,
};
export const visualMode = (v: VisualSettings) =>
  ["dots", "glow", "rings", "field"].indexOf(v.mode);
export const colorMode = (v: VisualSettings) =>
  ["species", "speed", "mono"].indexOf(v.color);
export const particleRadius = (zoom: number, v: VisualSettings) =>
  Math.min(3, 1.65 * Math.sqrt(zoom)) *
  v.size *
  (v.mode === "glow"
    ? 3
    : v.mode === "field"
      ? 6
      : v.mode === "rings"
        ? 1.8
        : 1);
export const trailOpacity = (v: VisualSettings) => 0.6 - 0.56 * v.persistence;
export function parseVisuals(value: unknown): VisualSettings {
  if (value === undefined) return { ...DEFAULT_VISUALS };
  if (!value || typeof value !== "object")
    throw new Error("Invalid visual settings.");
  const v = value as VisualSettings;
  if (
    !["dots", "glow", "rings", "field"].includes(v.mode) ||
    !["species", "speed", "mono"].includes(v.color) ||
    typeof v.trails !== "boolean" ||
    ![v.size, v.intensity, v.persistence].every(
      (x) => typeof x === "number" && Number.isFinite(x),
    ) ||
    v.size < 0.5 ||
    v.size > 3 ||
    v.intensity < 0.2 ||
    v.intensity > 2 ||
    v.persistence < 0 ||
    v.persistence > 1
  )
    throw new Error("Invalid visual settings.");
  return {
    mode: v.mode,
    color: v.color,
    size: v.size,
    intensity: v.intensity,
    trails: v.trails,
    persistence: v.persistence,
  };
}
