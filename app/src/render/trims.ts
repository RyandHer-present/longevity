// Armour trims, coloured the way the game does it: the trim textures are greyscale "keys" that are
// swapped colour-for-colour against palettes/trim_base -> palettes/trim/<material>.
import { blockTex } from "../api";
import { loadImage } from "./skinview";

const imgs = new Map<string, Promise<HTMLImageElement>>();
const img = (path: string) => {
  let p = imgs.get(path);
  if (!p) {
    p = loadImage(blockTex(path));
    p.catch(() => imgs.delete(path));
    imgs.set(path, p);
  }
  return p;
};

/** Trim materials that have a darker palette for when the armour is made of the same thing. */
const DARKER = new Set(["copper", "diamond", "gold", "iron", "netherite"]);

function pixels(i: HTMLImageElement) {
  const c = document.createElement("canvas");
  c.width = i.width;
  c.height = i.height;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(i, 0, 0);
  return { c, x, d: x.getImageData(0, 0, i.width, i.height) };
}

const palettes = new Map<string, Promise<Map<number, [number, number, number]>>>();
function palette(material: string) {
  let p = palettes.get(material);
  if (!p) {
    p = Promise.all([img("palettes/trim_base"), img(`palettes/trim/${material}`)]).then(([b, m]) => {
      const bd = pixels(b).d.data;
      const md = pixels(m).d.data;
      const map = new Map<number, [number, number, number]>();
      for (let i = 0; i < bd.length && i < md.length; i += 4) map.set((bd[i] << 16) | (bd[i + 1] << 8) | bd[i + 2], [md[i], md[i + 1], md[i + 2]]);
      return map;
    });
    palettes.set(material, p);
  }
  return p;
}

const canvases = new Map<string, Promise<HTMLCanvasElement>>();
/** The 64x32 armour-layout trim texture for a pattern in a material. `armor` is the armour's own material ("iron", "gold"...). */
export function trimCanvas(pattern: string, material: string, legs: boolean, armor?: string): Promise<HTMLCanvasElement> {
  const pal = armor && armor === material && DARKER.has(material) ? material + "_darker" : material;
  const key = `${pattern}|${pal}|${legs ? 1 : 0}`;
  let p = canvases.get(key);
  if (!p) {
    p = Promise.all([img(`trims/entity/${legs ? "humanoid_leggings" : "humanoid"}/${pattern}`), palette(pal)]).then(([src, map]) => {
      const { c, x, d } = pixels(src);
      const a = d.data;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i + 3] === 0) continue;
        const k = (a[i] << 16) | (a[i + 1] << 8) | a[i + 2];
        let to = map.get(k);
        if (!to) {
          // a grey that isn't exactly on the key: use the nearest key colour
          let best = Infinity;
          for (const [kk, v] of map) {
            const dd = Math.abs(((kk >> 16) & 255) - a[i]) + Math.abs(((kk >> 8) & 255) - a[i + 1]) + Math.abs((kk & 255) - a[i + 2]);
            if (dd < best) {
              best = dd;
              to = v;
            }
          }
        }
        if (to) [a[i], a[i + 1], a[i + 2]] = to;
      }
      x.putImageData(d, 0, 0);
      return c;
    });
    p.catch(() => canvases.delete(key));
    canvases.set(key, p);
  }
  return p;
}

const fronts = new Map<string, Promise<string>>();
/**
 * A flat front view (16x32, like a closet card) of a full armour set wearing a trim, as a data URL.
 * `armor` is the armour material drawn underneath.
 */
export function trimFront(pattern: string, material: string, armor = "iron"): Promise<string> {
  const key = `${pattern}|${material}|${armor}`;
  let p = fronts.get(key);
  if (!p) {
    p = Promise.all([
      img(`entity/equipment/humanoid/${armor}`),
      img(`entity/equipment/humanoid_leggings/${armor}`),
      trimCanvas(pattern, material, false, armor),
      trimCanvas(pattern, material, true, armor),
    ]).then(([body, legs, tBody, tLegs]) => {
      const c = document.createElement("canvas");
      c.width = 16;
      c.height = 32;
      const x = c.getContext("2d")!;
      x.imageSmoothingEnabled = false;
      const draw = (src: CanvasImageSource) => {
        const s = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, flip = false) => {
          if (!flip) x.drawImage(src, sx, sy, w, h, dx, dy, w, h);
          else {
            x.save();
            x.translate(dx + w, dy);
            x.scale(-1, 1);
            x.drawImage(src, sx, sy, w, h, 0, 0, w, h);
            x.restore();
          }
        };
        return s;
      };
      // leggings first (under the chestplate and boots)
      for (const src of [legs, tLegs]) {
        const s = draw(src);
        s(20, 20, 8, 12, 4, 8); // waist
        s(4, 20, 4, 12, 4, 20); // right leg
        s(4, 20, 4, 12, 8, 20, true); // left leg
      }
      for (const src of [body, tBody]) {
        const s = draw(src);
        s(4, 20, 4, 12, 4, 20); // boots
        s(4, 20, 4, 12, 8, 20, true);
        s(20, 20, 8, 12, 4, 8); // chestplate
        s(44, 20, 4, 12, 0, 8); // right arm
        s(44, 20, 4, 12, 12, 8, true); // left arm
        s(8, 8, 8, 8, 4, 0); // helmet
      }
      return c.toDataURL();
    });
    p.catch(() => fronts.delete(key));
    fronts.set(key, p);
  }
  return p;
}
