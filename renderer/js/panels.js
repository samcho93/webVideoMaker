// 왼쪽 패널: 미디어함, 텍스트, 아이콘, 자막·나레이션, 효과.

import { createIconOverlay, createMask, createShapeOverlay, createTextOverlay } from '/shared/model.mjs';
import { formatHMS } from '/shared/time.mjs';
import * as actions from './actions.js';
import { drawIconPreview, EMOJIS, ICON_NAMES } from './raster.js';
import { mediaUrl, store } from './store.js';
import { buttonRow, el, heading, selectField, timeInput, toast } from './ui.js';

let activeTab = 'media';
let captionRole = 'subtitle';
let ttsVoices = null;
let voicesLoading = false;
const tts = { voice: '', rate: 0 };

const content = () => document.getElementById('tabContent');
const size = () => store.project.settings;

function typeIcon(type) {
  return { video: '🎞', image: '🖼', audio: '🎵' }[type];
}

function renderMedia() {
  const root = content();
  const fragment = [
    buttonRow(['＋ 미디어 가져오기', actions.importDialog, '비디오·사진·음악 파일을 불러옵니다 (Ctrl+I)']),
  ];
  const { media } = store.project;
  if (!media.length) {
    fragment.push(el('div', { class: 'empty', text: '파일을 이 창으로 끌어다 놓거나\n위 버튼으로 가져오세요.\n더블클릭하면 타임라인 끝에 붙습니다.' }));
    fragment[1].style.whiteSpace = 'pre-line';
  } else {
    const grid = el('div', { class: 'media-grid' });
    for (const m of media) grid.append(mediaCard(m));
    fragment.push(grid, el('p', { class: 'hint', text: '더블클릭: 타임라인 끝에 붙이기 · 끌어다 놓기: 원하는 위치에 배치' }));
  }
  root.replaceChildren(...fragment);
}

function mediaCard(m) {
  const rt = store.rt(m.id);
  const thumb = el('div', { class: 'thumb' });
  if (rt.sprite) {
    thumb.style.backgroundImage = `url("${mediaUrl(rt.sprite)}")`;
    if (rt.spriteCount > 1) {
      thumb.style.backgroundSize = `${rt.spriteCount * 100}% 100%`;
      thumb.style.backgroundPosition = '0 0';
    }
  } else {
    thumb.textContent = typeIcon(m.type);
  }
  let sub;
  if (m.type === 'image') sub = `${m.width}×${m.height}`;
  else if (m.type === 'audio') sub = formatHMS(m.duration);
  else sub = `${m.width}×${m.height} · ${formatHMS(m.duration)}`;
  let badge = null;
  if (rt.missing) badge = '파일 없음';
  else if (rt.proxyProgress !== undefined && rt.proxyProgress !== null) badge = `변환 ${Math.round(rt.proxyProgress * 100)}%`;
  const card = el('div', {
    class: `media-card${rt.missing ? ' missing' : ''}`,
    draggable: !rt.missing,
    title: m.path,
    ondblclick: () => (rt.missing ? actions.relinkMedia(m.id) : actions.appendToTimeline(m.id)),
    ondragstart: (e) => {
      e.dataTransfer.setData(`application/x-wvm-${m.type === 'audio' ? 'audio' : 'video'}`, m.id);
      e.dataTransfer.effectAllowed = 'copy';
    },
  },
  thumb,
  el('div', { class: 'meta' }, el('div', { class: 'name', text: m.name }), el('div', { class: 'sub', text: sub })));
  if (badge) card.append(el('span', { class: 'badge', text: badge }));
  card.append(el('button', {
    class: 'remove danger',
    text: '✕',
    title: '미디어함과 타임라인에서 제거',
    onclick: (e) => { e.stopPropagation(); actions.removeMedia(m.id); },
  }));
  return card;
}

function addOverlay(item) {
  actions.addItem('overlay', item);
}

function renderText() {
  const { width: W, height: H } = size();
  const t = actions.playhead();
  const presets = [
    ['큰 제목', { text: '제목을 입력하세요', size: 130, bold: true, outlineWidth: 5, outlineColor: '#000000' }, 'font-size:20px;font-weight:800'],
    ['부제목', { text: '부제목을 입력하세요', size: 72, bold: false, y: H * 0.65 }, 'font-size:16px'],
    ['강조 박스', { text: '강조할 내용', size: 80, bgOpacity: 0.85, bgColor: '#e5484d', shadow: false }, 'background:#e5484d'],
    ['하단 설명 바', { text: '설명을 입력하세요', size: 56, y: H * 0.86, bgOpacity: 0.65, bgColor: '#000000', shadow: false }, 'background:#000'],
    ['노란 외곽선', { text: '예능 자막', size: 110, color: '#ffe14d', outlineWidth: 8, outlineColor: '#1a1a1a', y: H * 0.8 }, 'color:#ffe14d;font-weight:800;-webkit-text-stroke:.5px #000'],
  ];
  const list = el('div', { class: 'preset-list' });
  for (const [label, patch, style] of presets) {
    list.append(el('button', { text: label, style, onclick: () => addOverlay(createTextOverlay(t, W, H, patch)) }));
  }
  content().replaceChildren(
    heading('텍스트 추가'),
    list,
    el('p', { class: 'hint', text: '재생 위치에 추가됩니다. 화면에서 끌어 옮기고, 오른쪽 패널에서 글꼴·색·페이드를 바꿀 수 있습니다.' }),
  );
}

function renderIcons() {
  const { width: W, height: H } = size();
  const t = () => actions.playhead();
  const icons = el('div', { class: 'icon-grid' });
  for (const name of ICON_NAMES) {
    const canvas = el('canvas', { width: 48, height: 48 });
    drawIconPreview(canvas, name);
    icons.append(el('button', { title: name, onclick: () => addOverlay(createIconOverlay(t(), W, H, name)) }, canvas));
  }
  const emojis = el('div', { class: 'icon-grid' });
  for (const emoji of EMOJIS) {
    emojis.append(el('button', {
      text: emoji,
      onclick: () => addOverlay(createTextOverlay(t(), W, H, { text: emoji, size: 180, font: 'Segoe UI Emoji', bold: false, shadow: false })),
    }));
  }
  content().replaceChildren(
    heading('아이콘'),
    icons,
    heading('이모지'),
    emojis,
    heading('도형'),
    buttonRow(
      ['사각형', () => addOverlay(createShapeOverlay(t(), W, H, 'rect'))],
      ['타원', () => addOverlay(createShapeOverlay(t(), W, H, 'ellipse', { w: 400, h: 400 }))],
      ['테두리', () => addOverlay(createShapeOverlay(t(), W, H, 'rect', { fillOpacity: 0, strokeWidth: 10, strokeColor: '#ff3b3b' }))],
    ),
  );
}

function renderCaptionRow(track, item) {
  const row = el('div', { class: `cap-row${store.selection === item.id ? ' selected' : ''}`, onclick: (e) => {
    if (e.target.tagName === 'BUTTON') return;
    store.select(item.id);
  } });
  const moveStart = (v) => store.mutate((p) => {
    const delta = v - item.start;
    item.start = v;
    if (item.voiceClipId) {
      for (const t of p.tracks) {
        const voice = t.clips.find((c) => c.id === item.voiceClipId);
        if (voice) voice.start = Math.max(0, voice.start + delta);
      }
    }
  });
  const times = el('div', { class: 'times' },
    timeInput(() => item.start, moveStart),
    el('span', { class: 'dim', text: '~' }),
    timeInput(() => item.start + item.duration, (v) => {
      if (v <= item.start) { toast('끝 시각은 시작 시각보다 뒤여야 합니다.', { error: true }); return; }
      store.mutate(() => { item.duration = v - item.start; });
    }),
    el('button', { text: '▶', title: '이 위치로 이동', onclick: () => actions.seekTo(item.start) }),
    el('button', {
      class: 'danger',
      text: '✕',
      title: '삭제',
      onclick: () => {
        store.select(item.id);
        actions.deleteSelected();
      },
    }));
  const text = el('textarea', { value: item.text, oninput: (e) => {
    store.mutate(() => { item.text = e.target.value; }, { coalesce: `caption-${item.id}` });
  } });
  row.append(times, text);
  if (item.voiceClipId) row.append(el('div', { class: 'voice', text: item.voice ? `♪ ${item.voice}` : '♪ 음성 생성됨' }));
  return row;
}

async function loadVoices() {
  if (ttsVoices !== null || voicesLoading) return;
  voicesLoading = true;
  try {
    ttsVoices = await window.api.ttsVoices();
    const korean = ttsVoices.find((v) => v.culture === 'ko-KR');
    tts.voice = korean?.name || ttsVoices[0]?.name || '';
  } catch (err) {
    console.warn('음성 목록 실패', err);
    ttsVoices = [];
  }
  voicesLoading = false;
  if (activeTab === 'captions') renderCaptions();
}

function renderCaptions() {
  // 입력 중에는 목록을 다시 만들지 않는다 (포커스 유지)
  const root = content();
  if (root.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  loadVoices();
  const track = store.project.tracks.find((t) => t.type === 'caption' && t.role === captionRole);
  const items = [...track.clips].sort((a, b) => a.start - b.start);

  const parts = [
    selectField('편집 대상', [['subtitle', '자막'], ['narration', '나레이션']], () => captionRole, (v) => { captionRole = v; renderCaptions(); }),
    buttonRow(['＋ 재생 위치에 추가', () => actions.addCaptionAtPlayhead(captionRole)]),
  ];
  if (captionRole === 'narration') {
    parts.push(
      heading('타임스탬프 나레이션 파일 (시:분:초)'),
      buttonRow(
        ['파일 불러오기', actions.importNarrationFile, '00:00:05 내용 형식의 텍스트 파일 또는 SRT'],
        ['파일로 출력', actions.exportNarrationFile, '현재 나레이션을 시:분:초 타임스탬프 텍스트 파일로 저장'],
      ),
      heading('나레이션 음성 생성'),
    );
    if (ttsVoices?.length) {
      parts.push(
        selectField('음성', ttsVoices.map((v) => [v.name, `${v.name} (${v.culture})`]), () => tts.voice, (v) => { tts.voice = v; }),
        selectField('말하기 속도', [['-4', '느리게'], ['-2', '조금 느리게'], ['0', '보통'], ['2', '조금 빠르게'], ['4', '빠르게']], () => tts.rate, (v) => { tts.rate = +v; }),
        buttonRow(['음성 생성하여 넣기', () => actions.generateNarrationVoices(tts), '각 나레이션 문장을 음성으로 합성해 나레이션 음성 트랙에 넣습니다']),
      );
    } else {
      parts.push(el('p', { class: 'hint', text: ttsVoices === null ? '음성 목록을 확인하는 중…' : '사용 가능한 Windows 음성이 없습니다. 음성 파일을 <audio:파일명> 으로 지정하거나 오디오 트랙에 직접 넣으세요.' }));
    }
    parts.push(el('p', { class: 'hint', text: '화면에 글자를 표시하지 않으려면 타임라인의 나레이션 트랙에서 🚫 를 누르세요. 음성은 그대로 들어갑니다.' }));
  } else {
    parts.push(buttonRow(
      ['SRT 불러오기', () => actions.importSrt(captionRole)],
      ['SRT 내보내기', () => actions.exportSrt(captionRole)],
    ));
  }
  const list = el('div', { class: 'cap-list' });
  for (const item of items) list.append(renderCaptionRow(track, item));
  parts.push(list);
  if (!items.length) parts.push(el('div', { class: 'empty', text: '아직 항목이 없습니다.' }));
  root.replaceChildren(...parts);
}

function renderEffects() {
  const { width: W, height: H } = size();
  const add = (effect, shape) => () => actions.addItem('effect', createMask(actions.playhead(), W, H, effect, shape));
  content().replaceChildren(
    heading('모자이크·블러'),
    buttonRow(['모자이크 (사각)', add('mosaic', 'rect')], ['모자이크 (타원)', add('mosaic', 'ellipse')]),
    buttonRow(['블러 (사각)', add('blur', 'rect')], ['블러 (타원)', add('blur', 'ellipse')]),
    el('p', { class: 'hint', text: '재생 위치부터 5초 동안 적용됩니다. 미리보기 화면에서 영역을 끌어 옮기고 모서리로 크기를 조절하세요. 움직이는 대상은 오른쪽 패널의 "이동 경로"를 켜면 따라갑니다.' }),
    heading('빠른 페이드'),
    buttonRow(
      ['페이드 인 1초', () => quickFade('fadeIn')],
      ['페이드 아웃 1초', () => quickFade('fadeOut')],
    ),
    el('p', { class: 'hint', text: '선택한 클립·텍스트에 적용됩니다. 오른쪽 패널에서 길이를 조절할 수 있습니다.' }),
    heading('구간 빨리 감기'),
    el('p', { class: 'hint', text: '1. 클립을 선택합니다.\n2. 재생 위치를 옮기며 I, O 키로 구간을 지정합니다.\n3. 타임라인 도구 모음에서 속도를 고르고 "구간 속도 적용"을 누릅니다.', style: 'white-space:pre-line' }),
    heading('해상도·방향 일괄 맞춤'),
    buttonRow(
      ['전체 맞춤', () => actions.fitAll('contain'), '여백을 두고 프레임 안에 맞춤'],
      ['꽉 채우기', () => actions.fitAll('cover'), '프레임을 가득 채우고 넘치는 부분은 잘림'],
      ['블러 배경', () => actions.fitAll('blur'), '여백을 흐린 영상으로 채움'],
    ),
  );
}

function quickFade(key) {
  const sel = store.selected();
  if (!sel || sel.track.type === 'effect' || sel.track.type === 'caption') {
    toast('페이드를 적용할 클립이나 텍스트를 먼저 선택하세요.', { error: true });
    return;
  }
  store.mutate(() => { sel.item[key] = 1; });
  store.emit('selection');
}

const RENDERERS = { media: renderMedia, text: renderText, icons: renderIcons, captions: renderCaptions, effects: renderEffects };

export function renderPanel() {
  RENDERERS[activeTab]();
}

export function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderPanel();
}

export function bindPanels() {
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  store.on('project', () => { if (activeTab === 'media' || activeTab === 'captions') renderPanel(); });
  store.on('media', () => { if (activeTab === 'media') renderPanel(); });
  store.on('selection', () => { if (activeTab === 'captions') renderPanel(); });
  window.api.onProxyProgress(({ mediaId, progress }) => {
    if (store.rt(mediaId).proxyProgress !== null) store.setRuntime(mediaId, { proxyProgress: progress });
  });
  renderPanel();
}
