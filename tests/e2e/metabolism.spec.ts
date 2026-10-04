import { test, expect } from "@playwright/test";
import { stableSimTime } from "./helpers";
test("metabolic GPU blends forces and converts composition with cached rule updates", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const available = await page.evaluate(
    async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  if (process.env.WEBGPU_TEST === "1") expect(available).toBe(true);
  test.skip(!available, "No GPU adapter");
  const result = await page.evaluate(async () => {
    const simUrl = "/src/engine/simulation.ts",
      gpuUrl = "/src/engine/gpu-physics.ts";
    const sim = await import(simUrl),
      { GPUPhysics } = await import(gpuUrl),
      engine = await GPUPhysics.create();
    let forceError = 0,
      reactionError = 0,
      massError = 0,
      minimum = 1,
      loneError = 0;
    try {
      const c = {
        ...sim.DEFAULT,
        count: 129,
        mode: "metabolic",
        solver: "mesh-gpu",
        meshResolution: 128,
        metabolism: { ...sim.DEFAULT.metabolism, initialMix: 0.5, rules: [] },
      };
      const initial = sim.createState(c);
      for (let i = 0; i < initial.positions.length; i++)
        initial.positions[i] = Math.floor(initial.positions[i] * 128) / 128;
      const cpu = structuredClone(initial),
        gpu = structuredClone(initial);
      engine.load(gpu);
      await engine.step(c);
      sim.step(cpu, { ...c, solver: "exact" });
      await engine.downloadState(gpu);
      for (let i = 0; i < cpu.velocities.length; i++)
        forceError = Math.max(
          forceError,
          Math.abs(cpu.velocities[i] - gpu.velocities[i]),
        );
      // Hold positions fixed to isolate reaction-field parity and live rule-buffer invalidation.
      engine.load(initial);
      const expected = structuredClone(initial),
        actual = structuredClone(initial);
      for (const rate of [0, 1, 3]) {
        const next = {
          ...c,
          strength: 0,
          metabolism: {
            ...c.metabolism,
            rate,
            rules: [
              { from: 0, to: 1, catalyst: 2, rate: 0.8 },
              { from: 0, to: 3, catalyst: -1, rate: 0.4 },
              { from: 1, to: 0, catalyst: 3, rate: 0.2 },
            ],
          },
        };
        for (let j = 0; j < 10; j++) {
          await engine.step(next, 3);
          for (let k = 0; k < 3; k++)
            sim.step(expected, { ...next, solver: "exact" });
        }
        await engine.downloadState(actual);
        for (let i = 0; i < actual.composition.length; i++)
          reactionError = Math.max(
            reactionError,
            Math.abs(actual.composition[i] - expected.composition[i]),
          );
        for (let i = 0; i < c.count; i++) {
          let total = 0;
          for (let k = 0; k < 4; k++) {
            const w = actual.composition[i * 4 + k];
            minimum = Math.min(minimum, w);
            total += w;
          }
          massError = Math.max(massError, Math.abs(total - 1));
        }
      }
      const loneConfig = {
        ...c,
        count: 1,
        strength: 0,
        metabolism: {
          ...c.metabolism,
          rules: [{ from: 0, to: 1, catalyst: 2, rate: 1 }],
        },
      };
      const lone = sim.createState(loneConfig),
        before = lone.composition.slice();
      engine.load(lone);
      await engine.step(loneConfig, 3);
      await engine.downloadState(lone);
      for (let i = 0; i < 4; i++)
        loneError = Math.max(
          loneError,
          Math.abs(lone.composition[i] - before[i]),
        );
      // Quantization must never invent a catalyst species whose share is zero everywhere.
      const absentConfig = {
        ...c,
        strength: 0,
        metabolism: {
          ...c.metabolism,
          rules: [{ from: 0, to: 2, catalyst: 3, rate: 3 }],
        },
      };
      const absent = sim.createState(absentConfig);
      for (let i = 0; i < c.count; i++)
        absent.composition.set([0.3, 0.7, 0, 0], i * 4);
      engine.load(absent);
      await engine.step(absentConfig, 3);
      await engine.downloadState(absent);
      const absentCatalystPreserved = Array.from(
        absent.composition as Float32Array,
      ).every((w, i) => i % 4 < 2 || w === 0);
      const largeConfig = {
        ...c,
        count: 50000,
        speedLimitEnabled: true,
        maxSpeed: 0.5,
        metabolism: sim.DEFAULT.metabolism,
      };
      const large = sim.createState(largeConfig);
      engine.load(large);
      await engine.step(largeConfig, 3);
      await engine.downloadState(large);
      let largeValid = Array.from(large.positions as Float32Array).every(
        (x) => Number.isFinite(x) && x >= 0 && x < 1,
      );
      for (let i = 0; i < largeConfig.count; i++) {
        let total = 0;
        for (let k = 0; k < 4; k++) {
          const v = large.composition[i * 4 + k];
          largeValid &&= Number.isFinite(v) && v >= 0 && v <= 1;
          total += v;
        }
        largeValid &&= Math.abs(total - 1) < 1e-6;
      }
      return {
        largeValid,
        absentCatalystPreserved,
        forceError,
        reactionError,
        massError,
        minimum,
        loneError,
        changed: actual.composition[0] !== initial.composition[0],
      };
    } finally {
      engine.destroy();
    }
  });
  await info.attach("metabolic-parity.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(result.forceError).toBeLessThan(0.0001);
  expect(result.reactionError).toBeLessThan(0.001);
  expect(result.massError).toBeLessThan(0.000001);
  expect(result.minimum).toBeGreaterThanOrEqual(0);
  expect(result.loneError).toBeLessThan(0.00001);
  expect(result.changed).toBe(true);
  expect(result.largeValid).toBe(true);
  expect(result.absentCatalystPreserved).toBe(true);
});
test("optional metabolic mode has editable rules, settings persistence and classic reset", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByLabel("Simulation mode", { exact: true })).toHaveValue(
    "classic",
  );
  await page
    .getByLabel("Simulation mode", { exact: true })
    .selectOption("metabolic");
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("exact");
  await expect(page.getByLabel("Physics backend")).toHaveText(
    "CPU · exact mixed forces",
  );
  await page.getByLabel("Rule 1 catalyst", { exact: true }).selectOption("3");
  await page.getByLabel("Rule 1 rate", { exact: true }).fill("0.75");
  await page.getByLabel("Initial mixing", { exact: true }).fill("0.5");
  await page
    .getByRole("button", { name: "Add conversion rule", exact: true })
    .click();
  await expect(page.getByLabel("Rule 5 source", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  const path = await (await download).path();
  await page
    .getByLabel("Simulation mode", { exact: true })
    .selectOption("classic");
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(page.getByLabel("Simulation mode", { exact: true })).toHaveValue(
    "metabolic",
  );
  await expect(page.getByLabel("Rule 1 rate", { exact: true })).toHaveValue(
    "0.75",
  );
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByLabel("Simulation mode", { exact: true })
    .selectOption("classic");
  await expect(page.getByLabel("Physics backend")).toHaveText(
    "CPU · exact grid",
  );
  await expect(page.getByLabel("Rule 1 source", { exact: true })).toHaveCount(
    0,
  );
});

test("metabolic GPU failure keeps mixed CPU behavior and remains optional", async ({
  page,
}) => {
  await page.route("**/src/engine/gpu-physics.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'export class GPUPhysics { static async create(){ throw new Error("GPU unavailable in metabolic test"); } }',
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page
    .getByLabel("Simulation mode", { exact: true })
    .selectOption("metabolic");
  await expect(page.getByLabel("Physics backend")).toHaveText(
    "CPU · exact mixed forces",
  );
  await expect(page.locator(".backend-notice")).toContainText(
    "Using CPU exact mixed forces",
  );
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Step simulation" }).click();
  await expect(page.locator(".simulation-bottom b")).not.toHaveText("0.0s");
  await page
    .getByLabel("Simulation mode", { exact: true })
    .selectOption("classic");
  await expect(page.getByLabel("Physics backend")).toHaveText(
    "CPU · exact grid",
  );
});

test("randomize replaces rules live without changing mixing, speed or paused state", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Randomize rules", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Simulation mode", { exact: true })
    .selectOption("metabolic");
  await page
    .getByLabel("Force calculation", { exact: true })
    .selectOption("exact");
  await page.getByLabel("Conversion speed", { exact: true }).fill("1.5");
  await page.getByLabel("Initial mixing", { exact: true }).fill("0.5");
  const before = await stableSimTime(page);
  await page
    .getByRole("button", { name: "Randomize rules", exact: true })
    .click();
  await expect(page.getByLabel("Rule 8 source", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add conversion rule", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Conversion speed", { exact: true }),
  ).toHaveValue("1.5");
  await expect(page.getByLabel("Initial mixing", { exact: true })).toHaveValue(
    "0.5",
  );
  await expect(page.locator(".simulation-bottom b")).toHaveText(before);
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  const path = await (await downloading).path();
  const { readFile } = await import("node:fs/promises");
  const saved = JSON.parse(await readFile(path!, "utf8"));
  expect(saved.metabolism.rules).toHaveLength(8);
  await page
    .getByRole("button", { name: "Reset conversion rules", exact: true })
    .click();
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(page.getByLabel("Rule 8 source", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("Conversion speed", { exact: true }),
  ).toHaveValue("1.5");
  await page
    .getByRole("button", { name: "Step simulation", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
