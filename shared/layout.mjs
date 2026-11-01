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

/** 시간 t 에서의 모자이크/블러 영역 좌상단 좌표 */
export function maskPositionAt(mask, t) {
  if (!mask.animate) return { x: mask.x, y: mask.y };
  const k = Math.min(1, Math.max(0, (t - mask.start) / Math.max(mask.duration, 1e-3)));
  return { x: mask.x + (mask.x2 - mask.x) * k, y: mask.y + (mask.y2 - mask.y) * k };
}

/** 페이드 인/아웃을 반영한 0~1 배율 */
export function fadeFactor(localT, duration, fadeIn = 0, fadeOut = 0) {
  let k = 1;
  if (fadeIn > 0 && localT < fadeIn) k = Math.min(k, Math.max(0, localT / fadeIn));
  if (fadeOut > 0 && localT > duration - fadeOut) k = Math.min(k, Math.max(0, (duration - localT) / fadeOut));
  return k;
}
