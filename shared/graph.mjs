// 프로젝트 → ffmpeg 입력/필터 그래프 변환. 외부 의존성이 없는 순수 함수라 단위 테스트가 가능하다.
//
// 텍스트·아이콘·자막은 렌더러에서 PNG 로 래스터화해 넘겨받는다. 덕분에 미리보기와 결과물의
// 글꼴·외곽선이 일치하고, ffmpeg 빌드의 폰트 지원 여부에 영향을 받지 않는다.

import { computeClipLayout, normAngle } from './layout.mjs';
import { findMedia, itemDuration, itemEnd, projectDuration } from './model.mjs';

const num = (v) => {
  const s = Number(v).toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const hexColor = (c) => `0x${String(c || '#000000').replace('#', '')}`;
const MANY_INPUTS = 6;

export const ENCODERS = {
  'mp4-h264': { ext: 'mp4', v: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium'], a: ['-c:a', 'aac', '-b:a', '192k'], extra: ['-movflags', '+faststart'], crf: { high: 18, medium: 23, low: 28 } },
  'mp4-h265': { ext: 'mp4', v: ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-tag:v', 'hvc1'], a: ['-c:a', 'aac', '-b:a', '192k'], extra: ['-movflags', '+faststart'], crf: { high: 22, medium: 27, low: 32 } },
  mov: { ext: 'mov', v: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium'], a: ['-c:a', 'aac', '-b:a', '192k'], extra: [], crf: { high: 18, medium: 23, low: 28 } },
  mkv: { ext: 'mkv', v: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium'], a: ['-c:a', 'aac', '-b:a', '192k'], extra: [], crf: { high: 18, medium: 23, low: 28 } },
  webm: { ext: 'webm', v: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-row-mt', '1', '-cpu-used', '4'], a: ['-c:a', 'libopus', '-b:a', '160k'], extra: [], crf: { high: 24, medium: 32, low: 40 } },
  gif: { ext: 'gif', v: [], a: null, extra: [], crf: {} },
};

function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${num(s)}`);
  return out;
}

/** 클립의 회전 필터와 회전 후 크기 */
function rotationFilters(angle, w, h) {
  const a = normAngle(angle);
  if (a === 0) return { filters: [], w, h };
  if (a === 90) return { filters: ['transpose=1'], w: h, h: w };
  if (a === 270) return { filters: ['transpose=2'], w: h, h: w };
  if (a === 180) return { filters: ['hflip', 'vflip'], w, h };
  const rad = (a * Math.PI) / 180;
  const r = num(rad);
  return {
    filters: ['format=rgba', `rotate=${r}:ow='rotw(${r})':oh='roth(${r})':c=none`],
    w: Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h,
    h: Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h,
  };
}

function colorFilter(clip) {
  const { brightness: b = 0, contrast: c = 0, saturation: s = 0 } = clip;
  if (!b && !c && !s) return [];
  return [`eq=brightness=${num(b * 0.5)}:contrast=${num(1 + c)}:saturation=${num(1 + s)}`];
}

function fadeFilters(duration, fadeIn, fadeOut) {
  const out = [];
  if (fadeIn > 0) out.push(`fade=t=in:st=0:d=${num(fadeIn)}:alpha=1`);
  if (fadeOut > 0) out.push(`fade=t=out:st=${num(Math.max(0, duration - fadeOut))}:d=${num(fadeOut)}:alpha=1`);
  return out;
}

/**
 * @param project 프로젝트
 * @param assets  { overlays: {id:{path,x,y}}, captions: {trackId:listPath}, masks: {id:path}, paths: {mediaId:path} }
 * @param opts    { format, quality, height, output }
 * @returns {{ inputArgs:string[], filter:string, outputArgs:string[], duration:number, inputCount:number }}
 */
export function buildExportPlan(project, assets = {}, opts = {}) {
  const { width: W, height: H, fps: F, background } = project.settings;
  const total = projectDuration(project);
  if (total <= 0) throw new Error('타임라인에 내보낼 내용이 없습니다.');
  const encoder = ENCODERS[opts.format || 'mp4-h264'];
  if (!encoder) throw new Error(`지원하지 않는 형식: ${opts.format}`);
  const wantAudio = !!encoder.a;

  const inputs = [];
  const addInput = (args) => { inputs.push(args); return inputs.length - 1; };
  const graph = [];
  const audioLabels = [];
  const mediaPath = (m) => assets.paths?.[m.id] || m.path;

  // 트랙은 배열 뒤쪽이 아래 레이어다.
  const bottomUp = [...project.tracks].reverse();
  const videoClips = [];
  const audioClips = [];
  for (const track of bottomUp) {
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    if (track.type === 'video') {
      for (const clip of sorted) {
        const media = findMedia(project, clip.mediaId);
        if (!media) throw new Error(`클립의 미디어를 찾을 수 없습니다: ${clip.mediaId}`);
        if (!track.hidden) videoClips.push({ clip, media, track });
        if (track.hidden && !track.muted) audioClips.push({ clip, media, track });
      }
    } else if (track.type === 'audio') {
      for (const clip of sorted) {
        const media = findMedia(project, clip.mediaId);
        if (!media) throw new Error(`클립의 미디어를 찾을 수 없습니다: ${clip.mediaId}`);
        audioClips.push({ clip, media, track });
      }
    }
  }
  const threadArgs = videoClips.length + audioClips.length >= MANY_INPUTS ? ['-threads', '2'] : [];

  graph.push(`color=c=${hexColor(background)}:s=${W}x${H}:r=${F}:d=${num(total)},format=yuv420p[base]`);
  let current = 'base';
  let n = 0;
  const nextLabel = (p) => `${p}${n++}`;
  const overlayOnto = (label, x, y, extra = '') => {
    const out = nextLabel('v');
    graph.push(`[${current}][${label}]overlay=x=${x}:y=${y}:eof_action=pass${extra}[${out}]`);
    current = out;
  };

  const addAudio = (index, clip, media, track) => {
    if (!wantAudio || !media.hasAudio || clip.muted || track.muted || !(clip.volume > 0)) return;
    const dur = itemDuration(clip);
    const fadeOut = Math.max(clip.fadeOut || 0, clip.audioFadeOut || 0);
    const chain = ['asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', ...atempoChain(clip.speed)];
    if (Math.abs(clip.volume - 1) > 1e-4) chain.push(`volume=${num(clip.volume)}`);
    if (clip.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(clip.fadeIn)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${num(Math.max(0, dur - fadeOut))}:d=${num(fadeOut)}`);
    if (clip.start > 0) chain.push(`adelay=delays=${Math.round(clip.start * 1000)}:all=1`);
    const label = nextLabel('a');
    graph.push(`[${index}:a:0]${chain.join(',')}[${label}]`);
    audioLabels.push(label);
  };

  const seekArgs = (clip) => [...(clip.in > 0.0005 ? ['-ss', num(clip.in)] : []), '-t', num(clip.out - clip.in)];

  // ── 비디오/이미지 클립 ──
  for (const { clip, media, track } of videoClips) {
    const dur = itemDuration(clip);
    const isImage = media.type === 'image';
    const index = isImage
      ? addInput(['-loop', '1', '-framerate', String(F), '-t', num(dur), '-i', mediaPath(media)])
      : addInput([...threadArgs, ...seekArgs(clip), '-i', mediaPath(media)]);

    const L = computeClipLayout(clip, media, W, H);
    const dw = even(L.dw);
    const dh = even(L.dh);
    const pre = [isImage ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${num(clip.speed)}`, `fps=${F}`];

    const fg = [];
    const { l = 0, t = 0, r = 0, b = 0 } = clip.crop || {};
    if (l || t || r || b) fg.push(`crop=iw*${num(1 - l - r)}:ih*${num(1 - t - b)}:iw*${num(l)}:ih*${num(t)}`);
    if (clip.flipH) fg.push('hflip');
    if (clip.flipV) fg.push('vflip');
    fg.push(...colorFilter(clip));
    fg.push(`scale=${dw}:${dh}`);
    const rot = rotationFilters(L.angle, dw, dh);
    fg.push(...rot.filters);
    fg.push('format=yuva420p');

    let x = Math.round(L.cx - rot.w / 2);
    let y = Math.round(L.cy - rot.h / 2);
    let body;
    if (clip.blurBackground) {
      const a = nextLabel('s');
      const bg = nextLabel('s');
      const fgLabel = nextLabel('s');
      const bgChain = [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, 'gblur=sigma=30', 'format=yuva420p'];
      body = nextLabel('s');
      graph.push(`[${index}:v:0]${pre.join(',')},split[${a}][${bg}]`);
      graph.push(`[${bg}]${bgChain.join(',')}[${bg}x]`);
      graph.push(`[${a}]${fg.join(',')}[${fgLabel}]`);
      graph.push(`[${bg}x][${fgLabel}]overlay=x=${x}:y=${y}[${body}]`);
      x = 0;
      y = 0;
    } else {
      body = nextLabel('s');
      graph.push(`[${index}:v:0]${pre.join(',')},${fg.join(',')}[${body}]`);
    }

    const post = [];
    const opacity = clip.opacity ?? 1;
    if (opacity < 0.999) post.push('format=rgba', `colorchannelmixer=aa=${num(opacity)}`);
    post.push(...fadeFilters(dur, clip.fadeIn, clip.fadeOut));
    post.push(`setpts=PTS+${num(clip.start)}/TB`);
    const finished = nextLabel('c');
    graph.push(`[${body}]${post.join(',')}[${finished}]`);
    overlayOnto(finished, x, y);

    if (!isImage && !track.muted) addAudio(index, clip, media, track);
  }

  // ── 오디오 트랙 (또는 숨겨진 비디오 트랙의 소리) ──
  for (const { clip, media, track } of audioClips) {
    if (!wantAudio || media.type === 'image' || !media.hasAudio || clip.muted || track.muted) continue;
    const index = addInput([...threadArgs, ...seekArgs(clip), '-i', mediaPath(media)]);
    addAudio(index, clip, media, track);
  }

  // ── 모자이크/블러 ──
  for (const track of bottomUp) {
    if (track.type !== 'effect' || track.hidden) continue;
    for (const mask of track.clips) {
      const end = itemEnd(mask);
      const w = Math.min(even(mask.w), W);
      const h = Math.min(even(mask.h), H);
      const clampX = (expr) => `min(max(${expr},0),${W - w})`;
      const clampY = (expr) => `min(max(${expr},0),${H - h})`;
      const k = `min(max((t-${num(mask.start)})/${num(Math.max(mask.duration, 1e-3))},0),1)`;
      const xExpr = mask.animate ? clampX(`${num(mask.x)}+(${num(mask.x2 - mask.x)})*${k}`) : clampX(num(mask.x));
      const yExpr = mask.animate ? clampY(`${num(mask.y)}+(${num(mask.y2 - mask.y)})*${k}`) : clampY(num(mask.y));
      const between = `between(t,${num(mask.start)},${num(end)})`;

      const keep = nextLabel('m');
      const region = nextLabel('m');
      graph.push(`[${current}]split[${keep}][${region}]`);
      const chain = [`crop=w=${w}:h=${h}:x='${xExpr}':y='${yExpr}'`];
      if (mask.effect === 'mosaic') {
        const block = Math.max(2, Math.round(mask.strength));
        chain.push(`scale=${Math.max(1, Math.round(w / block))}:${Math.max(1, Math.round(h / block))}:flags=area`, `scale=${w}:${h}:flags=neighbor`);
      } else {
        chain.push(`gblur=sigma=${num(mask.strength)}:enable='${between}'`);
      }
      let regionOut = nextLabel('m');
      graph.push(`[${region}]${chain.join(',')}[${regionOut}]`);
      if (mask.shape === 'ellipse') {
        const path = assets.masks?.[mask.id];
        if (!path) throw new Error('타원 마스크 이미지가 준비되지 않았습니다.');
        const maskIndex = addInput(['-loop', '1', '-framerate', String(F), '-t', num(total), '-i', path]);
        const gray = nextLabel('m');
        const merged = nextLabel('m');
        graph.push(`[${maskIndex}:v:0]scale=${w}:${h},format=gray[${gray}]`);
        graph.push(`[${regionOut}]format=yuva420p[${regionOut}a]`);
        graph.push(`[${regionOut}a][${gray}]alphamerge[${merged}]`);
        regionOut = merged;
      }
      const out = nextLabel('v');
      graph.push(`[${keep}][${regionOut}]overlay=x='${xExpr}':y='${yExpr}':enable='${between}':eof_action=pass[${out}]`);
      current = out;
    }
  }

  // ── 텍스트/아이콘 ──
  for (const track of bottomUp) {
    if (track.type !== 'overlay' || track.hidden) continue;
    for (const item of track.clips) {
      const asset = assets.overlays?.[item.id];
      if (!asset) continue;
      const index = addInput(['-loop', '1', '-framerate', String(F), '-t', num(item.duration), '-i', asset.path]);
      const chain = ['format=yuva420p', ...fadeFilters(item.duration, item.fadeIn, item.fadeOut), `setpts=PTS+${num(item.start)}/TB`];
      const label = nextLabel('o');
      graph.push(`[${index}:v:0]${chain.join(',')}[${label}]`);
      overlayOnto(label, Math.round(asset.x), Math.round(asset.y));
    }
  }

  // ── 자막/나레이션 ──
  for (const track of bottomUp) {
    if (track.type !== 'caption' || track.hidden || !track.clips.length) continue;
    const list = assets.captions?.[track.id];
    if (!list) continue;
    const index = addInput(['-f', 'concat', '-safe', '0', '-i', list]);
    const label = nextLabel('o');
    graph.push(`[${index}:v:0]fps=${F},format=yuva420p[${label}]`);
    overlayOnto(label, 0, 0);
  }

  // ── 출력 크기/형식 ──
  const outH = opts.height && opts.height !== H ? even(opts.height) : null;
  const outW = outH ? even((W * outH) / H) : null;
  const finalChain = [];
  if (outH) finalChain.push(`scale=${outW}:${outH}:flags=lanczos`);
  if (opts.format === 'gif') {
    finalChain.push(`fps=${Math.min(F, 15)}`, 'split[g1][g2]');
    graph.push(`[${current}]${finalChain.join(',')}`);
    graph.push('[g1]palettegen=stats_mode=diff[gp]');
    graph.push('[g2][gp]paletteuse=dither=bayer:bayer_scale=4[vout]');
  } else {
    finalChain.push('format=yuv420p');
    graph.push(`[${current}]${finalChain.join(',')}[vout]`);
  }

  // ── 오디오 믹스 (무음 트랙을 깔아 영상 길이에 맞춘다) ──
  const outputArgs = ['-map', '[vout]'];
  if (wantAudio) {
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(total)}[asil]`);
    if (audioLabels.length) {
      const labels = ['asil', ...audioLabels].map((l) => `[${l}]`).join('');
      graph.push(`${labels}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0,alimiter=limit=0.97:level=0[aout]`);
    } else {
      graph.push('[asil]anull[aout]');
    }
    outputArgs.push('-map', '[aout]');
  }
  outputArgs.push(...encoder.v);
  const crf = encoder.crf[opts.quality || 'high'];
  if (crf !== undefined) outputArgs.push('-crf', String(crf));
  if (encoder.a) outputArgs.push(...encoder.a);
  outputArgs.push(...encoder.extra, '-t', num(total));

  return { inputArgs: inputs.flat(), filter: graph.join(';\n'), outputArgs, duration: total, inputCount: inputs.length };
}

/** 자막 PNG 목록 → ffconcat 본문. 빈 구간은 투명 이미지로 채운다. */
export function buildCaptionConcat(entries, blankName, total) {
  const q = (name) => `'${String(name).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  let cursor = 0;
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i += 1) {
    const { name, start } = sorted[i];
    const nextStart = sorted[i + 1]?.start ?? Infinity;
    const end = Math.min(sorted[i].end, nextStart, total);
    if (start >= total || end <= start) continue;
    if (start > cursor) lines.push(`file ${q(blankName)}`, `duration ${num(start - cursor)}`);
    const from = Math.max(start, cursor);
    lines.push(`file ${q(name)}`, `duration ${num(end - from)}`);
    cursor = end;
  }
  if (cursor < total) lines.push(`file ${q(blankName)}`, `duration ${num(total - cursor)}`);
  lines.push(`file ${q(blankName)}`);
  return `${lines.join('\n')}\n`;
}
