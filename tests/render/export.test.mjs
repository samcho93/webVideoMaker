// 실제 ffmpeg 으로 프로젝트를 렌더링해 결과물의 길이·해상도·픽셀을 검증한다.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FFMPEG, probe, readJpegOrientation, run, makePeaks, setCacheDir, makePoster, makeProxy, makeSprite, normalizedImage } from '../../main/ffmpeg.mjs';
import { beginJob, runJob } from '../../main/exporter.mjs';
import { colorCurveValue, colorMatrix } from '../../shared/layout.mjs';
import { createMask, createMediaClip, createProject, newId } from '../../shared/model.mjs';

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'render');
const f = (name) => path.join(TMP, name);
const media = {};

const track = (p, name) => p.tracks.find((t) => t.name === name);

async function register(key, file) {
  const info = await probe(file);
  media[key] = { ...info, id: newId('med') };
  return media[key];
}

async function render(project, assets = {}, options = {}, prepare) {
  const id = beginJob();
  if (prepare) await prepare(id);
  const output = f(`out-${newId('r')}.${options.ext || 'mp4'}`);
  project.media = Object.values(media);
  const progress = [];
  const res = await runJob(id, { project, assets, options: { format: 'mp4-h264', quality: 'low', output, ...options } }, (v) => progress.push(v));
  assert.equal(res.output, output);
  return { output, progress };
}

/** 지정 시각의 프레임에서 한 점의 RGB 를 읽는다 */
async function pixel(file, time, x, y) {
  const raw = await run(FFMPEG, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1',
    '-vf', `crop=4:4:${x}:${y},scale=1:1,format=rgb24`, '-f', 'rawvideo', 'pipe:1']);
  return [...raw.subarray(0, 3)];
}

const near = (a, b, tol = 30) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

function sampleStdDev(buf) {
  let sum = 0;
  for (const v of buf) sum += v;
  const mean = sum / buf.length;
  let acc = 0;
  for (const v of buf) acc += (v - mean) ** 2;
  return Math.sqrt(acc / buf.length);
}

async function regionGray(file, time, x, y, w, h) {
  return run(FFMPEG, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1',
    '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', 'pipe:1']);
}

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  setCacheDir(path.join(TMP, 'cache'));
  // 가로 영상(빨강 배경 + 사인파), 세로 촬영 영상(파랑, 회전 메타데이터), 무늬 영상, 사진, 음악
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('red.mp4')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=blue:s=1280x720:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('blue-raw.mp4')]);
  await run(FFMPEG, ['-y', '-display_rotation', '90', '-i', f('blue-raw.mp4'), '-c', 'copy', f('portrait.mp4')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('pattern.mp4')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=gray:s=1280x720:r=30:d=5,noise=alls=70:allf=t', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', f('noise.mp4')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=green:s=800x600:d=1', '-frames:v', '1', '-update', '1', f('photo.png')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=20', '-c:a', 'libmp3lame', f('music.mp3')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=white:s=200x100:d=1', '-frames:v', '1', '-update', '1', f('overlay.png')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=yellow@1.0:s=1920x1080:d=1,format=rgba', '-frames:v', '1', '-update', '1', f('cap1.png')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=black@0.0:s=1920x1080:d=1,format=rgba', '-frames:v', '1', '-update', '1', f('blank.png')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', "color=black:s=400x400:d=1,format=gray,geq=lum='if(lte(hypot(X-200,Y-200),200),255,0)'", '-frames:v', '1', '-update', '1', f('ellipse.png')]);
  await register('red', f('red.mp4'));
  await register('portrait', f('portrait.mp4'));
  await register('pattern', f('pattern.mp4'));
  await register('noise', f('noise.mp4'));
  await register('photo', f('photo.png'));
  await register('music', f('music.mp3'));
});

after(() => {
  if (!process.env.KEEP_RENDER) fs.rmSync(TMP, { recursive: true, force: true });
});

test('probe: 회전 메타데이터를 반영해 세로 크기를 보고한다', () => {
  assert.equal(media.portrait.width, 720);
  assert.equal(media.portrait.height, 1280);
  assert.equal(media.red.hasAudio, true);
  assert.equal(media.music.type, 'audio');
  assert.equal(media.photo.type, 'image');
  assert.equal(media.red.needsProxy, false);
});

test('서로 다른 해상도·방향·사진을 이어 붙인다', async () => {
  const p = createProject();
  const c1 = createMediaClip(media.red, 0);
  c1.out = 2;
  const c2 = createMediaClip(media.portrait, 2);
  c2.out = 2;
  const c3 = createMediaClip(media.photo, 4);
  c3.out = 2;
  track(p, 'V1').clips.push(c1, c2, c3);
  const { output, progress } = await render(p);
  const info = await probe(output);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.ok(Math.abs(info.duration - 6) < 0.2, `길이 ${info.duration}`);
  assert.equal(progress.at(-1), 1);
  assert.ok(near(await pixel(output, 1, 960, 540), [254, 0, 0]));
  // 세로 영상: 가운데 파랑, 좌우는 검정 필러박스
  assert.ok(near(await pixel(output, 3, 960, 540), [0, 0, 254]));
  assert.ok(near(await pixel(output, 3, 100, 540), [0, 0, 0]));
  // 4:3 사진: 가운데 초록(0,128,0), 좌측 필러박스
  assert.ok(near(await pixel(output, 5, 960, 540), [0, 128, 0]));
  assert.ok(near(await pixel(output, 5, 100, 540), [0, 0, 0]));
});

test('구간 잘라내기 + 빨리 감기 길이', async () => {
  const p = createProject();
  track(p, 'V1').clips.push({ ...createMediaClip(media.pattern, 0), in: 1, out: 5, speed: 2 });
  const { output } = await render(p);
  const info = await probe(output);
  assert.ok(Math.abs(info.duration - 2) < 0.15, `길이 ${info.duration}`);
});

test('페이드 인/아웃은 배경색으로 전환된다', async () => {
  const p = createProject();
  track(p, 'V1').clips.push({ ...createMediaClip(media.red, 0), fadeIn: 1, fadeOut: 1 });
  const { output } = await render(p);
  const early = await pixel(output, 0.05, 960, 540);
  const mid = await pixel(output, 3, 960, 540);
  const late = await pixel(output, 5.9, 960, 540);
  assert.ok(early[0] < 60, `시작 ${early}`);
  assert.ok(mid[0] > 230, `중간 ${mid}`);
  assert.ok(late[0] < 60, `끝 ${late}`);
});

test('회전·채우기·블러 배경·투명도·크롭·반전 그래프가 실행된다', async () => {
  const p = createProject();
  const base = { ...createMediaClip(media.pattern, 0), out: 1 };
  track(p, 'V1').clips.push(
    { ...base, id: newId('c'), start: 0, rotation: 90 },
    { ...base, id: newId('c'), start: 1, rotation: 30, opacity: 0.5 },
    { ...base, id: newId('c'), start: 2, fit: 'cover', flipH: true, flipV: true },
    { ...base, id: newId('c'), start: 3, blurBackground: true, scale: 0.6, posX: 100, fadeIn: 0.2, fadeOut: 0.2 },
    { ...base, id: newId('c'), start: 4, crop: { l: 0.1, t: 0.1, r: 0.2, b: 0.2 }, brightness: 0.2, contrast: 0.1, saturation: -0.2, fit: 'stretch' },
  );
  const { output } = await render(p);
  const info = await probe(output);
  assert.ok(Math.abs(info.duration - 5) < 0.2);
});

test('블러 배경은 필러박스 영역을 채운다', async () => {
  const p = createProject();
  track(p, 'V1').clips.push({ ...createMediaClip(media.portrait, 0), out: 1, blurBackground: true });
  const { output } = await render(p);
  assert.ok(near(await pixel(output, 0.5, 100, 540), [0, 0, 254]));
});

test('음악 위치와 소리 믹스', async () => {
  const p = createProject();
  track(p, 'V1').clips.push({ ...createMediaClip(media.pattern, 0), out: 4 });
  track(p, '음악').clips.push({ ...createMediaClip(media.music, 2), out: 2 });
  const { output } = await render(p);
  const info = await probe(output);
  assert.equal(info.hasAudio, true);
  const pcm = await run(FFMPEG, ['-v', 'error', '-i', output, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
  const rms = (a, b) => {
    let acc = 0;
    let n = 0;
    for (let i = a * 8000; i < b * 8000 && i * 2 + 1 < pcm.length; i += 1) { acc += pcm.readInt16LE(i * 2) ** 2; n += 1; }
    return Math.sqrt(acc / Math.max(n, 1));
  };
  assert.ok(rms(0.5, 1.5) < 5, `음악 전 ${rms(0.5, 1.5)}`);
  assert.ok(rms(2.5, 3.5) > 500, `음악 중 ${rms(2.5, 3.5)}`);
});

test('모자이크·블러는 지정 구간·영역에만 적용된다', async () => {
  const p = createProject();
  track(p, 'V1').clips.push(createMediaClip(media.noise, 0));
  const mosaic = { ...createMask(1, 1920, 1080, 'mosaic'), x: 100, y: 100, w: 400, h: 400, duration: 1, strength: 80 };
  const blur = { ...createMask(3, 1920, 1080, 'blur'), x: 100, y: 100, w: 400, h: 400, duration: 1, strength: 30 };
  track(p, '모자이크·블러').clips.push(mosaic, blur);
  const { output } = await render(p);
  // 인접 픽셀 차이 평균: 노이즈 원본은 크고, 모자이크·블러 영역은 작아야 한다
  const edge = (b) => { let acc = 0; for (let i = 1; i < b.length; i += 1) acc += Math.abs(b[i] - b[i - 1]); return acc / b.length; };
  const region = (t) => regionGray(output, t, 100, 100, 400, 400);
  const original = edge(await region(0.5));
  assert.ok(original > 3, `원본 ${original}`);
  // 모자이크 블록 내부는 균일하다 (블록 크기 80, 인코딩 오차 허용)
  const block = await regionGray(output, 1.5, 108, 108, 64, 64);
  assert.ok(sampleStdDev(block) < 4, `블록 표준편차 ${sampleStdDev(block)}`);
  const blurred = edge(await region(3.5));
  assert.ok(blurred < original / 3, `블러 ${blurred} / 원본 ${original}`);
  // 구간 밖과 영역 밖은 그대로다
  const afterEdge = edge(await region(4.5));
  assert.ok(afterEdge > original / 2, `구간 후 ${afterEdge} / 원본 ${original}`);
  const outside = edge(await regionGray(output, 3.5, 1000, 600, 400, 400));
  assert.ok(outside > original / 2, `영역 밖 ${outside} / 원본 ${original}`);
});

test('타원·이동 모자이크 그래프가 실행된다', async () => {
  const p = createProject();
  track(p, 'V1').clips.push(createMediaClip(media.pattern, 0));
  const mask = { ...createMask(0, 1920, 1080, 'mosaic', 'ellipse'), x: 100, y: 100, w: 400, h: 400, duration: 5, keyframes: [{ t: 0, x: 100, y: 100 }, { t: 5, x: 1400, y: 600 }] };
  track(p, '모자이크·블러').clips.push(mask);
  const { output } = await render(p, { masks: { [mask.id]: f('ellipse.png') } });
  assert.ok((await probe(output)).duration > 4.8);
});

test('모자이크는 영상 중간에 기록한 위치로 옮겨 간다', async () => {
  const edge = (b) => { let acc = 0; for (let i = 1; i < b.length; i += 1) acc += Math.abs(b[i] - b[i - 1]); return acc / b.length; };
  const makeProject = (motion) => {
    const p = createProject();
    track(p, 'V1').clips.push(createMediaClip(media.noise, 0));
    track(p, '모자이크·블러').clips.push({
      ...createMask(0, 1920, 1080, 'mosaic'), x: 100, y: 100, w: 320, h: 320, duration: 5, strength: 80, motion,
      keyframes: [{ t: 0, x: 100, y: 100 }, { t: 2.5, x: 1000, y: 500 }],
    });
    return p;
  };
  const hold = (await render(makeProject('hold'))).output;
  const original = edge(await regionGray(hold, 1, 1000, 500, 320, 320));
  assert.ok(original > 3, `원본 ${original}`);
  assert.ok(sampleStdDev(await regionGray(hold, 1, 108, 108, 64, 64)) < 4, '기록 전: 처음 자리가 모자이크');
  assert.ok(edge(await regionGray(hold, 2.3, 100, 100, 320, 320)) < original / 2, '기록 직전까지 처음 자리 유지');
  assert.ok(sampleStdDev(await regionGray(hold, 3.5, 1008, 508, 64, 64)) < 4, '기록 후: 새 자리가 모자이크');
  assert.ok(edge(await regionGray(hold, 3.5, 100, 100, 320, 320)) > original / 2, '기록 후: 처음 자리는 원본');

  const linear = (await render(makeProject('linear'))).output;
  // 1.25초는 두 위치의 중간(550, 300)
  assert.ok(edge(await regionGray(linear, 1.25, 550, 300, 320, 320)) < original / 2, '중간 시각에는 중간 위치');
  assert.ok(edge(await regionGray(linear, 1.25, 1400, 700, 320, 320)) > original / 2, '다른 곳은 원본');
  assert.ok(edge(await regionGray(linear, 4, 1000, 500, 320, 320)) < original / 2, '마지막 기록 뒤에는 그 자리');
});

test('위치 기록이 많아도 내보낼 수 있다', async () => {
  const p = createProject();
  track(p, 'V1').clips.push(createMediaClip(media.pattern, 0));
  const keyframes = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.12, x: (i * 37) % 1500, y: (i * 53) % 700 }));
  track(p, '모자이크·블러').clips.push({ ...createMask(0, 1920, 1080, 'blur'), x: 0, y: 0, w: 200, h: 200, duration: 5, keyframes });
  const { output } = await render(p);
  assert.ok((await probe(output)).duration > 4.8);
});

test('영상 조절 결과가 공용 계산식과 일치한다', async () => {
  const SRC = [0x60, 0x80, 0xa0];
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=0x6080a0:s=640x360', '-frames:v', '1', '-update', '1', f('solid.png')]);
  const solid = await register('solid', f('solid.png'));
  const cases = [
    { brightness: 0.3 }, { brightness: -0.3 }, { contrast: 0.6 }, { contrast: -0.5 }, { saturation: -1 }, { saturation: 1 },
    { gamma: 1.8 }, { gamma: 0.6 }, { temperature: 0.8 }, { temperature: -0.8 }, { hue: 90 }, { hue: -120 },
    { brightness: 0.1, contrast: 0.2, saturation: 0.3, gamma: 1.2, temperature: 0.3, hue: 20 },
  ];
  const p = createProject();
  cases.forEach((patch, i) => {
    track(p, 'V1').clips.push({ ...createMediaClip(solid, i), out: 1, fit: 'stretch', ...patch });
  });
  const { output } = await render(p);
  for (const [i, patch] of cases.entries()) {
    const curved = ['r', 'g', 'b'].map((ch, c) => colorCurveValue(patch, ch, SRC[c] / 255));
    const m = colorMatrix(patch);
    const expected = [0, 1, 2].map((r) => Math.max(0, Math.min(1, m[r * 3] * curved[0] + m[r * 3 + 1] * curved[1] + m[r * 3 + 2] * curved[2])) * 255);
    const actual = await pixel(output, i + 0.5, 900, 500);
    assert.ok(near(actual, expected, 9), `${JSON.stringify(patch)} 기대 ${expected.map(Math.round)} 실제 ${actual}`);
  }
  delete media.solid;
});

test('선명도는 경계를 또렷하게 만들고 알파를 유지한다', async () => {
  const edge = (b) => { let acc = 0; for (let i = 1; i < b.length; i += 1) acc += Math.abs(b[i] - b[i - 1]); return acc / b.length; };
  const make = async (sharpness) => {
    const p = createProject();
    track(p, 'V1').clips.push({ ...createMediaClip(media.pattern, 0), out: 1, sharpness });
    return (await render(p)).output;
  };
  const plain = edge(await regionGray(await make(0), 0.5, 300, 300, 300, 300));
  const sharp = edge(await regionGray(await make(1), 0.5, 300, 300, 300, 300));
  assert.ok(sharp > plain * 1.2, `선명도 ${plain} → ${sharp}`);
});

test('오버레이 PNG 와 자막 ffconcat', async () => {
  const p = createProject();
  track(p, 'V1').clips.push({ ...createMediaClip(media.red, 0) });
  const overlay = { id: newId('o'), kind: 'text', start: 1, duration: 1, x: 0, y: 0, fadeIn: 0, fadeOut: 0 };
  track(p, '텍스트·아이콘').clips.push(overlay);
  const sub = track(p, '자막');
  sub.clips.push({ id: newId('c'), start: 3, duration: 1, text: 'x' });
  const assets = {
    overlays: { [overlay.id]: { path: f('overlay.png'), x: 100, y: 100 } },
    captionEntries: { [sub.id]: [{ name: f('cap1.png'), start: 3, end: 4 }] },
    blankName: f('blank.png'),
  };
  const { output } = await render(p, assets);
  assert.ok(near(await pixel(output, 0.5, 150, 150), [254, 0, 0]), '오버레이 전');
  assert.ok(near(await pixel(output, 1.5, 150, 150), [255, 255, 255]), '오버레이 중');
  assert.ok(near(await pixel(output, 2.5, 150, 150), [254, 0, 0]), '오버레이 후');
  assert.ok(near(await pixel(output, 2.5, 960, 540), [254, 0, 0]), '자막 전');
  assert.ok(near(await pixel(output, 3.5, 960, 540), [255, 255, 0]), '자막 중');
  assert.ok(near(await pixel(output, 4.5, 960, 540), [254, 0, 0]), '자막 후');
  assert.ok(Math.abs((await probe(output)).duration - 6) < 0.2);
});

for (const [format, ext, codec] of [['mp4-h265', 'mp4', 'hevc'], ['webm', 'webm', 'vp9'], ['mov', 'mov', 'h264'], ['mkv', 'mkv', 'h264'], ['gif', 'gif', 'gif']]) {
  test(`형식 내보내기: ${format}`, async () => {
    const p = createProject();
    track(p, 'V1').clips.push({ ...createMediaClip(media.red, 0), out: 1 });
    const { output } = await render(p, {}, { format, ext, height: 480 });
    const info = await probe(output);
    assert.equal(info.videoCodec, codec);
    assert.equal(info.height, 480);
    assert.equal(info.width, 854);
  });
}

test('EXIF 회전 사진을 똑바로 세운다', async () => {
  // 가로 400x200 JPEG 에 Orientation=6 APP1 을 삽입한다
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:s=400x200:d=1', '-frames:v', '1', '-update', '1', f('plain.jpg')]);
  const jpg = fs.readFileSync(f('plain.jpg'));
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  fs.writeFileSync(f('exif.jpg'), Buffer.concat([jpg.subarray(0, 2), app1, payload, jpg.subarray(2)]));
  assert.equal(await readJpegOrientation(f('exif.jpg')), 6);
  const info = await probe(f('exif.jpg'));
  assert.deepEqual([info.width, info.height], [200, 400]);
  const upright = await normalizedImage(f('exif.jpg'), 6);
  const out = await probe(upright);
  assert.deepEqual([out.width, out.height], [200, 400]);
});

test('H.264 는 다시 압축하지 않고 옮겨 담으며 소리만 변환한다', async () => {
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-shortest', '-f', 'mpegts', f('camera.mts')]);
  const info = await probe(f('camera.mts'));
  assert.equal(info.needsProxy, true);
  assert.equal(info.canRemux, true);
  const remux = await makeProxy(info);
  assert.match(remux, /\.remux\.mp4$/);
  const out = await probe(remux);
  assert.equal(out.videoCodec, 'h264');
  assert.equal(out.audioCodec, 'aac');
  assert.deepEqual([out.width, out.height], [640, 360], '해상도를 줄이지 않고 그대로 옮긴다');
  assert.ok(Math.abs(out.duration - 3) < 0.2, `길이 ${out.duration}`);
  assert.ok(!out.needsProxy);
  // 다시 압축을 요청하면 별도의 파일을 만든다
  const proxy = await makeProxy(info, null, { transcode: true });
  assert.match(proxy, /\.proxy\.mp4$/);
});

test('옮겨 담기가 실패하면 다시 압축으로 넘어간다', async () => {
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('ok.mp4')]);
  const info = await probe(f('ok.mp4'));
  const proxy = await makeProxy({ ...info, canRemux: true, videoCodec: 'h264', audioCodec: null, path: f('ok.mp4'), duration: 1 }, null);
  assert.ok(fs.statSync(proxy).size > 0);
  fs.writeFileSync(f('broken.mp4'), 'not a video');
  await assert.rejects(makeProxy({ ...info, canRemux: true, path: f('broken.mp4') }), /ffmpeg/);
});

test('MP4 안의 PCM 소리는 미리보기 확인 대상으로 분류한다', async () => {
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', f('pcm.mov')]);
  const info = await probe(f('pcm.mov'));
  assert.equal(info.needsProxy, true);
  assert.equal(info.canRemux, true);
});

test('대표 썸네일을 만들고, 캐시는 완성 표시가 있을 때만 다시 쓴다', async () => {
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', f('long.mp4')]);
  const info = await probe(f('long.mp4'));
  const poster = await makePoster(info, info.path);
  const posterInfo = await probe(poster);
  assert.deepEqual([posterInfo.width, posterInfo.height], [160, 90]);
  assert.equal(await makePoster(info, info.path), poster);
  // 만들다 끊긴 파일(완성 표시 없음)은 쓰지 않고 다시 만든다
  fs.rmSync(`${poster}.done`);
  fs.writeFileSync(poster, 'partial');
  await makePoster(info, info.path);
  assert.ok(fs.statSync(poster).size > 100);
  assert.ok(fs.existsSync(`${poster}.done`));
  assert.ok(!fs.readdirSync(path.dirname(poster)).some((n) => n.includes('.tmp')), '임시 파일을 남기지 않는다');
});

test('ffprobe 가 읽지 못하는 파일도 ffmpeg 으로 분석하고, 못 읽으면 이유를 알려 준다', async () => {
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'smptebars=s=320x240:d=1', '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1', '-update', '1', f('still.avif')]);
  const avif = await probe(f('still.avif'));
  assert.equal(avif.type, 'image');
  assert.deepEqual([avif.width, avif.height], [320, 240]);

  fs.writeFileSync(f('memo.txt'), 'hello');
  await assert.rejects(probe(f('memo.txt')), /영상이나 소리가 들어 있지 않은/);
  fs.writeFileSync(f('empty.mp4'), '');
  await assert.rejects(probe(f('empty.mp4')), /빈 파일/);
  await assert.rejects(probe(f('no-such-file.mp4')), /찾을 수 없습니다/);
  await assert.rejects(probe(TMP), /폴더/);
  const whole = fs.readFileSync(f('long.mp4'));
  fs.writeFileSync(f('truncated.mp4'), whole.subarray(0, Math.floor(whole.length / 2)));
  await assert.rejects(probe(f('truncated.mp4')), /완전히 저장되지/);
});

test('프록시·썸네일·파형을 생성한다', async () => {
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', f('legacy.avi')]);
  const info = await probe(f('legacy.avi'));
  assert.equal(info.needsProxy, true);
  const proxy = await makeProxy(info);
  const pinfo = await probe(proxy);
  assert.equal(pinfo.videoCodec, 'h264');
  assert.equal(pinfo.needsProxy, false);
  const { file, count } = await makeSprite(info, info.path);
  assert.ok(fs.statSync(file).size > 0);
  assert.equal(count, 2);
  const peaks = await makePeaks(info);
  assert.ok(peaks.data.length >= 50);
  assert.ok(Math.max(...peaks.data) > 10);
});
