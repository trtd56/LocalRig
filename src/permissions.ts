// Permission-mode decisions for mutating tool calls. Pure functions only —
// the agent loop calls canAutoApprove and falls back to its askPermission
// callback, so this module stays decoupled from any UI.
import type { PermissionMode } from "./config.ts";

/** True when a mutating tool call may run without asking the user. */
export function canAutoApprove(mode: PermissionMode, toolName: string, args: Record<string, unknown>): boolean {
  switch (mode) {
    case "yolo":
      return true;
    case "auto":
      // Non-bash mutating tools (edit/write) are trusted; bash only when the
      // command doesn't hit the denylist below.
      if (toolName !== "bash") return true;
      return !isDangerousCommand(typeof args.command === "string" ? args.command : "");
    default:
      return false; // "default": always ask
  }
}

// Absolute directories we never want auto-approved as chmod/chown/mv/cp targets.
const SYSTEM_DIRS = "etc|usr|bin|sbin|boot|var|dev|opt|System|Library";

// Tested against every command segment (see splitSegments). Each segment has
// leading env assignments and transparent wrappers stripped first. Err on the
// side of flagging — a false positive just costs one extra y/N prompt.
const SEGMENT_PATTERNS: RegExp[] = [
  // Filesystem destruction
  /^rm\b/,
  /^rmdir\b/,
  /^dd\b/,
  /^mkfs/, // mkfs, mkfs.ext4, ...
  /^shred\b/,
  // System control
  /^(?:shutdown|reboot|halt|poweroff)\b/,
  /^(?:kill|pkill|killall)\b/,
  // Privilege escalation
  /^sudo\b/,
  /^su\b/,
  // chmod/chown: recursive use, or a system-path target
  /^(?:chmod|chown)\b.*(?:\s-[a-zA-Z]*R|\s--recursive)\b/,
  new RegExp(`^(?:chmod|chown)\\b.*\\s/(?:${SYSTEM_DIRS})\\b`),
  // mv/cp with a destination in a system directory or at the home root (~ or ~/file)
  new RegExp(`^(?:mv|cp)\\b.*\\s(?:/(?:${SYSTEM_DIRS})(?:/\\S*)?|~(?:/[^/\\s]*)?)$`),
  // Git operations that touch remotes or discard work
  /^git\s+push\b/,
  /^git\s+reset\b.*--hard\b/,
  /^git\s+clean\b/,
  /^git\s+(?:checkout|restore)\b.*\s\.$/, // git checkout . / git restore --staged .
  // Publishing and machine-wide package changes
  /^(?:npm|bun|yarn|pnpm)\s+publish\b/,
  /^brew\s+(?:install|uninstall|remove)\b/,
  /^npm\s+(?:install|i)\b.*(?:\s-\w*g\b|\s--global\b)/,
  // Arbitrary-code escape hatches
  /^eval\b/,
  /^exec\b/,
];

// Tested against the whole command — these need to see across pipes/redirects.
const WHOLE_COMMAND_PATTERNS: RegExp[] = [
  // Downloader piped into a shell interpreter: curl ... | sh, wget ... | bash
  /\b(?:curl|wget|fetch)\b.*\|.*\b(?:sh|bash|zsh|dash|fish)\b/,
  // Output redirection onto raw devices or /etc
  />\s*\/dev\/(?:sd|hd|nvme|r?disk)/,
  />\s*\/etc\//,
];

/** Conservative denylist check for bash commands run in auto mode. */
export function isDangerousCommand(cmd: string): boolean {
  if (WHOLE_COMMAND_PATTERNS.some((re) => re.test(cmd))) return true;
  return splitSegments(cmd).some((seg) => {
    const stripped = stripWrappers(seg);
    return SEGMENT_PATTERNS.some((re) => re.test(stripped));
  });
}

/**
 * Split a shell command into per-command segments on &&, ||, ;, |, newlines,
 * plus the contents of $(...) and `...` substitutions. Not a real parser —
 * quotes are ignored, which only over-splits (the safe direction).
 */
function splitSegments(cmd: string): string[] {
  const segments: string[] = [];
  const rest = cmd.replace(/\$\(([^)]*)\)|`([^`]*)`/g, (_m, dollar, backtick) => {
    segments.push(...splitSegments((dollar ?? backtick ?? "") as string));
    return " ";
  });
  for (const part of rest.split(/&&|\|\||[;|\n]/)) {
    const t = part.trim();
    if (t) segments.push(t);
  }
  return segments;
}

/** Drop leading env assignments and transparent wrappers so e.g.
 *  `env FOO=1 rm -rf x` and `xargs rm` still match the rm pattern. */
function stripWrappers(segment: string): string {
  let s = segment;
  for (;;) {
    const next = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|(?:command|env|nohup|time|xargs)\s+)/, "");
    if (next === s) return s;
    s = next;
  }
}
