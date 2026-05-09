import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "dist");

if (!fs.existsSync(distDir)) {
  console.error(`finalize-cjs: ${distDir} does not exist`);
  process.exit(1);
}

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const jsFiles = collectJsFiles(distDir);
const renamed = new Set(jsFiles.map((f) => f.replace(/\.js$/, ".cjs")));

function rewriteRequires(content, fromCjs) {
  return content.replace(
    /require\((['"])(\.\.?\/[^'"]+?)\1\)/g,
    (match, quote, rel) => {
      if (rel.endsWith(".cjs") || rel.endsWith(".json")) return match;
      const baseDir = path.dirname(fromCjs);
      const candidates = [
        path.resolve(baseDir, rel + ".cjs"),
        path.resolve(baseDir, rel + "/index.cjs"),
      ];
      for (const c of candidates) {
        if (renamed.has(c)) {
          const newRel =
            rel + (c.endsWith("/index.cjs") ? "/index.cjs" : ".cjs");
          return `require(${quote}${newRel}${quote})`;
        }
      }
      return match;
    },
  );
}

for (const js of jsFiles) {
  const cjs = js.replace(/\.js$/, ".cjs");
  let content = fs.readFileSync(js, "utf8");
  content = rewriteRequires(content, cjs);
  fs.writeFileSync(cjs, content);
  fs.unlinkSync(js);
  const mapFile = js + ".map";
  if (fs.existsSync(mapFile)) {
    fs.renameSync(mapFile, cjs + ".map");
  }
}

console.log(
  `finalize-cjs: renamed ${jsFiles.length} .js -> .cjs in ${distDir}`,
);
