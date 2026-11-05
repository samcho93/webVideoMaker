import {
  app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, net, protocol, session, shell, utilityProcess,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makePeaks, makePoster, makeProxy, makeSprite, normalizedImage, probe, setCacheDir } from './ffmpeg.mjs';
import { beginJob, cancelJob, runJob, writeAsset } from './exporter.mjs';
import { listVoices, synthesize } from './tts.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_FILTER = [{ name: 'WebVideoMaker 프로젝트', extensions: ['wvm'] }];
const MEDIA_EXTENSIONS = [
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'vob', 'ts', 'mts', 'm2ts', 'mxf', '3gp', '3g2', 'ogv',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'tga', 'avif', 'heic', 'heif',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aif', 'aiff', 'ac3', 'amr',
];
const MEDIA_FILTER = [
  { name: '미디어 파일', extensions: MEDIA_EXTENSIONS },
  { name: '모든 파일', extensions: ['*'] },
];
const MAX_FOLDER_FILES = 500;
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

let win = null;
let dirty = false;
let pendingOpen = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => a.toLowerCase().endsWith('.wvm')) || null;

// media:// 로는 사용자가 불러온 파일과 앱 캐시만 제공한다.
const allowed = new Set();
const allow = (p) => { allowed.add(path.normalize(p).toLowerCase()); return p; };
const isAllowed = (p) => {
  const norm = path.normalize(p).toLowerCase();
  return allowed.has(norm) || norm.startsWith(`${path.normalize(cacheDir()).toLowerCase()}${path.sep}`);
};
const cacheDir = () => path.join(app.getPath('userData'), 'cache');
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.wvm');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function serveApp(request) {
  const { pathname } = new URL(request.url);
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const base = rel.startsWith('shared/') ? ROOT : path.join(ROOT, 'renderer');
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(path.join(ROOT, path.sep))) return new Response('Forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

async function serveMedia(request) {
  const { pathname } = new URL(request.url);
  const file = decodeURIComponent(pathname.slice(1));
  const stat = isAllowed(file) ? await fs.promises.stat(file).catch(() => null) : null;
  if (!stat) return new Response('Not found', { status: 404 });
  const { size } = stat;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  if (size === 0) return new Response(null, { status: 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status, headers });
}

function buildMenu() {
  const send = (cmd) => () => win?.webContents.send('menu', cmd);
  const template = [
    {
      label: '파일',
      submenu: [
        { label: '새 프로젝트', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: '프로젝트 열기…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: '다른 이름으로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: '미디어 가져오기…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { label: '비디오 내보내기…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        { role: 'quit', label: '끝내기' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: '다시 실행', accelerator: 'CmdOrCtrl+Y', click: send('redo') },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로 고침' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
      ],
    },
    {
      label: '도움말',
      submenu: [{ label: '단축키 보기', click: send('shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let mpvHost = null;

const libmpvPath = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'libmpv', 'libmpv-2.dll')
  : path.join(ROOT, 'vendor', 'libmpv', 'libmpv-2.dll'));

/** libmpv 재생 프로세스를 띄워 렌더러와 직접 연결한다. 문제가 생겨도 앱은 변환 방식으로 계속 동작한다 */
function startMpvHost() {
  mpvHost?.kill();
  mpvHost = null;
  const dll = libmpvPath();
  if (!fs.existsSync(dll)) {
    win?.webContents.send('mpv:down');
    return;
  }
  const env = { ...process.env, WVM_LIBMPV: dll };
  if (process.env.WVM_E2E) env.WVM_MPV_NO_AUDIO = '1';
  const host = utilityProcess.fork(path.join(ROOT, 'main', 'mpvHost.cjs'), [], { env, serviceName: 'WebVideoMaker libmpv' });
  mpvHost = host;
  const { port1, port2 } = new MessageChannelMain();
  host.postMessage({}, [port1]);
  win?.webContents.postMessage('mpv:port', null, [port2]);
  host.on('exit', () => {
    if (mpvHost === host) {
      mpvHost = null;
      win?.webContents.send('mpv:down');
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#14161b',
    title: 'WebVideoMaker',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://local/index.html');
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => {
    startMpvHost();
    if (pendingOpen) {
      win.webContents.send('project:openPath', pendingOpen);
      pendingOpen = null;
    }
  });
  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['저장하지 않고 닫기', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: 'WebVideoMaker',
      message: '저장하지 않은 변경 사항이 있습니다. 닫을까요?',
    });
    if (choice === 1) e.preventDefault();
    else fs.rmSync(autosavePath(), { force: true });
  });
  win.on('closed', () => {
    win = null;
    mpvHost?.kill();
    mpvHost = null;
  });
}

async function deriveAndAllow(fn) {
  const file = await fn();
  allow(file);
  return file;
}

/** 끌어다 놓은 폴더를 그 안의 미디어 파일 목록으로 펼친다 */
async function expandPaths(paths) {
  const extensions = new Set(MEDIA_EXTENSIONS.map((e) => `.${e}`));
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (files.length >= MAX_FOLDER_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  for (const p of paths) {
    const stat = await fs.promises.stat(p).catch(() => null);
    if (stat?.isDirectory()) await walk(p);
    else files.push(p);
  }
  return files;
}

async function uprightSource(info) {
  if (info.type === 'image' && info.orientation > 1) return deriveAndAllow(() => normalizedImage(info.path, info.orientation));
  return null;
}

function registerIpc() {
  ipcMain.handle('media:pick', async () => {
    const res = await dialog.showOpenDialog(win, { title: '미디어 가져오기', filters: MEDIA_FILTER, properties: ['openFile', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('media:allow', (_e, paths) => { paths.forEach(allow); });
  ipcMain.handle('media:probe', async (_e, paths) => Promise.all(paths.map(async (p) => {
    try {
      const info = await probe(p);
      allow(p);
      return { ok: true, info };
    } catch (err) {
      return { ok: false, path: p, error: err.message };
    }
  })));
  // 미리보기·내보내기에 쓸 정규화 이미지와 썸네일
  ipcMain.handle('media:expand', (_e, paths) => expandPaths(paths));
  ipcMain.handle('media:poster', async (_e, info) => {
    const exportPath = await uprightSource(info);
    if (info.type === 'audio') return { exportPath, poster: null };
    return { exportPath, poster: allow(await makePoster(info, exportPath || info.path)) };
  });
  ipcMain.handle('media:derive', async (_e, info) => {
    const exportPath = await uprightSource(info);
    const result = { exportPath, sprite: null, spriteCount: 0 };
    if (info.type !== 'audio') {
      const { file, count } = await makeSprite(info, exportPath || info.path);
      result.sprite = allow(file);
      result.spriteCount = count;
    }
    return result;
  });
  ipcMain.handle('media:peaks', async (_e, info) => (info.hasAudio ? makePeaks(info) : null));
  ipcMain.handle('media:proxy', (_e, mediaId, info, options) => deriveAndAllow(() => makeProxy(info, (progress) => {
    win?.webContents.send('proxy:progress', { mediaId, progress });
  }, options)));

  ipcMain.handle('project:save', async (_e, { filePath, json, name }) => {
    let target = filePath;
    if (!target) {
      const res = await dialog.showSaveDialog(win, { title: '프로젝트 저장', defaultPath: `${name || '프로젝트'}.wvm`, filters: PROJECT_FILTER });
      if (res.canceled) return null;
      target = res.filePath;
    }
    // 프로젝트와 미디어를 함께 옮겨도 찾을 수 있도록 상대 경로를 같이 기록한다
    const data = JSON.parse(json);
    for (const media of data.media || []) media.relPath = path.relative(path.dirname(target), media.path);
    fs.writeFileSync(target, JSON.stringify(data, null, 1), 'utf8');
    return target;
  });
  ipcMain.handle('project:open', async (_e, filePath) => {
    let target = filePath;
    if (!target) {
      const res = await dialog.showOpenDialog(win, { title: '프로젝트 열기', filters: PROJECT_FILTER, properties: ['openFile'] });
      if (res.canceled) return null;
      [target] = res.filePaths;
    }
    return { path: target, json: fs.readFileSync(target, 'utf8') };
  });
  ipcMain.handle('project:readAutosave', () => (!process.env.WVM_E2E && fs.existsSync(autosavePath()) ? fs.readFileSync(autosavePath(), 'utf8') : null));
  ipcMain.handle('project:writeAutosave', (_e, json) => fs.writeFileSync(autosavePath(), json, 'utf8'));
  ipcMain.handle('project:clearAutosave', () => fs.rmSync(autosavePath(), { force: true }));
  ipcMain.handle('project:setDirty', (_e, value, title) => {
    dirty = value;
    if (win && title) win.setTitle(title);
  });
  ipcMain.handle('project:pickRelink', async (_e, name) => {
    const res = await dialog.showOpenDialog(win, { title: `"${name}" 위치 찾기`, properties: ['openFile'], filters: MEDIA_FILTER });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('text:open', async (_e, { title, extensions }) => {
    const res = await dialog.showOpenDialog(win, { title, filters: [{ name: '텍스트', extensions }, { name: '모든 파일', extensions: ['*'] }], properties: ['openFile'] });
    if (res.canceled) return null;
    const buf = fs.readFileSync(res.filePaths[0]);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('euc-kr').decode(buf); // 메모장 ANSI 저장본
    }
    return { path: res.filePaths[0], text };
  });
  ipcMain.handle('text:save', async (_e, { title, defaultName, extensions, text }) => {
    const res = await dialog.showSaveDialog(win, { title, defaultPath: defaultName, filters: [{ name: '텍스트', extensions }] });
    if (res.canceled) return null;
    fs.writeFileSync(res.filePath, `﻿${text}`, 'utf8');
    return res.filePath;
  });
  ipcMain.handle('path:resolve', (_e, baseFile, rel) => {
    const resolved = path.resolve(path.dirname(baseFile), rel);
    return fs.existsSync(resolved) ? resolved : null;
  });

  ipcMain.handle('tts:voices', () => listVoices());
  ipcMain.handle('tts:generate', (_e, req) => synthesize(req, cacheDir()));

  ipcMain.handle('export:pickPath', async (_e, { defaultName, ext }) => {
    const res = await dialog.showSaveDialog(win, { title: '비디오 내보내기', defaultPath: `${defaultName}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    return res.canceled ? null : res.filePath;
  });
  ipcMain.handle('export:begin', () => beginJob());
  ipcMain.handle('export:writeAsset', (_e, id, name, bytes) => writeAsset(id, name, bytes));
  ipcMain.handle('export:start', (_e, id, spec) => runJob(id, spec, (progress) => {
    win?.webContents.send('export:progress', { id, progress });
  }));
  ipcMain.handle('export:cancel', (_e, id) => cancelJob(id));

  ipcMain.handle('shell:reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('dialog:confirm', async (_e, { message, buttons }) => {
    const res = await dialog.showMessageBox(win, { type: 'question', message, buttons, defaultId: 0, cancelId: buttons.length - 1, title: 'WebVideoMaker' });
    return res.response;
  });
}

if (!app.requestSingleInstanceLock({})) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = argv.find((a) => a.toLowerCase().endsWith('.wvm'));
    if (file) win.webContents.send('project:openPath', file);
  });

  app.whenReady().then(() => {
    setCacheDir(cacheDir());
    protocol.handle('app', serveApp);
    protocol.handle('media', serveMedia);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'local-fonts'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'local-fonts');
    registerIpc();
    buildMenu();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
