// Runs a tool from backend/.venv on any OS: node scripts/venv-run.mjs <tool> [args...]
// The venv puts executables in Scripts\ on Windows and bin/ elsewhere.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "backend");
const win = process.platform === "win32";
const [tool, ...args] = process.argv.slice(2);

if (!tool) {
  console.error("usage: node scripts/venv-run.mjs <tool> [args...]");
  process.exit(2);
}

const exe = join(backend, ".venv", win ? "Scripts" : "bin", win ? `${tool}.exe` : tool);
if (!existsSync(exe)) {
  console.error(`Not found: ${exe}\nCreate the venv first: cd backend && python -m venv .venv && pip install -r requirements.txt`);
  process.exit(1);
}

const child = spawn(exe, args, { cwd: backend, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
