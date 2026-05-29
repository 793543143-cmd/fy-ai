import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

async function rebuildDist() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  const files = ["index.html", "app.js", "styles.css", "PROJECT_ID.md"];
  await Promise.all(
    files.map(async (name) => {
      await fs.copyFile(path.join(root, name), path.join(dist, name));
    })
  );
}

await rebuildDist();
console.log("Built static dist/ for Bolt hosting");
