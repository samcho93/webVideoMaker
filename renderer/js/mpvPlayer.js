// libmpv 재생기. <video> 와 같은 속성·이벤트를 제공해 미리보기 합성기가 그대로 쓸 수 있다.
// 프레임은 canvas 에 그려지므로 ctx.drawImage(player.canvas, ...) 로 합성한다.

const READY_TIMEOUT_MS = 15000;
const players = new Map();
let port = null;
let nextId = 1;
let available = false;
let settleReady = null;
let readyPromise = null;

function resetReady() {
  readyPromise = new Promise((resolve) => { settleReady = resolve; });
  setTimeout(() => settleReady?.(false), READY_TIMEOUT_MS);
}

function setAvailable(value) {
  available = value;
  settleReady?.(value);
}

function failAll(message) {
  for (const player of [...players.values()]) player.handle({ type: 'error', message });
}

/** libmpv 를 쓸 수 있으면 true. 준비 중이면 기다린다 */
export const whenMpvReady = () => readyPromise;
export const mpvAvailable = () => available;

export function initMpv() {
  resetReady();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'wvm-mpv-port' || !e.ports[0]) return;
    [port] = e.ports;
    port.onmessage = ({ data }) => {
      if (data.type === 'ready') setAvailable(true);
      else if (data.type === 'fatal') console.warn('libmpv 오류', data.message);
      else players.get(data.id)?.handle(data);
    };
  });
  window.api.onMpvDown(() => {
    port = null;
    setAvailable(false);
    failAll('libmpv 재생 프로세스가 종료되었습니다.');
  });
}

export class MpvPlayer extends EventTarget {
  constructor(path, audioOnly) {
    super();
    this.id = nextId;
    nextId += 1;
    this.audioOnly = audioOnly;
    this.canvas = audioOnly ? null : document.createElement('canvas');
    this.ctx = this.canvas?.getContext('2d');
    this.readyState = 0;
    this.seeking = false;
    this.paused = true;
    this.error = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.duration = 0;
    this.time = 0;
    this.rate = 1;
    this.loaded = false;
    this.pendingSeek = null;
    // 미리보기가 볼륨을 조절하는 통로. <audio> 의 GainNode 와 같은 모양이다
    let volume = 1;
    this.__gain = {
      gain: {
        get value() { return volume; },
        set value(v) {
          if (Math.abs(v - volume) < 0.005) return;
          volume = v;
          this.owner.post({ cmd: 'volume', value: v });
        },
        owner: this,
      },
    };
    players.set(this.id, this);
    if (port) port.postMessage({ id: this.id, cmd: 'open', path, audioOnly });
    else queueMicrotask(() => this.handle({ type: 'error', message: 'libmpv 를 사용할 수 없습니다.' }));
  }

  post(message) {
    port?.postMessage({ id: this.id, ...message });
  }

  get currentTime() { return this.time; }

  set currentTime(t) {
    this.time = t;
    if (this.loaded) this.seekTo(t);
    else this.pendingSeek = t;
  }

  get playbackRate() { return this.rate; }

  set playbackRate(v) {
    if (v === this.rate) return;
    this.rate = v;
    this.post({ cmd: 'speed', value: v });
  }

  seekTo(t) {
    if (this.seeking) {
      this.pendingSeek = t;
      return;
    }
    this.seeking = true;
    this.post({ cmd: 'seek', time: t });
  }

  play() {
    this.paused = false;
    this.post({ cmd: 'play' });
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.post({ cmd: 'pause' });
  }

  close() {
    this.post({ cmd: 'close' });
    players.delete(this.id);
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  handle(m) {
    if (m.type === 'loaded') {
      this.loaded = true;
      this.duration = m.duration;
      this.videoWidth = m.w;
      this.videoHeight = m.h;
      if (this.canvas) {
        this.canvas.width = m.w;
        this.canvas.height = m.h;
      }
      if (this.audioOnly) this.readyState = 4;
      if (this.pendingSeek !== null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        this.seekTo(t);
      }
      this.emit('loadeddata');
    } else if (m.type === 'frame') {
      this.ctx.putImageData(new ImageData(new Uint8ClampedArray(m.data), m.w, m.h), 0, 0);
      this.post({ cmd: 'ack' });
      this.readyState = 4;
      this.emit('canplay');
    } else if (m.type === 'seeked') {
      this.seeking = false;
      if (this.pendingSeek !== null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        this.seekTo(t);
      } else {
        this.emit('seeked');
      }
    } else if (m.type === 'time') {
      // 멈춰 있을 때는 요청한 시각을 유지한다. 실제 프레임 시각과의 작은 차이로 탐색을 반복하지 않게 한다
      if (!this.paused && !this.seeking) this.time = m.time;
    } else if (m.type === 'error') {
      this.error = { message: m.message };
      this.emit('error');
    }
  }
}
