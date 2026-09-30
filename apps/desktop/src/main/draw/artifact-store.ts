/**
 * Where Axon's drawings go — one directory Axon owns, names Axon chooses.
 *
 * Nothing outside this module decides where a drawing is written. There is no
 * path argument anywhere on the way here: the directory comes from the runtime
 * configuration (`AXON_HOME/drawings`), the file name is built from a fixed
 * word for what was drawn, the time, and random hex, and the result is checked
 * to be inside the directory before anything is written. A file that already
 * exists is never overwritten (`wx`), so even a collision cannot replace
 * something.
 *
 * `contains` is the check the rest of Axon uses before handing a path to
 * another application: only a file this store could have named, in this
 * directory, passes.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** What may name a drawing: a short lower-case word Axon chose. */
const SLUG = /^[a-z]{1,20}$/;
/** Every file this store writes, and nothing else. */
export const DRAWING_FILE = /^[a-z]{1,20}-\d{8}-\d{6}-[0-9a-f]{8}\.png$/;

export interface SavedDrawing {
  /** Absolute path. INTERNAL: handed to Windows to open, never to the model. */
  readonly path: string;
  /** The name alone, which is what the user and the model are told. */
  readonly fileName: string;
}

export interface DrawingStoreOptions {
  readonly now?: () => Date;
  /** Eight hex characters. Injected so a test can force a collision. */
  readonly random?: () => string;
}

const two = (value: number): string => String(value).padStart(2, '0');

export class DrawingStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly random: () => string;

  constructor(directory: string, options: DrawingStoreOptions = {}) {
    this.root = path.resolve(directory);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? (() => randomBytes(4).toString('hex'));
  }

  get directory(): string {
    return this.root;
  }

  /** Is this a drawing this store could have written, in its own directory? */
  contains(candidate: string): boolean {
    if (typeof candidate !== 'string' || candidate === '') return false;
    const resolved = path.resolve(candidate);
    return path.dirname(resolved) === this.root && DRAWING_FILE.test(path.basename(resolved));
  }

  async save(slug: string, png: Uint8Array): Promise<SavedDrawing> {
    if (!SLUG.test(slug)) throw new Error('A drawing is named by a short word Axon chose.');
    const at = this.now();
    const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
    const suffix = this.random();
    if (!/^[0-9a-f]{8}$/.test(suffix)) throw new Error('A drawing name needs eight hex characters.');
    const fileName = `${slug}-${stamp}-${suffix}.png`;
    const target = path.join(this.root, fileName);
    if (!this.contains(target)) throw new Error('That drawing would not be inside Axon\'s drawings folder.');

    await fs.mkdir(this.root, { recursive: true });
    // `wx`: fail rather than replace. Nothing is ever overwritten.
    await fs.writeFile(target, png, { flag: 'wx' });
    return { path: target, fileName };
  }
}
