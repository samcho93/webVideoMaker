// 내보내기 작업: 렌더러가 만든 PNG 를 임시 폴더에 받고, 필터 그래프를 구성해 ffmpeg 을 실행한다.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG } from './ffmpeg.mjs';
import { buildCaptionConcat, buildExportPlan } from '../shared/graph.mjs';
import { projectDuration } from '../shared/model.mjs';

const jobs = new Map();

export function beginJob() {
  const id = randomUUID();
  const dir = path.join(os.tmpdir(), 'webvideomaker', id);
  fs.mkdirSync(dir, { recursive: true });
  jobs.set(id, { dir, proc: null, cancelled: false, output: null });
  return id;
}

function jobOf(id) {
  const job = jobs.get(id);
  if (!job) throw new Error('내보내기 작업을 찾을 수 없습니다.');
  return job;
}

export function writeAsset(id, name, bytes) {
  const job = jobOf(id);
  const safe = path.basename(name);
  const file = path.join(job.dir, safe);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.cancelled = true;
  job.proc?.kill();
}

function cleanup(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  fs.rmSync(job.dir, { recursive: true, force: true });
}

/**
 * @param spec { project, assets:{overlays,masks,paths, captionEntries:{trackId:[{name,start,end}]}, blankName}, options:{format,quality,height,output} }
 */
export function runJob(id, spec, onProgress) {
  const job = jobOf(id);
  const { project, assets, options } = spec;

  const captions = {};
  for (const [trackId, entries] of Object.entries(assets.captionEntries || {})) {
    const list = path.join(job.dir, `captions-${trackId}.ffconcat`);
    fs.writeFileSync(list, buildCaptionConcat(entries, assets.blankName, projectDuration(project)), 'utf8');
    captions[trackId] = list;
  }

  const plan = buildExportPlan(project, { ...assets, captions }, options);
  const script = path.join(job.dir, 'filter.txt');
  fs.writeFileSync(script, plan.filter, 'utf8');

  const args = ['-y', '-hide_banner', ...plan.inputArgs, '-filter_complex_script', script, ...plan.outputArgs,
    '-progress', 'pipe:1', '-nostats', options.output];

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    job.proc = proc;
    job.output = options.output;
    let tail = '';
    let buffer = '';
    proc.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
    proc.stdout.on('data', (d) => {
      buffer += d;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / plan.duration));
      }
    });
    proc.on('error', (err) => { cleanup(id); reject(err); });
    proc.on('close', (code) => {
      const cancelled = job.cancelled;
      cleanup(id);
      if (cancelled) {
        fs.rmSync(options.output, { force: true });
        resolve({ cancelled: true });
      } else if (code === 0) {
        onProgress(1);
        resolve({ output: options.output, duration: plan.duration });
      } else {
        fs.rmSync(options.output, { force: true });
        reject(new Error(`ffmpeg 오류 (${code})\n${tail}`));
      }
    });
  });
}
