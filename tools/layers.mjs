// One-off: node layers.mjs
// Builds the depth data for the three parallax layers from their images in ../assets:
//   plate.jpg  the full scene                               -> front-data.png
//   mid.jpg    the same scene without the nearest plants    -> mid-data.png
//   bg.jpg     the same scene without any near trees/plants -> back-data.png
// Each data file holds 16-bit disparity (white = near; high byte in R, low byte in B) and,
// in G, how big the depth jump is at each pixel. The page tears a layer open along the big
// jumps when the camera moves, and the layer behind shows through.
import sharp from 'sharp';
import { pipeline, RawImage } from '@huggingface/transformers';

const assets = new URL('../assets/', import.meta.url).pathname;
const W = 1584, H = 672;  // half the plate; the depth model resolves no finer than this
const EDGE = 0.12;        // disparity jump that counts as a depth edge
const SHARPEN = 5;        // px: soft depth ramps up to twice this wide become hard steps
const GROW = 3;           // px: near surfaces grow by this, so the tear lands just outside them

const estimator = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small');

// Float disparity, normalised to 0..1 and resampled to W x H.
async function depthOf(name) {
  const { predicted_depth: t } = await estimator(await RawImage.read(assets + name));
  const [h, w] = t.dims.slice(-2), src = t.data;
  let min = Infinity, max = -Infinity;
  for (const v of src) { if (v < min) min = v; if (v > max) max = v; }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = Math.min(w - 1.001, (x + 0.5) * w / W - 0.5), fy = Math.min(h - 1.001, (y + 0.5) * h / H - 0.5);
    const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy)), ax = Math.max(0, fx - x0), ay = Math.max(0, fy - y0);
    const i = y0 * w + x0;
    out[y * W + x] = ((src[i] * (1 - ax) + src[i + 1] * ax) * (1 - ay) + (src[i + w] * (1 - ax) + src[i + w + 1] * ax) * ay - min) / (max - min);
  }
  return out;
}
const grayOf = async name => Float32Array.from(
  await sharp(assets + name).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer(), v => v / 255);

// Separable min/max filter with a square window of radius r.
function extreme(src, r, pick) {
  const pass = (a, step, n, lines) => {
    const out = new Float32Array(a.length);
    for (let l = 0; l < lines; l++) for (let i = 0; i < n; i++) {
      const base = step === 1 ? l * W : l;
      let m = a[base + i * step];
      for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) m = pick(m, a[base + k * step]);
      out[base + i * step] = m;
    }
    return out;
  };
  return pass(pass(src, 1, W, H), W, H, W);
}

// Snap soft edges to whichever side they are closer to, leaving smooth slopes (the ground) alone.
function sharpen(d) {
  const lo = extreme(d, SHARPEN, Math.min), hi = extreme(d, SHARPEN, Math.max);
  return extreme(d.map((v, i) => hi[i] - lo[i] < EDGE ? v : hi[i] - v < v - lo[i] ? hi[i] : lo[i]), GROW, Math.max);
}

function save(name, disparity, tears) {
  const lo = extreme(disparity, 1, Math.min), hi = extreme(disparity, 1, Math.max);
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(Math.min(1, Math.max(0, disparity[i])) * 65535);
    px[i * 3] = v >> 8; px[i * 3 + 2] = v & 255;
    // Only real edges may tear; a gentle slope like the ground must never.
    if (tears && hi[i] - lo[i] > EDGE * 0.6) px[i * 3 + 1] = Math.min(255, (hi[i] - lo[i]) * 255);
  }
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toFile(assets + name);
}

const plate = await depthOf('plate.jpg'), plateGray = await grayOf('plate.jpg');
await save('front-data.png', sharpen(plate), true);

// Every depth map is normalised on its own. Rescale the others so the ground matches the
// plate's: take the median ratio over near ground that looks the same in both images.
async function matched(name) {
  const d = await depthOf(name), gray = await grayOf(name), ratios = [];
  for (let i = 0; i < d.length; i += 7) if (d[i] > 0.2 && Math.abs(gray[i] - plateGray[i]) < 0.06) ratios.push(plate[i] / d[i]);
  const scale = ratios.sort((a, b) => a - b)[ratios.length >> 1];
  console.log(`${name}: scale ${scale.toFixed(3)} from ${ratios.length} samples`);
  console.assert(scale > 0.5 && scale < 2 && ratios.length > 1000, 'depth scale looks wrong');
  return d.map(v => v * scale);
}
await save('mid-data.png', sharpen(await matched('mid.jpg')), true);
await save('back-data.png', await matched('bg.jpg'), false);
