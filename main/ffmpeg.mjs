// ffmpeg/ffprobe 실행과 미디어 분석, 미리보기용 파생 파일(프록시·썸네일·파형) 생성.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
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

export function run(bin, args, { onStdout, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, signal });
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
export function readJpegOrientation(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
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
    fs.closeSync(fd);
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

export async function probe(file) {
  const raw = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(raw.toString('utf8'));
  const ext = path.extname(file).toLowerCase();
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const isImage = IMAGE_EXT.has(ext) && !audio;
  const stat = fs.statSync(file);
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
    orientation: 1,
  };
  if (!result.type) throw new Error('재생 가능한 스트림이 없습니다.');

  if (result.type === 'video') {
    // 세로 촬영 영상의 회전 메타데이터. ffmpeg·크로미움 모두 자동 회전하므로 표시 크기만 맞춘다.
    const matrix = video.side_data_list?.find((d) => d.rotation !== undefined);
    const rotation = Math.abs(Number(matrix?.rotation ?? video.tags?.rotate ?? 0)) % 360;
    result.rotation = rotation;
    if (rotation === 90 || rotation === 270) [result.width, result.height] = [result.height, result.width];
    const videoOk = BROWSER_VIDEO_CODECS.has(video.codec_name) && BROWSER_VIDEO_EXT.has(ext) && BROWSER_PIX_FMTS.has(video.pix_fmt);
    const audioOk = !audio || BROWSER_AUDIO_CODECS.has(audio.codec_name);
    const h26410bit = video.codec_name === 'h264' && video.pix_fmt !== 'yuv420p' && video.pix_fmt !== 'yuvj420p';
    result.needsProxy = !videoOk || !audioOk || h26410bit;
  } else if (result.type === 'audio') {
    result.needsProxy = !(BROWSER_AUDIO_EXT.has(ext) && BROWSER_AUDIO_CODECS.has(audio.codec_name));
  } else {
    result.duration = 0;
    result.orientation = readJpegOrientation(file);
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

function cachePath(file, suffix) {
  const st = fs.statSync(file);
  const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  return path.join(cacheDir, `${key}${suffix}`);
}

async function cached(target, make) {
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  const tmp = `${target}.tmp${path.extname(target)}`;
  await make(tmp);
  fs.renameSync(tmp, target);
  return target;
}

const inFlight = new Map();
function once(key, make) {
  if (!inFlight.has(key)) inFlight.set(key, make().finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

/** EXIF 회전이 있는 사진을 똑바로 세운 PNG. 미리보기와 내보내기 모두 이 파일을 쓴다. */
export function normalizedImage(file, orientation) {
  const target = cachePath(file, '.upright.png');
  return once(target, () => cached(target, (tmp) => run(FFMPEG, [
    '-y', '-noautorotate', '-i', file, '-vf', EXIF_FILTERS[orientation], '-frames:v', '1', '-update', '1', tmp,
  ])));
}

/** 브라우저가 재생하지 못하는 형식의 미리보기 대용 파일. 내보내기에는 원본을 쓴다. */
export function makeProxy(info, onProgress) {
  const ext = info.type === 'video' ? '.proxy.mp4' : info.type === 'audio' ? '.proxy.m4a' : '.proxy.png';
  const target = cachePath(info.path, ext);
  return once(target, () => cached(target, async (tmp) => {
    let args;
    if (info.type === 'image') {
      args = ['-y', '-i', info.path, '-frames:v', '1', '-update', '1', tmp];
    } else if (info.type === 'audio') {
      args = ['-y', '-i', info.path, '-vn', '-c:a', 'aac', '-b:a', '192k', tmp];
    } else {
      // 세로 영상도 긴 변 기준 1280 으로 줄인다.
      args = ['-y', '-i', info.path, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',format=yuv420p",
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-g', '15',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
    }
    await run(FFMPEG, args, {
      onStdout: (d) => {
        const m = /out_time_us=(\d+)/.exec(String(d));
        if (m && info.duration > 0) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / info.duration));
      },
    });
  }));
}

/** 타임라인·미디어함 썸네일 스프라이트 */
export function makeSprite(info, sourcePath) {
  const count = info.type === 'image' ? 1 : Math.max(1, Math.min(60, Math.ceil(info.duration / 2)));
  const target = cachePath(info.path, `.sprite${count}.jpg`);
  return once(target, () => cached(target, async (tmp) => {
    const box = 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2';
    if (info.type === 'image') {
      await run(FFMPEG, ['-y', '-i', sourcePath, '-vf', box, '-frames:v', '1', '-update', '1', tmp]);
      return;
    }
    const rate = count / Math.max(info.duration, 0.1);
    const attempt = (pre) => run(FFMPEG, ['-y', ...pre, '-i', sourcePath, '-an',
      '-vf', `fps=${rate.toFixed(5)},${box},tile=${count}x1`, '-frames:v', '1', '-update', '1', tmp]);
    // 키프레임만 읽으면 빠르지만, 키프레임이 드문 파일은 전체 디코딩으로 다시 시도한다.
    try {
      await attempt(['-skip_frame', 'nokey']);
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('empty');
    } catch {
      await attempt([]);
    }
  })).then((file) => ({ file, count }));
}

const PEAKS_PER_SECOND = 20;

/** 파형 피크(0~255). @returns {{rate:number, data:Uint8Array}} */
export async function makePeaks(info) {
  const target = cachePath(info.path, '.peaks');
  await once(target, () => cached(target, async (tmp) => {
    const out = fs.createWriteStream(tmp);
    const window = Math.round(8000 / PEAKS_PER_SECOND);
    let carry = Buffer.alloc(0);
    await run(FFMPEG, ['-v', 'error', '-i', info.path, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], {
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
  }));
  return { rate: PEAKS_PER_SECOND, data: new Uint8Array(fs.readFileSync(target)) };
}
