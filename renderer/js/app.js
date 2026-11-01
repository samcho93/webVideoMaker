// 진입점: 모듈 연결, 메뉴·단축키, 파일 끌어다 놓기, 자동 저장.

import * as actions from './actions.js';
import { bindExportDialog, prepareAssets } from './exportDialog.js';
import { bindPanels, setTab } from './panels.js';
import { attachStageInteractions, bindTransport, Preview } from './preview.js';
import { bindProperties } from './properties.js';
import { store } from './store.js';
import { Timeline } from './timeline.js';
import { loadSystemFonts, toast } from './ui.js';

const AUTOSAVE_MS = 30000;

const preview = new Preview(document.getElementById('preview'));
actions.setPreview(preview);
const transport = bindTransport(preview);
attachStageInteractions(preview);
const timeline = new Timeline(preview);
const exportDialog = bindExportDialog();
transport.onTime((t) => timeline.updatePlayhead(t));

store.on('project', () => timeline.render());
store.on('selection', () => {
  document.querySelectorAll('.clip.selected').forEach((n) => n.classList.remove('selected'));
  if (store.selection) document.querySelector(`.clip[data-item-id="${store.selection}"]`)?.classList.add('selected');
});
store.on('media', () => timeline.render());
store.on('range', () => timeline.updateRange());
store.on('title', (name) => { document.getElementById('projectName').textContent = name; });

bindPanels();
bindProperties();
store.setDirty(false);

function setRange(key, value) {
  store.range[key] = value;
  const { in: a, out: b } = store.range;
  if (a !== null && b !== null && b < a) store.range = { in: b, out: a };
  store.emit('range');
}

function editable(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

const commands = {
  new: actions.newProject,
  open: () => actions.openProject(),
  save: () => actions.saveProject(),
  saveAs: () => actions.saveProject({ saveAs: true }),
  import: actions.importDialog,
  export: () => exportDialog.open(),
  undo: () => {
    if (editable(document.activeElement)) document.execCommand('undo');
    else store.undo();
  },
  redo: () => {
    if (editable(document.activeElement)) document.execCommand('redo');
    else store.redo();
  },
  shortcuts: () => {
    store.select(null);
    toast('오른쪽 프로젝트 설정 패널 아래에서 단축키를 확인할 수 있습니다.');
  },
};

window.api.onMenu((cmd) => commands[cmd]?.());
window.api.onOpenPath((path) => actions.openProject(path));
document.querySelectorAll('[data-cmd]').forEach((b) => { b.onclick = () => commands[b.dataset.cmd](); });

// 타임라인 도구 모음
const on = (id, fn) => { document.getElementById(id).onclick = fn; };
on('tlSplit', actions.splitAtPlayhead);
on('tlDelete', () => actions.deleteSelected());
on('tlRipple', () => actions.deleteSelected({ ripple: true }));
on('tlCrossfade', () => actions.crossfade(1));
on('tlIn', () => setRange('in', preview.time));
on('tlOut', () => setRange('out', preview.time));
on('tlClear', () => { store.range = { in: null, out: null }; store.emit('range'); });
on('tlCutRange', actions.cutRange);
on('tlApplySpeed', () => actions.applySpeedToRange(+document.getElementById('tlSpeed').value));

window.addEventListener('keydown', (e) => {
  if (editable(e.target) || document.getElementById('exportDialog').open) return;
  const fps = store.project.settings.fps;
  const step = e.shiftKey ? 1 : 1 / fps;
  const ctrl = e.ctrlKey || e.metaKey;
  switch (e.code) {
    case 'Space': preview.toggle(); break;
    case 'ArrowLeft': preview.seek(preview.time - step); break;
    case 'ArrowRight': preview.seek(preview.time + step); break;
    case 'Home': preview.seek(0); break;
    case 'End': preview.seek(preview.duration); break;
    case 'KeyS': if (!ctrl) actions.splitAtPlayhead(); else return; break;
    case 'KeyI': if (!ctrl) setRange('in', preview.time); else return; break;
    case 'KeyO': if (!ctrl) setRange('out', preview.time); else return; break;
    case 'Delete':
    case 'Backspace': actions.deleteSelected({ ripple: e.shiftKey }); break;
    case 'KeyC': if (ctrl) actions.copySelected(); else return; break;
    case 'KeyV': if (ctrl) actions.pasteClipboard(); else return; break;
    case 'Escape': store.select(null); break;
    default: return;
  }
  e.preventDefault();
});

// 버튼 포커스가 Space 입력을 가로채지 않게 한다
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
});

// 탐색기에서 파일 끌어다 놓기
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
  const project = files.find((p) => p.toLowerCase().endsWith('.wvm'));
  if (project) {
    actions.openProject(project);
    return;
  }
  setTab('media');
  await actions.importPaths(files);
});

// 자동 저장과 복구
setInterval(() => {
  if (store.dirty) window.api.writeAutosave(JSON.stringify(store.project));
}, AUTOSAVE_MS);

async function offerRecovery() {
  const json = await window.api.readAutosave();
  if (!json) return;
  const choice = await window.api.confirm({
    message: '지난번에 저장하지 못한 작업이 남아 있습니다. 복구할까요?',
    buttons: ['복구', '버리기'],
  });
  if (choice === 0) {
    await actions.loadProjectJson(json, null);
    store.setDirty(true);
  } else {
    window.api.clearAutosave();
  }
}

loadSystemFonts();
offerRecovery();

// 자동화 테스트와 개발자 도구용
window.__wvm = { store, preview, timeline, actions, exportDialog, prepareAssets };
