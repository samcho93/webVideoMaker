// ffmpeg/ffprobe 실행과 미디어 분석, 미리보기용 파생 파일(프록시·썸네일·파형) 생성.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// 패키징되면 실행 파일은 asar 밖(app.asar.unpacked)에 있다.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
export const FFMPEG = unpacked(ffmpegStatic);
export const FFPROBE = unpacked(ffprobeStatic.path);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.tga', '.heic', '.heif', '.avif']);
const BROWSER_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);
const BROWSER_AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4']);
const BROWSER_PIX_FMTS = new Set(['yuv420p', 'yuvj420p', 'yuv420p10le']);

// 번들 ffprobe 는 ffmpeg 보다 오래된 판이라 읽지 못하는 파일이 있다. 그럴 때는 ffmpeg 의 출력으로 분석한다.
const NON_MEDIA_CODECS = new Set(['ansi', 'bintext', 'xbin', 'idf']);
const REMUX_VIDEO_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1']);
const COPY_AUDIO_CODECS = new Set(['aac', 'mp3']);
const PROGRESS_INTERVAL_MS = 250;

/** 동시에 실행할 작업 수를 제한한다 */
export function createQueue(limit) {
  const waiting = [];
  let active = 0;
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    next();
  });
}

const probeSlots = createQueue(4);
const posterSlots = createQueue(3);
const spriteSlots = createQueue(1);
const peakSlots = createQueue(1);
const proxySlots = createQueue(2);

export function run(bin, args, { onStdout, signal, background = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, signal });
    if (background && proc.pid) {
      // 편집 화면과 재생이 먼저 돌도록 뒤로 양보한다
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 이미 끝난 프로세스 */ }
    }
    const out = [];
    let err = '';
    proc.stdout.on('data', (d) => (onStdout ? onStdout(d) : out.push(d)));
    proc.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(bin)} 실패 (${code}): ${err.slice(-1500)}`));
    });
  });
}

function parseRate(rate) {
  const [a, b] = String(rate || '0/1').split('/').map(Number);
  return b ? a / b : a || 0;
}

/** JPEG EXIF Orientation(1~8). 없거나 JPEG 이 아니면 1 */
export async function readJpegOrientation(file) {
  const handle = await fs.promises.open(file, 'r').catch(() => null);
  if (!handle) return 1;
  try {
    const buf = Buffer.alloc(128 * 1024);
    const { bytesRead: n } = await handle.read(buf, 0, buf.length, 0);
    if (n < 4 || buf.readUInt16BE(0) !== 0xffd8) return 1;
    let p = 2;
    while (p + 4 < n) {
      if (buf[p] !== 0xff) return 1;
      const marker = buf[p + 1];
      const len = buf.readUInt16BE(p + 2);
      if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
        const tiff = p + 10;
        const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
        const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = tiff + u32(tiff + 4);
        const count = u16(ifd);
        for (let i = 0; i < count; i += 1) {
          const entry = ifd + 2 + i * 12;
          if (entry + 12 > n) return 1;
          if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
        }
        return 1;
      }
      if (marker === 0xda) return 1;
      p += 2 + len;
    }
    return 1;
  } catch {
    return 1;
  } finally {
    await handle.close();
  }
}

const EXIF_FILTERS = {
  2: 'hflip',
  3: 'hflip,vflip',
  4: 'vflip',
  5: 'transpose=0',
  6: 'transpose=1',
  7: 'transpose=3',
  8: 'transpose=2',
};

/** `ffmpeg -i` 의 분석 출력을 ffprobe JSON 과 같은 모양으로 바꾼다 */
export function parseFfmpegInfo(text) {
  const streams = [];
  const lines = String(text).split(/\r?\n/);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  for (const line of lines) {
    const video = /Stream #\d+:\d+.*?: Video: (\w+)(.*)$/.exec(line);
    const audio = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(line);
    if (video) {
      const size = /,\s*([a-z0-9_]+)(?:\(([^)]*)\))?,\s*(\d{2,5})x(\d{2,5})/.exec(video[2]);
      const fps = /([\d.]+) fps/.exec(video[2]) || /([\d.]+) tbr/.exec(video[2]);
      streams.push({
        codec_type: 'video',
        codec_name: video[1],
        pix_fmt: size?.[1] ?? null,
        field_order: /top first|top coded first/.test(size?.[2] ?? '') ? 'tt' : /bottom first|bottom coded first/.test(size?.[2] ?? '') ? 'bb' : 'progressive',
        width: Number(size?.[3]) || 0,
        height: Number(size?.[4]) || 0,
        avg_frame_rate: fps?.[1] ?? '0',
        disposition: { attached_pic: /\(attached pic\)/.test(line) ? 1 : 0 },
        side_data_list: [],
      });
    } else if (audio) {
      streams.push({ codec_type: 'audio', codec_name: audio[1], disposition: {} });
    } else {
      const rotation = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(line);
      const last = streams[streams.length - 1];
      if (rotation && last?.codec_type === 'video') last.side_data_list.push({ rotation: Number(rotation[1]) });
    }
  }
  return {
    streams,
    format: { duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0 },
  };
}

/** 분석 실패 원인을 사용자가 조치할 수 있는 말로 옮긴다 */
export function describeProbeFailure(text) {
  if (/moov atom not found/i.test(text)) return '파일이 완전히 저장되지 않았습니다. 복사·다운로드·녹화가 끝났는지 확인하세요.';
  if (/Permission denied|being used by another|sharing violation/i.test(text)) return '파일을 열 수 없습니다. 다른 프로그램이 사용 중이거나 읽기 권한이 없습니다.';
  if (/No such file/i.test(text)) return '파일을 찾을 수 없습니다.';
  if (/Invalid data found/i.test(text)) return '파일이 손상되었거나 지원하지 않는 형식입니다.';
  return '영상이나 소리가 들어 있지 않은 파일입니다.';
}

async function readStreams(file) {
  try {
    const raw = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    const info = JSON.parse(raw.toString('utf8'));
    if (info.streams?.length) return info;
  } catch { /* 아래에서 ffmpeg 으로 다시 읽는다 */ }
  const text = await new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    proc.stdout.resume();
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', () => resolve(err));
  });
  const info = parseFfmpegInfo(text);
  if (!info.streams.length) throw new Error(describeProbeFailure(text));
  return info;
}

export function probe(file) {
  return probeSlots(() => probeNow(file));
}

async function probeNow(file) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    throw new Error('파일을 찾을 수 없습니다.');
  }
  if (stat.isDirectory()) throw new Error('폴더입니다.');
  if (stat.size === 0) throw new Error('빈 파일입니다 (0바이트).');
  const info = await readStreams(file);
  const ext = path.extname(file).toLowerCase();
  const streams = (info.streams || []).filter((s) => !NON_MEDIA_CODECS.has(s.codec_name));
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const isImage = IMAGE_EXT.has(ext) && !audio;
  const result = {
    path: file,
    name: path.basename(file),
    size: stat.size,
    type: isImage ? 'image' : video ? 'video' : audio ? 'audio' : null,
    duration: Number(info.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0,
    width: video?.width || 0,
    height: video?.height || 0,
    fps: parseRate(video?.avg_frame_rate || video?.r_frame_rate),
    hasAudio: !!audio,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    rotation: 0,
    needsProxy: false,
    canRemux: false,
    interlaced: false,
    orientation: 1,
  };
  if (!result.type) throw new Error('영상이나 소리가 들어 있지 않은 파일입니다.');

  if (result.type === 'video') {
    // 세로 촬영 영상의 회전 메타데이터. ffmpeg·크로미움 모두 자동 회전하므로 표시 크기만 맞춘다.
    const matrix = video.side_data_list?.find((d) => d.rotation !== undefined);
    const rotation = Math.abs(Number(matrix?.rotation ?? video.tags?.rotate ?? 0)) % 360;
    result.rotation = rotation;
    if (rotation === 90 || rotation === 270) [result.width, result.height] = [result.height, result.width];
    const videoOk = BROWSER_VIDEO_CODECS.has(video.codec_name) && BROWSER_VIDEO_EXT.has(ext) && BROWSER_PIX_FMTS.has(video.pix_fmt);
    // MP4·MOV 안의 PCM 소리는 브라우저가 재생하지 못할 수 있다
    const audioOk = !audio || (BROWSER_AUDIO_CODECS.has(audio.codec_name) && !audio.codec_name.startsWith('pcm_'));
    const h26410bit = video.codec_name === 'h264' && video.pix_fmt !== 'yuv420p' && video.pix_fmt !== 'yuvj420p';
    result.needsProxy = !videoOk || !audioOk || h26410bit;
    result.interlaced = ['tt', 'bb', 'tb', 'bt'].includes(video.field_order);
    result.canRemux = REMUX_VIDEO_CODECS.has(video.codec_name) && !h26410bit && !result.interlaced;
  } else if (result.type === 'audio') {
    result.needsProxy = !(BROWSER_AUDIO_EXT.has(ext) && BROWSER_AUDIO_CODECS.has(audio.codec_name));
  } else {
    result.duration = 0;
    result.orientation = await readJpegOrientation(file);
    if (result.orientation >= 5) [result.width, result.height] = [result.height, result.width];
    result.needsProxy = !BROWSER_IMAGE_EXT.has(ext);
  }
  return result;
}

let cacheDir = null;
export function setCacheDir(dir) {
  cacheDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

// 메인 프로세스가 멈추면 창과 재생까지 함께 멈추므로 파일 작업은 모두 비동기로 한다.
const fileSize = (file) => fs.promises.stat(file).then((st) => st.size, () => 0);

async function cachePath(file, suffix) {
  const st = await fs.promises.stat(file);
  const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  return path.join(cacheDir, `${key}${suffix}`);
}

/**
 * 완성 표시 파일이 있어야 캐시로 인정한다. 임시 이름으로 만들고 바꾸는 방식은 쓰지 않는다.
 * 서명 없는 프로그램이 이미지 파일 이름을 연달아 바꾸면 보안 프로그램이 파일마다 수 초씩 붙잡거나 프로세스를 끝낼 수 있다.
 */
async function cached(target, make) {
  const done = `${target}.done`;
  if (await fileSize(done) > 0 && await fileSize(target) > 0) return target;
  try {
    await make(target);
    if (!await fileSize(target)) throw new Error('파일을 만들지 못했습니다.');
  } catch (err) {
    await fs.promises.rm(target, { force: true }).catch(() => {});
    throw err;
  }
  await fs.promises.writeFile(done, '1');
  return target;
}

const inFlight = new Map();
function once(key, make) {
  if (!inFlight.has(key)) inFlight.set(key, make().finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

/** EXIF 회전이 있는 사진을 똑바로 세운 PNG. 미리보기와 내보내기 모두 이 파일을 쓴다. */
export async function normalizedImage(file, orientation) {
  const target = await cachePath(file, '.upright.png');
  return once(target, () => cached(target, (tmp) => run(FFMPEG, [
    '-y', '-noautorotate', '-i', file, '-vf', EXIF_FILTERS[orientation], '-frames:v', '1', '-update', '1', tmp,
  ])));
}

function progressReporter(info, onProgress) {
  let lastAt = 0;
  return (d) => {
    const m = /out_time_us=(\d+)/.exec(String(d));
    if (!m || !(info.duration > 0)) return;
    const now = Date.now();
    if (now - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = now;
    onProgress?.(Math.min(1, Number(m[1]) / 1e6 / info.duration));
  };
}

/** 영상은 다시 압축하지 않고 MP4 로 옮겨 담는다. 소리만 필요하면 변환한다. */
function remuxArgs(info, tmp) {
  const copyAudio = COPY_AUDIO_CODECS.has(info.audioCodec);
  return ['-y', '-i', info.path, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy',
    ...(info.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
}

function transcodeArgs(info, tmp) {
  // 세로 영상도 긴 변 기준 1280 으로 줄인다.
  const scale = "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',format=yuv420p";
  return ['-y', '-i', info.path, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `${info.interlaced ? 'yadif,' : ''}${scale}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-g', '15',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
}

/**
 * 브라우저가 재생하지 못하는 형식의 미리보기 대용 파일. 내보내기에는 원본을 쓴다.
 * 옮겨 담기로 충분한 영상은 다시 압축하지 않는다. transcode 를 주면 항상 다시 압축한다.
 */
export async function makeProxy(info, onProgress, { transcode = false } = {}) {
  if (info.type === 'video' && info.canRemux && !transcode) {
    const target = await cachePath(info.path, '.remux.mp4');
    try {
      return await once(target, () => proxySlots(() => cached(target, (tmp) => run(FFMPEG, remuxArgs(info, tmp), {
        background: true,
        onStdout: progressReporter(info, onProgress),
      }))));
    } catch { /* 옮겨 담을 수 없는 파일은 아래에서 다시 압축한다 */ }
  }
  const ext = info.type === 'video' ? '.proxy.mp4' : info.type === 'audio' ? '.proxy.m4a' : '.proxy.png';
  const target = await cachePath(info.path, ext);
  return once(target, () => proxySlots(() => cached(target, async (tmp) => {
    let args;
    if (info.type === 'image') {
      args = ['-y', '-i', info.path, '-frames:v', '1', '-update', '1', tmp];
    } else if (info.type === 'audio') {
      args = ['-y', '-i', info.path, '-vn', '-c:a', 'aac', '-b:a', '192k', '-progress', 'pipe:1', '-nostats', tmp];
    } else {
      args = transcodeArgs(info, tmp);
    }
    await run(FFMPEG, args, { background: true, onStdout: progressReporter(info, onProgress) });
  })));
}

const THUMB_BOX = 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2';

function grabFrame(source, time, out) {
  return run(FFMPEG, ['-y', '-v', 'error', '-ss', time.toFixed(3), '-noaccurate_seek', '-i', source, '-an', '-sn',
    '-vf', THUMB_BOX, '-frames:v', '1', '-update', '1', out]);
}

/** 가져오자마자 보여 줄 대표 썸네일 한 장 */
export async function makePoster(info, sourcePath) {
  const target = await cachePath(info.path, '.poster.jpg');
  return once(target, () => posterSlots(() => cached(target, async (tmp) => {
    if (info.type === 'image') {
      await run(FFMPEG, ['-y', '-v', 'error', '-i', sourcePath, '-vf', THUMB_BOX, '-frames:v', '1', '-update', '1', tmp]);
      return;
    }
    await grabFrame(sourcePath, Math.min(1, info.duration * 0.1), tmp);
    if (!await fileSize(tmp)) await grabFrame(sourcePath, 0, tmp);
  })));
}

/** 타임라인·미디어함 썸네일 스프라이트 */
export async function makeSprite(info, sourcePath) {
  const count = info.type === 'image' ? 1 : Math.max(1, Math.min(60, Math.ceil(info.duration / 2)));
  const target = await cachePath(info.path, `.sprite${count}.jpg`);
  return once(target, () => spriteSlots(() => cached(target, async (tmp) => {
    if (info.type === 'image') {
      await run(FFMPEG, ['-y', '-i', sourcePath, '-vf', THUMB_BOX, '-frames:v', '1', '-update', '1', tmp]);
      return;
    }
    const rate = count / Math.max(info.duration, 0.1);
    const attempt = (pre) => run(FFMPEG, ['-y', ...pre, '-i', sourcePath, '-an',
      '-vf', `fps=${rate.toFixed(5)},${THUMB_BOX},tile=${count}x1`, '-frames:v', '1', '-update', '1', tmp], { background: true });
    // 키프레임만 읽으면 빠르지만, 키프레임이 드문 파일은 전체 디코딩으로 다시 시도한다.
    try {
      await attempt(['-skip_frame', 'nokey']);
      if (!await fileSize(tmp)) throw new Error('empty');
    } catch {
      await attempt([]);
    }
  }))).then((file) => ({ file, count }));
}

const PEAKS_PER_SECOND = 20;

/** 파형 피크(0~255). @returns {{rate:number, data:Uint8Array}} */
export async function makePeaks(info) {
  const target = await cachePath(info.path, '.peaks');
  await once(target, () => peakSlots(() => cached(target, async (tmp) => {
    const out = fs.createWriteStream(tmp);
    const window = Math.round(8000 / PEAKS_PER_SECOND);
    let carry = Buffer.alloc(0);
    await run(FFMPEG, ['-v', 'error', '-i', info.path, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], {
      background: true,
      onStdout: (chunk) => {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const frames = Math.floor(buf.length / 2 / window);
        const peaks = Buffer.alloc(frames);
        for (let i = 0; i < frames; i += 1) {
          let max = 0;
          for (let j = 0; j < window; j += 1) {
            const v = Math.abs(buf.readInt16LE((i * window + j) * 2));
            if (v > max) max = v;
          }
          peaks[i] = Math.min(255, Math.round((max / 32768) * 255));
        }
        out.write(peaks);
        carry = buf.subarray(frames * window * 2);
      },
    });
    await new Promise((resolve) => out.end(resolve));
  })));
  return { rate: PEAKS_PER_SECOND, data: new Uint8Array(await fs.promises.readFile(target)) };
}
