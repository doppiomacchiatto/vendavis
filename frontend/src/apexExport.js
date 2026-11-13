/**
 * Helpers that turn AI-generated Apex code blocks into deployable source files:
 * <Name>.cls / <Name>.trigger plus the matching -meta.xml.
 */

// Remove comments and string literals so a "class Foo" inside them is not picked up.
function stripNoise(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/'(?:[^'\\\r\n]|\\.)*'/g, "''");
}

/**
 * Describe the first top-level Apex type in a code block.
 * Returns { kind: "class" | "trigger", name } or null for plain snippets
 * (e.g. anonymous Apex like `System.debug(...)`) that are not saveable as a file.
 */
export function describeApex(code) {
  const src = stripNoise(code || "");
  const trg = /^\s*trigger\s+([A-Za-z_]\w*)\s+on\s+[A-Za-z_]\w*\s*\(/im.exec(src);
  if (trg) return { kind: "trigger", name: trg[1] };
  const cls = /\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/.exec(src);
  if (cls) return { kind: "class", name: cls[1] };
  return null;
}

export function apexFileFor(code) {
  const d = describeApex(code);
  if (!d) return null;
  const ext = d.kind === "trigger" ? "trigger" : "cls";
  return {
    kind: d.kind,
    name: d.name,
    ext,
    fileName: `${d.name}.${ext}`,
    metaFileName: `${d.name}.${ext}-meta.xml`,
  };
}

export function metaXml(kind, apiVersion = "68.0") {
  const root = kind === "trigger" ? "ApexTrigger" : "ApexClass";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${root} xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    `    <apiVersion>${apiVersion}</apiVersion>\n` +
    `    <status>Active</status>\n` +
    `</${root}>\n`
  );
}

/**
 * Build the file list for a set of code blocks. Blocks that are not a class,
 * interface, enum or trigger are skipped. If the same type appears twice (e.g. a
 * corrected version later in the answer), the later block wins.
 * Returns [{ kind, name, fileName, metaFileName, content, meta }].
 */
export function buildExportFiles(blocks, apiVersion = "68.0") {
  const byName = new Map();
  for (const code of blocks) {
    const f = apexFileFor(code);
    if (!f) continue;
    byName.delete(f.fileName);               // keep insertion order = last occurrence
    byName.set(f.fileName, {
      ...f,
      content: code.trimEnd() + "\n",
      meta: metaXml(f.kind, apiVersion),
    });
  }
  return [...byName.values()];
}

/** Join a folder and file name using the separator the folder path already uses. */
export function joinPath(dir, name) {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

export function baseName(path) {
  return String(path).split(/[\\/]/).pop();
}
