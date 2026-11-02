// 영상 조절 값을 SVG 필터로 만들어 캔버스에 적용한다. 계산식은 내보내기와 같은 shared/layout.mjs 를 쓴다.

import {
  colorCurveValue, colorMatrix, hasColorCurve, hasColorMatrix, isColorNeutral, sharpenKernel, sharpnessOf,
} from '/shared/layout.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_CACHED_FILTERS = 40;
const CURVE_STEPS = 256;
const cache = new Map(); // 값 조합 → 필터 id
let host = null;
let nextId = 0;

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function buildFilter(clip, id, sharpen) {
  const filter = svgEl('filter', { id, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' });
  if (hasColorCurve(clip)) {
    const transfer = svgEl('feComponentTransfer');
    for (const [fn, ch] of [['feFuncR', 'r'], ['feFuncG', 'g'], ['feFuncB', 'b']]) {
      const table = Array.from({ length: CURVE_STEPS }, (_, i) => colorCurveValue(clip, ch, i / (CURVE_STEPS - 1)).toFixed(5));
      transfer.append(svgEl(fn, { type: 'table', tableValues: table.join(' ') }));
    }
    filter.append(transfer);
  }
  if (hasColorMatrix(clip)) {
    const m = colorMatrix(clip);
    const values = [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0];
    filter.append(svgEl('feColorMatrix', { type: 'matrix', values: values.map((v) => v.toFixed(5)).join(' ') }));
  }
  const amount = sharpen ? sharpnessOf(clip) : 0;
  if (amount) {
    filter.append(svgEl('feConvolveMatrix', {
      order: '3', kernelMatrix: sharpenKernel(amount).join(' '), divisor: '1', bias: '0', edgeMode: 'duplicate', preserveAlpha: 'true',
    }));
  }
  return filter;
}

/**
 * ctx.filter 에 넣을 값.
 * 선명도는 1080p 한 프레임에 수백 ms 가 걸려 재생 중에는 sharpen=false 로 생략한다. 내보내기에는 항상 반영된다.
 */
export function clipFilter(clip, { sharpen = true } = {}) {
  if (isColorNeutral(clip)) return 'none';
  const useSharpen = sharpen && !!sharpnessOf(clip);
  if (!useSharpen && !hasColorCurve(clip) && !hasColorMatrix(clip)) return 'none';
  const key = JSON.stringify([clip.brightness, clip.contrast, clip.saturation, clip.gamma, clip.temperature, clip.hue, useSharpen ? clip.sharpness : 0]);
  let id = cache.get(key);
  if (id) {
    // 최근에 쓴 값이 뒤로 가도록 다시 넣는다
    cache.delete(key);
    cache.set(key, id);
    return `url(#${id})`;
  }
  if (!host) {
    host = svgEl('svg', { width: '0', height: '0', 'aria-hidden': 'true' });
    host.style.position = 'absolute';
    document.body.append(host);
  }
  nextId += 1;
  id = `clipColor${nextId}`;
  host.append(buildFilter(clip, id, useSharpen));
  cache.set(key, id);
  if (cache.size > MAX_CACHED_FILTERS) {
    const [oldKey, oldId] = cache.entries().next().value;
    cache.delete(oldKey);
    host.querySelector(`#${oldId}`)?.remove();
  }
  return `url(#${id})`;
}
