// libmpv DLL 을 내려받아 vendor/libmpv 에 둔다. 용량이 커서 저장소에는 넣지 않는다.
// 버전과 SHA-256 을 고정해 어디서 빌드해도 같은 파일을 쓴다.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261104';
const ARCHIVE = 'mpv-dev-x86_64-20261104-git-46787be250.7z';
const SHA256 = '5ae0aaa85b2e690e9c574a44e10a86f3d5fe4b406ef6dfa684f5ab25e6bf6306';
const DLL = 'libmpv-2.dll';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'vendor', 'libmpv');
const target = path.join(DIR, DLL);

if (fs.existsSync(target) && fs.statSync(target).size > 0) {
  console.log(`이미 있음: ${target}`);
  process.exit(0);
}

fs.mkdirSync(DIR, { recursive: true });
const archive = path.join(DIR, ARCHIVE);
console.log(`내려받는 중: ${ARCHIVE}`);
const res = await fetch(`${RELEASE}/${ARCHIVE}`);
if (!res.ok) throw new Error(`내려받기 실패: ${res.status}`);
const data = Buffer.from(await res.arrayBuffer());
const actual = createHash('sha256').update(data).digest('hex');
if (actual !== SHA256) throw new Error(`SHA-256 불일치: ${actual}`);
fs.writeFileSync(archive, data);

// Windows 10 이상에 포함된 tar 는 7z 를 풀 수 있다.
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(tar, ['-xf', archive, '-C', DIR, DLL], { stdio: 'inherit' });
fs.rmSync(archive, { force: true });
if (!fs.existsSync(target)) throw new Error(`${DLL} 을 찾지 못했습니다.`);
console.log(`완료: ${target} (${Math.round(fs.statSync(target).size / 1048576)}MB)`);
