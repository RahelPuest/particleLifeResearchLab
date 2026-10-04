import { readFileSync, writeFileSync, existsSync } from "node:fs";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
let markdown =
    "# Third-party notices\n\nExact package versions are pinned in package-lock.json. No external fonts or stock assets are used. Icons: Lucide (ISC). Runtime code is bundled locally.\n\n| Package | Version | License | Official documentation/source |\n|---|---|---|---|\n",
  full = "Particle Life — bundled dependency license notices\n";
for (const [path, info] of Object.entries(lock.packages) as [string, any][]) {
  if (!path || info.dev || !existsSync(path + "/package.json")) continue;
  const p = JSON.parse(readFileSync(path + "/package.json", "utf8"));
  const link =
    p.homepage ??
    (typeof p.repository === "object" ? p.repository.url : p.repository) ??
    `https://www.npmjs.com/package/${p.name}`;
  markdown += `| ${p.name} | ${p.version} | ${p.license ?? "See distribution"} | ${link} |\n`;
  const names = [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE-MIT",
    "license",
    "license.md",
    "license.txt",
  ];
  full += `\n\n==== ${p.name} ${p.version} (${p.license ?? ""}) ====\n`;
  let found = false;
  for (const name of names)
    if (existsSync(path + "/" + name)) {
      full += readFileSync(path + "/" + name, "utf8");
      found = true;
      break;
    }
  if (!found)
    full += `Declared license: ${p.license ?? "See package"}; source: ${link}\n`;
}
markdown +=
  "\nFull bundled notices are also provided in `public/THIRD_PARTY_NOTICES.txt`. React uses MIT and Lucide uses ISC. Build/test tools are development dependencies and their licenses remain in their installed packages.\n";
writeFileSync("THIRD_PARTY_NOTICES.md", markdown);
writeFileSync("public/THIRD_PARTY_NOTICES.txt", full);
