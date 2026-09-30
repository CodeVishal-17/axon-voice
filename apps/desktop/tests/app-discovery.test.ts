/**
 * Installed-application discovery (Phase 3).
 *
 * DISCOVERED IS NOT TRUSTED. These tests pin how the Start menu's listing
 * becomes Axon's catalog: every record validated, non-applications dropped,
 * duplicates collapsed, command lines and system tools marked blocked, each
 * entry given an Axon-owned identifier — and the AppID that actually starts
 * it kept on this side of the boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppCatalog,
  appIdentifier,
  blockedReason,
  buildCatalog,
  clarificationFor,
  isLaunchableAppId,
  kindOf,
  looksLikeCommand,
  resolveApp,
  viewOf,
} from '../src/main/apps/app-catalog.js';
import {
  WindowsDesktop,
  parseDefaultBrowser,
  parseStartMenuApps,
  type RawStartMenuApp,
} from '../src/main/platform/windows-desktop.js';
import { declaredFailureKind } from '@axon/core';

/** Shaped like the real listing on the machine Phase 3 was measured on. */
const RAW: readonly RawStartMenuApp[] = [
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
  { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
  { name: 'Claude', appId: 'Claude_pzs8sxrjxfjjc!Claude' },
  { name: 'Claude', appId: 'com.squirrel.AnthropicClaude.claude' },
  { name: 'Command Prompt', appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe' },
  { name: 'Windows PowerShell', appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' },
  { name: 'Terminal', appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' },
  { name: 'Anaconda Prompt', appId: 'C:\\Users\\me\\anaconda3\\anaconda-prompt.exe' },
  { name: 'Anaconda Prompt', appId: 'C:\\ProgramData\\anaconda3\\anaconda-prompt.exe' },
  { name: 'Git GUI', appId: 'C:\\Program Files\\Git\\cmd\\git-gui.exe' },
  { name: 'Uninstall Foo', appId: 'C:\\Program Files\\Foo\\uninstall.exe' },
  { name: 'Foo Manual', appId: 'C:\\Program Files\\Foo\\manual.pdf' },
  { name: 'Foo Website', appId: 'https://foo.example/' },
];

const CATALOG = buildCatalog(RAW);
const byName = (name: string) => CATALOG.filter((app) => app.name === name);

describe('building the catalog', () => {
  it('keeps applications and drops what is not one', () => {
    const names = CATALOG.map((app) => app.name);
    expect(names).toContain('Spotify');
    expect(names).toContain('WhatsApp');
    expect(names).toContain('Visual Studio Code');
    // Uninstallers, documents and web links are Start-menu entries, not applications.
    expect(names).not.toContain('Uninstall Foo');
    expect(names).not.toContain('Foo Manual');
    expect(names).not.toContain('Foo Website');
  });

  it('classifies how each entry is started', () => {
    expect(byName('Spotify')[0]?.kind).toBe('packaged');
    expect(byName('Visual Studio Code')[0]?.kind).toBe('registered');
    expect(byName('Git GUI')[0]?.kind).toBe('program');
    expect(kindOf('C:\\Program Files\\Foo\\manual.pdf')).toBeNull();
    expect(kindOf('https://foo.example/')).toBeNull();
  });

  it('collapses the same AppID listed twice, and keeps two programs that share a name', () => {
    const doubled = buildCatalog([...RAW, { name: 'Spotify (again)', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' }]);
    expect(doubled.filter((app) => app.appId === 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')).toHaveLength(1);
    expect(byName('Claude')).toHaveLength(2);
  });

  it('gives every entry a stable Axon-owned id that is not the AppID', () => {
    const again = buildCatalog([...RAW].reverse());
    for (const app of CATALOG) {
      expect(app.id).toMatch(/^app_[0-9a-f]{10}$/);
      expect(app.id).toBe(appIdentifier(app.appId));
      expect(again.find((other) => other.appId === app.appId)?.id).toBe(app.id);
    }
    expect(new Set(CATALOG.map((app) => app.id)).size).toBe(CATALOG.length);
  });

  it('survives malformed records rather than trusting them', () => {
    const hostile = [
      null,
      42,
      { name: 7, appId: 'x' },
      { name: 'No id' },
      { name: '', appId: 'Valid.App' },
      { name: 'Switch', appId: '/select,C:\\Windows' },
      { name: 'Quoted', appId: '"C:\\evil.exe" --flag' },
      { name: 'Percent', appId: '%COMSPEC%' },
      { name: 'Parent', appId: 'C:\\Apps\\..\\Windows\\System32\\calc.exe' },
      { name: 'Newline\u0000App\u202e', appId: 'Good.App' },
      { name: 'x'.repeat(500), appId: 'Long.Name.App' },
    ] as unknown as RawStartMenuApp[];
    const built = buildCatalog(hostile);
    expect(built.map((app) => app.appId).sort()).toEqual(['Good.App', 'Long.Name.App']);
    const good = built.find((app) => app.appId === 'Good.App');
    // Control and bidirectional-override characters are stripped from names.
    expect(good?.name).toBe('NewlineApp');
    expect(built.find((app) => app.appId === 'Long.Name.App')?.name.length).toBe(80);
  });

  it('is empty, not an error, for an empty listing', () => {
    expect(buildCatalog([])).toEqual([]);
  });

  it('never shows a model the AppID', () => {
    for (const app of CATALOG) {
      const view = viewOf(app);
      expect(Object.keys(view).sort()).toEqual(['id', 'kind', 'name']);
      expect(JSON.stringify(view)).not.toContain(app.appId);
    }
  });
});

describe('what is never started', () => {
  it('blocks command lines, shells and system tools by purpose and by program', () => {
    for (const name of ['Command Prompt', 'Windows PowerShell', 'Terminal', 'Anaconda Prompt']) {
      for (const app of byName(name)) expect(app.blocked, name).not.toBeNull();
    }
    expect(blockedReason('Python 3.13', 'PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0!Python')).not.toBeNull();
    expect(blockedReason('Registry Editor', 'C:\\Windows\\regedit.exe')).not.toBeNull();
    expect(blockedReason('Innocent name', 'C:\\Tools\\pwsh.exe')).not.toBeNull();
  });

  it('does not block ordinary applications, or a program for the name of its folder', () => {
    for (const name of ['Spotify', 'WhatsApp', 'Visual Studio Code', 'Claude', 'Git GUI']) {
      for (const app of byName(name)) expect(app.blocked, name).toBeNull();
    }
  });
});

describe('resolving a request', () => {
  it('matches an exact name, an alias, a prefix and an Axon id', () => {
    expect(resolveApp(CATALOG, 'spotify')).toMatchObject({ kind: 'match', app: { name: 'Spotify' } });
    expect(resolveApp(CATALOG, 'VS Code')).toMatchObject({ kind: 'match', app: { name: 'Visual Studio Code' } });
    expect(resolveApp(CATALOG, 'visual studio')).toMatchObject({ kind: 'match', app: { name: 'Visual Studio Code' } });
    expect(resolveApp(CATALOG, 'studio code')).toMatchObject({ kind: 'match', app: { name: 'Visual Studio Code' } });
    const whatsapp = byName('WhatsApp')[0]!;
    expect(resolveApp(CATALOG, whatsapp.id)).toMatchObject({ kind: 'match', app: { name: 'WhatsApp' } });
  });

  it('asks rather than picks when two programs share a name', () => {
    const resolution = resolveApp(CATALOG, 'Claude');
    expect(resolution.kind).toBe('ambiguous');
    if (resolution.kind !== 'ambiguous') return;
    const question = clarificationFor('Claude', resolution.candidates);
    expect(question).toMatch(/Which one do you mean\?/);
    for (const app of resolution.candidates) expect(question).toContain(app.id);
    // The question never carries an AppID.
    for (const app of resolution.candidates) expect(question).not.toContain(app.appId);
  });

  it('answers none for something that is not installed, and for an unknown id', () => {
    expect(resolveApp(CATALOG, 'Photoshop')).toEqual({ kind: 'none' });
    expect(resolveApp(CATALOG, 'app_0000000000')).toEqual({ kind: 'none' });
    expect(resolveApp(CATALOG, '   ')).toEqual({ kind: 'none' });
  });

  it('recognises a path or a command as not a name', () => {
    for (const request of [
      'C:\\Windows\\System32\\cmd.exe',
      'c:/tools/thing',
      'notepad.exe',
      'script.ps1',
      'run.bat',
      'spotify --remote-debugging-port=9222',
      'x | y',
      '$(whoami)',
      '%COMSPEC%',
      '"quoted"',
      '\\\\server\\share\\app',
    ]) {
      expect(looksLikeCommand(request), request).toBe(true);
    }
    for (const name of ['Spotify', 'Visual Studio Code', 'Minecraft: Java Edition', 'Hearts & Spades', "Paint 3D"]) {
      expect(looksLikeCommand(name), name).toBe(false);
    }
    // '&' is allowed because names use it — and harmless, because a request is
    // only ever a search key: this finds nothing, so nothing is started.
    expect(resolveApp(CATALOG, 'calc & del *')).toEqual({ kind: 'none' });
  });
});

describe('the launchable-AppID gate', () => {
  it('admits the shapes the Start menu uses', () => {
    for (const appId of [
      'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
      'Microsoft.VisualStudioCode',
      'C:\\Program Files\\Git\\cmd\\git-gui.exe',
      '{6D809377-6AF0-444B-8957-A3773F02200E}\\Foo\\foo.exe',
    ]) {
      expect(isLaunchableAppId(appId), appId).toBe(true);
    }
  });

  it('refuses anything that could change what the launcher host does', () => {
    for (const appId of [
      '',
      '/select,C:\\Windows',
      '-flag',
      '"C:\\evil.exe"',
      '%COMSPEC%',
      'C:\\Apps\\..\\evil.exe',
      'App\nId',
      'App;calc',
      'App|calc',
      'x'.repeat(513),
      42,
      null,
    ]) {
      expect(isLaunchableAppId(appId), String(appId)).toBe(false);
    }
  });

  it('is re-checked by the launcher itself, which starts a constant program without a shell', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/main/platform/electron-platform.ts'), 'utf8');
    const method = source.slice(source.indexOf('launchStartMenuApp(appId: string)'), source.indexOf('launchStartMenuApp(appId: string)') + 1_500);
    expect(method).toMatch(/if \(!isLaunchableAppId\(appId\)\)/);
    expect(method).toMatch(/spawn\('explorer\.exe', \[`shell:AppsFolder\\\\\$\{appId\}`\]/);
    expect(method).not.toMatch(/shell:\s*true/);
  });
});

describe('the catalog over time', () => {
  it('is null until first taken, then serves the snapshot until stale', async () => {
    let now = 0;
    let calls = 0;
    const catalog = new AppCatalog(
      () => {
        calls += 1;
        return Promise.resolve(RAW);
      },
      () => now,
      1_000,
    );
    expect(catalog.snapshot()).toBeNull();
    expect(catalog.stale).toBe(true);
    await catalog.current();
    expect(calls).toBe(1);
    expect(catalog.snapshot()?.length).toBe(CATALOG.length);
    now = 500;
    await catalog.current();
    expect(calls).toBe(1);
    now = 2_000;
    await catalog.current();
    expect(calls).toBe(2);
  });

  it('shares one listing between requests that arrive together', async () => {
    let calls = 0;
    const catalog = new AppCatalog(() => {
      calls += 1;
      return new Promise((resolve) => setTimeout(() => resolve(RAW), 10));
    });
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.current()]);
    expect(calls).toBe(1);
  });

  it('keeps the previous catalog, and throws, when a refresh fails — never "nothing installed"', async () => {
    let fail = false;
    let now = 0;
    const catalog = new AppCatalog(
      () => (fail ? Promise.reject(new Error('listing failed')) : Promise.resolve(RAW)),
      () => now,
      1_000,
    );
    await catalog.refresh();
    fail = true;
    now = 5_000;
    await expect(catalog.current()).rejects.toThrow('listing failed');
    expect(catalog.snapshot()?.length).toBe(CATALOG.length);
  });
});

describe('the platform discovery port', () => {
  it('parses the listing, including a single entry rendered as a bare object', () => {
    expect(parseStartMenuApps('[{"name":"A","appId":"A.App"},{"name":"B","appId":"B.App"}]')).toHaveLength(2);
    expect(parseStartMenuApps('{"name":"A","appId":"A.App"}')).toEqual([{ name: 'A', appId: 'A.App' }]);
    expect(parseStartMenuApps('')).toEqual([]);
    expect(parseStartMenuApps('[null, 5, {"name":1}]')).toEqual([]);
    expect(() => parseStartMenuApps('not json')).toThrow();
  });

  it('parses the default browser, and returns null for anything else', () => {
    expect(parseDefaultBrowser('{"progId":"DiaHTML","name":"Dia","appUserModelId":"TheBrowserCompany.Dia_x!Dia"}')).toEqual({
      progId: 'DiaHTML',
      name: 'Dia',
      appUserModelId: 'TheBrowserCompany.Dia_x!Dia',
    });
    expect(parseDefaultBrowser('{"error":"none"}')).toBeNull();
    expect(parseDefaultBrowser('garbage')).toBeNull();
    expect(parseDefaultBrowser('{"progId":""}')).toBeNull();
  });

  it('asks the program only for a constant mode — never a name, a path or a command', async () => {
    const modes: string[] = [];
    const desktop = new WindowsDesktop({
      platform: 'win32',
      run: () => Promise.resolve('[]'),
      runApps: (mode) => {
        modes.push(mode);
        return Promise.resolve(mode === 'list' ? '[{"name":"Spotify","appId":"S.S_x!S"}]' : '{"progId":"P","name":"Dia","appUserModelId":""}');
      },
    });
    await desktop.listStartMenuApps();
    await desktop.defaultBrowser();
    expect(modes).toEqual(['list', 'default-browser']);
  });

  it('throws a classified error when it cannot look, and UNSUPPORTED off Windows', async () => {
    const failing = new WindowsDesktop({ platform: 'win32', run: () => Promise.resolve('[]'), runApps: () => Promise.reject(new Error('boom')) });
    await expect(failing.listStartMenuApps()).rejects.toThrow('could not read the list of installed applications');

    const elsewhere = new WindowsDesktop({ platform: 'linux' });
    expect(elsewhere.appsAvailable).toBe(false);
    const error = await elsewhere.listStartMenuApps().catch((caught: unknown) => caught);
    expect(declaredFailureKind(error)).toBe('UNSUPPORTED');
    expect(await elsewhere.defaultBrowser()).toBeNull();
  });
});
