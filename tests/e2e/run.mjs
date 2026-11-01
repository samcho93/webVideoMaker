// 실제 Electron 앱을 띄워 UI 조작부터 내보내기 결과물까지 검증한다.
// 사용법: npm run test:e2e   (스크린샷은 tests/.tmp/e2e 에 남는다)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { FFMPEG, probe, run } from '../../main/ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(ROOT, 'tests', '.tmp', 'e2e');
const f = (n) => path.join(TMP, n);
const results = [];

async function step(name, fn) {
  try {
    await fn();
    results.push(`✔ ${name}`);
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push(`✖ ${name}`);
    console.error(`✖ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

async function makeMedia() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-shortest', f('가로영상.mp4')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', f('raw.mp4')]);
  await run(FFMPEG, ['-y', '-display_rotation', '90', '-i', f('raw.mp4'), '-c', 'copy', f('portrait.mp4')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'smptebars=s=800x600:d=1', '-frames:v', '1', '-update', '1', f('photo.png')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=30', '-c:a', 'libmp3lame', f('music.mp3')]);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=300:d=3', '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', f('legacy.avi')]);
  fs.writeFileSync(f('narration.txt'), '# 테스트\n00:00:01 첫 번째 나레이션입니다.\n00:00:05 - 00:00:08 두 번째 나레이션입니다.\n', 'utf8');
}

await makeMedia();

// WVM_EXE 를 지정하면 패키징된 실행 파일을 검증한다
const app = await electron.launch({
  ...(process.env.WVM_EXE ? { executablePath: process.env.WVM_EXE } : { args: [ROOT] }),
  env: { ...process.env, WVM_E2E: '1' },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.waitForFunction(() => window.__wvm);
await page.setViewportSize({ width: 1600, height: 980 }).catch(() => {});

const shot = (name) => page.screenshot({ path: f(`${name}.png`) });
const evalApp = (fn, arg) => page.evaluate(fn, arg);
const projectState = () => evalApp(() => JSON.parse(JSON.stringify(window.__wvm.store.project)));
const track = (p, name) => p.tracks.find((t) => t.name === name);
const waitFrame = () => page.waitForTimeout(500);
const seek = async (t) => {
  await evalApp((v) => window.__wvm.preview.seek(v), t);
  await page.waitForFunction(() => {
    const p = window.__wvm.preview;
    return [...p.slots.values()].every((s) => !s.el.seeking && s.el.readyState >= 2);
  }, null, { timeout: 15000 });
  await waitFrame();
};

await step('앱이 뜨고 프로토콜로 UI 를 불러온다', async () => {
  assert.equal(await page.locator('.brand').textContent(), '▶ WebVideoMaker');
  await shot('01-empty');
});

await step('여러 형식의 미디어 가져오기 (세로·사진·음악·프록시 필요 파일)', async () => {
  const paths = ['가로영상.mp4', 'portrait.mp4', 'photo.png', 'music.mp3', 'legacy.avi'].map(f);
  await evalApp((p) => window.__wvm.actions.importPaths(p), paths);
  const p = await projectState();
  assert.equal(p.media.length, 5);
  const portrait = p.media.find((m) => m.name === 'portrait.mp4');
  assert.deepEqual([portrait.width, portrait.height], [720, 1280]);
  assert.equal(p.media.find((m) => m.name === 'legacy.avi').needsProxy, true);
  await page.waitForFunction(() => {
    const { store } = window.__wvm;
    return store.project.media.every((m) => (m.type === 'audio' || store.rt(m.id).sprite) && (!m.needsProxy || store.rt(m.id).proxy) && (!m.hasAudio || store.rt(m.id).peaks));
  }, null, { timeout: 60000 });
  assert.equal(await page.locator('.media-card').count(), 5);
});

await step('더블클릭으로 이어 붙이기', async () => {
  await page.locator('.media-card', { hasText: '가로영상.mp4' }).dblclick();
  await page.locator('.media-card', { hasText: 'portrait.mp4' }).dblclick();
  await page.locator('.media-card', { hasText: 'photo.png' }).dblclick();
  await page.locator('.media-card', { hasText: 'music.mp3' }).dblclick();
  const p = await projectState();
  const v1 = track(p, 'V1').clips;
  assert.equal(v1.length, 3);
  assert.equal(Math.round(v1[1].start), 8);
  assert.equal(Math.round(v1[2].start), 12);
  assert.equal(track(p, '음악').clips.length, 1);
});

await step('미리보기: 영상이 실제로 그려진다 (CORS·프로토콜·디코딩)', async () => {
  await seek(2);
  const colorful = await evalApp(() => {
    const c = document.getElementById('preview');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4000) seen.add((data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4));
    return seen.size;
  });
  assert.ok(colorful > 10, `색 수 ${colorful}`);
  await shot('02-landscape');
});

await step('세로 영상은 필러박스로 표시된다', async () => {
  await seek(10);
  const edge = await evalApp(() => {
    const c = document.getElementById('preview');
    return [...c.getContext('2d').getImageData(50, 540, 1, 1).data];
  });
  assert.deepEqual(edge.slice(0, 3), [0, 0, 0]);
  await shot('03-portrait');
});

await step('자르기 버튼: 재생 위치에서 클립을 나눈다', async () => {
  await evalApp(() => {
    const { store, preview } = window.__wvm;
    store.select(store.project.tracks.find((t) => t.name === 'V1').clips[0].id);
    preview.seek(3);
  });
  await page.locator('#tlSplit').click();
  const v1 = track(await projectState(), 'V1').clips.sort((a, b) => a.start - b.start);
  assert.equal(v1.length, 4);
  assert.equal(v1[0].out, 3);
  assert.equal(v1[1].in, 3);
  assert.equal(v1[1].start, 3);
});

await step('실행 취소 / 다시 실행', async () => {
  await evalApp(() => window.__wvm.store.undo());
  assert.equal(track(await projectState(), 'V1').clips.length, 3);
  await evalApp(() => window.__wvm.store.redo());
  assert.equal(track(await projectState(), 'V1').clips.length, 4);
});

await step('구간 빨리 감기: 지정 구간만 2배속, 뒤 클립은 당겨진다', async () => {
  const before = track(await projectState(), 'V1').clips.sort((a, b) => a.start - b.start);
  await evalApp((id) => {
    const { store } = window.__wvm;
    store.select(id);
    store.range = { in: 4, out: 6 };
    store.emit('range');
  }, before[1].id);
  await page.locator('#tlSpeed').selectOption('2');
  await page.locator('#tlApplySpeed').click();
  const v1 = track(await projectState(), 'V1').clips.sort((a, b) => a.start - b.start);
  assert.equal(v1.length, 6);
  const fast = v1.find((c) => c.speed === 2);
  assert.equal(fast.start, 4);
  assert.equal((fast.out - fast.in) / fast.speed, 1);
  assert.equal(Math.round(v1.at(-2).start), 7);
});

await step('타임라인 끌기로 클립 이동', async () => {
  const music = track(await projectState(), '음악').clips[0];
  const node = page.locator(`.clip[data-item-id="${music.id}"]`);
  const box = await node.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 10, { steps: 4 });
  await page.mouse.up();
  const moved = track(await projectState(), '음악').clips[0];
  assert.ok(moved.start > 0, `시작 ${moved.start}`);
  await evalApp((id) => {
    const { store } = window.__wvm;
    store.mutate(() => { store.project.tracks.find((t) => t.name === '음악').clips.find((c) => c.id === id).start = 0; });
  }, music.id);
});

await step('트림 핸들로 길이 조절', async () => {
  const music = track(await projectState(), '음악').clips[0];
  const handle = page.locator(`.clip[data-item-id="${music.id}"] .trim.r`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 3, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + 10, { steps: 4 });
  await page.mouse.up();
  const trimmed = track(await projectState(), '음악').clips[0];
  assert.ok(trimmed.out < 30, `끝 ${trimmed.out}`);
  await evalApp(() => window.__wvm.store.undo());
});

await step('페이드 속성을 패널에서 입력', async () => {
  const first = track(await projectState(), 'V1').clips.sort((a, b) => a.start - b.start)[0];
  await evalApp((id) => window.__wvm.store.select(id), first.id);
  const row = page.locator('#properties .field', { hasText: '페이드 인' });
  await row.locator('input[type=number]').fill('1');
  const updated = track(await projectState(), 'V1').clips.find((c) => c.id === first.id);
  assert.equal(updated.fadeIn, 1);
});

await step('텍스트·아이콘·도형 추가', async () => {
  await evalApp(() => window.__wvm.preview.seek(1.5));
  await page.locator('#tabs button[data-tab=text]').click();
  await page.locator('.preset-list button', { hasText: '큰 제목' }).click();
  await page.locator('#tabs button[data-tab=icons]').click();
  await page.locator('.icon-grid button[title=star]').click();
  await page.locator('.icon-grid button', { hasText: '🔥' }).click();
  const overlays = track(await projectState(), '텍스트·아이콘').clips;
  assert.equal(overlays.length, 3);
  assert.equal(overlays[0].text, '제목을 입력하세요');
  await evalApp(() => {
    const { store } = window.__wvm;
    const list = store.project.tracks.find((t) => t.name === '텍스트·아이콘').clips;
    store.mutate(() => {
      list[0].y = 200;
      list[1].x = 300;
      list[1].y = 800;
      list[2].x = 1600;
      list[2].y = 800;
    });
  });
});

await step('미리보기에서 끌어 옮기기', async () => {
  const before = track(await projectState(), '텍스트·아이콘').clips[1];
  await evalApp((id) => window.__wvm.store.select(id), before.id);
  await seek(2);
  const box = await page.locator('.sel-box').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 20, { steps: 3 });
  await page.mouse.up();
  const after = track(await projectState(), '텍스트·아이콘').clips[1];
  assert.ok(after.x > before.x, `x ${before.x} → ${after.x}`);
  assert.ok(after.y < before.y, `y ${before.y} → ${after.y}`);
});

await step('모자이크·블러 추가 (이동 경로 포함)', async () => {
  await evalApp(() => window.__wvm.preview.seek(0));
  await page.locator('#tabs button[data-tab=effects]').click();
  await page.locator('.btn-row button', { hasText: '모자이크 (사각)' }).click();
  await evalApp(() => {
    const { store } = window.__wvm;
    const m = store.selected().item;
    store.mutate(() => Object.assign(m, { start: 0, duration: 3, x: 100, y: 100, w: 500, h: 400, x2: 100, y2: 100, strength: 40 }));
  });
  await page.locator('.btn-row button', { hasText: '블러 (타원)' }).click();
  await evalApp(() => {
    const { store } = window.__wvm;
    const m = store.selected().item;
    store.mutate(() => Object.assign(m, { start: 3, duration: 3, x: 1100, y: 100, w: 500, h: 400, animate: true, x2: 1300, y2: 500, strength: 25 }));
  });
  const masks = track(await projectState(), '모자이크·블러').clips;
  assert.equal(masks.length, 2);
  await seek(2);
  await shot('04-mosaic-text');
  await seek(4.5);
  await shot('05-blur');
});

await step('나레이션 파일 파싱 후 자막·SRT 처리', async () => {
  const text = fs.readFileSync(f('narration.txt'), 'utf8');
  await evalApp(async (src) => {
    const { store } = window.__wvm;
    const { parseNarration } = await import('/shared/narration.mjs');
    const { createCaption } = await import('/shared/model.mjs');
    const track = store.project.tracks.find((t) => t.role === 'narration');
    store.mutate(() => { for (const it of parseNarration(src).items) track.clips.push(createCaption(it.start, it.duration, it.text)); });
    const sub = store.project.tracks.find((t) => t.role === 'subtitle');
    store.mutate(() => { sub.clips.push(createCaption(1, 3, '한글 자막이 아주 길어도 프레임 안에서 자동으로 줄바꿈되어 표시되는지 확인하기 위한 문장입니다. 충분히 길게 씁니다.')); });
  }, text);
  await page.locator('#tabs button[data-tab=captions]').click();
  await page.locator('#tabContent select').first().selectOption('narration');
  assert.equal(await page.locator('.cap-row').count(), 2);
  assert.equal(await page.locator('.cap-row .times input').first().inputValue(), '00:00:01');
  await seek(2);
  await shot('06-captions');
});

await step('Windows 음성으로 나레이션 음성 생성', async () => {
  const voices = await evalApp(() => window.api.ttsVoices());
  console.log('  설치된 음성:', voices.map((v) => `${v.name}(${v.culture})`).join(', ') || '없음');
  if (!voices.length) return;
  const korean = voices.find((v) => v.culture === 'ko-KR') || voices[0];
  await evalApp((voice) => window.__wvm.actions.generateNarrationVoices({ voice, rate: 0 }), korean.name);
  const p = await projectState();
  const voiceClips = p.tracks.find((t) => t.role === 'voice').clips;
  assert.equal(voiceClips.length, 2);
  assert.equal(voiceClips[0].start, 1);
  assert.ok(p.media.find((m) => m.id === voiceClips[0].mediaId).duration > 0.3);
});

await step('나레이션 파일 불러오기·출력 (대화상자 경유, 음성 파일 지정 포함)', async () => {
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=f=500:d=2', '-c:a', 'libmp3lame', f('voice01.mp3')]);
  fs.writeFileSync(f('narr-import.txt'), '00:00:10 파일에서 불러온 문장\n00:00:15 - 00:00:17 <audio:voice01.mp3> 음성 지정 문장\n', 'utf8');
  const savedPath = f('narr-export.txt');
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.open] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.save });
    dialog.showMessageBox = async () => ({ response: 1 }); // 뒤에 추가
  }, { open: f('narr-import.txt'), save: savedPath });
  await page.locator('.btn-row button', { hasText: '파일 불러오기' }).click();
  await page.waitForFunction(() => {
    const { store } = window.__wvm;
    return store.project.tracks.find((t) => t.role === 'narration').clips.some((c) => c.voiceClipId && c.voice);
  }, null, { timeout: 15000 });
  const p = await projectState();
  const items = p.tracks.find((t) => t.role === 'narration').clips.sort((a, b) => a.start - b.start);
  assert.equal(items.length, 4);
  const voiced = items.find((c) => c.voice === 'voice01.mp3');
  assert.equal(voiced.start, 15);
  assert.equal(p.tracks.find((t) => t.role === 'voice').clips.find((c) => c.id === voiced.voiceClipId).start, 15);
  await page.locator('.btn-row button', { hasText: '파일로 출력' }).click();
  await page.waitForFunction(() => document.getElementById('toasts').textContent.includes('저장했습니다'));
  const written = fs.readFileSync(savedPath, 'utf8');
  assert.match(written, /00:00:01 - 00:00:0\d 첫 번째 나레이션입니다\./);
  assert.match(written, /00:00:15 - 00:00:17 <audio:voice01\.mp3> 음성 지정 문장/);
});

let projectFile;
await step('프로젝트 저장 후 다시 열기', async () => {
  projectFile = f('프로젝트.wvm');
  const before = await projectState();
  await evalApp(async (filePath) => {
    const { store } = window.__wvm;
    await window.api.saveProject({ filePath, json: JSON.stringify(store.project) });
    store.filePath = filePath;
    store.setDirty(false);
    await window.__wvm.actions.newProject();
  }, projectFile);
  assert.equal((await projectState()).media.length, 0);
  await evalApp((p) => window.__wvm.actions.openProject(p), projectFile);
  const after = await projectState();
  assert.equal(after.media.length, before.media.length);
  assert.equal(track(after, 'V1').clips.length, track(before, 'V1').clips.length);
  assert.ok(after.media[0].relPath);
  assert.equal(track(after, '텍스트·아이콘').clips[0].text, '제목을 입력하세요');
  await page.waitForFunction(() => {
    const { store } = window.__wvm;
    return store.project.media.every((m) => !m.needsProxy || store.rt(m.id).proxy);
  }, null, { timeout: 30000 });
});

await step('재생: 시간이 흐르고 멈춘다', async () => {
  await evalApp(() => window.__wvm.preview.seek(0.5));
  await page.waitForTimeout(600);
  await page.locator('#btnPlay').click();
  await page.waitForTimeout(1500);
  const t = await evalApp(() => window.__wvm.preview.time);
  assert.ok(t > 1, `재생 위치 ${t}`);
  const playingEl = await evalApp(() => [...window.__wvm.preview.slots.values()].some((s) => !s.el.paused));
  assert.ok(playingEl, '재생 중인 미디어 요소가 없음');
  await page.locator('#btnPlay').click();
  const t1 = await evalApp(() => window.__wvm.preview.time);
  await page.waitForTimeout(400);
  assert.equal(await evalApp(() => window.__wvm.preview.time), t1);
});

const output = f('결과물 출력.mp4');
await step('비디오 내보내기: 모든 효과를 반영해 파일 생성', async () => {
  await page.locator('#exportBtn').click();
  assert.ok(await page.locator('#exportDialog').evaluate((d) => d.open));
  await shot('07-export-dialog');
  await evalApp((out) => {
    window.__exportDone = window.__wvm.exportDialog.runExport({ format: 'mp4-h264', quality: 'medium', height: 1080, output: out });
  }, output);
  await page.waitForFunction(() => {
    const s = document.getElementById('exStatus').textContent;
    return s.startsWith('완료') || document.getElementById('toasts').textContent.includes('내보내기 실패');
  }, null, { timeout: 240000 });
  const failure = await page.locator('.toast.error').allTextContents();
  assert.ok(fs.existsSync(output), `출력 파일 없음: ${failure.join('\n')}`);
  await shot('08-export-done');
  await page.locator('#exClose').click();
  const info = await probe(output);
  const p = await projectState();
  const expected = await evalApp(async () => {
    const { projectDuration } = await import('/shared/model.mjs');
    return projectDuration(window.__wvm.store.project);
  });
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.duration - expected) < 0.3, `길이 ${info.duration} / 기대 ${expected}`);
  assert.ok(p.media.length >= 5);
});

await step('내보내기 중단: 작업을 멈추고 미완성 파일을 지운다', async () => {
  const partial = f('중단될 파일.mp4');
  await page.locator('#exportBtn').click();
  await evalApp((out) => { window.__wvm.exportDialog.runExport({ format: 'mp4-h265', quality: 'high', height: 1080, output: out }); }, partial);
  await page.waitForFunction(() => document.getElementById('exStatus').textContent.startsWith('렌더링 중'), null, { timeout: 60000 });
  await page.locator('#exCancel').click();
  await page.waitForFunction(() => document.getElementById('toasts').textContent.includes('중단했습니다'), null, { timeout: 15000 });
  assert.equal(fs.existsSync(partial), false);
  await page.locator('#exClose').click();
});

await step('결과물과 미리보기를 나란히 비교할 프레임 추출', async () => {
  for (const [name, t] of [['frame-2s', 2], ['frame-4.5s', 4.5], ['frame-portrait', 9], ['frame-photo', 12]]) {
    await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', output, '-frames:v', '1', '-update', '1', f(`${name}.png`)]);
  }
});

await step('미리보기 소리가 실제로 출력된다', async () => {
  const peak = await evalApp(async () => {
    const { preview, store } = window.__wvm;
    const v1 = store.project.tracks.find((t) => t.name === 'V1').clips;
    const first = v1.reduce((a, b) => (a.start < b.start ? a : b));
    preview.seek(first.start + 1.5);
    preview.play();
    await new Promise((r) => setTimeout(r, 500));
    const { el } = preview.slots.get(first.id);
    const analyser = preview.audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    el.__gain.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let max = 0;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 40));
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) max = Math.max(max, Math.abs(v));
    }
    el.__gain.disconnect(analyser);
    preview.pause();
    return max;
  });
  assert.ok(peak > 0.01, `최대 진폭 ${peak}`);
});

await step('렌더러 오류 없음', async () => {
  const real = errors.filter((e) => !e.includes('Autofill'));
  assert.deepEqual(real, []);
});

await evalApp(() => { window.__wvm.store.setDirty(false); window.api.clearAutosave(); });
await app.close();
console.log(`\n${results.filter((r) => r.startsWith('✔')).length}/${results.length} 통과`);
