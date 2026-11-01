// 내보내기: 텍스트·자막을 PNG 로 만들어 메인 프로세스에 넘기고 진행률을 표시한다.

import { ENCODERS } from '/shared/graph.mjs';
import { findMedia, itemEnd, projectDuration } from '/shared/model.mjs';
import { formatHMS } from '/shared/time.mjs';
import { blankFrame, canvasToPng, ellipseMask, rasterizeCaption, rasterizeOverlay } from './raster.js';
import { store } from './store.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

/** 렌더러에서 준비할 자산을 모두 만들어 작업 폴더로 보낸다 */
export async function prepareAssets(jobId, project, onStatus = () => {}) {
  const { width: W, height: H } = project.settings;
  const total = projectDuration(project);
  const write = async (name, canvas) => window.api.exportWriteAsset(jobId, name, await canvasToPng(canvas));
  const assets = { overlays: {}, masks: {}, paths: {}, captionEntries: {}, blankName: null };

  for (const media of project.media) {
    // 회전 정보가 있는 사진은 똑바로 세운 파일을 쓴다. 아직 준비 전이면 기다린다.
    let exportPath = store.rt(media.id).exportPath;
    if (!exportPath && media.type === 'image' && media.orientation > 1) ({ exportPath } = await window.api.derive(media));
    if (exportPath) assets.paths[media.id] = exportPath;
  }

  for (const track of project.tracks) {
    if (track.hidden) continue;
    if (track.type === 'overlay') {
      for (const item of track.clips) {
        if (item.start >= total) continue;
        const r = rasterizeOverlay(item, W, H);
        if (!r.w) continue;
        assets.overlays[item.id] = { path: await write(`ov-${item.id}.png`, r.canvas), x: r.x, y: r.y };
      }
    } else if (track.type === 'effect') {
      for (const mask of track.clips) {
        if (mask.shape !== 'ellipse') continue;
        const w = Math.min(Math.max(2, Math.round(mask.w / 2) * 2), W);
        const h = Math.min(Math.max(2, Math.round(mask.h / 2) * 2), H);
        assets.masks[mask.id] = await write(`mask-${mask.id}.png`, ellipseMask(w, h));
      }
    } else if (track.type === 'caption' && track.clips.length) {
      if (!assets.blankName) assets.blankName = 'blank.png';
      const entries = [];
      const items = track.clips.filter((c) => c.text.trim());
      let done = 0;
      for (const item of items) {
        const name = `cap-${item.id}.png`;
        await write(name, rasterizeCaption(item.text, track.style, W, H));
        entries.push({ name, start: item.start, end: itemEnd(item) });
        done += 1;
        if (done % 10 === 0) onStatus(`${track.name} 준비 중… ${done}/${items.length}`);
      }
      if (entries.length) assets.captionEntries[track.id] = entries;
    }
  }
  if (assets.blankName) await write(assets.blankName, blankFrame(W, H));
  return assets;
}

export function bindExportDialog() {
  const dialog = $('exportDialog');
  const state = { job: null, output: null };

  const resetUi = () => {
    $('exProgressWrap').hidden = true;
    $('exProgress').value = 0;
    $('exStatus').textContent = '';
    $('exReveal').hidden = true;
    $('exCancel').hidden = true;
    $('exStart').hidden = false;
    $('exClose').hidden = false;
    for (const id of ['exFormat', 'exHeight', 'exQuality']) $(id).disabled = false;
  };

  window.api.onExportProgress(({ id, progress }) => {
    if (id !== state.job) return;
    $('exProgress').value = progress;
    $('exStatus').textContent = `렌더링 중… ${(progress * 100).toFixed(1)}%`;
  });

  $('exClose').onclick = () => dialog.close();
  $('exReveal').onclick = () => window.api.reveal(state.output);
  $('exCancel').onclick = () => { if (state.job) window.api.exportCancel(state.job); };
  dialog.addEventListener('cancel', (e) => { if (state.job) e.preventDefault(); });

  $('exStart').onclick = async () => {
    const project = store.project;
    const format = $('exFormat').value;
    const output = await window.api.exportPickPath({ defaultName: project.name, ext: ENCODERS[format].ext });
    if (!output) return;
    await runExport(project, { format, quality: $('exQuality').value, height: +$('exHeight').value, output }, state);
  };

  async function runExport(project, options, st) {
    for (const id of ['exFormat', 'exHeight', 'exQuality']) $(id).disabled = true;
    $('exProgressWrap').hidden = false;
    $('exStart').hidden = true;
    $('exClose').hidden = true;
    $('exReveal').hidden = true;
    $('exCancel').hidden = false;
    $('exStatus').textContent = '준비 중…';
    const started = Date.now();
    const jobId = await window.api.exportBegin();
    st.job = jobId;
    st.output = options.output;
    try {
      const snapshot = JSON.parse(JSON.stringify(project));
      const assets = await prepareAssets(jobId, snapshot, (s) => { $('exStatus').textContent = s; });
      $('exStatus').textContent = '렌더링 시작…';
      const res = await window.api.exportStart(jobId, { project: snapshot, assets, options });
      if (res.cancelled) {
        resetUi();
        toast('내보내기를 중단했습니다.');
      } else {
        $('exProgress').value = 1;
        const secs = Math.round((Date.now() - started) / 1000);
        $('exStatus').textContent = `완료 (${secs}초 소요): ${options.output}`;
        $('exCancel').hidden = true;
        $('exClose').hidden = false;
        $('exReveal').hidden = false;
        $('exStart').hidden = false;
        for (const id of ['exFormat', 'exHeight', 'exQuality']) $(id).disabled = false;
      }
    } catch (err) {
      resetUi();
      toast(`내보내기 실패\n${String(err.message).slice(-900)}`, { error: true });
    } finally {
      st.job = null;
    }
  }

  return {
    open() {
      const { project } = store;
      const total = projectDuration(project);
      if (total <= 0) {
        toast('타임라인이 비어 있습니다. 먼저 미디어를 넣으세요.', { error: true });
        return;
      }
      const missing = project.tracks.flatMap((t) => t.clips)
        .map((c) => c.mediaId && findMedia(project, c.mediaId))
        .filter((m) => m && store.rt(m.id).missing);
      if (missing.length) {
        toast(`파일을 찾을 수 없는 미디어가 있습니다: ${[...new Set(missing.map((m) => m.name))].join(', ')}\n미디어함에서 더블클릭해 다시 연결하세요.`, { error: true });
        return;
      }
      const { width: W, height: H } = project.settings;
      const heights = [...new Set([H, 2160, 1440, 1080, 720, 480, 360])].filter((h) => h <= H).sort((a, b) => b - a);
      $('exHeight').replaceChildren(...heights.map((h) => {
        const w = Math.round((W * h) / H / 2) * 2;
        const opt = document.createElement('option');
        opt.value = h;
        opt.textContent = `${w}×${h}${h === H ? ' (프로젝트와 동일)' : ''}`;
        return opt;
      }));
      $('exInfo').textContent = `총 길이 ${formatHMS(total)} · ${project.settings.fps} fps`;
      resetUi();
      dialog.showModal();
    },
    runExport: (options) => runExport(store.project, options, state),
  };
}
