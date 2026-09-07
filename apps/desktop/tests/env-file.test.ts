/**
 * `.env` loading.
 *
 * Small surface, but it is the surface that decides whether an API key reaches
 * the process at all — and, more importantly, whether a stale file on disk can
 * shadow one the user set deliberately on the command line.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envFileCandidates, loadEnvFile, parseEnvFile } from '../src/main/env-file';

const created: string[] = [];

function tempDirWithEnv(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-env-'));
  fs.writeFileSync(path.join(dir, '.env'), contents, 'utf8');
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parsing', () => {
  it('reads simple assignments', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    expect(parseEnvFile('# a comment\n\nFOO=bar\n   \n# another')).toEqual({ FOO: 'bar' });
  });

  it('strips one matching pair of quotes', () => {
    expect(parseEnvFile('A="one"\nB=\'two\'\nC="three')).toEqual({ A: 'one', B: 'two', C: '"three' });
  });

  it('accepts an `export` prefix', () => {
    expect(parseEnvFile('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('keeps a # inside a value', () => {
    // API keys can contain almost anything; guessing at inline comments would
    // silently truncate one.
    expect(parseEnvFile('KEY=sk-ant-abc#def')).toEqual({ KEY: 'sk-ant-abc#def' });
  });

  it('keeps = inside a value', () => {
    expect(parseEnvFile('KEY=a=b=c')).toEqual({ KEY: 'a=b=c' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseEnvFile('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('accepts an empty value', () => {
    expect(parseEnvFile('ANTHROPIC_API_KEY=')).toEqual({ ANTHROPIC_API_KEY: '' });
  });

  it.each([
    ['no separator', 'JUST_A_WORD'],
    ['leading =', '=value'],
    ['an invalid key', '9INVALID=x'],
    ['a key with a dash', 'MY-KEY=x'],
  ])('skips %s', (_label, line) => {
    expect(parseEnvFile(line)).toEqual({});
  });
});

describe('loading', () => {
  it('applies values into the given environment', () => {
    const dir = tempDirWithEnv('FOO=bar');
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFile([path.join(dir, '.env')], env);

    expect(result.applied).toBe(1);
    expect(env.FOO).toBe('bar');
  });

  it('never overrides a variable already set', () => {
    // The rule that matters: `KEY=x npm run dev` must beat a stale file.
    const dir = tempDirWithEnv('FOO=from-file');
    const env: NodeJS.ProcessEnv = { FOO: 'from-shell' };

    const result = loadEnvFile([path.join(dir, '.env')], env);

    expect(env.FOO).toBe('from-shell');
    expect(result.applied).toBe(0);
  });

  it('treats an empty existing value as unset', () => {
    const dir = tempDirWithEnv('FOO=from-file');
    const env: NodeJS.ProcessEnv = { FOO: '' };

    loadEnvFile([path.join(dir, '.env')], env);

    expect(env.FOO).toBe('from-file');
  });

  it('uses the first candidate that exists', () => {
    const first = tempDirWithEnv('FOO=first');
    const second = tempDirWithEnv('FOO=second');
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFile(
      [path.join(first, 'missing', '.env'), path.join(first, '.env'), path.join(second, '.env')],
      env,
    );

    expect(env.FOO).toBe('first');
    expect(result.path).toBe(path.join(first, '.env'));
  });

  it('is a no-op when no file exists', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFile(['/definitely/not/here/.env'], env)).toEqual({ path: null, applied: 0 });
    expect(env).toEqual({});
  });

  it('does not throw when a candidate is a directory', () => {
    // `existsSync` is true for a directory; reading it throws EISDIR.
    const dir = tempDirWithEnv('FOO=bar');
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadEnvFile([dir, path.join(dir, '.env')], env)).not.toThrow();
    expect(env.FOO).toBe('bar');
  });
});

describe('candidate paths', () => {
  it('looks at the monorepo root before the app directory', () => {
    // `path.resolve` is used inside, so expectations are resolved too —
    // on Windows that means a drive letter these literals do not carry.
    const candidates = envFileCandidates('/repo/apps/desktop', '/repo');
    expect(candidates[0]).toBe(path.join(path.resolve('/repo'), '.env'));
    expect(candidates).toContain(path.join(path.resolve('/repo/apps/desktop'), '.env'));
  });

  it('does not repeat a path when cwd is already a root', () => {
    const candidates = envFileCandidates('/repo/apps/desktop', '/repo');
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
