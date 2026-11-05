// 미리보기 합성기와 화면 위 직접 조작(이동·크기 조절).

import { computeClipLayout, coverSize, fadeFactor, maskPositionAt, setMaskKeyframe } from '/shared/layout.mjs';
import { findMedia, itemDuration, itemEnd, projectDuration } from '/shared/model.mjs';
import { formatFrames, formatHMS } from '/shared/time.mjs';
import { reportPlaybackError } from './actions.js';
import { clipFilter } from './colorFilter.js';
import { MpvPlayer } from './mpvPlayer.js';
import { mediaUrl, previewPath, store } from './store.js';
import { rasterizeCaption, rasterizeOverlay } from './raster.js';

const PREROLL = 1.5;
const DRIFT_PLAYING = 0.3;
const DRIFT_PAUSED = 0.02;
const DRAG_THRESHOLD_PX = 3;
const MAX_IDLE_MPV_PLAYERS = 3;

export class Preview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tmp = document.createElement('canvas');
    this.time = 0;
    this.playing = false;
    this.dirty = true;
    this.slots = new Map(); // clipId → { el, mediaId, gain }
    this.free = new Map(); // src → element[]
    this.images = new Map(); // path → HTMLImageElement
    this.audioCtx = null;
    this.lastNow = 0;
    this.onTime = () => {};
    this.resize();
    requestAnimationFrame((t) => this.tick(t));
  }

  get duration() {
    return projectDuration(store.project);
  }

  resize() {
    const { width, height } = store.project.settings;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.layoutStage();
    this.invalidate();
  }

  layoutStage() {
    const area = document.getElementById('stageArea');
    const stage = document.getElementById('stage');
    const { width, height } = store.project.settings;
    const maxW = area.clientWidth - 20;
    const maxH = area.clientHeight - 20;
    const k = Math.min(maxW / width, maxH / height);
    stage.style.width = `${Math.max(10, Math.floor(width * k))}px`;
    stage.style.height = `${Math.max(10, Math.floor(height * k))}px`;
  }

  invalidate() {
    this.dirty = true;
  }

  seek(t) {
    this.time = Math.max(0, t);
    this.invalidate();
    this.onTime(this.time);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (this.duration <= 0) return;
    if (this.time >= this.duration - 0.01) this.time = 0;
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    this.audioCtx.resume();
    this.playing = true;
    this.lastNow = performance.now();
    document.getElementById('btnPlay').textContent = '❚❚';
  }

  pause() {
    this.playing = false;
    document.getElementById('btnPlay').textContent = '▶';
    for (const { el } of this.slots.values()) el.pause();
    this.invalidate();
  }

  // ── 미디어 요소 관리 ──

  acquire(clip, media) {
    const slot = this.slots.get(clip.id);
    const path = previewPath(media);
    if (!path) return null;
    // 같은 파일이라도 재생 엔진이 바뀌면 새 요소를 쓴다
    const key = `${store.rt(media.id).engine ?? 'browser'}|${path}`;
    if (slot && slot.key === key) return slot;
    if (slot) this.release(clip.id);

    const pool = this.free.get(key);
    const el = pool?.pop() || this.createElement(media, path);
    const fresh = { el, path, key, gain: el.__gain };
    this.slots.set(clip.id, fresh);
    return fresh;
  }

  createElement(media, path) {
    const useMpv = store.rt(media.id).engine === 'mpv';
    if (useMpv) this.trimIdleMpvPlayers();
    const el = useMpv ? new MpvPlayer(path, media.type === 'audio') : document.createElement(media.type === 'audio' ? 'audio' : 'video');
    const { id } = media;
    const failed = () => {
      // 재생 시험을 통과했어도 재생 중에 실패할 수 있다. 미리보기 파일로 바꾼다
      const current = findMedia(store.project, id);
      if (current) reportPlaybackError(current, path);
      this.invalidate();
    };
    if (!useMpv) {
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.playsInline = true;
      el.src = mediaUrl(path);
    }
    el.addEventListener('seeked', () => this.invalidate());
    el.addEventListener('loadeddata', () => {
      if (media.type === 'video' && !el.videoWidth) failed();
      this.invalidate();
    });
    el.addEventListener('canplay', () => this.invalidate());
    el.addEventListener('error', failed);
    return el;
  }

  /** libmpv 재생기는 파일마다 해독기를 붙잡고 있으므로 쉬는 것은 일정 수만 남긴다 */
  trimIdleMpvPlayers() {
    const idle = [...this.free.entries()].filter(([key]) => key.startsWith('mpv|'));
    let count = idle.reduce((n, [, list]) => n + list.length, 0);
    for (const [, list] of idle) {
      while (list.length && count >= MAX_IDLE_MPV_PLAYERS) {
        list.shift().close();
        count -= 1;
      }
    }
  }

  connectAudio(el) {
    if (el.__gain || !this.audioCtx) return;
    const source = this.audioCtx.createMediaElementSource(el);
    const gain = this.audioCtx.createGain();
    source.connect(gain).connect(this.audioCtx.destination);
    el.__gain = gain;
  }

  release(clipId) {
    const slot = this.slots.get(clipId);
    if (!slot) return;
    slot.el.pause();
    if (!this.free.has(slot.key)) this.free.set(slot.key, []);
    this.free.get(slot.key).push(slot.el);
    this.slots.delete(clipId);
  }

  imageFor(media) {
    const path = previewPath(media);
    if (!path) return null;
    let img = this.images.get(path);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => this.invalidate();
      img.src = mediaUrl(path);
      this.images.set(path, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** 재생 위치에 맞춰 미디어 요소를 동기화한다. @returns 버퍼링 중이면 true */
  syncMedia() {
    const t = this.time;
    const wanted = new Set();
    let stalled = false;
    const { project } = store;
    for (const track of project.tracks) {
      if (track.type !== 'video' && track.type !== 'audio') continue;
      for (const clip of track.clips) {
        const media = findMedia(project, clip.mediaId);
        if (!media || media.type === 'image') continue;
        const end = itemEnd(clip);
        const active = t >= clip.start && t < end;
        const soon = this.playing && t >= clip.start - PREROLL && t < clip.start;
        if (!active && !soon) continue;
        const slot = this.acquire(clip, media);
        if (!slot) continue;
        wanted.add(clip.id);
        const { el } = slot;
        const want = active ? clip.in + (t - clip.start) * clip.speed : clip.in;

        if (this.playing) this.connectAudio(el);
        if (el.__gain) {
          const fade = fadeFactor(t - clip.start, itemDuration(clip), clip.fadeIn, Math.max(clip.fadeOut || 0, clip.audioFadeOut || 0));
          const silent = track.muted || clip.muted || !media.hasAudio;
          el.__gain.gain.value = silent ? 0 : clip.volume * fade;
        }

        if (active && this.playing) {
          if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed;
          if (Math.abs(el.currentTime - want) > DRIFT_PLAYING && !el.seeking) el.currentTime = want;
          if (el.paused) el.play().catch(() => {});
          if (!el.error && (el.seeking || el.readyState < 2)) stalled = true;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - want) > DRIFT_PAUSED && !el.seeking && el.readyState >= 1) el.currentTime = want;
        }
      }
    }
    for (const id of [...this.slots.keys()]) if (!wanted.has(id)) this.release(id);
    return stalled;
  }

  // ── 합성 ──

  tick(now) {
    requestAnimationFrame((t) => this.tick(t));
    if (this.playing) {
      const dt = Math.min(0.25, (now - this.lastNow) / 1000);
      this.lastNow = now;
      const stalled = this.syncMedia();
      if (!stalled) {
        this.time += dt;
        this.onTime(this.time);
      }
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.pause();
      }
      this.draw();
    } else if (this.dirty) {
      this.dirty = false;
      this.syncMedia();
      this.draw();
    }
  }

  draw() {
    const { ctx, time: t } = this;
    const { project } = store;
    const { width: W, height: H, background } = project.settings;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);

    const bottomUp = [...project.tracks].reverse();
    for (const track of bottomUp) {
      if (track.type !== 'video' || track.hidden) continue;
      const active = track.clips.filter((c) => t >= c.start && t < itemEnd(c)).sort((a, b) => a.start - b.start);
      for (const clip of active) this.drawClip(clip, t, W, H);
    }
    for (const track of bottomUp) {
      if (track.type !== 'effect' || track.hidden) continue;
      for (const mask of track.clips) if (t >= mask.start && t < itemEnd(mask)) this.drawMask(mask, t, W, H);
    }
    for (const track of bottomUp) {
      if (track.type !== 'overlay' || track.hidden) continue;
      for (const item of track.clips) {
        if (t < item.start || t >= itemEnd(item)) continue;
        const r = rasterizeOverlay(item, W, H);
        ctx.globalAlpha = fadeFactor(t - item.start, item.duration, item.fadeIn, item.fadeOut);
        ctx.drawImage(r.canvas, r.x, r.y);
        ctx.globalAlpha = 1;
      }
    }
    for (const track of bottomUp) {
      if (track.type !== 'caption' || track.hidden) continue;
      const item = track.clips.find((c) => t >= c.start && t < itemEnd(c) && c.text);
      if (item) ctx.drawImage(rasterizeCaption(item.text, track.style, W, H), 0, 0);
    }
    this.updateSelectionBox();
  }

  drawClip(clip, t, W, H) {
    const { ctx } = this;
    const media = findMedia(store.project, clip.mediaId);
    if (!media) return;
    let source;
    let srcW;
    if (media.type === 'image') {
      source = this.imageFor(media);
      srcW = source?.naturalWidth;
    } else {
      source = this.slots.get(clip.id)?.el;
      if (!source) {
        // 일시정지 직후처럼 슬롯이 아직 없는 경우 다음 그리기에서 동기화된다
        const slot = this.acquire(clip, media);
        source = slot?.el;
        this.invalidate();
      }
      srcW = source?.videoWidth;
    }
    const alpha = (clip.opacity ?? 1) * fadeFactor(t - clip.start, itemDuration(clip), clip.fadeIn, clip.fadeOut);
    const L = computeClipLayout(clip, media, W, H);

    if (!source || !srcW || (source.readyState !== undefined && source.readyState < 2)) {
      ctx.fillStyle = '#20242c';
      ctx.fillRect(L.cx - L.bboxW / 2, L.cy - L.bboxH / 2, L.bboxW, L.bboxH);
      if (!previewPath(media)) {
        ctx.fillStyle = '#99a0b0';
        ctx.font = `${Math.round(H / 24)}px "Malgun Gothic"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(store.rt(media.id).missing ? '파일을 찾을 수 없음' : '미리보기 변환 중…', L.cx, L.cy);
      }
      return;
    }
    // 프록시는 원본보다 작을 수 있으므로 원본 좌표를 실제 픽셀로 환산한다
    const k = srcW / media.width;
    // libmpv 재생기는 프레임을 자체 canvas 에 담고 있다
    const image = source.canvas ?? source;

    ctx.save();
    ctx.globalAlpha = alpha;
    if (clip.blurBackground) {
      const cover = coverSize(media.width, media.height, W, H);
      ctx.filter = 'blur(30px)';
      ctx.drawImage(image, (W - cover.w) / 2, (H - cover.h) / 2, cover.w, cover.h);
    }
    ctx.filter = clipFilter(clip, { sharpen: !this.playing });
    ctx.translate(L.cx, L.cy);
    ctx.rotate((L.angle * Math.PI) / 180);
    ctx.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);
    ctx.drawImage(image, L.sx * k, L.sy * k, L.sw * k, L.sh * k, -L.dw / 2, -L.dh / 2, L.dw, L.dh);
    ctx.restore();
  }

  drawMask(mask, t, W, H) {
    const { ctx, tmp } = this;
    const { x: rawX, y: rawY } = maskPositionAt(mask, t);
    const w = Math.min(mask.w, W);
    const h = Math.min(mask.h, H);
    const x = Math.round(Math.min(Math.max(rawX, 0), W - w));
    const y = Math.round(Math.min(Math.max(rawY, 0), H - h));
    ctx.save();
    if (mask.shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.clip();
    }
    if (mask.effect === 'mosaic') {
      const block = Math.max(2, Math.round(mask.strength));
      const sw = Math.max(1, Math.round(w / block));
      const sh = Math.max(1, Math.round(h / block));
      tmp.width = sw;
      tmp.height = sh;
      const tc = tmp.getContext('2d');
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(this.canvas, x, y, w, h, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
      ctx.imageSmoothingEnabled = true;
    } else {
      // 가장자리까지 고르게 흐려지도록 여유분을 포함해 복사한 뒤 흐린다
      const margin = Math.ceil(mask.strength * 3);
      const cx = Math.max(0, x - margin);
      const cy = Math.max(0, y - margin);
      const cw = Math.min(W, x + w + margin) - cx;
      const ch = Math.min(H, y + h + margin) - cy;
      tmp.width = cw;
      tmp.height = ch;
      tmp.getContext('2d').drawImage(this.canvas, cx, cy, cw, ch, 0, 0, cw, ch);
      if (mask.shape !== 'ellipse') {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
      }
      ctx.filter = `blur(${mask.strength}px)`;
      ctx.drawImage(tmp, cx, cy);
    }
    ctx.restore();
  }

  // ── 선택 상자 ──

  /** 선택 항목의 프레임 내 경계 (현재 시각에 보이는 것만) */
  boundsOf(item, track) {
    const t = this.time;
    const { width: W, height: H } = store.project.settings;
    if (t < item.start || t >= itemEnd(item)) return null;
    if (track.type === 'effect') {
      const p = maskPositionAt(item, t);
      return { x: p.x, y: p.y, w: item.w, h: item.h };
    }
    if (track.type === 'overlay') {
      const r = rasterizeOverlay(item, W, H);
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    if (track.type === 'video') {
      const media = findMedia(store.project, item.mediaId);
      if (!media) return null;
      const L = computeClipLayout(item, media, W, H);
      return { x: L.cx - L.bboxW / 2, y: L.cy - L.bboxH / 2, w: L.bboxW, h: L.bboxH };
    }
    return null;
  }

  updateSelectionBox() {
    const overlay = document.getElementById('stageOverlay');
    const sel = store.selected();
    const bounds = sel && !sel.track.locked ? this.boundsOf(sel.item, sel.track) : null;
    let box = overlay.firstElementChild;
    if (!bounds) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.innerHTML = '<div class="handle"></div>';
      overlay.append(box);
    }
    const { width: W, height: H } = store.project.settings;
    box.className = `sel-box${sel.track.type === 'effect' ? ' mask' : ''}`;
    box.style.left = `${(bounds.x / W) * 100}%`;
    box.style.top = `${(bounds.y / H) * 100}%`;
    box.style.width = `${(bounds.w / W) * 100}%`;
    box.style.height = `${(bounds.h / H) * 100}%`;
  }
}

/** 미리보기 화면에서 항목을 고르고 끌어서 옮기거나 크기를 바꾼다 */
export function attachStageInteractions(preview) {
  const overlay = document.getElementById('stageOverlay');

  const toProject = (e) => {
    const r = overlay.getBoundingClientRect();
    const { width: W, height: H } = store.project.settings;
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, k: W / r.width };
  };

  const hitTest = (p) => {
    // 위에 보이는 순서: 오버레이 → 효과 → 비디오 (위쪽 트랙 우선)
    const order = ['overlay', 'effect', 'video'];
    for (const type of order) {
      for (const track of store.project.tracks) {
        if (track.type !== type || track.hidden || track.locked) continue;
        const items = [...track.clips].sort((a, b) => b.start - a.start);
        for (const item of items) {
          const b = preview.boundsOf(item, track);
          if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return item.id;
        }
      }
    }
    return null;
  };

  overlay.addEventListener('pointerdown', (e) => {
    const p = toProject(e);
    const onHandle = e.target.classList.contains('handle');
    if (!onHandle && !e.target.classList.contains('sel-box')) {
      const id = hitTest(p);
      store.select(id);
      preview.invalidate();
      if (!id) return;
    }
    const sel = store.selected();
    if (!sel || sel.track.locked) return;
    const { item, track } = sel;
    const start = JSON.parse(JSON.stringify(item));
    const local = preview.time - item.start;
    const from = track.type === 'effect' ? maskPositionAt(item, preview.time) : null;
    overlay.setPointerCapture(e.pointerId);
    let moved = false;

    const moveMask = (dx, dy, shift) => {
      const nx = Math.round(from.x + dx);
      const ny = Math.round(from.y + dy);
      item.keyframes = (start.keyframes ?? []).map((k) => ({ ...k }));
      if (shift) {
        // Shift: 위치 기록 전체를 함께 옮긴다
        item.keyframes.forEach((k) => { k.x = Math.round(k.x + dx); k.y = Math.round(k.y + dy); });
        item.x = Math.round(start.x + dx);
        item.y = Math.round(start.y + dy);
      } else if (!item.keyframes.length && local < 1 / store.project.settings.fps) {
        // 시작 지점에서 끌면 처음 자리를 잡는 것이다
        item.x = nx;
        item.y = ny;
      } else {
        item.x = start.x;
        item.y = start.y;
        setMaskKeyframe(item, local, nx, ny);
      }
    };

    const move = (ev) => {
      // 클릭할 때의 작은 흔들림으로 위치가 기록되지 않게 한다
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_THRESHOLD_PX) return;
      const q = toProject(ev);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      moved = true;
      store.mutate(() => {
        if (onHandle) {
          applyResize(item, start, track, dx, dy);
        } else if (track.type === 'video') {
          item.posX = Math.round(start.posX + dx);
          item.posY = Math.round(start.posY + dy);
        } else if (track.type === 'effect') {
          moveMask(dx, dy, ev.shiftKey);
        } else {
          item.x = Math.round(start.x + dx);
          item.y = Math.round(start.y + dy);
        }
      }, { coalesce: `stage-${item.id}`, light: true });
    };
    const up = () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      if (moved) {
        store.emit('project');
        store.emit('selection');
      }
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
  });
}

function applyResize(item, start, track, dx, dy) {
  const { width: W, height: H } = store.project.settings;
  if (track.type === 'effect' || item.kind === 'shape') {
    item.w = Math.max(16, Math.round(start.w + (track.type === 'effect' ? dx : dx * 2)));
    item.h = Math.max(16, Math.round(start.h + (track.type === 'effect' ? dy : dy * 2)));
    if (track.type === 'effect') {
      item.w = Math.min(item.w, W);
      item.h = Math.min(item.h, H);
    }
  } else if (item.kind === 'text' || item.kind === 'icon') {
    item.size = Math.max(8, Math.round(start.size * (1 + (dx * 2) / Math.max(H / 3, 1))));
  } else if (track.type === 'video') {
    item.scale = Math.max(0.05, +(start.scale * (1 + (dx * 2) / W)).toFixed(3));
  }
}

export function bindTransport(preview) {
  const code = document.getElementById('timecode');
  const total = document.getElementById('totalTime');
  const fps = () => store.project.settings.fps;
  const listeners = [];
  preview.onTime = (t) => {
    code.textContent = formatFrames(t, fps());
    listeners.forEach((fn) => fn(t));
  };
  const refreshTotal = () => { total.textContent = formatHMS(preview.duration); };
  store.on('project', refreshTotal);
  store.on('project-light', () => preview.invalidate());
  store.on('project', () => { preview.resize(); preview.onTime(preview.time); });
  store.on('selection', () => preview.invalidate());
  store.on('media', () => preview.invalidate());
  refreshTotal();

  document.getElementById('btnPlay').onclick = () => preview.toggle();
  document.getElementById('btnStart').onclick = () => preview.seek(0);
  document.getElementById('btnEnd').onclick = () => preview.seek(preview.duration);
  document.getElementById('btnPrev').onclick = () => preview.seek(preview.time - 1 / fps());
  document.getElementById('btnNext').onclick = () => preview.seek(preview.time + 1 / fps());
  new ResizeObserver(() => preview.layoutStage()).observe(document.getElementById('stageArea'));
  return { onTime: (fn) => listeners.push(fn) };
}
