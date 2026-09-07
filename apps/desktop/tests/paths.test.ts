/**
 * Path classification — the whole of `fs.write`'s risk judgement.
 *
 * Each case here is a way of naming a file that a naive `startsWith` check
 * would get wrong, which is precisely the class of bug that turns a write tool
 * into a way out of its sandbox.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPath, isWithin, type PathPolicy } from '../src/main/tools/executors/paths';

const HOME = path.resolve('C:/Users/tester');
const POLICY: PathPolicy = {
  workspaceRoot: path.join(HOME, 'Axon', 'workspace'),
  forbiddenRoots: [path.resolve('C:/Windows'), path.resolve('C:/Program Files'), path.join(HOME, 'Axon', 'logs')],
};

describe('isWithin', () => {
  it('treats a directory as within itself', () => {
    expect(isWithin(POLICY.workspaceRoot, POLICY.workspaceRoot)).toBe(true);
  });

  it('accepts a nested descendant', () => {
    expect(isWithin(POLICY.workspaceRoot, path.join(POLICY.workspaceRoot, 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the parent name', () => {
    // The prefix-matching bug in one line: "workspace-secrets" is not inside
    // "workspace", however much the strings look alike.
    expect(isWithin(POLICY.workspaceRoot, `${POLICY.workspaceRoot}-secrets/x.txt`)).toBe(false);
  });

  it('rejects a parent directory', () => {
    expect(isWithin(POLICY.workspaceRoot, path.join(HOME, 'Axon'))).toBe(false);
  });
});

describe('classifyPath — the safe case', () => {
  it('treats a relative path as living inside the workspace', () => {
    const verdict = classifyPath('notes.txt', POLICY);
    expect(verdict.class).toBe('INSIDE_WORKSPACE');
    expect(verdict.resolved).toBe(path.join(POLICY.workspaceRoot, 'notes.txt'));
  });

  it('accepts a nested relative path', () => {
    expect(classifyPath('reports/q3/summary.md', POLICY).class).toBe('INSIDE_WORKSPACE');
  });

  it('accepts the absolute form of a workspace path', () => {
    expect(classifyPath(path.join(POLICY.workspaceRoot, 'a.txt'), POLICY).class).toBe('INSIDE_WORKSPACE');
  });
});

describe('classifyPath — approval required', () => {
  it('flags a path just outside the workspace', () => {
    const verdict = classifyPath('../escaped.txt', POLICY);
    expect(verdict.class).toBe('OUTSIDE_WORKSPACE');
    expect(verdict.resolved).toBe(path.join(HOME, 'Axon', 'escaped.txt'));
  });

  it('flags the user desktop', () => {
    expect(classifyPath(path.join(HOME, 'Desktop', 'notes.txt'), POLICY).class).toBe('OUTSIDE_WORKSPACE');
  });

  it('resolves traversal before deciding, rather than trusting the literal string', () => {
    const verdict = classifyPath('a/b/../../../../elsewhere.txt', POLICY);
    expect(verdict.class).toBe('OUTSIDE_WORKSPACE');
    expect(verdict.resolved).not.toContain('..');
  });
});

describe('classifyPath — forbidden', () => {
  it('refuses a protected system directory', () => {
    const verdict = classifyPath('C:/Windows/System32/drivers/etc/hosts', POLICY);
    expect(verdict.class).toBe('FORBIDDEN');
    expect(verdict.reason).toContain('protected');
  });

  it('refuses regardless of case', () => {
    // Windows filesystems are case-insensitive; a case-sensitive check here
    // would be bypassed by lowercasing the drive path.
    expect(classifyPath('c:/windows/system32/x.txt', POLICY).class).toBe('FORBIDDEN');
  });

  it('refuses traversal that lands in a protected directory', () => {
    const escape = path.join(POLICY.workspaceRoot, '..', '..', '..', '..', 'Windows', 'x.txt');
    expect(classifyPath(escape, POLICY).class).toBe('FORBIDDEN');
  });

  it("refuses writes into Axon's own event log directory", () => {
    // The audit trail must not be rewritable by the agent it describes.
    expect(classifyPath(path.join(HOME, 'Axon', 'logs', 'events.jsonl'), POLICY).class).toBe('FORBIDDEN');
  });

  it('prefers FORBIDDEN over INSIDE_WORKSPACE when the two overlap', () => {
    const overlapping: PathPolicy = {
      workspaceRoot: path.resolve('C:/Windows/ws'),
      forbiddenRoots: [path.resolve('C:/Windows')],
    };
    expect(classifyPath('a.txt', overlapping).class).toBe('FORBIDDEN');
  });
});

describe('classifyPath — unrepresentable', () => {
  it.each([
    ['an empty path', ''],
    ['whitespace only', '   '],
    ['a null byte', 'a\0b.txt'],
    ['a UNC share', '\\\\server\\share\\x.txt'],
    ['the device namespace', '\\\\?\\C:\\Windows\\x.txt'],
    ['an alternate data stream', 'C:/Users/tester/Axon/workspace/notes.txt:hidden'],
  ])('rejects %s', (_label, value) => {
    expect(classifyPath(value, POLICY).class).toBe('INVALID');
  });

  it('does not mistake the drive-letter colon for a data stream', () => {
    expect(classifyPath('C:/Users/tester/Axon/workspace/ok.txt', POLICY).class).toBe('INSIDE_WORKSPACE');
  });
});
