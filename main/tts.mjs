// Windows 내장 음성(SAPI)으로 나레이션 음성 파일을 만든다.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VOICES_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }
$s.Dispose()
`;

const SPEAK_SCRIPT = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:WVM_VOICE) { $s.SelectVoice($env:WVM_VOICE) }
$s.Rate = [int]$env:WVM_RATE
$s.SetOutputToWaveFile($env:WVM_OUT)
$s.Speak([IO.File]::ReadAllText($env:WVM_TEXT, [Text.Encoding]::UTF8))
$s.Dispose()
`;

function powershell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `PowerShell 종료 코드 ${code}`))));
  });
}

export async function listVoices() {
  if (process.platform !== 'win32') return [];
  const out = await powershell(VOICES_SCRIPT);
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, culture] = line.split('|');
    return { name, culture };
  });
}

/** @returns 생성된 WAV 경로 */
export async function synthesize({ text, voice, rate = 0 }, cacheDir) {
  if (process.platform !== 'win32') throw new Error('음성 생성은 Windows 에서만 지원합니다.');
  const dir = path.join(cacheDir, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const key = createHash('sha1').update(JSON.stringify([text, voice, rate])).digest('hex').slice(0, 20);
  const wav = path.join(dir, `${key}.wav`);
  if (fs.existsSync(wav) && fs.statSync(wav).size > 44) return wav;
  const textFile = path.join(dir, `${key}.txt`);
  fs.writeFileSync(textFile, text, 'utf8');
  try {
    await powershell(SPEAK_SCRIPT, {
      WVM_VOICE: voice || '',
      WVM_RATE: String(Math.round(rate)),
      WVM_OUT: wav,
      WVM_TEXT: textFile,
    });
  } finally {
    fs.rmSync(textFile, { force: true });
  }
  return wav;
}
