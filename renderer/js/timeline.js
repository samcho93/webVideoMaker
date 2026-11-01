// 타임라인: 트랙/클립 표시, 끌어서 이동·트림, 자석 맞춤, 재생 위치·구간 표시.

import { findMedia, isMediaClip, itemDuration, itemEnd, MIN_ITEM_DURATION, projectDuration } from '/shared/model.mjs';
import { formatHMS } from '/shared/time.mjs';
import { mediaUrl, store } from './store.js';
import { el } from './ui.js';
import { addTrack, placeOnTrack, removeTrack } from './actions.js';

const ROW_H = { video: 62, audio: 46, overlay: 30, caption: 30, effect: 30 };
const SNAP_PX = 8;
const THUMB_W = 96;
const zoomFromSlider = (v) => 2 * 150 ** (v / 100); // 2 ~ 300 px/초
const sliderFromZoom = (z) => (Math.log(z / 2) / Math.log(150)) * 100;

const trackClass = (track, media) => {
  if (track.type === 'video') return media?.type === 'image' ? 'image' : 'video';
  if (track.type === 'caption') return track.role === 'narration' ? 'narration' : 'caption';
  return track.type;
};

function itemLabel(track, item, media) {
  if (media) return media.name;
  if (track.type === 'effect') return `${item.effect === 'mosaic' ? '모자이크' : '블러'}${item.animate ? ' (이동)' : ''}`;
  if (track.type === 'overlay') return item.kind === 'text' ? item.text.split('\n')[0] : item.kind === 'icon' ? `아이콘: ${item.icon}` : '도형';
  return item.text?.split('\n')[0] ?? '';
}

export class Timeline {
  constructor(preview) {
    this.preview = preview;
    this.zoom = zoomFromSlider(45);
    this.scroll = document.getElementById('tlScroll');
    this.content = document.getElementById('tlContent');
    this.rows = document.getElementById('tlRows');
    this.headers = document.getElementById('tlHeaders');
    this.ruler = document.getElementById('tlRuler');
    this.rulerCanvas = document.getElementById('tlRulerCanvas');
    this.playhead = document.getElementById('tlPlayhead');
    this.rangeEl = document.getElementById('tlRange');
    this.zoomInput = document.getElementById('tlZoom');
    this.bind();
    this.render();
  }

  bind() {
    this.zoomInput.addEventListener('input', () => this.setZoom(zoomFromSlider(+this.zoomInput.value)));
    this.scroll.addEventListener('scroll', () => {
      this.headers.scrollTop = this.scroll.scrollTop;
      this.drawRuler();
    });
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(Math.min(300, Math.max(2, this.zoom * (e.deltaY < 0 ? 1.15 : 0.87))));
      this.zoomInput.value = sliderFromZoom(this.zoom);
    }, { passive: false });
    new ResizeObserver(() => this.drawRuler()).observe(this.scroll);

    // 눈금자 클릭·끌기로 재생 위치 이동
    this.ruler.addEventListener('pointerdown', (e) => {
      this.ruler.setPointerCapture(e.pointerId);
      const seek = (ev) => this.preview.seek(this.timeAt(ev.clientX));
      seek(e);
      const up = () => {
        this.ruler.removeEventListener('pointermove', seek);
        this.ruler.removeEventListener('pointerup', up);
      };
      this.ruler.addEventListener('pointermove', seek);
      this.ruler.addEventListener('pointerup', up);
    });
    // 빈 곳 클릭: 선택 해제와 위치 이동
    this.rows.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.clip')) return;
      store.select(null);
      this.preview.seek(this.timeAt(e.clientX));
    });
  }

  timeAt(clientX) {
    const r = this.content.getBoundingClientRect();
    return Math.max(0, (clientX - r.left) / this.zoom);
  }

  setZoom(z) {
    // 재생 위치가 화면에서 움직이지 않도록 스크롤을 보정한다
    const viewX = this.preview.time * this.zoom - this.scroll.scrollLeft;
    this.zoom = z;
    this.render();
    this.scroll.scrollLeft = this.preview.time * z - viewX;
  }

  updatePlayhead(t) {
    this.playhead.style.left = `${t * this.zoom}px`;
    if (this.preview.playing) {
      const x = t * this.zoom;
      const { scrollLeft, clientWidth } = this.scroll;
      if (x > scrollLeft + clientWidth - 40 || x < scrollLeft) this.scroll.scrollLeft = x - 60;
    }
  }

  updateRange() {
    const { in: a, out: b } = store.range;
    if (a === null && b === null) {
      this.rangeEl.style.display = 'none';
      return;
    }
    const from = a ?? 0;
    const to = b ?? Math.max(from, projectDuration(store.project));
    this.rangeEl.style.display = 'block';
    this.rangeEl.style.left = `${from * this.zoom}px`;
    this.rangeEl.style.width = `${Math.max(1, (to - from) * this.zoom)}px`;
  }

  render() {
    const { project } = store;
    const total = projectDuration(project);
    const width = Math.max((total + 30) * this.zoom, this.scroll.clientWidth);
    this.content.style.width = `${width}px`;

    this.headers.replaceChildren();
    this.rows.replaceChildren();
    project.tracks.forEach((track) => {
      this.headers.append(this.renderHeader(track));
      this.rows.append(this.renderRow(track));
    });
    this.headers.append(el('div', { class: 'btn-row', style: 'padding:4px' },
      el('button', { text: '+비디오', title: '비디오 트랙 추가', onclick: () => addTrack('video') }),
      el('button', { text: '+오디오', title: '오디오 트랙 추가', onclick: () => addTrack('audio') })));
    this.rows.append(el('div', { style: 'height:40px' }));
    this.drawRuler();
    this.updatePlayhead(this.preview.time);
    this.updateRange();
  }

  renderHeader(track) {
    const header = el('div', { class: 'tl-header', style: `height:${ROW_H[track.type]}px`, title: track.name });
    header.append(el('span', { class: 'tname', text: track.name }));
    const toggle = (label, key, title) => el('button', {
      text: label,
      title,
      class: track[key] ? 'on' : '',
      onclick: () => store.mutate(() => { track[key] = !track[key]; }),
    });
    if (track.type === 'video' || track.type === 'audio') header.append(toggle('🔇', 'muted', '소리 끄기'));
    if (track.type !== 'audio') header.append(toggle('🚫', 'hidden', '숨기기 (내보내기에서도 제외)'));
    header.append(toggle('🔒', 'locked', '잠금'));
    if ((track.type === 'video' || track.type === 'audio') && !track.role && !track.clips.length
      && store.project.tracks.filter((t) => t.type === track.type).length > 1) {
      header.append(el('button', { text: '✕', title: '트랙 삭제', onclick: () => removeTrack(track.id) }));
    }
    return header;
  }

  renderRow(track) {
    const row = el('div', { class: `tl-row${track.locked ? ' locked' : ''}`, style: `height:${ROW_H[track.type]}px` });
    row.dataset.trackId = track.id;
    row.dataset.type = track.type;
    for (const item of track.clips) row.append(this.renderClip(track, item));

    if (track.type === 'video' || track.type === 'audio') {
      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(`application/x-wvm-${track.type}`)) return;
        e.preventDefault();
        row.classList.add('drop');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        row.classList.remove('drop');
        const mediaId = e.dataTransfer.getData(`application/x-wvm-${track.type}`);
        if (!mediaId) return;
        e.preventDefault();
        placeOnTrack(mediaId, track.id, this.snapTime(this.timeAt(e.clientX), null));
      });
    }
    return row;
  }

  renderClip(track, item) {
    const media = isMediaClip(item) ? findMedia(store.project, item.mediaId) : null;
    const dur = itemDuration(item);
    const width = Math.max(4, dur * this.zoom);
    const hiddenTrack = track.hidden || (track.muted && track.type === 'audio');
    const node = el('div', {
      class: `clip ${trackClass(track, media)}${store.selection === item.id ? ' selected' : ''}${hiddenTrack ? ' dim-track' : ''}`,
      style: `left:${item.start * this.zoom}px;width:${width}px`,
    });
    node.dataset.itemId = item.id;

    if (media && track.type === 'video') this.addThumbs(node, item, media, width);
    if (media && media.hasAudio) this.addWave(node, item, media, width, track);
    node.append(el('span', { class: 'label', text: itemLabel(track, item, media) }));
    if (media && item.speed !== 1) node.append(el('span', { class: 'badge', text: `${item.speed}배속` }));
    if (item.fadeIn > 0) node.append(el('div', { class: 'fade in', style: `width:${item.fadeIn * this.zoom}px` }));
    if (item.fadeOut > 0) node.append(el('div', { class: 'fade out', style: `width:${item.fadeOut * this.zoom}px` }));
    node.append(el('div', { class: 'trim l' }), el('div', { class: 'trim r' }));
    node.addEventListener('pointerdown', (e) => this.startDrag(e, track, item, node));
    return node;
  }

  addThumbs(node, item, media, width) {
    const rt = store.rt(media.id);
    if (!rt.sprite) return;
    const box = el('div', { class: 'thumbs' });
    const url = `url("${mediaUrl(rt.sprite)}")`;
    const h = ROW_H.video - 6;
    const w = (h * 16) / 9;
    const cell = Math.max(w, THUMB_W);
    const shown = Math.min(40, Math.ceil(width / cell));
    const frames = rt.spriteCount;
    for (let i = 0; i < shown; i += 1) {
      const srcT = media.type === 'image' ? 0 : item.in + ((i * cell) / width) * (item.out - item.in);
      const index = media.type === 'image' ? 0 : Math.min(frames - 1, Math.floor((srcT / media.duration) * frames));
      const thumb = el('i', { style: `width:${cell}px` });
      thumb.style.backgroundImage = url;
      thumb.style.backgroundSize = `${w * frames}px ${h}px`;
      thumb.style.backgroundPosition = `${-index * w}px 0`;
      box.append(thumb);
    }
    node.append(box);
  }

  addWave(node, item, media, width, track) {
    const peaks = store.rt(media.id).peaks;
    if (!peaks) return;
    const height = track.type === 'video' ? 20 : ROW_H.audio - 6;
    const w = Math.min(Math.ceil(width), 4000);
    const canvas = el('canvas', { class: 'wave', width: w, height });
    if (track.type === 'video') { canvas.style.height = `${height}px`; }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = track.type === 'video' ? '#b8f0d8cc' : '#d9fff0';
    const { rate, data } = peaks;
    for (let x = 0; x < w; x += 1) {
      const t = item.in + (x / w) * (item.out - item.in);
      const i = Math.floor(t * rate);
      const v = (data[i] || 0) / 255;
      const bar = Math.max(1, v * height * (item.muted ? 0.2 : Math.min(1, item.volume)));
      ctx.fillRect(x, height - bar, 1, bar);
    }
    node.append(canvas);
  }

  drawRuler() {
    const canvas = this.rulerCanvas;
    const w = this.scroll.clientWidth;
    if (!w) return;
    const left = this.scroll.scrollLeft;
    canvas.width = w;
    canvas.height = 26;
    canvas.style.left = `${left}px`;
    canvas.style.width = `${w}px`;
    const ctx = canvas.getContext('2d');
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'top';
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const major = steps.find((s) => s * this.zoom >= 80) || 3600;
    const minor = major / 5;
    const first = Math.floor(left / this.zoom / minor) * minor;
    for (let t = first; t * this.zoom < left + w; t += minor) {
      const x = Math.round(t * this.zoom - left) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? '#7b8294' : '#4a5060';
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 12 : 20);
      ctx.lineTo(x, 26);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#b6bccb';
        ctx.fillText(formatHMS(t), x + 3, 2);
      }
    }
  }

  /** 다른 클립 가장자리와 재생 위치에 맞춘다 */
  snapTime(t, excludeId, otherEdgeOffset = 0) {
    const threshold = SNAP_PX / this.zoom;
    let best = t;
    let bestD = threshold;
    const consider = (edge) => {
      for (const candidate of [edge, edge - otherEdgeOffset]) {
        const d = Math.abs(candidate - t);
        if (d < bestD) { bestD = d; best = candidate; }
      }
    };
    consider(0);
    consider(this.preview.time);
    for (const track of store.project.tracks) {
      for (const c of track.clips) {
        if (c.id === excludeId) continue;
        consider(c.start);
        consider(itemEnd(c));
      }
    }
    return Math.max(0, best);
  }

  startDrag(e, track, item, node) {
    if (e.button !== 0) return;
    e.stopPropagation();
    store.select(item.id);
    node = this.rows.querySelector(`[data-item-id="${item.id}"]`) || node;
    if (track.locked) return;
    const mode = e.target.classList.contains('trim') ? (e.target.classList.contains('l') ? 'left' : 'right') : 'move';
    const media = isMediaClip(item) ? findMedia(store.project, item.mediaId) : null;
    const startX = e.clientX;
    const orig = { start: item.start, in: item.in, out: item.out, duration: item.duration, dur: itemDuration(item) };
    node.setPointerCapture(e.pointerId);
    let moved = false;
    let next = null;
    let targetTrack = track;

    const onMove = (ev) => {
      const dt = (ev.clientX - startX) / this.zoom;
      if (!moved && Math.abs(ev.clientX - startX) < 3 && mode !== 'move') return;
      if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
      moved = true;
      next = mode === 'move' ? this.computeMove(item, orig, dt) : this.computeTrim(item, orig, media, dt, mode);
      if (mode === 'move') {
        const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList?.contains('tl-row'));
        if (under && under.dataset.type === track.type && !store.project.tracks.find((t) => t.id === under.dataset.trackId)?.locked) {
          if (under.dataset.trackId !== targetTrack.id) {
            targetTrack = store.project.tracks.find((t) => t.id === under.dataset.trackId);
            under.append(node);
          }
        }
      }
      node.style.left = `${next.start * this.zoom}px`;
      node.style.width = `${Math.max(4, next.visualDur * this.zoom)}px`;
    };

    const onUp = () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      if (!moved || !next) {
        this.preview.invalidate();
        return;
      }
      store.mutate((p) => {
        const delta = next.start - item.start;
        Object.assign(item, next.apply);
        // 음성이 연결된 나레이션은 함께 이동한다
        if (mode === 'move' && item.voiceClipId) {
          for (const t of p.tracks) {
            const voice = t.clips.find((c) => c.id === item.voiceClipId);
            if (voice) voice.start = Math.max(0, voice.start + delta);
          }
        }
        if (targetTrack !== track) {
          track.clips = track.clips.filter((c) => c !== item);
          targetTrack.clips.push(item);
        }
      });
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
  }

  computeMove(item, orig, dt) {
    const start = this.snapTime(Math.max(0, orig.start + dt), item.id, orig.dur);
    return { start, visualDur: orig.dur, apply: { start } };
  }

  computeTrim(item, orig, media, dt, mode) {
    if (isMediaClip(item)) {
      const { speed } = item;
      const limit = media?.type === 'image' ? Infinity : media?.duration ?? Infinity;
      if (mode === 'left') {
        let start = this.snapTime(orig.start + dt, item.id);
        // 원본 범위와 최소 길이 안으로 제한
        const minStart = orig.start - orig.in / speed;
        const maxStart = orig.start + orig.dur - MIN_ITEM_DURATION;
        const lowerBound = media?.type === 'image' ? 0 : minStart;
        start = Math.min(maxStart, Math.max(lowerBound, start));
        const newIn = media?.type === 'image' ? 0 : orig.in + (start - orig.start) * speed;
        const out = media?.type === 'image' ? orig.out - (start - orig.start) : orig.out;
        return { start, visualDur: (out - newIn) / speed, apply: { start, in: newIn, out } };
      }
      let end = this.snapTime(orig.start + orig.dur + dt, item.id);
      end = Math.max(orig.start + MIN_ITEM_DURATION, end);
      const out = Math.min(limit, orig.in + (end - orig.start) * speed);
      return { start: orig.start, visualDur: (out - orig.in) / speed, apply: { out } };
    }
    if (mode === 'left') {
      const start = Math.min(orig.start + orig.duration - MIN_ITEM_DURATION, this.snapTime(Math.max(0, orig.start + dt), item.id));
      const duration = orig.duration - (start - orig.start);
      return { start, visualDur: duration, apply: { start, duration } };
    }
    const end = Math.max(orig.start + MIN_ITEM_DURATION, this.snapTime(orig.start + orig.duration + dt, item.id));
    const duration = end - orig.start;
    return { start: orig.start, visualDur: duration, apply: { duration } };
  }
}
