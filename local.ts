/**
 * Native folder picker and "open in Finder/Explorer", for a deployed Planner
 * that can't open dialogs on this machine itself.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";

/** Five minutes to choose a folder before the picker is given up on. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000;
const PICK_PROMPT = "Choose a project folder";

/** Picker command per platform; a non-zero exit means "cancelled". All arguments are constants. */
function pickerCommand(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["osascript", "-e", `POSIX path of (choose folder with prompt "${PICK_PROMPT}")`];
    case "win32":
      return [
        "powershell.exe",
        "-NoProfile",
        "-STA",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms;" +
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
          `$d.Description = '${PICK_PROMPT}';` +
          "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }",
      ];
    default:
      return ["zenity", "--file-selection", "--directory", `--title=${PICK_PROMPT}`];
  }
}

let picking = false;

/** Is a picker already on screen? Only one at a time: a caller can't stack dialogs. */
export const isPicking = () => picking;

/** Show the native folder picker; `null` when the user cancels. */
export async function pickFolder(): Promise<string | null> {
  picking = true;
  try {
    const proc = Bun.spawn(pickerCommand(), { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), PICK_TIMEOUT_MS);
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0 || !out) {
      return null;
    }
    // macOS returns a trailing slash; keep "/" itself.
    return out.length > 1 ? out.replace(/[\\/]+$/, "") : out;
  } catch {
    return null;
  } finally {
    picking = false;
  }
}

/**
 * Open a directory in the OS file manager. On macOS a directory with an
 * extension may be a bundle that `open` would *launch or install*
 * (Foo.app, Foo.prefPane, Foo.saver…), so those are only revealed (`-R`).
 * `path` was checked by the caller: absolute, existing, a directory.
 */
export function openFolder(path: string): void {
  const [file, ...args] =
    process.platform === "darwin"
      ? ["open", ...(/\.[^.]+$/.test(basename(path)) ? ["-R", path] : [path])]
      : process.platform === "win32"
        ? ["explorer.exe", path]
        : ["xdg-open", path];
  const child = spawn(file, args, { detached: true, stdio: "ignore" });
  child.on("error", (e) => console.warn(`[planner-claude] couldn't open ${path}: ${e.message}`));
  child.unref();
}
