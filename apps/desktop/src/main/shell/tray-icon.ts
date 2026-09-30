/**
 * The tray icon, drawn in code.
 *
 * A small glass orb in Axon's listening blue. Generated rather than shipped as
 * an image file, so there is no binary asset to review and nothing to load
 * from disk. PURE: a size in, a BGRA bitmap out.
 */

const BASE: readonly [number, number, number] = [72, 149, 255];
const DEEP: readonly [number, number, number] = [36, 78, 170];

export function orbIconBitmap(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size * 0.44;
  const lightX = centre - radius * 0.35;
  const lightY = centre - radius * 0.4;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre);
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance));
      if (alpha === 0) continue;

      // Deeper toward the lower edge, bright where the light catches it.
      const depth = Math.max(0, Math.min(1, (y - centre) / radius + 0.2)) * 0.55;
      const highlight = Math.max(0, 1 - Math.hypot(x - lightX, y - lightY) / (radius * 1.05)) ** 1.6;
      const channel = (i: 0 | 1 | 2): number => {
        const body = BASE[i] + (DEEP[i] - BASE[i]) * depth;
        return Math.round(body + (255 - body) * highlight * 0.8);
      };

      const offset = (y * size + x) * 4;
      pixels[offset] = channel(2);
      pixels[offset + 1] = channel(1);
      pixels[offset + 2] = channel(0);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}
