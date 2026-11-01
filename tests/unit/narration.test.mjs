import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNarration, parseSrt, serializeNarration, serializeSrt } from '../../shared/narration.mjs';
import { formatFrames, formatHMS, formatPrecise, parseTime } from '../../shared/time.mjs';

test('시:분:초 변환', () => {
  assert.equal(formatHMS(3725), '01:02:05');
  assert.equal(formatPrecise(5.25), '00:00:05.250');
  assert.equal(formatPrecise(5), '00:00:05');
  assert.equal(formatFrames(1.5, 30), '00:00:01:15');
  assert.equal(parseTime('01:02:05'), 3725);
  assert.equal(parseTime('02:05'), 125);
  assert.equal(parseTime('00:00:05,500'), 5.5);
  assert.equal(parseTime('00:61:00'), null);
  assert.equal(parseTime('abc'), null);
});

test('나레이션 파일 파싱', () => {
  const { items, errors } = parseNarration(`﻿# 주석
머리말 줄
00:00:05 안녕하세요.
둘째 줄입니다.
00:00:12 - 00:00:18 끝 시각 지정
[00:00:20] <audio:voice 01.mp3> 음성 지정
00:01:00.5 ~ 00:01:03 소수 초
`);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
  assert.equal(items.length, 4);
  assert.deepEqual(
    { start: items[0].start, text: items[0].text },
    { start: 5, text: '안녕하세요.\n둘째 줄입니다.' }
  );
  assert.equal(items[1].duration, 6);
  assert.equal(items[2].voice, 'voice 01.mp3');
  assert.equal(items[2].text, '음성 지정');
  assert.equal(items[3].start, 60.5);
  assert.equal(items[3].duration, 2.5);
});

test('끝 시각이 없으면 다음 항목 전까지로 제한', () => {
  const { items } = parseNarration('00:00:01 아주 길고 길고 길고 길고 길고 길고 길고 긴 나레이션 문장입니다\n00:00:03 다음');
  assert.equal(items[0].duration, 2);
});

test('나레이션 왕복 변환', () => {
  const source = [
    { start: 5, duration: 3, text: '첫째\n둘째', voice: null },
    { start: 62, duration: 4, text: '셋째', voice: 'v.mp3' },
  ];
  const text = serializeNarration(source);
  assert.match(text, /00:00:05 - 00:00:08 첫째/);
  assert.match(text, /00:01:02 - 00:01:06 <audio:v\.mp3> 셋째/);
  const { items, errors } = parseNarration(text);
  assert.equal(errors.length, 0);
  assert.deepEqual(items, source);
});

test('SRT 왕복 변환', () => {
  const source = [{ start: 1.5, duration: 2, text: '자막 <b>하나</b>', voice: null }];
  const parsed = parseSrt(serializeSrt(source));
  assert.deepEqual(parsed, [{ start: 1.5, duration: 2, text: '자막 하나', voice: null }]);
});
