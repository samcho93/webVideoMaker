import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeClipLayout, fadeFactor, maskPositionAt } from '../../shared/layout.mjs';

const clip = (patch) => ({ fit: 'contain', scale: 1, posX: 0, posY: 0, rotation: 0, crop: { l: 0, t: 0, r: 0, b: 0 }, ...patch });

test('세로 영상은 가로 프레임에 필러박스로 맞춘다', () => {
  const L = computeClipLayout(clip(), { width: 1080, height: 1920 }, 1920, 1080);
  assert.equal(Math.round(L.dh), 1080);
  assert.equal(Math.round(L.dw), 608);
  assert.equal(L.cx, 960);
});

test('90도 회전하면 경계 상자 기준으로 맞춘다', () => {
  const L = computeClipLayout(clip({ rotation: 90 }), { width: 1080, height: 1920 }, 1920, 1080);
  assert.equal(Math.round(L.bboxW), 1920);
  assert.equal(Math.round(L.bboxH), 1080);
  assert.equal(Math.round(L.dw), 1080);
  assert.equal(Math.round(L.dh), 1920);
});

test('cover 는 프레임을 가득 채운다', () => {
  const L = computeClipLayout(clip({ fit: 'cover' }), { width: 1080, height: 1920 }, 1920, 1080);
  assert.equal(Math.round(L.dw), 1920);
  assert.ok(L.dh > 1080);
});

test('크롭은 원본 영역과 비율에 반영된다', () => {
  const L = computeClipLayout(clip({ crop: { l: 0.25, t: 0, r: 0.25, b: 0 } }), { width: 1000, height: 1000 }, 1000, 1000);
  assert.equal(L.sx, 250);
  assert.equal(L.sw, 500);
  assert.equal(Math.round(L.dh), 1000);
});

test('페이드 배율', () => {
  assert.equal(fadeFactor(0.5, 10, 1, 1), 0.5);
  assert.equal(fadeFactor(5, 10, 1, 1), 1);
  assert.equal(fadeFactor(9.5, 10, 1, 1), 0.5);
});

test('이동 마스크 위치 보간', () => {
  const mask = { animate: true, start: 2, duration: 4, x: 0, y: 100, x2: 100, y2: 100 };
  assert.deepEqual(maskPositionAt(mask, 4), { x: 50, y: 100 });
  assert.deepEqual(maskPositionAt(mask, 99), { x: 100, y: 100 });
});
