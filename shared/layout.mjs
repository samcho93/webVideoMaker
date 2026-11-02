// 클립 배치 계산. 미리보기(canvas)와 내보내기(ffmpeg)가 같은 결과를 쓰도록 한 곳에 둔다.

export const normAngle = (deg) => ((deg % 360) + 360) % 360;

/**
 * @returns dw,dh  회전 전 표시 크기(px), cx,cy 프레임 내 중심 좌표, angle 도(deg),
 *          sx,sy,sw,sh 원본 기준 크롭 영역(px), bboxW,bboxH 회전 후 경계 크기
 */
export function computeClipLayout(clip, media, W, H) {
  const crop = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
  const sw = Math.max(1, media.width * (1 - crop.l - crop.r));
  const sh = Math.max(1, media.height * (1 - crop.t - crop.b));
  const angle = normAngle(clip.rotation || 0);
  const rad = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const rotW = cos * sw + sin * sh;
  const rotH = sin * sw + cos * sh;
  const scale = clip.scale ?? 1;

  let dw;
  let dh;
  if (clip.fit === 'stretch') {
    const quarter = angle % 180 === 90;
    dw = (quarter ? H : W) * scale;
    dh = (quarter ? W : H) * scale;
  } else {
    const s = clip.fit === 'cover' ? Math.max(W / rotW, H / rotH) : Math.min(W / rotW, H / rotH);
    dw = sw * s * scale;
    dh = sh * s * scale;
  }
  return {
    dw,
    dh,
    cx: W / 2 + (clip.posX || 0),
    cy: H / 2 + (clip.posY || 0),
    angle,
    sx: media.width * crop.l,
    sy: media.height * crop.t,
    sw,
    sh,
    bboxW: cos * dw + sin * dh,
    bboxH: sin * dw + cos * dh,
  };
}

/** 원본 전체를 프레임에 꽉 차게 그릴 때의 크기 (블러 배경용) */
export function coverSize(mediaW, mediaH, W, H) {
  const s = Math.max(W / mediaW, H / mediaH);
  return { w: mediaW * s, h: mediaH * s };
}

const KEYFRAME_MERGE_SECONDS = 0.02;

function keyframePositionAt(mask, local) {
  const keys = mask.keyframes;
  if (local <= keys[0].t) return { x: keys[0].x, y: keys[0].y };
  for (let i = 1; i < keys.length; i += 1) {
    if (local < keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      if (mask.motion === 'hold') return { x: a.x, y: a.y };
      const k = (local - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y };
}

/** 시간 t 에서의 모자이크/블러 영역 좌상단 좌표 */
export function maskPositionAt(mask, t) {
  if (!mask.keyframes?.length) return { x: mask.x, y: mask.y };
  return keyframePositionAt(mask, t - mask.start);
}

/** 마스크 시작 기준 시각 local 의 위치를 기록한다. 처음 기록하면 시작 위치도 함께 남긴다 */
export function setMaskKeyframe(mask, local, x, y) {
  if (!mask.keyframes?.length) mask.keyframes = [{ t: 0, x: mask.x, y: mask.y }];
  const same = mask.keyframes.find((k) => Math.abs(k.t - local) < KEYFRAME_MERGE_SECONDS);
  if (same) Object.assign(same, { x, y });
  else mask.keyframes.push({ t: local, x, y });
  mask.keyframes.sort((a, b) => a.t - b.t);
  mask.x = mask.keyframes[0].x;
  mask.y = mask.keyframes[0].y;
}

/** 앞부분을 delta 초만큼 잘라도 남은 구간의 위치가 그대로이도록 맞춘다. 음수면 앞으로 늘린다 */
export function trimMaskStart(mask, delta) {
  if (!mask.keyframes?.length) return;
  if (delta < 0) {
    mask.keyframes = mask.keyframes.map((k) => ({ ...k, t: k.t - delta }));
    return;
  }
  const at = keyframePositionAt(mask, delta);
  const rest = mask.keyframes.filter((k) => k.t > delta + KEYFRAME_MERGE_SECONDS).map((k) => ({ ...k, t: k.t - delta }));
  mask.keyframes = [{ t: 0, x: at.x, y: at.y }, ...rest];
  mask.x = at.x;
  mask.y = at.y;
}

/** 마스크를 시작 기준 cut 초에서 둘로 나눌 때 위치 기록을 나눈다 */
export function splitMaskKeyframes(head, tail, cut) {
  if (!head.keyframes?.length) return;
  const at = keyframePositionAt(head, cut);
  tail.keyframes = head.keyframes.map((k) => ({ ...k }));
  trimMaskStart(tail, cut);
  head.keyframes = head.keyframes.filter((k) => k.t < cut - KEYFRAME_MERGE_SECONDS);
  if (head.motion !== 'hold') head.keyframes.push({ t: cut, x: at.x, y: at.y });
}

// ── 영상 조절 ──
// 미리보기(SVG 필터)와 내보내기(FFmpeg)가 같은 계산을 하도록 식을 이곳에 모은다.
// 순서: 채널별 곡선(색온도 → 대비 → 밝기 → 감마) → 색 행렬(채도 → 색조) → 선명도

export const COLOR_DEFAULTS = { brightness: 0, contrast: 0, saturation: 0, gamma: 1, temperature: 0, hue: 0, sharpness: 0 };
const TEMPERATURE_GAIN = { r: 0.25, g: 0, b: -0.25 };
const BRIGHTNESS_RANGE = 0.5;

const colorOf = (clip) => {
  const c = {};
  for (const key of Object.keys(COLOR_DEFAULTS)) c[key] = clip[key] ?? COLOR_DEFAULTS[key];
  return c;
};

export const hasColorCurve = (clip) => {
  const c = colorOf(clip);
  return c.brightness !== 0 || c.contrast !== 0 || c.gamma !== 1 || c.temperature !== 0;
};
export const hasColorMatrix = (clip) => {
  const c = colorOf(clip);
  return c.saturation !== 0 || c.hue !== 0;
};
export const sharpnessOf = (clip) => colorOf(clip).sharpness;
export const isColorNeutral = (clip) => !hasColorCurve(clip) && !hasColorMatrix(clip) && !sharpnessOf(clip);

/** 채널 ch('r','g','b')의 입력 v(0~1)에 대한 출력(0~1) */
export function colorCurveValue(clip, ch, v) {
  const c = colorOf(clip);
  const gain = 1 + TEMPERATURE_GAIN[ch] * c.temperature;
  const shaped = (v * gain - 0.5) * (1 + c.contrast) + 0.5 + c.brightness * BRIGHTNESS_RANGE;
  return Math.max(0, Math.min(1, shaped)) ** (1 / c.gamma);
}

/** colorCurveValue 와 같은 식의 FFmpeg lutrgb 표현 (val: 0~255) */
export function colorCurveExpr(clip, ch) {
  const c = colorOf(clip);
  const gain = 1 + TEMPERATURE_GAIN[ch] * c.temperature;
  return `255*pow(clip((val/255*${gain}-0.5)*${1 + c.contrast}+0.5+${c.brightness * BRIGHTNESS_RANGE},0,1),${1 / c.gamma})+0.5`;
}

/** 채도·색조를 합친 3×3 행렬 (행 우선) */
export function colorMatrix(clip) {
  const c = colorOf(clip);
  const LR = 0.2126;
  const LG = 0.7152;
  const LB = 0.0722;
  const s = 1 + c.saturation;
  const sat = [
    LR + (1 - LR) * s, LG - LG * s, LB - LB * s,
    LR - LR * s, LG + (1 - LG) * s, LB - LB * s,
    LR - LR * s, LG - LG * s, LB + (1 - LB) * s,
  ];
  const rad = (c.hue * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hue = [
    LR + cos * (1 - LR) - sin * LR, LG - cos * LG - sin * LG, LB - cos * LB + sin * (1 - LB),
    LR - cos * LR + sin * 0.143, LG + cos * (1 - LG) + sin * 0.14, LB - cos * LB - sin * 0.283,
    LR - cos * LR - sin * (1 - LR), LG - cos * LG + sin * LG, LB + cos * (1 - LB) + sin * LB,
  ];
  const out = [];
  for (let r = 0; r < 3; r += 1) {
    for (let col = 0; col < 3; col += 1) {
      out.push(hue[r * 3] * sat[col] + hue[r * 3 + 1] * sat[3 + col] + hue[r * 3 + 2] * sat[6 + col]);
    }
  }
  return out;
}

/** 선명도 3×3 합성곱 행렬 */
export function sharpenKernel(amount) {
  return [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0];
}

/** 페이드 인/아웃을 반영한 0~1 배율 */
export function fadeFactor(localT, duration, fadeIn = 0, fadeOut = 0) {
  let k = 1;
  if (fadeIn > 0 && localT < fadeIn) k = Math.min(k, Math.max(0, localT / fadeIn));
  if (fadeOut > 0 && localT > duration - fadeOut) k = Math.min(k, Math.max(0, (duration - localT) / fadeOut));
  return k;
}
