// 텍스트·아이콘·도형·자막의 래스터화. 미리보기와 내보내기가 같은 그림을 쓴다.

const ICONS = {
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21.1 7 14.2 2 9.3l6.9-1z',
  heart: 'M12 21s-8-5.2-10-10.1C.6 7.1 3 3.5 6.7 3.5c2.2 0 4 1.2 5.3 3.1 1.3-1.9 3.1-3.1 5.3-3.1 3.7 0 6.1 3.6 4.7 7.4C20 15.8 12 21 12 21z',
  check: 'M9.5 18.5L3 12l2.5-2.5 4 4 9-9L21 7z',
  cross: 'M6 3.5l6 6 6-6L20.5 6l-6 6 6 6-2.5 2.5-6-6-6 6L3.5 18l6-6-6-6z',
  right: 'M2 9h11V4l9 8-9 8v-5H2z',
  left: 'M22 9H11V4l-9 8 9 8v-5h11z',
  up: 'M9 22V11H4l8-9 8 9h-5v11z',
  down: 'M9 2v11H4l8 9 8-9h-5V2z',
  play: 'M6 3l15 9-15 9z',
  pause: 'M5 3h5v18H5zM14 3h5v18h-5z',
  pin: 'M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
  bubble: 'M3 4h18v13H9l-5 4v-4H3z',
  warning: 'M12 2L1 21h22zM11 9h2v6h-2zm0 8h2v2h-2z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM11 10h2v8h-2zm0-4h2v2h-2z',
  music: 'M9 3l12-2v14.5a3 3 0 1 1-2-2.8V5.2L11 6.5v11a3 3 0 1 1-2-2.8z',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3zM12 9a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v4h-2zM11 19h2v4h-2zM1 11h4v2H1zM19 11h4v2h-4z',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z',
  home: 'M12 3L2 12h3v9h5v-6h4v6h5v-9h3z',
  flag: 'M5 2h2v20H5zM8 3h12l-3 5 3 5H8z',
  crown: 'M2 7l5 5 5-8 5 8 5-5-2 13H4z',
  fire: 'M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-4 3-7 1 2 2 2 3-5z',
  thumbs: 'M2 10h4v11H2zM8 21V10l4-8c2 0 3 1 3 3l-1 4h7c1 0 1.5 1 1 2l-3 9c0 .7-1 1-1.5 1z',
  smile: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM7 14h10a5 5 0 0 1-10 0z',
};
export const ICON_NAMES = Object.keys(ICONS);
export const EMOJIS = ['😀', '😂', '😍', '😎', '🤔', '😱', '👍', '👏', '🙏', '🔥', '✨', '🎉', '💯', '❤️', '⭐', '🎵', '📌', '📢', '✅', '❌', '⚠️', '➡️', '💡', '🎬'];

const canvasOf = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};

export function drawIconPreview(canvas, name) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / 24, canvas.height / 24);
  ctx.fillStyle = '#e6e8ee';
  ctx.fill(new Path2D(ICONS[name]), 'evenodd');
}

const fontOf = (s) => `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : '400 '}${s.size}px "${s.font}", "Malgun Gothic", "Segoe UI Emoji", sans-serif`;

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** (0,0) 을 중심으로 여러 줄 텍스트를 그린다 */
function drawTextBlock(ctx, s) {
  ctx.font = fontOf(s);
  ctx.textBaseline = 'middle';
  const lines = String(s.text).split('\n');
  const lh = s.size * (s.lineHeight || 1.25);
  const width = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  const height = lines.length * lh;
  const pad = s.size * 0.3;

  if (s.bgOpacity > 0) {
    ctx.fillStyle = hexAlpha(s.bgColor, s.bgOpacity);
    ctx.beginPath();
    ctx.roundRect(-width / 2 - pad, -height / 2 - pad * 0.6, width + pad * 2, height + pad * 1.2, s.size * 0.12);
    ctx.fill();
  }
  const align = s.align || 'center';
  ctx.textAlign = align;
  const x = align === 'left' ? -width / 2 : align === 'right' ? width / 2 : 0;
  lines.forEach((line, i) => {
    const y = -height / 2 + lh * (i + 0.5);
    if (s.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,.75)';
      ctx.shadowBlur = s.size * 0.12;
      ctx.shadowOffsetX = s.size * 0.03;
      ctx.shadowOffsetY = s.size * 0.04;
    }
    if (s.outlineWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = s.outlineWidth * 2;
      ctx.strokeStyle = s.outlineColor;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
  });
  return { width: width + pad * 2, height: height + pad * 1.2 };
}

function drawOverlayBody(ctx, item) {
  ctx.globalAlpha = item.opacity ?? 1;
  if (item.kind === 'text') {
    drawTextBlock(ctx, item);
  } else if (item.kind === 'icon') {
    const k = item.size / 24;
    ctx.save();
    if (item.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = item.size * 0.06;
      ctx.shadowOffsetY = item.size * 0.03;
    }
    ctx.scale(k, k);
    ctx.translate(-12, -12);
    ctx.shadowOffsetY *= 1;
    ctx.fillStyle = item.color;
    ctx.fill(new Path2D(ICONS[item.icon] || ICONS.star), 'evenodd');
    ctx.restore();
  } else if (item.kind === 'shape') {
    ctx.beginPath();
    const { w, h } = item;
    if (item.shape === 'ellipse') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else ctx.roundRect(-w / 2, -h / 2, w, h, item.shape === 'rect' ? item.radius : 0);
    if (item.fillOpacity > 0) {
      ctx.fillStyle = hexAlpha(item.fill, item.fillOpacity);
      ctx.fill();
    }
    if (item.strokeWidth > 0) {
      ctx.lineWidth = item.strokeWidth;
      ctx.strokeStyle = item.strokeColor;
      ctx.stroke();
    }
  }
}

/** 시간·페이드를 뺀 나머지가 같으면 다시 그리지 않는다 */
const overlayCache = new Map();
const CACHE_LIMIT = 400;

function remember(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

/**
 * 오버레이를 불투명 영역 크기의 캔버스로 만든다.
 * @returns {{canvas:HTMLCanvasElement, x:number, y:number, w:number, h:number}}
 */
export function rasterizeOverlay(item, W, H) {
  const { id, start, duration, fadeIn, fadeOut, ...look } = item;
  const key = JSON.stringify([look, W, H]);
  const hit = overlayCache.get(key);
  if (hit) return hit;

  const full = canvasOf(W, H);
  const ctx = full.getContext('2d', { willReadFrequently: true });
  ctx.translate(item.x, item.y);
  ctx.rotate(((item.rotation || 0) * Math.PI) / 180);
  drawOverlayBody(ctx, item);

  const { data } = ctx.getImageData(0, 0, W, H);
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y += 1) {
    const row = y * W * 4 + 3;
    for (let x = 0; x < W; x += 1) {
      if (data[row + x * 4] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return remember(overlayCache, key, { canvas: canvasOf(2, 2), x: item.x, y: item.y, w: 0, h: 0 });
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const canvas = canvasOf(w, h);
  canvas.getContext('2d').drawImage(full, -minX, -minY);
  return remember(overlayCache, key, { canvas, x: minX, y: minY, w, h });
}

/** 글자 단위까지 고려한 줄바꿈 */
function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else if (ctx.measureText(word).width > maxWidth) {
        for (const ch of word) {
          if (ctx.measureText(line + ch).width > maxWidth && line) {
            out.push(line.trimEnd());
            line = ch;
          } else {
            line += ch;
          }
        }
      } else {
        if (line.trim()) out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const captionCache = new Map();

/** 자막 한 항목을 프레임 크기 투명 캔버스로 만든다 */
export function rasterizeCaption(text, style, W, H) {
  const key = JSON.stringify([text, style, W, H]);
  const hit = captionCache.get(key);
  if (hit) return hit;
  const canvas = canvasOf(W, H);
  const ctx = canvas.getContext('2d');
  ctx.font = fontOf(style);
  const lines = wrapLines(ctx, text, W * 0.9);
  const height = lines.length * style.size * 1.25;
  const pad = style.size * 0.18;
  let y;
  if (style.position === 'top') y = style.margin + height / 2 + pad;
  else if (style.position === 'middle') y = H / 2;
  else y = H - style.margin - height / 2 - pad;
  ctx.translate(W / 2, y);
  drawTextBlock(ctx, { ...style, text: lines.join('\n'), align: 'center', lineHeight: 1.25 });
  return remember(captionCache, key, canvas);
}

/** 타원 영역용 흑백 마스크 (흰색=적용) */
export function ellipseMask(w, h) {
  const canvas = canvasOf(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

export function blankFrame(W, H) {
  return canvasOf(W, H);
}

export function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) reject(new Error('PNG 변환 실패'));
      else resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}
