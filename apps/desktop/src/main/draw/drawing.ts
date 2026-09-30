/**
 * Axon's own drawings — a small, fixed set of scenes, rendered deterministically.
 *
 * WHY A FIXED SET, AND NOT "DRAW ANYTHING". Drawing in Paint the way a person
 * does means moving a mouse to coordinates and dragging, which is exactly the
 * mechanism Axon refuses everywhere (see `ui-input.ts`): a coordinate is a
 * target nobody can check. So Axon never draws IN Paint. It draws here — a
 * scene made of a few dozen primitives, rendered to a PNG by this file — and
 * then asks Windows to open that one file in Paint.
 *
 * The model's entire input is a description ("a simple house at sunset"). It
 * is matched against words in this file; it never becomes a shape, a colour,
 * a coordinate or a path. An unrecognised subject is a refusal, not a guess.
 *
 * Pure: no I/O. `renderPng` uses zlib to compress, which is computation.
 */

import { deflateSync } from 'node:zlib';

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

export type SceneKey = 'house' | 'sunset' | 'cat' | 'tree';
export type SkyVariant = 'day' | 'sunset' | 'night';

export type Shape =
  | { readonly kind: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly fill: string }
  | { readonly kind: 'ellipse'; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number; readonly fill: string }
  | { readonly kind: 'polygon'; readonly points: readonly (readonly [number, number])[]; readonly fill: string }
  | { readonly kind: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly width: number; readonly fill: string };

export interface Scene {
  readonly key: SceneKey;
  readonly sky: SkyVariant;
  /** What it is, as a person would say it: "a house", "a house at sunset". */
  readonly label: string;
  readonly background: string;
  /** The fixed plan, in drawing order. */
  readonly steps: readonly DrawStep[];
  /** Every shape of every step, in order: the finished picture. */
  readonly shapes: readonly Shape[];
}

/** One step of a plan: what it is, as it is announced, and its shapes. */
export interface DrawStep {
  readonly label: string;
  readonly shapes: readonly Shape[];
}

/** The subjects Axon can draw, as they are offered to the model and the user. */
export const DRAWABLE_SUBJECTS: readonly string[] = ['a house', 'a sunset', 'a cat', 'a tree'];

const SUBJECT_WORDS: Readonly<Record<SceneKey, readonly string[]>> = {
  house: ['house', 'home', 'cottage', 'hut', 'cabin'],
  cat: ['cat', 'kitten', 'kitty'],
  tree: ['tree'],
  sunset: ['sunset', 'sundown', 'dusk', 'sunrise'],
};
const SUNSET_WORDS = ['sunset', 'sundown', 'dusk', 'sunrise', 'evening'];
const NIGHT_WORDS = ['night', 'moon', 'stars', 'starry', 'midnight'];

/**
 * What a description asks for, or null when it is not something Axon draws.
 *
 * Word-matched, never pattern-matched against the model's text as code. When a
 * description names two subjects ("a cat under a tree"), the first one named
 * is the drawing — one subject, stated plainly, rather than a composition
 * Axon was not asked for.
 */
export function resolveSubject(description: string): { readonly key: SceneKey; readonly sky: SkyVariant } | null {
  if (typeof description !== 'string') return null;
  const words = description.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const has = (list: readonly string[]): boolean => words.some((word) => list.includes(word) || list.includes(word.replace(/s$/, '')));

  let found: { key: SceneKey; at: number } | null = null;
  for (const key of ['house', 'cat', 'tree'] as const) {
    const at = words.findIndex((word) => SUBJECT_WORDS[key].includes(word) || SUBJECT_WORDS[key].includes(word.replace(/s$/, '')));
    if (at !== -1 && (found === null || at < found.at)) found = { key, at };
  }
  const sky: SkyVariant = has(NIGHT_WORDS) ? 'night' : has(SUNSET_WORDS) ? 'sunset' : 'day';
  if (found) return { key: found.key, sky };
  if (has(SUBJECT_WORDS.sunset)) return { key: 'sunset', sky: 'sunset' };
  return null;
}

// --- scenes ------------------------------------------------------------------
//
// Every scene is a FIXED PLAN: an ordered list of named steps, each a handful
// of shapes whose coordinates are constants in this file. `draw.paint` shows
// the plan in Paint one step at a time. Nothing about a step — its shapes,
// its order, its count — comes from the model.

const rect = (x: number, y: number, w: number, h: number, fill: string): Shape => ({ kind: 'rect', x, y, w, h, fill });
const ellipse = (cx: number, cy: number, rx: number, ry: number, fill: string): Shape => ({ kind: 'ellipse', cx, cy, rx, ry, fill });
const circle = (cx: number, cy: number, r: number, fill: string): Shape => ellipse(cx, cy, r, r, fill);
const polygon = (fill: string, ...points: (readonly [number, number])[]): Shape => ({ kind: 'polygon', points, fill });
const line = (x1: number, y1: number, x2: number, y2: number, width: number, fill: string): Shape => ({ kind: 'line', x1, y1, x2, y2, width, fill });
const step = (label: string, ...shapes: Shape[]): DrawStep => ({ label, shapes });

const SUNSET_BANDS = ['#2d1b4e', '#5b2a6e', '#a4436b', '#e3685a', '#f59e4c', '#ffcf6b'];

/** The sky down to `horizon` — only the colour, not what hangs in it. */
function skyBackdrop(sky: SkyVariant, horizon: number): Shape[] {
  if (sky === 'sunset') {
    const band = horizon / SUNSET_BANDS.length;
    return SUNSET_BANDS.map((fill, index) => rect(0, Math.floor(index * band), CANVAS_WIDTH, Math.ceil(band) + 1, fill));
  }
  if (sky === 'night') return [rect(0, 0, CANVAS_WIDTH, horizon, '#0c1a3a')];
  return [rect(0, 0, CANVAS_WIDTH, horizon, '#9fdcff'), rect(0, 0, CANVAS_WIDTH, Math.floor(horizon / 3), '#86cffa')];
}

/** The sun, the setting sun, or the moon and stars. */
function skyLight(sky: SkyVariant, horizon: number, sunX = 640): DrawStep {
  if (sky === 'sunset') return step('the sun', circle(sunX, horizon, 70, '#ffe08a'));
  if (sky === 'night') {
    const stars: [number, number][] = [[80, 60], [190, 130], [300, 50], [420, 110], [520, 40], [120, 220], [760, 200], [360, 200], [700, 60]];
    return step('the moon and stars', ...stars.map(([x, y]) => circle(x, y, 3, '#fff6c9')), circle(sunX, 110, 45, '#f3f0d7'), circle(sunX + 18, 98, 40, '#0c1a3a'));
  }
  const rays: Shape[] = [];
  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2;
    rays.push(line(sunX + Math.cos(angle) * 68, 110 + Math.sin(angle) * 68, sunX + Math.cos(angle) * 92, 110 + Math.sin(angle) * 92, 6, '#ffd23f'));
  }
  return step('the sun', ...rays, circle(sunX, 110, 55, '#ffd23f'));
}

const CLOUDS = (): DrawStep => step('a cloud', ellipse(170, 110, 60, 26, '#ffffff'), ellipse(215, 95, 45, 30, '#ffffff'), ellipse(255, 112, 50, 22, '#ffffff'));

function groundColor(sky: SkyVariant): string {
  return sky === 'night' ? '#1f4d2b' : sky === 'sunset' ? '#4a6b3a' : '#5cb85c';
}

function houseSteps(sky: SkyVariant): DrawStep[] {
  const lit = sky === 'day' ? '#bfe6ff' : '#ffd35a';
  const window = (x: number, y: number): Shape[] => [
    rect(x - 4, y - 4, 68, 63, '#ffffff'),
    rect(x, y, 60, 55, lit),
    line(x + 30, y, x + 30, y + 55, 4, '#ffffff'),
    line(x, y + 27, x + 60, y + 27, 4, '#ffffff'),
  ];
  const smoke = sky === 'night' ? '#8793a8' : '#e2e2e2';
  return [
    step('the sky and the ground', ...skyBackdrop(sky, 440), rect(0, 440, CANVAS_WIDTH, 160, groundColor(sky))),
    step('the walls', rect(260, 270, 280, 190, '#e8d5b0')),
    step('the roof', polygon('#b5473a', [235, 280], [400, 160], [565, 280])),
    step('the door', rect(375, 360, 56, 100, '#6b4226'), circle(420, 412, 5, '#ffd23f'), polygon('#c9a26b', [375, 460], [431, 460], [470, 600], [336, 600])),
    step('the windows', ...window(286, 310), ...window(454, 310)),
    skyLight(sky, 440),
    // Stands on the roof's slope, so it reads as behind the roof line.
    step('the chimney', polygon('#8a3a30', [470, 180], [504, 180], [504, 236], [470, 212])),
    step('the smoke', circle(492, 160, 13, smoke), circle(505, 138, 16, smoke), circle(522, 112, 19, smoke)),
    ...(sky === 'day' ? [CLOUDS()] : []),
    step('a tree', rect(118, 360, 22, 90, '#7a4b2a'), circle(129, 340, 48, '#2f8f46'), circle(100, 365, 32, '#38a452'), circle(158, 365, 32, '#38a452')),
  ];
}

function sunsetSteps(): DrawStep[] {
  const horizon = 360;
  const reflections: Shape[] = [];
  for (let row = 0; row < 7; row += 1) {
    const half = 70 - row * 9;
    reflections.push(line(400 - half, horizon + 18 + row * 22, 400 + half, horizon + 18 + row * 22, 6, '#ffcf6b'));
  }
  return [
    step('the sky', ...skyBackdrop('sunset', horizon)),
    skyLight('sunset', horizon, 400),
    step('the far mountains', polygon('#3b2350', [0, horizon], [0, 250], [110, 190], [220, 280], [300, 230], [380, horizon])),
    step('the near mountains', polygon('#2a1a3d', [430, horizon], [520, 240], [610, 300], [700, 210], [CANVAS_WIDTH, 270], [CANVAS_WIDTH, horizon])),
    step('the water', rect(0, horizon, CANVAS_WIDTH, CANVAS_HEIGHT - horizon, '#23355c')),
    step('the reflection', ...reflections),
  ];
}

function catSteps(sky: SkyVariant): DrawStep[] {
  const fur = '#f39c3d';
  const stripe = '#d9771f';
  return [
    step('the room', ...(sky === 'day' ? [rect(0, 0, CANVAS_WIDTH, 460, '#fdf1dc')] : skyBackdrop(sky, 460)), rect(0, 460, CANVAS_WIDTH, 140, sky === 'day' ? '#c89f73' : groundColor(sky))),
    step('the tail', line(520, 470, 600, 440, 26, fur), line(600, 440, 640, 380, 26, fur), line(640, 380, 630, 320, 26, fur), circle(630, 318, 13, fur)),
    step('the body', ellipse(400, 430, 135, 95, fur), line(330, 380, 350, 470, 8, stripe), line(400, 370, 400, 480, 8, stripe), line(470, 380, 450, 470, 8, stripe)),
    step('the paws', ellipse(335, 515, 38, 20, fur), ellipse(465, 515, 38, 20, fur)),
    step('the ears', polygon(fur, [320, 230], [335, 140], [390, 200]), polygon(fur, [480, 230], [465, 140], [410, 200]), polygon('#ffb3c1', [335, 215], [342, 165], [375, 203]), polygon('#ffb3c1', [465, 215], [458, 165], [425, 203])),
    step('the head', circle(400, 270, 90, fur)),
    step('the eyes', ellipse(365, 255, 17, 22, '#7ed957'), ellipse(435, 255, 17, 22, '#7ed957'), ellipse(365, 257, 5, 16, '#1b1b1b'), ellipse(435, 257, 5, 16, '#1b1b1b')),
    step('the nose and whiskers', polygon('#ff8fa3', [390, 290], [410, 290], [400, 302]), line(400, 302, 388, 315, 3, '#6b3a1f'), line(400, 302, 412, 315, 3, '#6b3a1f'), line(380, 300, 310, 288, 2, '#4a2a14'), line(380, 306, 312, 312, 2, '#4a2a14'), line(420, 300, 490, 288, 2, '#4a2a14'), line(420, 306, 488, 312, 2, '#4a2a14')),
    ...(sky === 'day' ? [] : [skyLight(sky, 460)]),
  ];
}

function treeSteps(sky: SkyVariant): DrawStep[] {
  return [
    step('the sky and the ground', ...skyBackdrop(sky, 460), rect(0, 460, CANVAS_WIDTH, 140, groundColor(sky))),
    step('the trunk', rect(370, 300, 60, 180, '#7a4b2a'), line(400, 350, 330, 290, 18, '#7a4b2a'), line(400, 340, 470, 280, 18, '#7a4b2a')),
    step('the leaves', circle(400, 220, 110, '#2f8f46'), circle(310, 270, 80, '#38a452'), circle(490, 270, 80, '#38a452'), circle(400, 300, 75, '#2f8f46')),
    step('the apples', ...[[340, 230], [450, 200], [390, 290], [300, 290], [500, 300], [420, 160]].map(([x, y]) => circle(x!, y!, 12, '#e23b3b'))),
    skyLight(sky, 460),
    ...(sky === 'day' ? [CLOUDS()] : []),
  ];
}

/** The most steps any plan has. A plan is bounded, and a test holds it to this. */
export const MAX_DRAW_STEPS = 12;

/** The scene for a subject Axon resolved. Never called with the model's text. */
export function buildScene(key: SceneKey, sky: SkyVariant): Scene {
  const at = sky === 'sunset' ? ' at sunset' : sky === 'night' ? ' at night' : '';
  const make = (label: string, background: string, steps: DrawStep[], resolvedSky: SkyVariant = sky): Scene => ({
    key,
    sky: resolvedSky,
    label,
    background,
    steps,
    shapes: steps.flatMap((entry) => entry.shapes),
  });
  switch (key) {
    case 'house':
      return make(`a house${at}`, '#9fdcff', houseSteps(sky));
    case 'sunset':
      return make('a sunset', '#2d1b4e', sunsetSteps(), 'sunset');
    case 'cat':
      return make(`a cat${at}`, '#fdf1dc', catSteps(sky));
    case 'tree':
      return make(`a tree${at}`, '#9fdcff', treeSteps(sky));
  }
}

/**
 * The plan as pictures: frame N is every step up to and including step N,
 * on the scene's background. Each frame is a whole picture, so showing them in
 * order builds the drawing up — and showing any one of them is never a
 * half-state Paint has to merge.
 */
export function renderFrames(scene: Scene): readonly { readonly label: string; readonly png: Uint8Array }[] {
  return scene.steps.map((entry, index) => ({
    label: entry.label,
    png: renderPng({ ...scene, shapes: scene.steps.slice(0, index + 1).flatMap((part) => part.shapes) }),
  }));
}

// --- SVG ---------------------------------------------------------------------

/** The same scene as SVG: no script, no external reference, nothing but shapes. */
export function renderSvg(scene: Scene): string {
  const body = scene.shapes.map((shape) => {
    switch (shape.kind) {
      case 'rect':
        return `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" fill="${shape.fill}"/>`;
      case 'ellipse':
        return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" fill="${shape.fill}"/>`;
      case 'polygon':
        return `<polygon points="${shape.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="${shape.fill}"/>`;
      case 'line':
        return `<line x1="${round(shape.x1)}" y1="${round(shape.y1)}" x2="${round(shape.x2)}" y2="${round(shape.y2)}" stroke="${shape.fill}" stroke-width="${shape.width}" stroke-linecap="round"/>`;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">` +
    `<rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="${scene.background}"/>${body.join('')}</svg>`
  );
}

const round = (value: number): number => Math.round(value * 100) / 100;

// --- raster ------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [0, 0, 0];
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The scene as 8-bit RGB pixels, row by row. Filled at pixel centres; no anti-aliasing. */
export function rasterize(scene: Scene): Uint8Array {
  const width = CANVAS_WIDTH;
  const height = CANVAS_HEIGHT;
  const pixels = new Uint8Array(width * height * 3);
  const [br, bg, bb] = rgb(scene.background);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 3] = br;
    pixels[index * 3 + 1] = bg;
    pixels[index * 3 + 2] = bb;
  }

  const fill = (x0: number, y0: number, x1: number, y1: number, colour: string, inside: (x: number, y: number) => boolean): void => {
    const [r, g, b] = rgb(colour);
    const left = Math.max(0, Math.floor(x0));
    const top = Math.max(0, Math.floor(y0));
    const right = Math.min(width - 1, Math.ceil(x1));
    const bottom = Math.min(height - 1, Math.ceil(y1));
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        const offset = (y * width + x) * 3;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
      }
    }
  };

  for (const shape of scene.shapes) {
    switch (shape.kind) {
      case 'rect':
        fill(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h, shape.fill, (x, y) => x >= shape.x && x < shape.x + shape.w && y >= shape.y && y < shape.y + shape.h);
        break;
      case 'ellipse':
        fill(shape.cx - shape.rx, shape.cy - shape.ry, shape.cx + shape.rx, shape.cy + shape.ry, shape.fill, (x, y) => {
          const dx = (x - shape.cx) / shape.rx;
          const dy = (y - shape.cy) / shape.ry;
          return dx * dx + dy * dy <= 1;
        });
        break;
      case 'polygon': {
        const xs = shape.points.map(([x]) => x);
        const ys = shape.points.map(([, y]) => y);
        fill(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), shape.fill, (x, y) => insidePolygon(shape.points, x, y));
        break;
      }
      case 'line': {
        const half = shape.width / 2;
        fill(
          Math.min(shape.x1, shape.x2) - half,
          Math.min(shape.y1, shape.y2) - half,
          Math.max(shape.x1, shape.x2) + half,
          Math.max(shape.y1, shape.y2) + half,
          shape.fill,
          (x, y) => distanceToSegment(x, y, shape.x1, shape.y1, shape.x2, shape.y2) <= half,
        );
        break;
      }
    }
  }
  return pixels;
}

function insidePolygon(points: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The scene as a PNG file's bytes. Deterministic: the same scene is the same bytes. */
export function renderPng(scene: Scene): Uint8Array {
  const pixels = rasterize(scene);
  const stride = CANVAS_WIDTH * 3;
  const raw = Buffer.alloc((stride + 1) * CANVAS_HEIGHT);
  for (let y = 0; y < CANVAS_HEIGHT; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(CANVAS_WIDTH, 0);
  header.writeUInt32BE(CANVAS_HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return new Uint8Array(
    Buffer.concat([Buffer.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]),
  );
}

/** Pixels as read back from an application: RGBA, row by row. */
export interface ReadBackImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/**
 * How much of an image read back from Paint IS the scene: a fixed grid of
 * sample points across the drawing, each compared with Axon's own rendering.
 * Pure. An image smaller than the drawing cannot match it.
 */
export function canvasMatch(scene: Scene, image: ReadBackImage): { readonly matched: number; readonly sampled: number } {
  const wanted = rasterize(scene);
  let matched = 0;
  let sampled = 0;
  const fits = image.width >= CANVAS_WIDTH && image.height >= CANVAS_HEIGHT && image.rgba.length >= image.width * image.height * 4;
  for (let y = 5; y < CANVAS_HEIGHT; y += 37) {
    for (let x = 5; x < CANVAS_WIDTH; x += 41) {
      sampled += 1;
      if (!fits) continue;
      const got = (y * image.width + x) * 4;
      const want = (y * CANVAS_WIDTH + x) * 3;
      const close = [0, 1, 2].every((channel) => Math.abs(image.rgba[got + channel]! - wanted[want + channel]!) <= 8);
      if (close) matched += 1;
    }
  }
  return { matched, sampled };
}

/** Does this look like a PNG at all? For bytes Axon did not make itself. */
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
