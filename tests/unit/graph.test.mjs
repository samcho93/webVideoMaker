import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCaptionConcat, buildExportPlan } from '../../shared/graph.mjs';
import { createMask, createMediaClip, createProject, itemDuration, projectDuration } from '../../shared/model.mjs';

const video = { id: 'm1', path: 'C:/a.mp4', type: 'video', width: 1280, height: 720, duration: 20, hasAudio: true };
const music = { id: 'm2', path: 'C:/b.mp3', type: 'audio', duration: 60, hasAudio: true };

function setup() {
  const project = createProject();
  project.media.push(video, music);
  return project;
}
const track = (p, name) => p.tracks.find((t) => t.name === name);

test('빈 타임라인은 내보낼 수 없다', () => {
  assert.throws(() => buildExportPlan(createProject()), /내보낼 내용/);
});

test('속도 변경은 길이·setpts·atempo 에 반영된다', () => {
  const p = setup();
  const clip = { ...createMediaClip(video, 0), in: 2, out: 10, speed: 4 };
  track(p, 'V1').clips.push(clip);
  assert.equal(itemDuration(clip), 2);
  assert.equal(projectDuration(p), 2);
  const plan = buildExportPlan(p);
  assert.match(plan.filter, /setpts=\(PTS-STARTPTS\)\/4/);
  assert.match(plan.filter, /atempo=2,atempo=2/);
  assert.deepEqual(plan.inputArgs.slice(0, 5), ['-ss', '2', '-t', '8', '-i']);
});

test('페이드는 영상 알파와 오디오에 모두 적용된다', () => {
  const p = setup();
  track(p, 'V1').clips.push({ ...createMediaClip(video, 0), fadeIn: 1, fadeOut: 2 });
  const { filter } = buildExportPlan(p);
  assert.match(filter, /fade=t=in:st=0:d=1:alpha=1/);
  assert.match(filter, /fade=t=out:st=18:d=2:alpha=1/);
  assert.match(filter, /afade=t=in:st=0:d=1/);
  assert.match(filter, /afade=t=out:st=18:d=2/);
});

test('음악은 타임라인 위치만큼 지연되고 믹스된다', () => {
  const p = setup();
  track(p, 'V1').clips.push(createMediaClip(video, 0));
  track(p, '음악').clips.push({ ...createMediaClip(music, 3), out: 10, volume: 0.5 });
  const { filter } = buildExportPlan(p);
  assert.match(filter, /adelay=delays=3000:all=1/);
  assert.match(filter, /volume=0.5/);
  assert.match(filter, /amix=inputs=3:duration=first:normalize=0/);
});

test('음소거 트랙과 숨긴 트랙은 제외된다', () => {
  const p = setup();
  track(p, 'V1').clips.push(createMediaClip(video, 0));
  track(p, '음악').clips.push(createMediaClip(music, 0));
  track(p, '음악').muted = true;
  const plan = buildExportPlan(p);
  assert.equal(plan.inputCount, 1);
  track(p, '음악').muted = false;
  track(p, 'V1').hidden = true;
  const hidden = buildExportPlan(p);
  assert.doesNotMatch(hidden.filter, /fps=30/);
});

test('이동 모자이크는 시간식을 쓴다', () => {
  const p = setup();
  track(p, 'V1').clips.push(createMediaClip(video, 0));
  const mask = { ...createMask(1, 1920, 1080, 'mosaic'), animate: true, x: 0, y: 0, x2: 400, y2: 0 };
  track(p, '모자이크·블러').clips.push(mask);
  const { filter } = buildExportPlan(p);
  assert.match(filter, /flags=neighbor/);
  assert.match(filter, /\(400\)\*min\(max\(\(t-1\)\/5,0\),1\)/);
  assert.match(filter, /between\(t,1,6\)/);
});

test('형식별 인코더 인자', () => {
  const p = setup();
  track(p, 'V1').clips.push(createMediaClip(video, 0));
  assert.ok(buildExportPlan(p, {}, { format: 'webm' }).outputArgs.includes('libvpx-vp9'));
  const gif = buildExportPlan(p, {}, { format: 'gif' });
  assert.ok(!gif.outputArgs.includes('[aout]'));
  assert.match(gif.filter, /palettegen/);
  assert.match(buildExportPlan(p, {}, { height: 720 }).filter, /scale=1280:720/);
});

test('자막 ffconcat 은 빈 구간을 채우고 겹침을 잘라낸다', () => {
  const body = buildCaptionConcat(
    [{ name: 'a.png', start: 1, end: 3 }, { name: 'b.png', start: 2.5, end: 4 }, { name: "c'.png", start: 90, end: 99 }],
    'blank.png',
    10
  );
  assert.equal(body, `ffconcat version 1.0
file 'blank.png'
duration 1
file 'a.png'
duration 1.5
file 'b.png'
duration 1.5
file 'blank.png'
duration 6
file 'blank.png'
`);
});
