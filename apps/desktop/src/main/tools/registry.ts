/**
 * The tool registry.
 *
 * ARCHITECTURAL BOUNDARY — read before editing.
 *
 * This is the ONLY module in Axon permitted to import from `./executors/`.
 * Everything downstream (the dispatcher, and later the brain) receives tools
 * through this registry or through the code-free projection in
 * `schema-view.ts`. `tests/architecture.test.ts` fails the build if another
 * module imports an executor, so this comment is checked, not merely believed.
 *
 * The point is not that a stray import would be untidy. It is that the
 * dispatcher's guarantees — schema validation, dynamic risk resolution, the
 * approval gate — are only guarantees if there is no second way in.
 */

import type { RegisteredTool } from '@axon/core';
import type { AppLauncher, BrowserController, ScreenCapturer } from '../platform/ports.js';
import { createAppOpenTool } from './executors/app-open.js';
import { createFsWriteTool } from './executors/fs-write.js';
import { createScreenshotTool } from './executors/system-screenshot.js';
import {
  createBrowserBackTool,
  createBrowserClickTool,
  createBrowserCloseTool,
  createBrowserForwardTool,
  createBrowserNavigateTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserScrollTool,
  createBrowserTypeTool,
} from './executors/browser.js';
import { createMemoryForgetTool, createMemorySaveTool, createMemorySearchTool } from './executors/memory.js';
import { APP_KEYS } from './executors/app-registry.js';
import {
  WindowRegistry,
  createAppFocusTool,
  createWindowFocusTool,
  createWindowListTool,
  createWindowMaximizeTool,
  createWindowMinimizeTool,
} from './executors/windows.js';
import type { PathPolicy } from './executors/paths.js';
import type { PersistenceService } from '../persistence/persistence-service.js';
import type { DesktopWindows } from '../platform/windows-desktop.js';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      // Silently replacing a tool would let a later registration shadow an
      // earlier one's risk policy without anybody noticing.
      throw new Error(`A tool named "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): readonly string[] {
    return Array.from(this.tools.keys()).sort();
  }

  list(): readonly RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  get size(): number {
    return this.tools.size;
  }
}

export interface RegistryDependencies {
  readonly launcher: AppLauncher;
  readonly capturer: ScreenCapturer;
  readonly screenshotDir: string;
  readonly pathPolicy: PathPolicy;
  /** Absent when browsing is not configured; Axon then has no web tools. */
  readonly browser?: BrowserController | null;
  /** Absent when there is no database; Axon then has no memory tools. */
  readonly persistence?: PersistenceService | null;
  /** Absent off Windows; Axon then has no window tools and says so. */
  readonly desktop?: DesktopWindows | null;
}

/** The tools Axon ships with today. */
export function createDefaultRegistry(deps: RegistryDependencies): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createAppOpenTool(deps.launcher));
  registry.register(createScreenshotTool({ capturer: deps.capturer, screenshotDir: deps.screenshotDir }));
  registry.register(createFsWriteTool(deps.pathPolicy));

  // The browser tools exist only when a browser does. A tool the model can see
  // but that can never work is worse than no tool: it produces confident plans
  // built on a capability that is not there.
  const browser = deps.browser;
  if (browser) {
    registry.register(createBrowserOpenTool(browser));
    registry.register(createBrowserNavigateTool(browser));
    registry.register(createBrowserReadTool(browser));
    registry.register(createBrowserClickTool(browser));
    registry.register(createBrowserTypeTool(browser));
    registry.register(createBrowserScrollTool(browser));
    registry.register(createBrowserBackTool(browser));
    registry.register(createBrowserForwardTool(browser));
    registry.register(createBrowserCloseTool(browser));
  }

  // Window tools exist only where windows can actually be enumerated. A tool
  // the model can see but that can never work is worse than no tool: it
  // produces confident plans built on a capability that is not there.
  const desktop = deps.desktop;
  if (desktop?.available) {
    // ONE registry, shared by every window tool. Two registries would mean two
    // ideas of what `w2` refers to, which is the kind of ambiguity that ends
    // with an agent acting on the wrong window.
    const windows = new WindowRegistry();
    registry.register(createWindowListTool(desktop, windows));
    registry.register(createWindowFocusTool(desktop, windows));
    registry.register(createWindowMinimizeTool(desktop, windows));
    registry.register(createWindowMaximizeTool(desktop, windows));
    registry.register(createAppFocusTool(desktop, windows, APP_KEYS));
  }

  // Memory tools exist only when there is somewhere to remember. Offering
  // `memory.save` against a failed database would produce an assistant that
  // confidently promises to remember things and then does not.
  const persistence = deps.persistence;
  if (persistence?.available) {
    registry.register(createMemorySaveTool(persistence));
    registry.register(createMemorySearchTool(persistence));
    registry.register(createMemoryForgetTool(persistence));
  }

  return registry;
}
