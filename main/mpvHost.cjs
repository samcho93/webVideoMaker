// libmpv 재생 프로세스. 프레임 렌더링이 동기 호출이라 메인 프로세스와 분리한다.
// 렌더러와 MessagePort 로 직접 통신한다.

const koffi = require('koffi');

const lib = koffi.load(process.env.WVM_LIBMPV);

const RENDER_API_TYPE = 1;
const RENDER_SW_SIZE = 17;
const RENDER_SW_FORMAT = 18;
const RENDER_SW_STRIDE = 19;
const RENDER_SW_POINTER = 20;
const RENDER_UPDATE_FRAME = 1;
const FORMAT_DOUBLE = 5;
const EVENT = { END_FILE: 7, FILE_LOADED: 8, VIDEO_RECONFIG: 17, PLAYBACK_RESTART: 21 };
const END_REASON_ERROR = 4;
const MAX_FRAME_WIDTH = 1280;
const TICK_MS = 16;
const TIME_REPORT_MS = 50;

const Param = koffi.struct('mpv_render_param', { type: 'int', data: 'void *' });
const Event = koffi.struct('mpv_event', { event_id: 'int', error: 'int', reply_userdata: 'uint64', data: 'void *' });
const EndFile = koffi.struct('mpv_event_end_file', { reason: 'int', error: 'int' });

const mpv = {
  create: lib.func('void *mpv_create()'),
  initialize: lib.func('int mpv_initialize(void *ctx)'),
  setOption: lib.func('int mpv_set_option_string(void *ctx, const char *name, const char *value)'),
  setProperty: lib.func('int mpv_set_property_string(void *ctx, const char *name, const char *value)'),
  getDouble: lib.func('int mpv_get_property(void *ctx, const char *name, int format, _Out_ double *data)'),
  command: lib.func('int mpv_command(void *ctx, const char **args)'),
  waitEvent: lib.func('void *mpv_wait_event(void *ctx, double timeout)'),
  destroy: lib.func('void mpv_terminate_destroy(void *ctx)'),
  renderCreate: lib.func('int mpv_render_context_create(_Out_ void **res, void *mpv, mpv_render_param *params)'),
  renderUpdate: lib.func('uint64_t mpv_render_context_update(void *ctx)'),
  render: lib.func('int mpv_render_context_render(void *ctx, mpv_render_param *params)'),
  renderFree: lib.func('void mpv_render_context_free(void *ctx)'),
  version: lib.func('unsigned long mpv_client_api_version()'),
};

const cstring = (text) => {
  const bytes = Buffer.from(`${text}\0`, 'utf8');
  const ptr = koffi.alloc('char', bytes.length);
  koffi.encode(ptr, koffi.array('char', bytes.length), [...bytes].map((b) => (b > 127 ? b - 256 : b)));
  return ptr;
};
const SW_API = cstring('sw');
const SW_FORMAT = cstring('rgb0');

const players = new Map();
let port = null;

function send(message) {
  port?.postMessage(message);
}

function getDouble(ctx, name) {
  const out = [0];
  return mpv.getDouble(ctx, name, FORMAT_DOUBLE, out) === 0 ? out[0] : null;
}

function allocFrame(player) {
  const dw = getDouble(player.ctx, 'dwidth') || 0;
  const dh = getDouble(player.ctx, 'dheight') || 0;
  if (!dw || !dh) return false;
  const w = Math.min(MAX_FRAME_WIDTH, dw) & ~1;
  const h = Math.max(2, Math.round((dh * w) / dw)) & ~1;
  player.w = w;
  player.h = h;
  player.stride = w * 4;
  const bytes = player.stride * h;
  player.pixels = koffi.alloc('uint8', bytes);
  // Electron 은 외부 메모리를 직접 가리키는 버퍼를 금지하므로 프레임마다 복사한다
  player.frameType = koffi.array('uint8', bytes, 'Typed');
  const size = koffi.alloc('int', 2);
  koffi.encode(size, koffi.array('int', 2), [w, h]);
  const stride = koffi.alloc('size_t', 1);
  koffi.encode(stride, 'size_t', player.stride);
  player.params = [
    { type: RENDER_SW_SIZE, data: size },
    { type: RENDER_SW_FORMAT, data: SW_FORMAT },
    { type: RENDER_SW_STRIDE, data: stride },
    { type: RENDER_SW_POINTER, data: player.pixels },
    { type: 0, data: null },
  ];
  return true;
}

function open({ id, path: file, audioOnly }) {
  const ctx = mpv.create();
  if (!ctx) {
    send({ id, type: 'error', message: 'mpv_create 실패' });
    return;
  }
  const options = {
    config: 'no',
    'load-scripts': 'no',
    ytdl: 'no',
    osc: 'no',
    'input-default-bindings': 'no',
    'input-vo-keyboard': 'no',
    idle: 'yes',
    pause: 'yes',
    'keep-open': 'always',
    'hr-seek': 'yes',
    sid: 'no',
    vo: audioOnly ? 'null' : 'libmpv',
    vid: audioOnly ? 'no' : 'auto',
    hwdec: 'auto-copy',
    'volume-max': '200',
    'audio-display': 'no',
  };
  for (const [name, value] of Object.entries(options)) mpv.setOption(ctx, name, value);
  if (process.env.WVM_MPV_NO_AUDIO) mpv.setOption(ctx, 'ao', 'null');
  if (mpv.initialize(ctx) < 0) {
    send({ id, type: 'error', message: 'mpv_initialize 실패' });
    mpv.destroy(ctx);
    return;
  }
  const player = { id, ctx, audioOnly, render: null, w: 0, h: 0, awaitingAck: false, lastTime: 0 };
  if (!audioOnly) {
    const res = [null];
    const params = [{ type: RENDER_API_TYPE, data: SW_API }, { type: 0, data: null }];
    if (mpv.renderCreate(res, ctx, params) < 0) {
      send({ id, type: 'error', message: 'mpv_render_context_create 실패' });
      mpv.destroy(ctx);
      return;
    }
    [player.render] = res;
  }
  players.set(id, player);
  mpv.command(ctx, ['loadfile', file, null]);
}

function close(id) {
  const player = players.get(id);
  if (!player) return;
  players.delete(id);
  if (player.render) mpv.renderFree(player.render);
  mpv.destroy(player.ctx);
}

function announceLoaded(player) {
  send({ id: player.id, type: 'loaded', w: player.w, h: player.h, duration: getDouble(player.ctx, 'duration') || 0 });
}

function handleEvents(player) {
  for (;;) {
    const ptr = mpv.waitEvent(player.ctx, 0);
    const event = koffi.decode(ptr, Event);
    if (event.event_id === 0) return;
    if (event.event_id === EVENT.FILE_LOADED) {
      // 영상은 첫 프레임을 해독해야 크기를 알 수 있으므로 VIDEO_RECONFIG 까지 기다린다
      if (player.audioOnly) announceLoaded(player);
    } else if (event.event_id === EVENT.VIDEO_RECONFIG) {
      if (!player.audioOnly && !player.params && allocFrame(player)) announceLoaded(player);
    } else if (event.event_id === EVENT.PLAYBACK_RESTART) {
      send({ id: player.id, type: 'seeked' });
    } else if (event.event_id === EVENT.END_FILE) {
      const end = koffi.decode(event.data, EndFile);
      if (end.reason === END_REASON_ERROR) send({ id: player.id, type: 'error', message: `재생 실패 (${end.error})` });
    }
  }
}

function pushFrame(player) {
  if (!player.params || player.awaitingAck) return;
  if (!(Number(mpv.renderUpdate(player.render)) & RENDER_UPDATE_FRAME)) return;
  if (mpv.render(player.render, player.params) < 0) return;
  const view = koffi.decode(player.pixels, player.frameType);
  // rgb0 의 패딩 바이트를 불투명으로 채운다
  for (let i = 3; i < view.length; i += 4) view[i] = 255;
  player.awaitingAck = true;
  send({ id: player.id, type: 'frame', w: player.w, h: player.h, data: view.buffer });
}

function tick() {
  const now = Date.now();
  for (const player of players.values()) {
    handleEvents(player);
    if (!players.has(player.id)) continue;
    if (!player.audioOnly) pushFrame(player);
    if (now - player.lastTime >= TIME_REPORT_MS) {
      player.lastTime = now;
      const time = getDouble(player.ctx, 'time-pos');
      if (time !== null) send({ id: player.id, type: 'time', time });
    }
  }
}

function handle(message) {
  const { id, cmd } = message;
  if (cmd === 'open') {
    open(message);
    return;
  }
  const player = players.get(id);
  if (!player) return;
  if (cmd === 'close') close(id);
  else if (cmd === 'ack') player.awaitingAck = false;
  else if (cmd === 'play') mpv.setProperty(player.ctx, 'pause', 'no');
  else if (cmd === 'pause') mpv.setProperty(player.ctx, 'pause', 'yes');
  else if (cmd === 'seek') mpv.command(player.ctx, ['seek', String(message.time), 'absolute+exact', null]);
  else if (cmd === 'speed') mpv.setProperty(player.ctx, 'speed', String(message.value));
  else if (cmd === 'volume') mpv.setProperty(player.ctx, 'volume', String(Math.round(message.value * 100)));
}

process.parentPort.once('message', (e) => {
  [port] = e.ports;
  port.on('message', (m) => {
    try {
      handle(m.data);
    } catch (err) {
      send({ id: m.data?.id, type: 'error', message: String(err?.message || err) });
    }
  });
  port.start();
  send({ type: 'ready', version: Number(mpv.version()) });
  setInterval(() => {
    try {
      tick();
    } catch (err) {
      send({ type: 'fatal', message: String(err?.message || err) });
    }
  }, TICK_MS);
});
