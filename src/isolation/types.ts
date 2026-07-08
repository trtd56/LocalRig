export type IsolationApplyStatus =
  | "pending"
  | "not_needed"
  | "applied"
  | "retained"
  | "conflict"
  | "failed";

export type IsolationCleanupStatus = "pending" | "removed" | "retained";

export interface WorkspaceFingerprint {
  headOid: string;
  headRef: string;
  indexDigest: string;
  contentDigest: string;
}

export interface IsolationHandle {
  mode: "worktree";
  sessionId: string;
  sourceCwd: string;
  repoRoot: string;
  cwdRelative: string;
  storeDir: string;
  gitDir: string;
  worktreeRoot: string;
  executionCwd: string;
  baselineCommit: string;
  baselineTree: string;
  baseline: WorkspaceFingerprint;
  baselineModes: Record<string, number>;
  /** Harness-owned paths inside the repository excluded from parent snapshots. */
  parentExcluded: string[];
}

export interface IsolationArtifact {
  mode: "worktree";
  sessionId: string;
  sourceCwd: string;
  repoRoot: string;
  worktreePath?: string;
  baselineCommit: string;
  baselineTree: string;
  finalTree: string;
  patchPath: string;
  manifestPath: string;
  patchSha256: string;
  changedRepoPaths: string[];
  finalContentDigest: string;
  /** Final POSIX permissions for every regular path touched or mode-changed. */
  finalModes: Record<string, number>;
  baselineFingerprint: WorkspaceFingerprint;
  applyStatus: IsolationApplyStatus;
  cleanupStatus: IsolationCleanupStatus;
  conflict?: string;
  rollbackFailed?: boolean;
}

export interface IsolationSessionMetadata {
  mode: "worktree" | "in_place";
  source_cwd: string;
  workspace_id?: string;
  baseline_commit?: string;
  baseline_tree?: string;
  patch_path?: string;
  patch_sha256?: string;
  apply_status?: IsolationApplyStatus;
  cleanup_status?: IsolationCleanupStatus;
  worktree_path?: string;
  conflict?: string;
  baseline_fingerprint?: WorkspaceFingerprint;
  final_content_digest?: string;
  final_modes?: Record<string, number>;
  final_modes_sha256?: string;
  rollback_failed?: boolean;
}

export interface IsolationGcOptions {
  homeDir?: string;
  /** Private execution data younger than this is never collected. */
  staleAfterMs?: number;
  /** Injectable clock for deterministic maintenance/tests. */
  nowMs?: number;
}

export interface IsolationGcResult {
  examined: number;
  removedWorktrees: number;
  removedEmptyStores: number;
  preservedArtifacts: number;
  skippedLive: number;
  skippedUnsafe: number;
}

export class IsolationError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "conflict" | "io" | "internal",
  ) {
    super(message);
    this.name = "IsolationError";
  }
}
