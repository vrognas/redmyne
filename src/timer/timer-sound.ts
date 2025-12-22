import { exec } from "child_process";
import * as os from "os";

/**
 * Play completion sound when timer ends
 * Uses platform-specific methods
 */
export function playCompletionSound(): void {
  const platform = os.platform();

  try {
    if (platform === "win32") {
      // Windows - use PowerShell beep
      exec('powershell -c "[console]::beep(800,300)"');
    } else if (platform === "darwin") {
      // macOS - use afplay with system sound
      exec("afplay /System/Library/Sounds/Glass.aiff");
    } else {
      // Linux - try paplay or beep
      exec("paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null || echo -e '\\a'");
    }
  } catch {
    // Fallback: terminal bell (may not work in all terminals)
    try {
      process.stdout.write("\x07");
    } catch {
      // Silent fail - sound notification is non-critical
    }
  }
}
