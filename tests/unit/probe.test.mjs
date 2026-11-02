import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueue, describeProbeFailure, parseFfmpegInfo } from '../../main/ffmpeg.mjs';

const OUTPUT = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:\\clips\\a.mp4':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 25 kb/s
  Stream #0:0[0x1](und): Video: av1 (libdav1d) (Main) (av01 / 0x31307661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 20 kb/s, 29.97 fps, 30 tbr, 30k tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 2 kb/s (default)
  Stream #0:2: Video: mjpeg (Baseline), yuvj420p(pc), 320x240, 90k tbr, 90k tbn (attached pic)
At least one output file must be specified`;

test('ffmpeg 출력을 ffprobe 와 같은 모양으로 읽는다', () => {
  const info = parseFfmpegInfo(OUTPUT);
  assert.equal(info.format.duration, 62.5);
  assert.equal(info.streams.length, 3);
  const [video, audio, cover] = info.streams;
  assert.equal(video.codec_name, 'av1');
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.deepEqual([video.width, video.height], [1920, 1080]);
  assert.equal(video.avg_frame_rate, '29.97');
  assert.equal(video.field_order, 'progressive');
  assert.equal(video.side_data_list[0].rotation, -90);
  assert.equal(video.disposition.attached_pic, 0);
  assert.equal(audio.codec_name, 'aac');
  assert.equal(cover.disposition.attached_pic, 1);
});

test('비월주사 영상을 알아본다', () => {
  const [video] = parseFfmpegInfo('  Stream #0:0: Video: h264 (High), yuv420p(top first), 1920x1080, 29.97 fps').streams;
  assert.equal(video.field_order, 'tt');
});

test('스트림이 없으면 빈 목록을 돌려준다', () => {
  assert.deepEqual(parseFfmpegInfo('C:\\a.mp4: Invalid data found when processing input').streams, []);
});

test('실패 원인을 알아듣기 쉬운 말로 바꾼다', () => {
  assert.match(describeProbeFailure('[mov] moov atom not found\nInvalid data found'), /완전히 저장되지/);
  assert.match(describeProbeFailure('a.mp4: Permission denied'), /다른 프로그램/);
  assert.match(describeProbeFailure('a.mp4: No such file or directory'), /찾을 수 없습니다/);
  assert.match(describeProbeFailure('a.xyz: Invalid data found when processing input'), /손상되었거나/);
});

test('동시 실행 수를 제한하고 실패해도 다음 작업을 이어 간다', async () => {
  const slots = createQueue(2);
  let active = 0;
  let peak = 0;
  const task = (fail) => slots(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => { setTimeout(r, 10); });
    active -= 1;
    if (fail) throw new Error('x');
    return 'ok';
  });
  const results = await Promise.allSettled([task(), task(true), task(), task(), task()]);
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
});
