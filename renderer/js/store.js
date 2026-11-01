// 앱 상태와 실행 취소 기록.

import { createProject, findItem } from '/shared/model.mjs';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 900;
const listeners = new Map();

export const store = {
  project: createProject(),
  filePath: null,
  dirty: false,
  selection: null, // 선택한 타임라인 항목 id
  range: { in: null, out: null },
  /** mediaId → { proxy, exportPath, sprite, spriteCount, peaks, missing, proxyProgress } (저장하지 않음) */
  runtime: new Map(),
  clipboard: null,

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
  },
  emit(event, payload) {
    listeners.get(event)?.forEach((fn) => fn(payload));
  },

  past: [],
  future: [],
  _lastKey: null,
  _lastAt: 0,

  /**
   * 프로젝트 변경. coalesce 키가 같고 연달아 일어나면 실행 취소 한 번으로 묶는다.
   * light 면 미리보기만 갱신한다 (드래그 중).
   */
  mutate(fn, { coalesce = null, light = false } = {}) {
    const now = Date.now();
    const merge = coalesce && coalesce === this._lastKey && now - this._lastAt < COALESCE_MS;
    if (!merge) {
      this.past.push(JSON.stringify(this.project));
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
    this._lastKey = coalesce;
    this._lastAt = now;
    this.future = [];
    fn(this.project);
    this.setDirty(true);
    this.emit(light ? 'project-light' : 'project');
  },

  undo() {
    if (!this.past.length) return;
    this.future.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.past.pop());
    this._afterHistory();
  },
  redo() {
    if (!this.future.length) return;
    this.past.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.future.pop());
    this._afterHistory();
  },
  _afterHistory() {
    this._lastKey = null;
    if (this.selection && !findItem(this.project, this.selection)) this.selection = null;
    this.setDirty(true);
    this.emit('project');
    this.emit('selection');
  },

  select(id) {
    if (this.selection === id) return;
    this.selection = id;
    this.emit('selection');
  },
  selected() {
    return this.selection ? findItem(this.project, this.selection) : null;
  },

  setRuntime(mediaId, patch) {
    this.runtime.set(mediaId, { ...this.runtime.get(mediaId), ...patch });
    this.emit('media');
  },
  rt(mediaId) {
    return this.runtime.get(mediaId) || {};
  },

  setDirty(value) {
    this.dirty = value;
    const name = this.filePath ? this.filePath.split(/[\\/]/).pop() : this.project.name;
    const title = `${value ? '● ' : ''}${name} — WebVideoMaker`;
    window.api.setDirty(value, title);
    this.emit('title', name);
  },

  /** 새 프로젝트로 교체 */
  load(project, filePath = null) {
    this.project = project;
    this.filePath = filePath;
    this.selection = null;
    this.range = { in: null, out: null };
    this.past = [];
    this.future = [];
    this._lastKey = null;
    this.runtime.clear();
    this.setDirty(false);
    this.emit('project');
    this.emit('selection');
    this.emit('media');
    this.emit('range');
  },
};

export const mediaUrl = (path) => `media://local/${encodeURIComponent(path)}`;

/** 미리보기에 쓸 파일. 변환이 필요한데 아직 준비되지 않았으면 null */
export function previewPath(media) {
  const rt = store.rt(media.id);
  if (rt.missing) return null;
  if (media.needsProxy) return rt.proxy || null;
  return rt.exportPath || media.path;
}
