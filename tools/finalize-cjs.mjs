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
      if (rel.endsWith(".cjs") || rel.endsWith(".js") || rel.endsWith(".json"))
        return match;
      const baseDir = path.dirname(fromCjs);
      const candidates = [
        path.resolve(baseDir, rel + ".cjs"),
        path.resolve(baseDir, rel + "/index.cjs"),
      ];
      // candidates is fixed-order: index 0 is the sibling .cjs file,
      // index 1 is the directory's index.cjs. Use the index rather
      // than path.endsWith("/index.cjs") so the check survives Windows
      // backslash-separated absolute paths returned by path.resolve.
      for (const [idx, c] of candidates.entries()) {
        if (renamed.has(c)) {
          const newRel = idx === 1 ? `${rel}/index.cjs` : `${rel}.cjs`;
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
  // tsc emits a //# sourceMappingURL=foo.js.map trailer; once we
  // rename the map file to foo.cjs.map, the in-file pointer needs to
  // match or devtools can't resolve the map.
  content = content.replace(
    /\/\/# sourceMappingURL=(.+)\.js\.map\b/g,
    "//# sourceMappingURL=$1.cjs.map",
  );
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
