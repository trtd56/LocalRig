import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig } from "../src/config.ts";
import { auditWritableScope, buildMacSandboxProfile, sandboxEnvironment } from "../src/tools/bash.ts";
import { prepareWorkspaceScope } from "../src/tools/path-boundary.ts";
import { createTools } from "../src/tools/registry.ts";
import type { ToolContext, WorkspaceScope } from "../src/types.ts";
import {
  captureWorkspaceSnapshot,
  changedFileScopeViolations,
  diffWorkspaceSnapshots,
  reportFromSnapshots,
} from "../src/workspace-snapshot.ts";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-security-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-security-outside-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function toolsFor(scope?: WorkspaceScope, mode: "auto" | "yolo" = "auto") {
  const ctx: ToolContext = {
    cwd: root,
    scope,
    readFiles: new Map(),
    todos: [],
    signal: new AbortController().signal,
    report: { changedFiles: new Map(), commandsRun: [] },
  };
  const tools = new Map(createTools({ ...defaultConfig, permissionMode: mode }, ctx).map((tool) => [tool.name, tool]));
  return { ctx, tools };
}

describe("direct tool path boundary", () => {
  test("rejects existing and prospective symlink escapes", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(root, "existing-link"));
    fs.symlinkSync(path.join(outside, "missing-parent"), path.join(root, "dangling-link"));
    const { ctx, tools } = toolsFor();

    const read = await tools.get("read")!.execute({ path: "existing-link/secret.txt" }, ctx);
    const writeExisting = await tools.get("write")!.execute({ path: "existing-link/new.txt", content: "bad" }, ctx);
    const writeDangling = await tools.get("write")!.execute({ path: "dangling-link/new.txt", content: "bad" }, ctx);

    expect(read.ok).toBe(false);
    expect(writeExisting.ok).toBe(false);
    expect(writeDangling.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "missing-parent", "new.txt"))).toBe(false);
  });

  test("enforces allowed and protected paths for read/write/edit", async () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "src", "locked.ts"), "const x = 1;\n");
    fs.writeFileSync(path.join(root, "docs", "guide.md"), "guide\n");
    const scope = prepareWorkspaceScope(root, { allowedPaths: ["src"], protectedPaths: ["src/locked.ts"] });
    const { ctx, tools } = toolsFor(scope);

    const outsideAllow = await tools.get("read")!.execute({ path: "docs/guide.md" }, ctx);
    const readable = await tools.get("read")!.execute({ path: "src/locked.ts" }, ctx);
    const protectedWrite = await tools.get("edit")!.execute({
      path: "src/locked.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    }, ctx);
    const allowedWrite = await tools.get("write")!.execute({ path: "src/new.ts", content: "ok\n" }, ctx);

    expect(outsideAllow.ok).toBe(false);
    expect(readable.ok).toBe(true);
    expect(protectedWrite.ok).toBe(false);
    expect(protectedWrite.output).toContain("protected");
    expect(allowedWrite.ok).toBe(true);
  });

  test("refuses to mutate multiply-linked files", async () => {
    const original = path.join(outside, "shared.txt");
    fs.writeFileSync(original, "original");
    fs.linkSync(original, path.join(root, "shared.txt"));
    const { ctx, tools } = toolsFor();
    const result = await tools.get("write")!.execute({ path: "shared.txt", content: "changed" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("hard-linked");
    expect(fs.readFileSync(original, "utf8")).toBe("original");
  });
});

describe("bash sandbox", () => {
  test("sanitized environment does not expose caller secrets", () => {
    const env = sandboxEnvironment(root, path.join(root, "tmp"), {
      PATH: "/bin",
      LANG: "C",
      SECRET_TOKEN: "do-not-leak",
      AWS_ACCESS_KEY_ID: "do-not-leak",
      NODE_OPTIONS: "--require malicious.js",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.LANG).toBe("C");
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  test("profile denies network and grants writes only to scope and private temp", () => {
    fs.mkdirSync(path.join(root, "src"));
    const scope = prepareWorkspaceScope(root, { allowedPaths: ["src"], protectedPaths: ["src/locked"] });
    const profile = buildMacSandboxProfile(scope, path.join(root, ".tmp"), { HOME: outside });
    expect(profile).toContain("(deny default)");
    expect(profile).not.toContain("(allow default)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny signal (require-not (target self)))");
    expect(profile).toContain("(deny file-read* (require-not");
    expect(profile).toContain(scope.allowedPaths[0]!);
    expect(profile).toContain(scope.protectedPaths[0]!);
  });

  test("auto mode denies reading arbitrary files outside cwd", async () => {
    if (process.platform !== "darwin") return;
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "must-not-leak");
    const { ctx, tools } = toolsFor(undefined, "auto");
    const result = await tools.get("bash")!.execute({ command: `/bin/cat ${JSON.stringify(secret)}` }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("must-not-leak");
    expect(result.output).toMatch(/not permitted|denied/i);
  });

  test("auto mode cannot signal a process outside its sandbox", async () => {
    if (process.platform !== "darwin") return;
    const victim = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      expect(victim.pid).toBeNumber();
      const { ctx, tools } = toolsFor(undefined, "auto");
      const result = await tools.get("bash")!.execute({ command: `/bin/kill -TERM ${victim.pid}` }, ctx);
      expect(result.ok).toBe(false);
      expect(() => process.kill(victim.pid!, 0)).not.toThrow();
    } finally {
      const closed = once(victim, "close");
      victim.kill("SIGKILL");
      await closed;
    }
  });

  test("auto mode refuses to start when writable scope contains a hard link", async () => {
    if (process.platform !== "darwin") return;
    const external = path.join(outside, "shared.txt");
    fs.writeFileSync(external, "original");
    fs.linkSync(external, path.join(root, "shared.txt"));
    const { ctx, tools } = toolsFor(undefined, "auto");
    const result = await tools.get("bash")!.execute({ command: "touch should-not-run" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("hard links");
    expect(fs.existsSync(path.join(root, "should-not-run"))).toBe(false);
  });

  test("writable-scope audit fingerprint changes when the tree changes", () => {
    const scope = prepareWorkspaceScope(root);
    const before = auditWritableScope(scope);
    fs.writeFileSync(path.join(root, "new.txt"), "new");
    expect(auditWritableScope(scope)).not.toBe(before);
  });

  test("auto mode blocks host writes while explicit yolo permits them", async () => {
    if (process.platform !== "darwin") return;
    const target = path.join(outside, "host.txt");
    const auto = toolsFor(undefined, "auto");
    const denied = await auto.tools.get("bash")!.execute({ command: `printf blocked > ${JSON.stringify(target)}` }, auto.ctx);
    expect(denied.ok).toBe(false);
    expect(fs.existsSync(target)).toBe(false);

    const yolo = toolsFor(undefined, "yolo");
    const allowed = await yolo.tools.get("bash")!.execute({ command: `printf allowed > ${JSON.stringify(target)}` }, yolo.ctx);
    expect(allowed.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("allowed");
  });

  test("auto mode enforces a narrow allowlist and protected path", async () => {
    if (process.platform !== "darwin") return;
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "locked"));
    const scope = prepareWorkspaceScope(root, { allowedPaths: ["src", "locked"], protectedPaths: ["locked"] });
    const { ctx, tools } = toolsFor(scope, "auto");
    expect((await tools.get("bash")!.execute({ command: "touch src/ok" }, ctx)).ok).toBe(true);
    expect((await tools.get("bash")!.execute({ command: "touch outside-scope" }, ctx)).ok).toBe(false);
    expect((await tools.get("bash")!.execute({ command: "touch locked/no" }, ctx)).ok).toBe(false);
    expect(fs.existsSync(path.join(root, "src", "ok"))).toBe(true);
    expect(fs.existsSync(path.join(root, "outside-scope"))).toBe(false);
    expect(fs.existsSync(path.join(root, "locked", "no"))).toBe(false);
  });

  test("deny-default profile still runs the repository's Bun test dependency graph", async () => {
    if (process.platform !== "darwin") return;
    const repository = path.resolve(import.meta.dir, "..");
    const scope = prepareWorkspaceScope(repository);
    const ctx: ToolContext = {
      cwd: repository,
      scope,
      readFiles: new Map(),
      todos: [],
      signal: new AbortController().signal,
      report: { changedFiles: new Map(), commandsRun: [] },
    };
    const bash = createTools({ ...defaultConfig, permissionMode: "auto" }, ctx).find((tool) => tool.name === "bash")!;
    const result = await bash.execute({ command: "bun test test/check.test.ts", timeout_ms: 30_000 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("3 pass");
  });
});

describe("workspace snapshots", () => {
  test("reports bash-style modified, created, deleted, and untracked files", async () => {
    fs.writeFileSync(path.join(root, "modify.txt"), "before");
    fs.writeFileSync(path.join(root, "delete.txt"), "delete");
    const before = await captureWorkspaceSnapshot(root);
    fs.writeFileSync(path.join(root, "modify.txt"), "after");
    fs.rmSync(path.join(root, "delete.txt"));
    fs.writeFileSync(path.join(root, "untracked.txt"), "new");
    const after = await captureWorkspaceSnapshot(root);

    expect(diffWorkspaceSnapshots(before, after)).toEqual([
      { path: "delete.txt", action: "deleted" },
      { path: "modify.txt", action: "modified" },
      { path: "untracked.txt", action: "created" },
    ]);
  });

  test("scope audit fails changes outside allowlist and under protected paths", async () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "docs"));
    const scope = prepareWorkspaceScope(root, { allowedPaths: ["src", "docs"], protectedPaths: ["docs"] });
    const report = {
      changedFiles: [
        { path: "src/ok.ts", action: "created" as const },
        { path: "docs/no.md", action: "created" as const },
      ],
      commandsRun: [],
    };
    expect(changedFileScopeViolations(scope, report)).toHaveLength(1);
  });

  test("snapshot report preserves command audit data", async () => {
    const before = await captureWorkspaceSnapshot(root);
    fs.writeFileSync(path.join(root, "from-bash.txt"), "x");
    const after = await captureWorkspaceSnapshot(root);
    const report = reportFromSnapshots(before, after, { changedFiles: [], commandsRun: ["touch from-bash.txt"] });
    expect(report.changedFiles).toEqual([{ path: "from-bash.txt", action: "created" }]);
    expect(report.commandsRun).toEqual(["touch from-bash.txt"]);
  });

  test("detects git-ignored file changes while excluding only explicit noisy directories", async () => {
    fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=before\n");
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, ".git", "noise"), "before");
    fs.writeFileSync(path.join(root, "node_modules", "noise"), "before");
    const before = await captureWorkspaceSnapshot(root);

    fs.writeFileSync(path.join(root, ".env"), "TOKEN=after\n");
    fs.writeFileSync(path.join(root, ".git", "noise"), "after");
    fs.writeFileSync(path.join(root, "node_modules", "noise"), "after");
    const after = await captureWorkspaceSnapshot(root);

    expect(diffWorkspaceSnapshots(before, after)).toEqual([{ path: ".env", action: "modified" }]);
  });

  test("snapshot acquisition obeys an already-aborted command signal", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await expect(captureWorkspaceSnapshot(root, controller.signal)).rejects.toBeDefined();
  });
});
