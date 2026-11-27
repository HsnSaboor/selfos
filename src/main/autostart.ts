/**
 * XDG autostart entry (PRD F-SHELL-05, STACK §2.5).
 *
 * The file is written with `--hidden` so a login start lands in the tray, and
 * removal deletes it. `Exec=` is the real executable path, quoted because a
 * path may contain spaces.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTOSTART_FILE = () => join(homedir(), ".config", "autostart", "selfos.desktop");

export function autostartEnabled(file: string = AUTOSTART_FILE()): boolean {
  return existsSync(file);
}

export function setAutostart(enabled: boolean, file: string = AUTOSTART_FILE()): boolean {
  if (enabled) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=SelfOS",
        `Exec=${JSON.stringify(process.execPath)} --hidden`,
        "X-GNOME-Autostart-enabled=true",
        "Terminal=false",
        "",
      ].join("\n"),
    );
  } else {
    rmSync(file, { force: true });
  }
  return existsSync(file);
}
