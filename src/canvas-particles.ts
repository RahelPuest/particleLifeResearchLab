import { type VisualSettings } from "./visuals";

// A small reusable sprite palette keeps gradients out of the per-particle loop.
export function particleSprites(v: VisualSettings, override?: number[][]) {
  const colors =
    override ??
    (v.color === "species"
      ? [
          [0.447, 0.898, 0.737],
          [0.941, 0.741, 0.443],
          [0.6, 0.612, 0.965],
          [0.929, 0.518, 0.616],
        ]
      : v.color === "mono"
        ? [[0.82, 0.93, 1]]
        : Array.from({ length: 32 }, (_, i) => {
            const t = i / 31;
            return [0.15 + 0.85 * t, 0.55 + 0.2 * t, 1 - 0.9 * t];
          }));
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return colors.map((color) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!,
      image = ctx.createImageData(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const d = Math.hypot((x + 0.5) / 32 - 1, (y + 0.5) / 32 - 1);
        let alpha = 1 - smooth(0.6, 1, d);
        if (v.mode === "glow")
          alpha =
            (Math.exp(-7 * d * d) + 0.4 * (1 - smooth(0.05, 0.22, d))) *
            (1 - smooth(0.8, 1, d)) *
            v.intensity;
        if (v.mode === "rings")
          alpha = smooth(0.48, 0.65, d) * (1 - smooth(0.8, 1, d));
        if (v.mode === "field")
          alpha =
            Math.exp(-4 * d * d) * (1 - smooth(0.8, 1, d)) * 0.09 * v.intensity;
        const i = (y * 64 + x) * 4;
        for (let k = 0; k < 3; k++)
          image.data[i + k] = Math.round(color[k] * 255);
        image.data[i + 3] = d > 1 ? 0 : Math.round(Math.min(1, alpha) * 255);
      }
    ctx.putImageData(image, 0, 0);
    return canvas;
  });
}

// Quantized composition palette is bounded (165 mixtures), avoiding a new gradient per particle.
export function mixtureKey(composition: Float32Array, i: number) {
  const bins = [0, 0, 0, 0];
  let remaining = 8;
  for (let k = 0; k < 3; k++) {
    bins[k] = Math.min(remaining, Math.round(composition[i * 4 + k] * 8));
    remaining -= bins[k];
  }
  bins[3] = remaining;
  return bins.join(",");
}
export function mixtureColor(key: string) {
  const weights = key.split(",").map(Number),
    colors = [
      [0.447, 0.898, 0.737],
      [0.941, 0.741, 0.443],
      [0.6, 0.612, 0.965],
      [0.929, 0.518, 0.616],
    ];
  return [0, 1, 2].map((k) =>
    weights.reduce((sum, w, i) => sum + (w / 8) * colors[i][k], 0),
  );
}
