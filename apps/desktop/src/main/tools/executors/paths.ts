/**
 * Filesystem path classification.
 *
 * This is the whole of `fs.write`'s risk judgement, kept separate from the
 * executor so it can be tested exhaustively without touching a disk. It is
 * pure: everything it needs arrives as an argument.
 *
 * The rule it implements:
 *
 *   inside the agent workspace  -> SAFE
 *   inside a protected system   -> FORBIDDEN (no approval can unlock it)
 *   anywhere else               -> REQUIRES_APPROVAL
 *   unrepresentable             -> INVALID (the caller escalates)
 *
 * Windows-specific hazards handled here, because each of them is a way to
 * describe a path that a naive `startsWith` check would misclassify:
 *
 *   - Case insensitivity: `c:\windows` and `C:\Windows` are one directory.
 *   - Traversal: `workspace\..\..\Windows\x` resolves out of the workspace.
 *   - UNC paths: `\\server\share` is not on this machine at all.
 *   - Device namespace: `\\?\C:\Windows` bypasses normalization.
 *   - Alternate data streams: `notes.txt:evil` writes hidden content.
 */

import path from 'node:path';

export type PathClass = 'INSIDE_WORKSPACE' | 'FORBIDDEN' | 'OUTSIDE_WORKSPACE' | 'INVALID';

export interface PathPolicy {
  readonly workspaceRoot: string;
  readonly forbiddenRoots: readonly string[];
}

export interface PathClassification {
  readonly class: PathClass;
  /** Absolute, normalized path. Null when the input could not be resolved. */
  readonly resolved: string | null;
  readonly reason: string;
}

/**
 * True when `child` is `parent` or lives beneath it.
 *
 * Uses `path.relative` rather than string prefixing: prefixing reports
 * `C:\work-secrets` as being inside `C:\work`, which is exactly the kind of
 * near-miss that turns into a security bug.
 */
export function isWithin(parent: string, child: string): boolean {
  const from = normalizeForCompare(parent);
  const to = normalizeForCompare(child);
  if (from === to) return true;
  const relative = path.relative(from, to);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeForCompare(target: string): string {
  const resolved = path.resolve(target);
  // Windows filesystems are case-insensitive; comparing case-sensitively would
  // let `c:\windows\...` slip past a check written for `C:\Windows`.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Reject path shapes we refuse to reason about at all. */
function rejectUnsupportedShape(raw: string): string | null {
  if (raw.trim() === '') return 'The path is empty.';
  if (raw.includes('\0')) return 'The path contains a null byte.';

  const normalizedSeparators = raw.replace(/\//g, '\\');

  if (normalizedSeparators.startsWith('\\\\')) {
    // Covers both UNC shares (\\server\share) and the device namespace
    // (\\?\, \\.\), which skips the normalization every check here relies on.
    return 'UNC and device-namespace paths are not permitted.';
  }

  // An alternate data stream is written as `file.txt:stream`. A drive letter
  // colon is legitimate and always at index 1, so look past it.
  const afterDrive = normalizedSeparators.slice(2);
  if (afterDrive.includes(':')) {
    return 'Alternate data streams are not permitted.';
  }

  return null;
}

/**
 * Classify a caller-supplied path.
 *
 * Relative paths resolve against the workspace root, so the natural way to
 * name a file is also the safe way.
 */
export function classifyPath(raw: string, policy: PathPolicy): PathClassification {
  if (typeof raw !== 'string') {
    return { class: 'INVALID', resolved: null, reason: 'The path was not a string.' };
  }

  const shapeProblem = rejectUnsupportedShape(raw);
  if (shapeProblem) {
    return { class: 'INVALID', resolved: null, reason: shapeProblem };
  }

  let resolved: string;
  try {
    resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(policy.workspaceRoot, raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { class: 'INVALID', resolved: null, reason: `The path could not be resolved: ${message}` };
  }

  // Forbidden wins over everything, including the workspace. If someone ever
  // configures the workspace inside a protected root, the protected root is
  // the answer that keeps the machine intact.
  for (const root of policy.forbiddenRoots) {
    if (isWithin(root, resolved)) {
      return {
        class: 'FORBIDDEN',
        resolved,
        reason: `${resolved} is inside the protected location ${root}.`,
      };
    }
  }

  if (isWithin(policy.workspaceRoot, resolved)) {
    return {
      class: 'INSIDE_WORKSPACE',
      resolved,
      reason: `${resolved} is inside the Axon workspace.`,
    };
  }

  return {
    class: 'OUTSIDE_WORKSPACE',
    resolved,
    reason: `${resolved} is outside the Axon workspace (${policy.workspaceRoot}).`,
  };
}
