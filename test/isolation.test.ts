import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyArtifact,
  cleanupIsolation,
  finalizeIsolation,
  gcIsolation,
  isolationRepoLockPath,
  isolationMetadata,
  mapIsolationPath,
  prepareIsolation,
} from "../src/isolation/worktree.ts";
import { IsolationError } from "../src/isolation/types.ts";
import { cmdBatch } from "../src/index.ts";
import { loadSession, saveSession } from "../src/session.ts";
import type { BatchDeps } from "../src/batch.ts";
import type { ChatMessage, RunReport, RunStatus, WorkspaceScope } from "../src/types.ts";

const roots: string[] = [];
const previousHome = process.env.LH_HOME;
const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const previousGitObjectDirectory = process.env.GIT_OBJECT_DIRECTORY;
const previousGitExternalDiff = process.env.GIT_EXTERNAL_DIFF;

afterEach(() => {
  if (previousHome === undefined) delete process.env.LH_HOME;
  else process.env.LH_HOME = previousHome;
  if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
  if (previousGitObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
  else process.env.GIT_OBJECT_DIRECTORY = previousGitObjectDirectory;
  if (previousGitExternalDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
  else process.env.GIT_EXTERNAL_DIFF = previousGitExternalDiff;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function run(cwd: string, args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString().trim();
}

function repo(): { root: string; home: string } {
  const root = temp("lh-iso-repo-");
  const home = temp("lh-iso-home-");
  process.env.LH_HOME = home;
  run(root, ["init", "-q"]);
  run(root, ["config", "user.name", "Isolation Test"]);
  run(root, ["config", "user.email", "isolation@example.invalid"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.env\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  fs.writeFileSync(path.join(root, "delete.txt"), "delete me\n");
  fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(root, "script.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  fs.symlinkSync("tracked.txt", path.join(root, "link"));
  run(root, ["add", "-A"]);
  run(root, ["commit", "-qm", "initial"]);
  return { root, home };
}

function gitState(root: string): { head: string; index: string; refs: string; objects: string[] } {
  const objects = path.join(root, ".git", "objects");
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(path.relative(objects, full));
    }
  };
  visit(objects);
  return {
    head: run(root, ["rev-parse", "HEAD"]),
    index: createHash("sha256").update(fs.readFileSync(path.join(root, ".git", "index"))).digest("hex"),
    refs: run(root, ["show-ref", "--head", "--dereference"]),
    objects: files.sort(),
  };
}

describe("private Git worktree isolation", () => {
  test("round-trips dirty, untracked, ignored, binary, symlink, mode, and deletion without touching parent Git state", async () => {
    const { root, home } = repo();
    fs.appendFileSync(path.join(root, "tracked.txt"), "staged\n");
    run(root, ["add", "tracked.txt"]);
    fs.appendFileSync(path.join(root, "tracked.txt"), "unstaged\n");
    fs.writeFileSync(path.join(root, "untracked.txt"), "untracked\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=baseline\n", { mode: 0o600 });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "skip"), "large dependency\n");
    fs.rmSync(path.join(root, "delete.txt"));
    const beforeGit = gitState(root);
    const beforeTracked = fs.readFileSync(path.join(root, "tracked.txt"), "utf8");
    const relevantStatus = (cwd: string) => run(cwd, ["status", "--porcelain=v1", "--ignored", "-uall"])
      .split("\n")
      .filter((line) => !line.includes("node_modules/"))
      .join("\n");
    const beforeStatus = relevantStatus(root);
    const beforeBranch = run(root, ["branch", "--show-current"]);

    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "roundtrip", homeDir: home });
    expect(fs.readFileSync(path.join(handle.executionCwd, "tracked.txt"), "utf8")).toBe(beforeTracked);
    expect(fs.readFileSync(path.join(handle.executionCwd, ".env"), "utf8")).toContain("baseline");
    expect(fs.existsSync(path.join(handle.executionCwd, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(handle.executionCwd, "delete.txt"))).toBe(false);
    expect(relevantStatus(handle.executionCwd)).toBe(beforeStatus);
    expect(run(handle.executionCwd, ["branch", "--show-current"])).toBe(beforeBranch);
    expect(run(handle.executionCwd, ["rev-parse", "HEAD"])).toBe(beforeGit.head);
    expect(gitState(root)).toEqual(beforeGit);

    fs.writeFileSync(path.join(handle.executionCwd, "tracked.txt"), "agent final\n");
    fs.writeFileSync(path.join(handle.executionCwd, "binary.bin"), Buffer.from([9, 0, 8, 0, 7]));
    fs.chmodSync(path.join(handle.executionCwd, "script.sh"), 0o755);
    fs.rmSync(path.join(handle.executionCwd, "link"));
    fs.symlinkSync("script.sh", path.join(handle.executionCwd, "link"));
    fs.rmSync(path.join(handle.executionCwd, "untracked.txt"));
    fs.writeFileSync(path.join(handle.executionCwd, ".env"), "SECRET=changed\n");
    fs.writeFileSync(path.join(handle.executionCwd, "created.txt"), "created\n");

    const artifact = await finalizeIsolation(handle);
    expect(artifact.changedRepoPaths).toEqual([
      ".env", "binary.bin", "created.txt", "link", "script.sh", "tracked.txt", "untracked.txt",
    ]);
    expect(fs.statSync(artifact.patchPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(artifact.manifestPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe(beforeTracked);
    expect(gitState(root)).toEqual(beforeGit);

    expect(await applyArtifact(handle, artifact)).toBe("applied");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("agent final\n");
    expect([...fs.readFileSync(path.join(root, "binary.bin"))]).toEqual([9, 0, 8, 0, 7]);
    expect(fs.lstatSync(path.join(root, "script.sh")).mode & 0o111).not.toBe(0);
    expect(fs.readlinkSync(path.join(root, "link"))).toBe("script.sh");
    expect(fs.existsSync(path.join(root, "untracked.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toContain("changed");
    expect(fs.statSync(path.join(root, ".env")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(root, "created.txt"), "utf8")).toContain("created");
    const afterGit = gitState(root);
    expect(afterGit.head).toBe(beforeGit.head);
    expect(afterGit.index).toBe(beforeGit.index);
    expect(afterGit.refs).toBe(beforeGit.refs);
    expect(afterGit.objects).toEqual(beforeGit.objects);
    expect(await cleanupIsolation(handle, artifact)).toBe("removed");
    expect(fs.existsSync(artifact.patchPath)).toBe(true);
  });

  test("concurrent parent change conflicts without applying the artifact", async () => {
    const { root, home } = repo();
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "conflict", homeDir: home });
    fs.writeFileSync(path.join(handle.executionCwd, "tracked.txt"), "agent\n");
    const artifact = await finalizeIsolation(handle);
    fs.writeFileSync(path.join(root, "tracked.txt"), "human\n");
    expect(await applyArtifact(handle, artifact)).toBe("conflict");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("human\n");
    expect(artifact.applyStatus).toBe("conflict");
    await cleanupIsolation(handle, artifact);
  });

  test("switching HEAD to a different branch at the same commit conflicts", async () => {
    const { root, home } = repo();
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "head-ref-conflict", homeDir: home });
    fs.writeFileSync(path.join(handle.executionCwd, "tracked.txt"), "agent\n");
    const artifact = await finalizeIsolation(handle);
    run(root, ["branch", "same-commit", "HEAD"]);
    run(root, ["symbolic-ref", "HEAD", "refs/heads/same-commit"]);
    expect(await applyArtifact(handle, artifact)).toBe("conflict");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
    await cleanupIsolation(handle, artifact);
  });

  test("no-op and tampered artifacts are still verified under the repo lock", async () => {
    const { root, home } = repo();
    const noOp = await prepareIsolation({ sourceCwd: root, sessionId: "noop-conflict", homeDir: home });
    const noOpArtifact = await finalizeIsolation(noOp);
    expect(noOpArtifact.applyStatus).toBe("not_needed");
    fs.writeFileSync(path.join(root, "tracked.txt"), "human\n");
    expect(await applyArtifact(noOp, noOpArtifact)).toBe("conflict");
    await cleanupIsolation(noOp, noOpArtifact);

    fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
    const tampered = await prepareIsolation({ sourceCwd: root, sessionId: "tampered-apply", homeDir: home });
    fs.writeFileSync(path.join(tampered.executionCwd, "tracked.txt"), "agent\n");
    const tamperedArtifact = await finalizeIsolation(tampered);
    fs.appendFileSync(tamperedArtifact.patchPath, "# changed after persistence\n");
    expect(await applyArtifact(tampered, tamperedArtifact)).toBe("conflict");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
    await cleanupIsolation(tampered, tamperedArtifact);
  });

  test("applies and verifies a non-Git permission-only change", async () => {
    const { root, home } = repo();
    fs.writeFileSync(path.join(root, "__proto__"), "edge\n", { mode: 0o644 });
    const before = gitState(root);
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "mode-only", homeDir: home });
    fs.chmodSync(path.join(handle.executionCwd, "tracked.txt"), 0o600);
    fs.chmodSync(path.join(handle.executionCwd, "__proto__"), 0o600);
    const artifact = await finalizeIsolation(handle);
    expect(fs.readFileSync(artifact.patchPath).length).toBe(0);
    expect(artifact.applyStatus).toBe("pending");
    expect(artifact.changedRepoPaths).toContain("tracked.txt");
    expect(artifact.changedRepoPaths).toContain("__proto__");
    expect(await applyArtifact(handle, artifact)).toBe("applied");
    expect(fs.statSync(path.join(root, "tracked.txt")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, "__proto__")).mode & 0o777).toBe(0o600);
    expect(gitState(root)).toEqual(before);
    await cleanupIsolation(handle, artifact);
  });

  test("post-apply verification failure restores bytes and permissions from the private backup", async () => {
    const { root, home } = repo();
    fs.chmodSync(path.join(root, "tracked.txt"), 0o600);
    const before = gitState(root);
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "rollback", homeDir: home });
    fs.writeFileSync(path.join(handle.executionCwd, "tracked.txt"), "agent\n");
    fs.chmodSync(path.join(handle.executionCwd, "tracked.txt"), 0o755);
    const artifact = await finalizeIsolation(handle);
    artifact.finalContentDigest = "0".repeat(64);
    expect(await applyArtifact(handle, artifact)).toBe("failed");
    expect(artifact.conflict).toContain("rollback verified");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.statSync(path.join(root, "tracked.txt")).mode & 0o777).toBe(0o600);
    expect(gitState(root)).toEqual(before);
    await cleanupIsolation(handle, artifact);
  });

  test("SIGINT observed during apply rolls the parent back before returning", async () => {
    const { root, home } = repo();
    fs.chmodSync(path.join(root, "tracked.txt"), 0o600);
    const before = gitState(root);
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "interrupt-rollback", homeDir: home });
    fs.writeFileSync(path.join(handle.executionCwd, "tracked.txt"), "agent\n");
    fs.chmodSync(path.join(handle.executionCwd, "tracked.txt"), 0o755);
    const artifact = await finalizeIsolation(handle);
    const controller = new AbortController();

    // applyArtifact first yields immediately before parent mutation. Queue the
    // abort behind that yield so it is observed at the post-mutation commit
    // boundary and exercises the durable rollback path.
    const applying = applyArtifact(handle, artifact, { signal: controller.signal });
    setImmediate(() => controller.abort(new DOMException("Interrupted", "AbortError")));

    expect(await applying).toBe("failed");
    expect(artifact.conflict).toContain("isolation apply interrupted");
    expect(artifact.conflict).toContain("rollback verified");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.statSync(path.join(root, "tracked.txt")).mode & 0o777).toBe(0o600);
    expect(gitState(root)).toEqual(before);
    await cleanupIsolation(handle, artifact);
  });

  test("an OS SIGINT queued by synchronous Git is classified before rollback returns", async () => {
    const { root, home } = repo();
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "os-sigint-rollback", homeDir: home });
    fs.writeFileSync(path.join(handle.executionCwd, "tracked.txt"), "agent\n");
    const artifact = await finalizeIsolation(handle);
    const before = gitState(root);
    const controller = new AbortController();
    let sawSigint = false;
    const onSigint = () => {
      sawSigint = true;
      controller.abort(new DOMException("Interrupted", "AbortError"));
    };
    const which = Bun.spawnSync(["which", "git"], { stdout: "pipe", stderr: "pipe" });
    expect(which.exitCode).toBe(0);
    const realGit = which.stdout.toString().trim();
    const bin = temp("lh-iso-git-wrapper-");
    const wrapper = path.join(bin, "git");
    fs.writeFileSync(wrapper, [
      "#!/bin/sh",
      'if [ "$1" = "apply" ] && [ "$2" = "--binary" ]; then',
      `  kill -INT ${process.pid}`,
      "  exit 130",
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });

    process.on("SIGINT", onSigint);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    try {
      expect(await applyArtifact(handle, artifact, { signal: controller.signal })).toBe("failed");
    } finally {
      process.env.PATH = savedPath;
      process.off("SIGINT", onSigint);
    }

    expect(sawSigint).toBe(true);
    expect(artifact.conflict).toContain("isolation apply interrupted");
    expect(artifact.conflict).toContain("rollback verified");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
    expect(gitState(root)).toEqual(before);
    await cleanupIsolation(handle, artifact);
  });

  test("retained patch can seed a resumed isolated worktree", async () => {
    const { root, home } = repo();
    fs.writeFileSync(path.join(root, ".env"), "baseline\n", { mode: 0o600 });
    const first = await prepareIsolation({ sourceCwd: root, sessionId: "resume-a", homeDir: home });
    fs.writeFileSync(path.join(first.executionCwd, "tracked.txt"), "partial\n");
    fs.writeFileSync(path.join(first.executionCwd, ".env"), "partial secret\n", { mode: 0o600 });
    const artifact = await finalizeIsolation(first);
    const retained = isolationMetadata(artifact);
    artifact.applyStatus = "retained";
    await cleanupIsolation(first, artifact);
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");

    const resumed = await prepareIsolation({
      sourceCwd: root,
      sessionId: "resume-b",
      homeDir: home,
      seedPatchPath: artifact.patchPath,
      seedPatchSha256: artifact.patchSha256,
      seedBaselineTree: artifact.baselineTree,
      seedBaselineFingerprint: retained.baseline_fingerprint,
      seedFinalContentDigest: retained.final_content_digest,
      seedFinalModes: retained.final_modes,
      seedFinalModesSha256: retained.final_modes_sha256,
    });
    expect(fs.readFileSync(path.join(resumed.executionCwd, "tracked.txt"), "utf8")).toBe("partial\n");
    expect(fs.statSync(path.join(resumed.executionCwd, ".env")).mode & 0o777).toBe(0o600);
    fs.appendFileSync(path.join(resumed.executionCwd, "tracked.txt"), "fixed\n");
    const resumedArtifact = await finalizeIsolation(resumed);
    expect(await applyArtifact(resumed, resumedArtifact)).toBe("applied");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("partial\nfixed\n");
    await cleanupIsolation(resumed, resumedArtifact);
  });

  test("resume rejects a changed baseline or tampered retained patch before replay", async () => {
    const { root, home } = repo();
    const first = await prepareIsolation({ sourceCwd: root, sessionId: "resume-source", homeDir: home });
    fs.writeFileSync(path.join(first.executionCwd, "tracked.txt"), "partial\n");
    const artifact = await finalizeIsolation(first);
    await cleanupIsolation(first, artifact);

    fs.writeFileSync(path.join(root, "tracked.txt"), "human\n");
    await expect(prepareIsolation({
      sourceCwd: root,
      sessionId: "resume-changed",
      homeDir: home,
      seedPatchPath: artifact.patchPath,
      seedPatchSha256: artifact.patchSha256,
      seedBaselineTree: artifact.baselineTree,
    })).rejects.toMatchObject({ code: "conflict" });
    fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");

    fs.appendFileSync(artifact.patchPath, "# tampered\n");
    await expect(prepareIsolation({
      sourceCwd: root,
      sessionId: "resume-tampered",
      homeDir: home,
      seedPatchPath: artifact.patchPath,
      seedPatchSha256: artifact.patchSha256,
      seedBaselineTree: artifact.baselineTree,
    })).rejects.toMatchObject({ code: "conflict" });
  });

  test("reclaims only a dead apply lock and fails closed for a live owner", async () => {
    const { root, home } = repo();
    const lockFile = isolationRepoLockPath(root);
    const lockDir = path.dirname(lockFile);
    fs.mkdirSync(lockDir, { recursive: true });

    const dead = await prepareIsolation({ sourceCwd: root, sessionId: "dead-lock", homeDir: home });
    fs.writeFileSync(path.join(dead.executionCwd, "tracked.txt"), "dead lock applied\n");
    const deadArtifact = await finalizeIsolation(dead);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_647, token: "stale" }), { mode: 0o600 });
    expect(await applyArtifact(dead, deadArtifact)).toBe("applied");
    expect(fs.existsSync(lockFile)).toBe(false);
    await cleanupIsolation(dead, deadArtifact);

    const otherHome = temp("lh-iso-other-home-");
    process.env.LH_HOME = otherHome;
    const malformed = await prepareIsolation({ sourceCwd: root, sessionId: "malformed-lock", homeDir: otherHome });
    fs.writeFileSync(path.join(malformed.executionCwd, "tracked.txt"), "malformed lock applied\n");
    const malformedArtifact = await finalizeIsolation(malformed);
    fs.writeFileSync(lockFile, "", { mode: 0o600 });
    const oldLockTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, oldLockTime, oldLockTime);
    expect(await applyArtifact(malformed, malformedArtifact)).toBe("applied");
    expect(fs.existsSync(lockFile)).toBe(false);
    await cleanupIsolation(malformed, malformedArtifact);
    process.env.LH_HOME = home;

    const live = await prepareIsolation({ sourceCwd: root, sessionId: "live-lock", homeDir: home });
    fs.writeFileSync(path.join(live.executionCwd, "tracked.txt"), "must not apply\n");
    const liveArtifact = await finalizeIsolation(live);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "live" }), { mode: 0o600 });
    expect(await applyArtifact(live, liveArtifact)).toBe("conflict");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("malformed lock applied\n");
    expect(fs.existsSync(lockFile)).toBe(true);
    fs.rmSync(lockFile);
    await cleanupIsolation(live, liveArtifact);
  });

  test("the fixed repo lock recovers a journaled apply after a worker crash", async () => {
    const { root, home } = repo();
    fs.chmodSync(path.join(root, "tracked.txt"), 0o600);
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "crash-recovery", homeDir: home });
    const artifact = await finalizeIsolation(handle);
    const backupDir = path.join(handle.storeDir, "apply-backup");
    const backupPath = path.join(backupDir, "tracked.txt");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(root, "tracked.txt"), backupPath);
    fs.chmodSync(backupPath, 0o600);
    const journalPath = path.join(handle.storeDir, "apply-journal.json");
    fs.writeFileSync(journalPath, JSON.stringify({
      schemaVersion: 1,
      repoRoot: fs.realpathSync(root),
      baseline: handle.baseline,
      parentExcluded: handle.parentExcluded,
      manifestPath: artifact.manifestPath,
      finalContentDigest: artifact.finalContentDigest,
      backup: {
        dir: backupDir,
        absentParents: [],
        entries: [{
          repoPath: "tracked.txt",
          kind: "file",
          mode: 0o600,
          sha256: createHash("sha256").update("base\n").digest("hex"),
          backupPath,
        }],
      },
    }));
    fs.chmodSync(journalPath, 0o600);
    fs.writeFileSync(path.join(root, "tracked.txt"), "partially applied\n");
    fs.chmodSync(path.join(root, "tracked.txt"), 0o755);
    const lockFile = isolationRepoLockPath(root);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_647, token: "dead", journalPath }), { mode: 0o600 });

    expect(await applyArtifact(handle, artifact)).toBe("applied");
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.statSync(path.join(root, "tracked.txt")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
    await cleanupIsolation(handle, artifact);
  });

  test("GC skips live and unsafe stores while preserving retained artifacts", async () => {
    const { root, home } = repo();
    const live = await prepareIsolation({ sourceCwd: root, sessionId: "gc-live", homeDir: home });
    const old = new Date(0);
    fs.utimesSync(live.storeDir, old, old);
    fs.utimesSync(path.join(live.storeDir, "owner.json"), old, old);
    const firstGc = gcIsolation({ homeDir: home, staleAfterMs: 0, nowMs: Date.now() + 1_000 });
    expect(firstGc.skippedLive).toBe(1);
    expect(fs.existsSync(live.worktreeRoot)).toBe(true);

    fs.writeFileSync(path.join(live.executionCwd, "tracked.txt"), "retained by gc\n");
    const artifact = await finalizeIsolation(live);
    fs.writeFileSync(path.join(live.storeDir, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
    fs.utimesSync(live.storeDir, old, old);
    fs.utimesSync(path.join(live.storeDir, "owner.json"), old, old);

    const outside = temp("lh-iso-gc-outside-");
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
    fs.symlinkSync(outside, path.join(home, "isolation", "unsafe-link"));
    const secondGc = gcIsolation({ homeDir: home, staleAfterMs: 0, nowMs: Date.now() + 1_000 });
    expect(secondGc.removedWorktrees).toBe(1);
    expect(secondGc.preservedArtifacts).toBe(1);
    expect(secondGc.skippedUnsafe).toBe(1);
    expect(fs.existsSync(live.worktreeRoot)).toBe(false);
    expect(fs.existsSync(artifact.patchPath)).toBe(true);
    expect(fs.existsSync(artifact.manifestPath)).toBe(true);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");

    const orphan = await prepareIsolation({ sourceCwd: root, sessionId: "gc-orphan", homeDir: home });
    fs.writeFileSync(path.join(orphan.storeDir, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
    fs.utimesSync(orphan.storeDir, old, old);
    fs.utimesSync(path.join(orphan.storeDir, "owner.json"), old, old);
    const thirdGc = gcIsolation({ homeDir: home, staleAfterMs: 0, nowMs: Date.now() + 1_000 });
    expect(thirdGc.removedEmptyStores).toBe(1);
    expect(fs.existsSync(orphan.storeDir)).toBe(false);
  });

  test("private Git creation ignores caller object redirection, filters, and init hooks", async () => {
    const { root, home } = repo();
    const hostile = temp("lh-iso-hostile-git-");
    const template = path.join(hostile, "template");
    const hooks = path.join(template, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    const sentinel = path.join(hostile, "executed");
    const hook = path.join(hooks, "post-checkout");
    const filter = path.join(hostile, "filter.sh");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${sentinel}\n`, { mode: 0o755 });
    fs.writeFileSync(filter, `#!/bin/sh\ntouch ${sentinel}\ncat\n`, { mode: 0o755 });
    const config = path.join(hostile, "gitconfig");
    fs.writeFileSync(config, [
      "[init]",
      `\ttemplateDir = ${template}`,
      '[filter "evil"]',
      `\tclean = ${filter}`,
      "\tsmudge = cat",
      "\trequired = true",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(root, ".gitattributes"), "*.txt filter=evil\n");
    const before = gitState(root);
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_OBJECT_DIRECTORY = path.join(root, ".git", "objects");

    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "hostile-git-env", homeDir: home });
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(gitState(root)).toEqual(before);
    expect(fs.readFileSync(path.join(handle.executionCwd, "tracked.txt"), "utf8")).toBe("base\n");
    fs.writeFileSync(path.join(handle.executionCwd, "tracked.txt"), "private change\n");
    process.env.GIT_EXTERNAL_DIFF = filter;
    const artifact = await finalizeIsolation(handle);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.readFileSync(artifact.patchPath, "utf8")).toContain("private change");
    await cleanupIsolation(handle, artifact);
  });

  test("fails closed before copying a multiply-linked parent file", async () => {
    const { root, home } = repo();
    const outside = temp("lh-iso-hardlink-outside-");
    const external = path.join(outside, "external.txt");
    fs.linkSync(path.join(root, "tracked.txt"), external);
    await expect(prepareIsolation({ sourceCwd: root, sessionId: "hardlink", homeDir: home }))
      .rejects.toThrow("multiply-linked");
    expect(fs.readFileSync(external, "utf8")).toBe("base\n");
    expect(fs.existsSync(path.join(home, "isolation", "hardlink"))).toBe(false);
  });

  test("finalization has an independent hard deadline and retains the private checkout", async () => {
    const { root, home } = repo();
    const handle = await prepareIsolation({ sourceCwd: root, sessionId: "finalize-timeout", homeDir: home });
    fs.writeFileSync(path.join(handle.executionCwd, "partial.txt"), "partial\n");
    await expect(finalizeIsolation(handle, { timeoutMs: 0 })).rejects.toThrow("timed out");
    expect(fs.readFileSync(path.join(handle.executionCwd, "partial.txt"), "utf8")).toBe("partial\n");
    expect(fs.existsSync(path.join(root, "partial.txt"))).toBe(false);
    await cleanupIsolation(handle);
  });

  test("maps absolute scope paths into a subdirectory checkout", async () => {
    const { root, home } = repo();
    fs.mkdirSync(path.join(root, "packages", "a"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "a", "x.txt"), "x\n");
    run(root, ["add", "packages/a/x.txt"]);
    run(root, ["commit", "-qm", "subdir"]);
    const logical = path.join(root, "packages", "a");
    const handle = await prepareIsolation({ sourceCwd: logical, sessionId: "subdir", homeDir: home });
    expect(handle.executionCwd.endsWith(path.join("packages", "a"))).toBe(true);
    expect(mapIsolationPath(logical, handle.executionCwd, path.join(logical, "x.txt"))).toBe(path.join(handle.executionCwd, "x.txt"));
    expect(() => mapIsolationPath(logical, handle.executionCwd, path.join(root, "tracked.txt"))).toThrow();
    const aliasParent = temp("lh-iso-cwd-alias-");
    const alias = path.join(aliasParent, "alias");
    fs.symlinkSync(logical, alias);
    expect(mapIsolationPath(alias, handle.executionCwd, path.join(logical, "x.txt"))).toBe(path.join(handle.executionCwd, "x.txt"));
    expect(mapIsolationPath(alias, handle.executionCwd, path.join(alias, "future.txt"))).toBe(path.join(handle.executionCwd, "future.txt"));
    await cleanupIsolation(handle);
  });

  test("fails closed for non-Git, unborn, and unmerged repositories", async () => {
    const home = temp("lh-iso-home-");
    const plain = temp("lh-iso-plain-");
    await expect(prepareIsolation({ sourceCwd: plain, sessionId: "plain", homeDir: home })).rejects.toBeInstanceOf(IsolationError);

    const unborn = temp("lh-iso-unborn-");
    run(unborn, ["init", "-q"]);
    await expect(prepareIsolation({ sourceCwd: unborn, sessionId: "unborn", homeDir: home })).rejects.toBeInstanceOf(IsolationError);

    const { root } = repo();
    const baseBranch = run(root, ["branch", "--show-current"]);
    run(root, ["checkout", "-qb", "other"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "other\n");
    run(root, ["commit", "-am", "other"]);
    run(root, ["checkout", "-q", baseBranch]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "master\n");
    run(root, ["commit", "-am", "master"]);
    Bun.spawnSync(["git", "merge", "other"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await expect(prepareIsolation({ sourceCwd: root, sessionId: "unmerged", homeDir: home })).rejects.toBeInstanceOf(IsolationError);
  });

  test("fails closed for a dirty submodule", async () => {
    const nested = temp("lh-iso-submodule-");
    run(nested, ["init", "-q"]);
    run(nested, ["config", "user.name", "Isolation Test"]);
    run(nested, ["config", "user.email", "isolation@example.invalid"]);
    fs.writeFileSync(path.join(nested, "nested.txt"), "base\n");
    run(nested, ["add", "nested.txt"]);
    run(nested, ["commit", "-qm", "nested"]);

    const { root, home } = repo();
    run(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "modules/nested"]);
    run(root, ["commit", "-qam", "add submodule"]);
    fs.writeFileSync(path.join(root, "modules", "nested", "nested.txt"), "dirty\n");
    await expect(prepareIsolation({ sourceCwd: root, sessionId: "dirty-submodule", homeDir: home }))
      .rejects.toThrow("submodules");
  });
});

function batchDeps(onRun: (scope: WorkspaceScope) => RunStatus): BatchDeps {
  return {
    now: Date.now,
    applyBudget: () => {},
    createAgent: (systemPrompt, _task, scope) => {
      let status: RunStatus = "error";
      const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
      return {
        async run(prompt: string) {
          messages.push({ role: "user", content: prompt });
          status = onRun(scope!);
          messages.push({ role: "assistant", content: status });
          return status;
        },
        get lastRunStatus() { return status; },
        getReport(): RunReport { return { changedFiles: [], commandsRun: [] }; },
        getMessages() { return messages; },
        interrupt() { status = "interrupted"; },
      };
    },
    runCheck: async (command, _timeout, attempts) => ({
      command,
      exit_code: 0,
      attempts,
      output_tail: "ok",
    }),
  };
}

describe("batch isolation integration", () => {
  test("applies once only after every task and final check succeed", async () => {
    const { root, home } = repo();
    const manifest = path.join(home, "tasks.json");
    fs.writeFileSync(manifest, JSON.stringify({ tasks: [{ id: "a", prompt: "edit", check: "true" }] }));
    const deps = batchDeps((scope) => {
      expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
      fs.writeFileSync(path.join(scope.cwd, "tracked.txt"), "batch\n");
      return "ok";
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await cmdBatch(["--tasks", manifest, "--cwd", root, "--worktree", "--json", "--quiet", "--session-id", "batch-applied"], deps)).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("batch\n");
    const record = loadSession("batch-applied")!;
    expect(record.status).toBe("ok");
    expect(record.cwd).toBe(path.resolve(root));
    expect(record.isolation?.apply_status).toBe("applied");
    expect(fs.existsSync(record.isolation!.patch_path!)).toBe(true);
  });

  test("partial batch retains a patch and leaves the parent unchanged", async () => {
    const { root, home } = repo();
    const manifest = path.join(home, "tasks.json");
    fs.writeFileSync(manifest, JSON.stringify({ tasks: [{ id: "a", prompt: "edit" }] }));
    const deps = batchDeps((scope) => {
      fs.writeFileSync(path.join(scope.cwd, "tracked.txt"), "partial\n");
      return "check_failed";
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await cmdBatch(["--tasks", manifest, "--cwd", root, "--worktree", "--json", "--quiet", "--session-id", "batch-retained"], deps)).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
    const record = loadSession("batch-retained")!;
    expect(record.isolation?.apply_status).toBe("retained");
    expect(fs.existsSync(record.isolation!.patch_path!)).toBe(true);
  });

  test("parent concurrency turns an otherwise successful batch into conflict", async () => {
    const { root, home } = repo();
    const manifest = path.join(home, "tasks.json");
    fs.writeFileSync(manifest, JSON.stringify({ tasks: [{ id: "a", prompt: "edit" }] }));
    const deps = batchDeps((scope) => {
      fs.writeFileSync(path.join(scope.cwd, "tracked.txt"), "agent\n");
      fs.writeFileSync(path.join(root, "tracked.txt"), "human\n");
      return "ok";
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await cmdBatch(["--tasks", manifest, "--cwd", root, "--worktree", "--json", "--quiet", "--session-id", "batch-conflict"], deps)).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("human\n");
    const record = loadSession("batch-conflict")!;
    expect(record.status).toBe("error");
    expect(record.errorKind).toBe("conflict");
    expect(record.isolation?.apply_status).toBe("conflict");
  });

  test("any final sweep mutation is audited, reported, and fails before apply", async () => {
    const { root, home } = repo();
    fs.mkdirSync(path.join(root, "allowed"));
    fs.writeFileSync(path.join(root, "allowed", "seed.txt"), "seed\n");
    run(root, ["add", "allowed/seed.txt"]);
    run(root, ["commit", "-qm", "allowed scope"]);
    const manifest = path.join(home, "tasks.json");
    fs.writeFileSync(manifest, JSON.stringify({
      tasks: [{ id: "a", prompt: "inspect", check: "true", allowed_paths: ["allowed"] }],
    }));
    let executionRoot = "";
    let checkCalls = 0;
    const deps = batchDeps((scope) => {
      executionRoot = scope.cwd;
      return "ok";
    });
    deps.runCheck = async (command, _timeout, attempts) => {
      checkCalls++;
      if (checkCalls === 2) fs.writeFileSync(path.join(executionRoot, "allowed", "sweep-side-effect.txt"), "sweep side effect\n");
      return { command, exit_code: 0, attempts, output_tail: "ok" };
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(await cmdBatch([
        "--tasks", manifest,
        "--cwd", root,
        "--worktree",
        "--json", "--quiet",
        "--session-id", "batch-sweep-scope",
      ], deps)).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(fs.existsSync(path.join(root, "allowed", "sweep-side-effect.txt"))).toBe(false);
    const record = loadSession("batch-sweep-scope")!;
    expect(record.status).toBe("failed");
    expect(record.tasks?.[0]?.check?.regressed).toBe(true);
    expect(record.report?.changedFiles.some((entry) => entry.path === "allowed/sweep-side-effect.txt")).toBe(true);
    expect(record.isolation?.apply_status).toBe("retained");
  });
});

async function runOneShotProcess(params: {
  root: string;
  home: string;
  server: ReturnType<typeof Bun.serve>;
  sessionId: string;
  extra?: string[];
}): Promise<{ code: number; payload: any; stderr: string }> {
  const proc = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../src/index.ts"),
    "-p", "edit generated.txt",
    "--cwd", params.root,
    "--json", "--quiet",
    "--session-id", params.sessionId,
    ...(params.extra ?? []),
  ], {
    cwd: params.root,
    env: { ...process.env, LH_HOME: params.home, OLLAMA_HOST: params.server.url.toString() },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, payload: stdout.trim() ? JSON.parse(stdout) : undefined, stderr };
}

async function runCliProcess(args: string[], options: { cwd: string; home: string; host?: string }) {
  const proc = Bun.spawn([
    process.execPath,
    path.resolve(import.meta.dir, "../src/index.ts"),
    ...args,
  ], {
    cwd: options.cwd,
    env: { ...process.env, LH_HOME: options.home, ...(options.host ? { OLLAMA_HOST: options.host } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, payload: stdout.trim() ? JSON.parse(stdout) : undefined, stderr };
}

describe("one-shot isolation integration", () => {
  test("submit placeholder and detached worker preserve execution dimensions", async () => {
    const { root, home } = repo();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({
        message: { role: "assistant", content: "done" },
        done: true,
        prompt_eval_count: 2,
        eval_count: 1,
      }) + "\n"),
    });
    try {
      const submitted = await runCliProcess([
        "submit", "-p", "do nothing", "--cwd", root, "--in-place", "--json",
        "--caller", "codex", "--hardware", "test-hardware", "--integration-version", "2.1.0",
      ], { cwd: root, home, host: server.url.toString() });
      expect(submitted.code).toBe(0);
      const id = submitted.payload.session_id as string;
      expect(loadSession(id)?.dimensions).toMatchObject({
        caller: "codex",
        hardware: "test-hardware",
        integrationVersion: "2.1.0",
      });

      let completed = loadSession(id);
      for (let i = 0; i < 200 && completed?.status === "running"; i++) {
        await Bun.sleep(10);
        completed = loadSession(id);
      }
      expect(completed?.status).toBe("ok");
      expect(completed?.dimensions).toMatchObject({
        caller: "codex",
        callerSource: "cli",
        hardware: "test-hardware",
        hardwareSource: "cli",
        integrationVersion: "2.1.0",
        integrationVersionSource: "cli",
        localrigVersion: "0.1.0",
      });
    } finally {
      server.stop(true);
    }
  });

  test("runs agent and check in private cwd, then applies and exposes metadata", async () => {
    const { root, home } = repo();
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/api/ps") return Response.json({ models: [] });
        const body = await request.json() as { messages?: Array<{ role?: string }> };
        const last = body.messages?.at(-1)?.role;
        const message = last === "tool"
          ? { role: "assistant", content: "done" }
          : { role: "assistant", content: "", tool_calls: [{ function: { name: "write", arguments: { path: "generated.txt", content: "generated\n" } } }] };
        return new Response(JSON.stringify({ message, done: true, prompt_eval_count: 2, eval_count: 1 }) + "\n");
      },
    });
    try {
      const out = await runOneShotProcess({
        root,
        home,
        server,
        sessionId: "oneshot-applied",
        extra: [
          "--check", "test -f generated.txt",
          "--caller", "codex", "--hardware", "test-hardware", "--integration-version", "2.1.0",
        ],
      });
      expect(out.code).toBe(0);
      expect(out.payload.status).toBe("ok");
      expect(out.payload.cwd).toBe(path.resolve(root));
      expect(out.payload.isolation.apply_status).toBe("applied");
      expect(fs.readFileSync(path.join(root, "generated.txt"), "utf8")).toBe("generated\n");
      expect(fs.existsSync(out.payload.isolation.patch_path)).toBe(true);
      expect(loadSession("oneshot-applied")?.dimensions).toMatchObject({
        caller: "codex",
        hardware: "test-hardware",
        integrationVersion: "2.1.0",
        localrigVersion: "0.1.0",
      });
    } finally {
      server.stop(true);
    }
  });

  test("an agent-modifiable acceptance check cannot write back into the parent checkout", async () => {
    if (process.platform !== "darwin") return;
    const { root, home } = repo();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({
        message: { role: "assistant", content: "done" },
        done: true,
        prompt_eval_count: 2,
        eval_count: 1,
      }) + "\n"),
    });
    try {
      const parentTarget = path.join(root, "tracked.txt");
      const out = await runOneShotProcess({
        root,
        home,
        server,
        sessionId: "check-sandbox",
        extra: ["--check", `printf hacked > ${parentTarget}`, "--check-retries", "0"],
      });
      expect(out.code).toBe(1);
      expect(out.payload.status).toBe("check_failed");
      expect(out.payload.check.output_tail).toMatch(/not permitted/i);
      expect(fs.readFileSync(parentTarget, "utf8")).toBe("base\n");
    } finally {
      server.stop(true);
    }
  });

  test("check failure retains patch, and resume replays it before applying the fix", async () => {
    const { root: repoRoot, home } = repo();
    const root = path.join(repoRoot, "packages", "a");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
    run(repoRoot, ["add", "packages/a/seed.txt"]);
    run(repoRoot, ["commit", "-qm", "subdirectory"]);
    let content = "partial\n";
    const requestBodies: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/api/ps") return Response.json({ models: [] });
        const body = await request.json() as { messages?: Array<{ role?: string; content?: string }> };
        requestBodies.push(JSON.stringify(body));
        const last = body.messages?.at(-1)?.role;
        const system = body.messages?.[0]?.content ?? "";
        const privateCwd = /^- cwd: (.+)$/m.exec(system)?.[1];
        const message = last === "tool"
          ? { role: "assistant", content: "done" }
          : { role: "assistant", content: "", tool_calls: [{ function: {
            name: "write",
            arguments: { path: privateCwd ? path.join(privateCwd, "generated.txt") : "generated.txt", content },
          } }] };
        return new Response(JSON.stringify({ message, done: true, prompt_eval_count: 2, eval_count: 1 }) + "\n");
      },
    });
    try {
      const first = await runOneShotProcess({
        root, home, server, sessionId: "oneshot-retained",
        extra: ["--check", "false", "--check-retries", "0"],
      });
      expect(first.code).toBe(1);
      expect(first.payload.status).toBe("check_failed");
      expect(first.payload.isolation.apply_status).toBe("retained");
      expect(fs.existsSync(path.join(root, "generated.txt"))).toBe(false);
      expect(fs.existsSync(first.payload.isolation.patch_path)).toBe(true);
      const previousWorktree = first.payload.isolation.worktree_path as string;

      const retainedRecord = loadSession("oneshot-retained")!;
      const retainedIsolation = retainedRecord.isolation!;
      saveSession({ ...retainedRecord, isolation: { ...retainedIsolation, patch_path: undefined } });
      const requestsBeforeMissingMetadata = requestBodies.length;
      const missingMetadata = await runOneShotProcess({
        root,
        home,
        server,
        sessionId: "oneshot-missing-metadata",
        extra: ["--resume", "oneshot-retained"],
      });
      expect(missingMetadata.code).toBe(1);
      expect(missingMetadata.payload.error_kind).toBe("conflict");
      expect(missingMetadata.payload.error).toContain("no retained patch");
      expect(requestBodies.length).toBe(requestsBeforeMissingMetadata);
      saveSession({ ...loadSession("oneshot-retained")!, isolation: retainedIsolation });

      const retainedPatch = first.payload.isolation.patch_path as string;
      const backupPatch = `${retainedPatch}.bak`;
      fs.renameSync(retainedPatch, backupPatch);
      const requestsBeforeMissing = requestBodies.length;
      const missingPatch = await runOneShotProcess({
        root,
        home,
        server,
        sessionId: "oneshot-missing-patch",
        extra: ["--resume", "oneshot-retained"],
      });
      expect(missingPatch.code).toBe(1);
      expect(missingPatch.payload.error_kind).toBe("conflict");
      expect(requestBodies.length).toBe(requestsBeforeMissing);
      fs.renameSync(backupPatch, retainedPatch);

      const other = repo();
      const wrongRoot = await runOneShotProcess({
        root: other.root,
        home,
        server,
        sessionId: "oneshot-wrong-root",
        extra: ["--resume", "oneshot-retained"],
      });
      expect(wrongRoot.code).toBe(1);
      expect(wrongRoot.payload.error_kind).toBe("conflict");
      expect(wrongRoot.payload.error).toContain("belongs to");

      content = "resumed\n";
      const resumeRequestStart = requestBodies.length;
      const resumed = await runOneShotProcess({
        root, home, server, sessionId: "oneshot-resumed",
        extra: ["--resume", "oneshot-retained", "--check", "test \"$(cat generated.txt)\" = resumed"],
      });
      expect(resumed.code).toBe(0);
      expect(resumed.payload.status).toBe("ok");
      expect(resumed.payload.resumed_from).toBe("oneshot-retained");
      expect(resumed.payload.isolation.apply_status).toBe("applied");
      expect(fs.readFileSync(path.join(root, "generated.txt"), "utf8")).toBe("resumed\n");
      const resumedRequests = requestBodies.slice(resumeRequestStart).join("\n");
      expect(resumedRequests).not.toContain(previousWorktree);
      expect(resumedRequests).toContain(resumed.payload.isolation.worktree_path);
      expect(resumedRequests).not.toContain(path.join("packages", "a", "packages", "a", "generated.txt"));
    } finally {
      server.stop(true);
    }
  });

  test("submit, poll, and wait JSON expose isolation lifecycle metadata", async () => {
    const { root, home } = repo();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({
        message: { role: "assistant", content: "done" },
        done: true,
        prompt_eval_count: 2,
        eval_count: 1,
      }) + "\n"),
    });
    try {
      const submitted = await runCliProcess(
        ["submit", "-p", "inspect only", "--cwd", root, "--json", "--quiet"],
        { cwd: root, home, host: server.url.toString() },
      );
      expect(submitted.code).toBe(0);
      expect(submitted.payload.status).toBe("running");
      expect(submitted.payload.isolation).toMatchObject({
        mode: "worktree",
        source_cwd: path.resolve(root),
        apply_status: "pending",
      });

      const polled = await runCliProcess(
        ["poll", submitted.payload.session_id, "--json"],
        { cwd: root, home },
      );
      expect(polled.payload.isolation.mode).toBe("worktree");

      const waited = await runCliProcess(
        ["wait", submitted.payload.session_id, "--timeout", "10", "--json"],
        { cwd: root, home },
      );
      expect(waited.code).toBe(0);
      expect(waited.payload.status).toBe("ok");
      expect(waited.payload.isolation).toMatchObject({
        mode: "worktree",
        apply_status: "not_needed",
        cleanup_status: "removed",
      });
    } finally {
      server.stop(true);
    }
  });

  test("non-Git and yolo fail closed unless in-place is explicit", async () => {
    const root = temp("lh-iso-nongit-");
    const home = temp("lh-iso-home-");
    const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 500 }) });
    try {
      const nongit = await runOneShotProcess({ root, home, server, sessionId: "nongit-default" });
      expect(nongit.code).toBe(1);
      expect(nongit.payload.error_kind).toBe("config");
      expect(nongit.payload.error).toContain("--in-place");

      const { root: gitRoot, home: gitHome } = repo();
      const yolo = await runOneShotProcess({ root: gitRoot, home: gitHome, server, sessionId: "yolo-default", extra: ["--yolo"] });
      expect(yolo.code).toBe(1);
      expect(yolo.payload.error_kind).toBe("config");
      expect(yolo.payload.error).toContain("--in-place");
    } finally {
      server.stop(true);
    }
  });
});
