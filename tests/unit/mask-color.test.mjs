import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExportPlan } from '../../shared/graph.mjs';
import {
  colorCurveValue, colorMatrix, isColorNeutral, maskPositionAt, setMaskKeyframe, splitMaskKeyframes, trimMaskStart,
} from '../../shared/layout.mjs';
import { createMask, createMediaClip, createProject, normalizeProject } from '../../shared/model.mjs';

const video = { id: 'm1', type: 'video', path: 'a.mp4', width: 1920, height: 1080, duration: 10, hasAudio: false };
const maskAt = (start = 2) => ({ ...createMask(start, 1920, 1080), x: 100, y: 50, duration: 10 });

test('마스크를 처음 옮기면 시작 위치와 새 위치가 기록된다', () => {
  const m = maskAt();
  setMaskKeyframe(m, 4, 500, 250);
  assert.deepEqual(m.keyframes, [{ t: 0, x: 100, y: 50 }, { t: 4, x: 500, y: 250 }]);
  assert.deepEqual(maskPositionAt(m, 2), { x: 100, y: 50 });
  assert.deepEqual(maskPositionAt(m, 4), { x: 300, y: 150 });
  assert.deepEqual(maskPositionAt(m, 6), { x: 500, y: 250 });
  assert.deepEqual(maskPositionAt(m, 11), { x: 500, y: 250 }, '마지막 기록 뒤에는 그 자리에 머문다');
});

test('같은 시각에 다시 옮기면 기록을 덮어쓰고, 중간 기록은 순서대로 끼어든다', () => {
  const m = maskAt();
  setMaskKeyframe(m, 4, 500, 250);
  setMaskKeyframe(m, 4.01, 600, 250);
  assert.equal(m.keyframes.length, 2);
  assert.equal(m.keyframes[1].x, 600);
  setMaskKeyframe(m, 2, 900, 900);
  assert.deepEqual(m.keyframes.map((k) => k.t), [0, 2, 4]);
  assert.deepEqual(maskPositionAt(m, 4), { x: 900, y: 900 });
});

test('바로 이동 방식은 다음 기록 전까지 제자리에 있다', () => {
  const m = { ...maskAt(), motion: 'hold' };
  setMaskKeyframe(m, 4, 500, 250);
  assert.deepEqual(maskPositionAt(m, 5.99), { x: 100, y: 50 });
  assert.deepEqual(maskPositionAt(m, 6), { x: 500, y: 250 });
});

test('앞을 잘라도 남은 구간의 위치는 그대로다', () => {
  const m = maskAt();
  setMaskKeyframe(m, 4, 500, 250);
  const before = maskPositionAt(m, 5);
  trimMaskStart(m, 1);
  m.start = 3;
  assert.deepEqual(maskPositionAt(m, 5), before);
  assert.equal(m.keyframes[0].t, 0);
  const longer = maskAt();
  setMaskKeyframe(longer, 4, 500, 250);
  trimMaskStart(longer, -1);
  longer.start = 1;
  assert.deepEqual(maskPositionAt(longer, 6), { x: 500, y: 250 });
  assert.deepEqual(maskPositionAt(longer, 1), { x: 100, y: 50 });
});

test('나눈 앞뒤 조각이 나눈 지점에서 이어진다', () => {
  const head = maskAt();
  setMaskKeyframe(head, 4, 500, 250);
  setMaskKeyframe(head, 8, 900, 250);
  const before = [3, 5, 7, 9].map((t) => maskPositionAt(head, t));
  const tail = JSON.parse(JSON.stringify(head));
  splitMaskKeyframes(head, tail, 3);
  tail.start = 5;
  assert.deepEqual([maskPositionAt(head, 3), maskPositionAt(tail, 5), maskPositionAt(tail, 7), maskPositionAt(tail, 9)], before);
});

test('예전 프로젝트의 시작·끝 이동을 위치 기록으로 옮긴다', () => {
  const raw = createProject();
  raw.tracks.find((t) => t.type === 'effect').clips.push({ id: 'a', start: 1, duration: 4, x: 0, y: 0, w: 10, h: 10, animate: true, x2: 400, y2: 100 });
  raw.tracks.find((t) => t.type === 'effect').clips.push({ id: 'b', start: 1, duration: 4, x: 7, y: 8, w: 10, h: 10, animate: false, x2: 7, y2: 8 });
  const [moving, fixed] = normalizeProject(raw).tracks.find((t) => t.type === 'effect').clips;
  assert.deepEqual(maskPositionAt(moving, 3), { x: 200, y: 50 });
  assert.equal('animate' in moving, false);
  assert.deepEqual(fixed.keyframes, []);
  assert.deepEqual(maskPositionAt(fixed, 3), { x: 7, y: 8 });
});

test('위치 기록이 여러 개면 구간별 시간식을 만든다', () => {
  const p = createProject();
  p.media.push(video);
  p.tracks.find((t) => t.name === 'V1').clips.push(createMediaClip(video, 0));
  const m = maskAt(1);
  setMaskKeyframe(m, 2, 300, 50);
  setMaskKeyframe(m, 6, 300, 700);
  p.tracks.find((t) => t.type === 'effect').clips.push(m);
  const { filter } = buildExportPlan(p);
  assert.match(filter, /if\(lt\(t,3\),100\+\(200\)\*\(t-1\)\/2,if\(lt\(t,7\),300\+\(0\)\*\(t-3\)\/4,300\)\)/);
  m.motion = 'hold';
  assert.match(buildExportPlan(p).filter, /if\(lt\(t,3\),100,if\(lt\(t,7\),300,300\)\)/);
});

test('영상 조절 기본값은 변화가 없고 필터도 넣지 않는다', () => {
  const clip = createMediaClip(video, 0);
  assert.equal(isColorNeutral(clip), true);
  for (const ch of ['r', 'g', 'b']) for (const v of [0, 0.3, 1]) assert.ok(Math.abs(colorCurveValue(clip, ch, v) - v) < 1e-9);
  colorMatrix(clip).forEach((v, i) => assert.ok(Math.abs(v - ([0, 4, 8].includes(i) ? 1 : 0)) < 1e-3));
  const p = createProject();
  p.media.push(video);
  p.tracks.find((t) => t.name === 'V1').clips.push(clip);
  assert.doesNotMatch(buildExportPlan(p).filter, /lutrgb|colorchannelmixer|convolution/);
});

test('예전 프로젝트처럼 새 항목이 없어도 동작한다', () => {
  const old = { brightness: 0.2, contrast: 0, saturation: 0 };
  assert.equal(isColorNeutral(old), false);
  assert.ok(colorCurveValue(old, 'r', 0.5) > 0.5);
});

test('조절 항목별로 값이 올바른 방향으로 바뀐다', () => {
  assert.ok(colorCurveValue({ brightness: 0.4 }, 'g', 0.3) > 0.3);
  assert.ok(colorCurveValue({ gamma: 2 }, 'g', 0.3) > 0.3);
  assert.ok(colorCurveValue({ contrast: 0.5 }, 'g', 0.2) < 0.2);
  assert.ok(colorCurveValue({ temperature: 1 }, 'r', 0.5) > 0.5);
  assert.ok(colorCurveValue({ temperature: 1 }, 'b', 0.5) < 0.5);
  const gray = colorMatrix({ saturation: -1 });
  assert.ok(Math.abs(gray[0] - gray[3]) < 1e-6, '채도 0 이면 흑백');
});
