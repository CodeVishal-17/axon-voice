/**
 * Application compatibility probe, against the real operating system.
 *
 *   npm run compat:probe -- Spotify WhatsApp "WhatsApp Beta" "VS Code" "Claude#0" "default browser"
 *   npm run compat:probe -- --launch --pages=5 Spotify
 *
 * For each application: is it discovered, which windows it owns (by package
 * identity, by program, or only by title), and what its accessibility tree
 * exposes — page by page, with latency, and whether a scoped read works.
 *
 * READ-ONLY. It never types, clicks, invokes or sets anything, and it prints
 * COUNTS of controls, never their names: in a messaging application a
 * control's name is somebody's message.
 *
 * --launch starts an application that has no window, the way Axon does (its
 * Start-menu entry). With it, and only then, the probe cleans up after itself:
 * it ends the processes that own that application's windows AND did not exist
 * before the probe started anything. An application that was already running
 * — even in the background, windowless — is never touched.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app } = require('electron');

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--') && !/electron|compat-probe/.test(arg));
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const pagesFlag = [...flags].find((flag) => flag.startsWith('--pages='));
const maxPages = pagesFlag ? Number(pagesFlag.split('=')[1]) : 5;
const launch = flags.has('--launch');
const settleFlag = [...flags].find((flag) => flag.startsWith('--settle='));
const settleMs = settleFlag ? Number(settleFlag.split('=')[1]) : 0;
const repeatFlag = [...flags].find((flag) => flag.startsWith('--repeat='));
const repeat = repeatFlag ? Number(repeatFlag.split('=')[1]) : 0;
const asJson = flags.has('--json');

/** Every running process, right now: id -> lowercased image name. Used only to know what NOT to end. */
function runningProcesses() {
  const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const processes = new Map();
  for (const line of out.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line);
    if (match) processes.set(Number(match[2]), match[1].toLowerCase());
  }
  return processes;
}

function render(report) {
  const lines = [];
  lines.push(`catalog: ${report.catalog.entries} applications (${report.catalog.blocked} blocked) in ${report.catalog.ms} ms`);
  lines.push(`windows: ${report.windowListing.windows} listed, ${report.windowListing.withIdentity} with owner identity, in ${report.windowListing.ms} ms`);
  lines.push(`default browser: ${report.defaultBrowser.name ?? '(not identified)'} in ${report.defaultBrowser.ms} ms`);
  for (const row of report.rows) {
    lines.push('');
    lines.push(`== ${row.request}`);
    lines.push(`   resolution: ${row.resolution}${row.application ? ` -> ${row.application.name} (${row.application.kind}, ${row.application.id})` : ''}`);
    if (row.candidates) lines.push(`   candidates: ${row.candidates.map((c) => `${c.id} ${c.kind}`).join(', ')}`);
    lines.push(`   identity: package=${row.identity.package ?? '-'} program=${row.identity.program ?? '-'}`);
    lines.push(`   windows: ${row.windows.owned} owned (basis: ${row.windows.basis}, minimized: ${row.windows.minimized})`);
    if (row.launch.attempted) lines.push(`   launch: evidence=${row.launch.evidence ?? 'none'} in ${row.launch.ms ?? '-'} ms`);
    const a = row.accessibility;
    lines.push(`   accessibility: read=${a.read}`);
    for (const page of a.pages) {
      lines.push(`     page ${page.page}: ${page.controls} controls, hasMore=${page.hasMore}, ${page.ms} ms${page.problem ? `, ${page.problem}` : ''}`);
    }
    if (a.counts) {
      const c = a.counts;
      lines.push(`     buttons=${c.buttons} textFields=${c.textFields} invokable=${c.invokable} settable=${c.settable} sensitive=${c.sensitive} containers=${c.containers} fieldsWithText=${c.withValue}`);
      lines.push(`     content-length names=${c.longNames} searchFields=${c.searchFields} composeFields=${c.composeFields}`);
      lines.push(`     roles: ${Object.entries(c.roles).map(([role, n]) => `${role}=${n}`).join(', ')}`);
    }
    lines.push(`     scoped: ${a.scoped.tested ? `${a.scoped.controls} controls in ${a.scoped.ms} ms${a.scoped.problem ? ` (${a.scoped.problem})` : ''}` : 'not tested (no container control on page 1)'}`);
    if (a.staleScope) lines.push(`     stale scope -> ${a.staleScope}`);
    if (a.repeat) lines.push(`     page 1 x${a.repeat.count}: p50=${a.repeat.p50} ms p95=${a.repeat.p95} ms`);
    for (const note of row.notes) lines.push(`   note: ${note}`);
  }
  return lines.join('\n');
}

async function main() {
  const outDir = path.resolve(__dirname, '../out/main');
  const runtime = require(path.join(outDir, 'runtime.js'));
  const desktop = new runtime.WindowsDesktop({ platform: process.platform });
  const launcher = new runtime.ElectronAppLauncher();

  const before = launch ? runningProcesses() : null;
  const launched = [];
  const report = await runtime.runCompatibilityProbe(desktop, args.length ? args : ['Spotify', 'WhatsApp', 'WhatsApp Beta', 'VS Code', 'Claude', 'default browser'], {
    maxPages,
    settleMs,
    repeat,
    restoreLaunched: flags.has('--restore'),
    launchWaitMs: 30_000,
    ...(launch
      ? {
          launch: async (appId) => {
            launched.push(appId);
            await launcher.launchStartMenuApp(appId);
          },
        }
      : {}),
  });

  console.log(asJson ? JSON.stringify(report, null, 2) : render(report));
  // The native accessibility engine is a child process: end it with the probe.
  desktop.dispose();

  // CLEANUP, from what the probe recorded while measuring — no second
  // catalog read that could fail and leave an application running. Only
  // processes that did NOT exist before the probe started anything: the ones
  // that owned the launched application's windows, and new processes of the
  // program it runs as.
  if (launch && launched.length > 0 && before) {
    const after = runningProcesses();
    for (const row of report.rows.filter((entry) => entry.launch.attempted)) {
      const ours = new Set(row.processIds.filter((pid) => !before.has(pid)));
      if (row.expectedProgram) {
        for (const [pid, image] of after) if (!before.has(pid) && image === row.expectedProgram) ours.add(pid);
      }
      if (ours.size === 0) console.log(`cleanup: nothing the probe started is left for ${row.request}`);
      for (const pid of ours) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          console.log(`cleanup: ended process ${pid}, which the probe started`);
        } catch {
          console.log(`cleanup: process ${pid} had already exited`);
        }
      }
    }
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
