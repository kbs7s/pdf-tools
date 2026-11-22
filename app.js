import * as pdfjsLib from './lib/pdf.min.mjs';
import { STRINGS } from './i18n.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const { PDFDocument, degrees, rgb, StandardFonts } = window.PDFLib;

/* ---------------- i18n ---------------- */
let lang = 'en';
try { lang = localStorage.getItem('lang') || ''; } catch {}
if (!STRINGS[lang]) lang = (navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';

function t(key, vars = {}) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) ?? STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}
function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
  document.getElementById('langBtn').textContent = t('langOther');
  document.title = t('appName');
}
document.getElementById('langBtn').addEventListener('click', () => {
  lang = lang === 'ar' ? 'en' : 'ar';
  try { localStorage.setItem('lang', lang); } catch {}
  applyLang();
  route(true);
});

/* ---------------- helpers ---------------- */
const $app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(html) { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; }
function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
function baseName(name) { return name.replace(/\.[^.]+$/, ''); }
const sleep0 = () => new Promise(r => setTimeout(r, 0));

const busyEl = document.getElementById('busy');
const busyText = document.getElementById('busyText');
function busy(on, text) { busyEl.classList.toggle('on', !!on); busyText.textContent = text || t('working'); }
async function progress(text) { busyText.textContent = text; await sleep0(); }

async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }

function friendlyError(e) {
  const m = String(e && (e.message || e));
  if (/encrypt|password/i.test(m) || (e && e.name === 'PasswordException')) return t('encrypted');
  if (/Failed to parse|Invalid PDF|No PDF header|InvalidPDF/i.test(m)) return t('badPdf');
  return t('genericError', { msg: m });
}

async function loadLib(bytes) {
  try { return await PDFDocument.load(bytes); }
  catch (e) { throw new Error(friendlyError(e)); }
}
async function loadJs(bytes) {
  try { return await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise; }
  catch (e) { throw new Error(friendlyError(e)); }
}

/** Render a pdf.js page to a canvas. `opt.width` = target pixel width, or `opt.scale`. */
async function renderPage(pdf, num, opt = {}) {
  const page = await pdf.getPage(num);
  const vp1 = page.getViewport({ scale: 1 });
  let scale = opt.scale || (opt.width ? opt.width / vp1.width : 1);
  const maxSide = opt.maxSide || 4096;
  scale = Math.min(scale, maxSide / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return { canvas, width: vp1.width, height: vp1.height };
}
const canvasBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

/** Parse "1-3, 5, 8-" into arrays of 0-based page indexes. */
function parseRanges(str, total) {
  const groups = [];
  for (const raw of str.split(/[,،;]+/)) {
    const part = raw.trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    if (!part) continue;
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) throw new Error(t('badRange', { r: part, total }));
    let a, b;
    if (m.length === 2) { a = b = +m[1]; } else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : total; }
    if (a < 1 || b > total || a > b) throw new Error(t('badRange', { r: part, total }));
    const g = []; for (let i = a; i <= b; i++) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) throw new Error(t('badRange', { r: str, total }));
  return groups;
}

/** Map a point in "visual" page space (as the page is shown, bottom-left origin) to PDF user space. */
function visualBox(page) {
  const crop = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  return { crop, rot, vw: swap ? crop.height : crop.width, vh: swap ? crop.width : crop.height };
}
function toUser(box, vx, vy) {
  const { crop, rot } = box; const W = crop.width, H = crop.height;
  let x, y;
  if (rot === 90) { x = W - vy; y = vx; }
  else if (rot === 180) { x = W - vx; y = H - vy; }
  else if (rot === 270) { x = vy; y = H - vx; }
  else { x = vx; y = vy; }
  return { x: x + crop.x, y: y + crop.y };
}
/** Draw an image upright as seen on screen, centred at visual (cx, cy), rotated `angle` degrees counter-clockwise. */
function drawImageVisual(page, box, img, cx, cy, w, hgt, angle = 0, opacity = 1) {
  const a = angle * Math.PI / 180;
  const vx = cx - (w / 2 * Math.cos(a) - hgt / 2 * Math.sin(a));
  const vy = cy - (w / 2 * Math.sin(a) + hgt / 2 * Math.cos(a));
  const p = toUser(box, vx, vy);
  const o = { x: p.x, y: p.y, width: w, height: hgt, rotate: degrees(box.rot + angle), opacity };
  if (img instanceof window.PDFLib.PDFEmbeddedPage) page.drawPage(img, o); else page.drawImage(img, o);
}

const hasArabic = s => /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(s);

/** Render text to a transparent PNG canvas (lets us use any language/font). */
function textCanvas(text, { px = 48, color = '#000', family = 'system-ui, sans-serif', weight = '700', scale = 3 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${weight} ${px * scale}px ${family}`;
  ctx.font = font;
  const lines = String(text).split(/\r?\n/);
  const pad = px * scale * 0.2, lineH = px * scale * 1.3;
  const w = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2);
  const hh = Math.ceil(lines.length === 1 ? px * scale * 1.5 : lineH * lines.length + px * scale * 0.3);
  c.width = Math.max(w, 4); c.height = hh;
  ctx.font = font;
  const firstStrong = String(text).match(/[A-Za-z\u00C0-\u024F\u0590-\u08FF\uFB1D-\uFEFF]/);
  const rtl = !!(firstStrong && hasArabic(firstStrong[0]));
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = lines.length === 1 ? 'center' : (rtl ? 'right' : 'left');
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  const x = lines.length === 1 ? c.width / 2 : (rtl ? c.width - pad : pad);
  lines.forEach((l, i) => ctx.fillText(l, x, lines.length === 1 ? c.height / 2 : px * scale * 0.15 + lineH * (i + 0.5)));
  return { canvas: c, width: c.width / scale, height: c.height / scale };
}
async function embedCanvasPng(doc, canvas) {
  const blob = await canvasBlob(canvas, 'image/png');
  return doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
}
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); }

/** Load an image file into a canvas (respects phone photo orientation), limited to maxSide px. */
function imageToCanvas(file, maxSide = 3000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, hh = img.naturalHeight;
      const s = Math.min(1, maxSide / Math.max(w, hh));
      w = Math.round(w * s); hh = Math.round(hh * s);
      const c = document.createElement('canvas'); c.width = w; c.height = hh;
      c.getContext('2d').drawImage(img, 0, 0, w, hh);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('badImage', { name: file.name }))); };
    img.src = url;
  });
}

/* ---------------- icons ---------------- */
const ic = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  merge: ic('<path d="M8 3v5a4 4 0 0 0 4 4 4 4 0 0 1 4 4v5"/><path d="M16 3v5a4 4 0 0 1-4 4"/><path d="m13 18 3 3 3-3"/>'),
  split: ic('<path d="M12 3v18"/><path d="M5 7h4v10H5z"/><path d="M15 7h4v10h-4z"/>'),
  organize: ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  rotate: ic('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  delete: ic('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
  compress: ic('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>'),
  img2pdf: ic('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'),
  pdf2img: ic('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="m8 18 3-3 2 2 3-3"/>'),
  numbers: ic('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'),
  watermark: ic('<path d="M12 2.7s7 6.8 7 11.3a7 7 0 1 1-14 0c0-4.5 7-11.3 7-11.3z"/>'),
  sign: ic('<path d="M3 20c3 0 4-3 6-8s3-6 4-4-2 7 0 7 3-3 4-3 1 3 4 3"/><path d="M3 23h18"/>'),
  up: ic('<path d="m18 15-6-6-6 6"/>'),
  down: ic('<path d="m6 9 6 6 6-6"/>'),
  left: ic('<path d="m15 18-6-6 6-6"/>'),
  right: ic('<path d="m9 18 6-6-6-6"/>'),
  x: ic('<path d="M18 6 6 18M6 6l12 12"/>'),
  rotL: ic('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  rotR: ic('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  trash: ic('<path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/>'),
  edit: ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  forms: ic('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h4M7 14h10"/><path d="m14 8 1.5 1.5L18 7"/>'),
  ocr: ic('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h10M7 12h10M7 16h6"/>'),
  protect: ic('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: ic('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/>'),
  scan: ic('<path d="M3 8V6a2 2 0 0 1 2-2h2M17 4h2a2 2 0 0 1 2 2v2M21 16v2a2 2 0 0 1-2 2h-2M7 20H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.5"/>'),
  crop: ic('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
  redact: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6" y="9" width="8" height="3" fill="currentColor"/><path d="M6 15h12"/>'),
  view: ic('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  insert: ic('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M12 11v6M9 14h6"/>'),
  extract: ic('<rect x="3" y="3" width="13" height="13" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m16 11-3-3-7 7"/><path d="M21 8v11a2 2 0 0 1-2 2H8"/>'),
  stamp: ic('<path d="M9 3h6l-1 7h3a2 2 0 0 1 2 2v3H5v-3a2 2 0 0 1 2-2h3z"/><path d="M5 19h14"/>'),
  nup: ic('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M12 5v14"/>'),
  gray: ic('<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  repair: ic('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>'),
  upload: ic('<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>'),
};

/* ---------------- shared UI ---------------- */
function dropZone({ accept, multiple, label, onFiles }) {
  const z = h(`<label class="drop">
      <span style="color:var(--accent)">${ICONS.upload.replace('<svg', '<svg width="32" height="32"')}</span>
      <span class="big">${esc(label)}</span><small>${esc(t('dropHint'))}</small>
      <input type="file" accept="${accept}" ${multiple ? 'multiple' : ''}>
    </label>`);
  const input = z.querySelector('input');
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', e => {
    e.preventDefault(); z.classList.remove('over');
    const files = [...e.dataTransfer.files].filter(f => matchAccept(f, accept));
    if (files.length) onFiles(multiple ? files : [files[0]]);
  });
  return z;
}
function matchAccept(f, accept) {
  return accept.split(',').some(a => {
    a = a.trim();
    if (a.endsWith('/*')) return f.type.startsWith(a.slice(0, -1));
    if (a.startsWith('.')) return f.name.toLowerCase().endsWith(a);
    return f.type === a;
  });
}
function addMoreButton(accept, onFiles) {
  const b = h(`<label class="btn">+ ${esc(t('addMore'))}<input type="file" accept="${accept}" multiple hidden></label>`);
  const i = b.querySelector('input');
  i.addEventListener('change', () => { if (i.files.length) onFiles([...i.files]); i.value = ''; });
  return b;
}

/** Reorderable list of items: {name, meta, thumb} */
function fileList(items, onChange) {
  const ul = h('<ul class="file-list"></ul>');
  items.forEach((it, i) => {
    const li = h(`<li>
      ${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : ''}
      <span class="name">${esc(it.name)}</span><span class="meta">${esc(it.meta || '')}</span>
      <button class="icon-btn" data-a="up" title="${esc(t('moveUp'))}" ${i === 0 ? 'disabled' : ''}>${ICONS.up}</button>
      <button class="icon-btn" data-a="down" title="${esc(t('moveDown'))}" ${i === items.length - 1 ? 'disabled' : ''}>${ICONS.down}</button>
      <button class="icon-btn" data-a="rm" title="${esc(t('remove'))}">${ICONS.x}</button></li>`);
    li.addEventListener('click', e => {
      const a = e.target.closest('button')?.dataset.a; if (!a) return;
      if (a === 'up') [items[i - 1], items[i]] = [items[i], items[i - 1]];
      if (a === 'down') [items[i + 1], items[i]] = [items[i], items[i + 1]];
      if (a === 'rm') items.splice(i, 1);
      onChange();
    });
    ul.appendChild(li);
  });
  return ul;
}

/** Show the finished file(s) with Download / Share buttons. outputs: [{name, data(Uint8Array|Blob), type}] */
async function showResult(view, outputs, extraHtml = '') {
  let file;
  if (outputs.length === 1) {
    const o = outputs[0];
    file = new File([o.data], o.name, { type: o.type || 'application/pdf' });
  } else {
    const zip = new JSZip();
    const seen = new Set();
    for (const o of outputs) {
      let n = o.name; let k = 2;
      while (seen.has(n)) n = o.name.replace(/(\.[^.]+)$/, `-${k++}$1`);
      seen.add(n); zip.file(n, o.data);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    file = new File([blob], view.zipName || 'files.zip', { type: 'application/zip' });
  }
  const url = URL.createObjectURL(file);
  const box = view.querySelector('.result-slot');
  const canShare = navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch { return false; } })();
  box.innerHTML = '';
  const r = h(`<div class="result">
      <div><b>${esc(t('done'))}</b> ${esc(file.name)} · ${fmtSize(file.size)}</div>
      ${extraHtml}
      <div class="btn-row">
        <a class="btn primary" href="${url}" download="${esc(file.name)}">${esc(t('download'))}</a>
        ${canShare ? `<button class="btn" data-share>${esc(t('share'))}</button>` : ''}
        <button class="btn" data-again>${esc(t('startOver'))}</button>
      </div></div>`);
  r.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ files: [file], title: file.name }).catch(() => {}));
  r.querySelector('[data-again]').addEventListener('click', () => route(true));
  addContinue(r, file);
  box.appendChild(r);
  r.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Wrap an async action with busy overlay + error display. */
async function run(view, fn) {
  const err = view.querySelector('.err-slot');
  err.textContent = '';
  busy(true);
  try { await fn(); }
  catch (e) { console.error(e); err.textContent = (e && e.message) || friendlyError(e); err.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  finally { busy(false); }
}

function toolShell(id) {
  const v = h(`<section>
      <div class="tool-head"><a class="back" href="#">${lang === 'ar' ? '→' : '←'} ${esc(t('back'))}</a><h2>${esc(t('t_' + id))}</h2></div>
      <p class="tool-desc">${esc(t('d_' + id))}</p>
      <div class="result-slot"></div>
      <div class="panel body"></div>
      <div class="error err-slot"></div>
    </section>`);
  return v;
}
function seg(name, options, value) {
  return `<div class="seg">${options.map(([v, label]) => `<label><input type="radio" name="${name}" value="${v}" ${v === value ? 'checked' : ''}>${esc(label)}</label>`).join('')}</div>`;
}
const val = (v, name) => v.querySelector(`[name="${name}"]:checked`)?.value ?? v.querySelector(`[name="${name}"]`)?.value;

/** Single PDF picker: calls onLoad(file, bytes) and shows the file name with a change button. */
function singlePdf(body, onLoad) {
  const zone = dropZone({ accept: 'application/pdf,.pdf', multiple: false, label: t('chooseFile'), onFiles: async ([f]) => {
    const view = body.closest('section');
    await run(view, async () => {
      const bytes = await readBytes(f);
      body.innerHTML = '';
      const head = h(`<div class="file-list" style="margin:0"><li style="list-style:none"><span class="name">${esc(f.name)}</span><span class="meta">${fmtSize(f.size)}</span><button class="btn small" data-change>${esc(t('change'))}</button></li></div>`);
      head.querySelector('[data-change]').addEventListener('click', () => route(true));
      body.appendChild(head);
      await onLoad(f, bytes);
    });
  } });
  body.appendChild(zone);
}

/* ---------------- tools ---------------- */
const TOOLS = [
  { id: 'view', render: toolView },
  { id: 'merge', render: toolMerge },
  { id: 'split', render: toolSplit },
  { id: 'organize', render: toolOrganize },
  { id: 'rotate', render: toolOrganize },
  { id: 'delete', render: toolOrganize },
  { id: 'insert', render: toolInsert },
  { id: 'compress', render: toolCompress },
  { id: 'crop', render: toolCrop },
  { id: 'scan', render: toolScan },
  { id: 'img2pdf', render: toolImg2Pdf },
  { id: 'pdf2img', render: toolPdf2Img },
  { id: 'extract', render: toolExtract },
  { id: 'ocr', render: toolOcr },
  { id: 'edit', render: toolEdit },
  { id: 'forms', render: toolForms },
  { id: 'sign', render: toolSign },
  { id: 'stamp', render: toolStamp },
  { id: 'numbers', render: toolNumbers },
  { id: 'watermark', render: toolWatermark },
  { id: 'nup', render: toolNup },
  { id: 'gray', render: toolGray },
  { id: 'redact', render: toolRedact },
  { id: 'protect', render: toolProtect },
  { id: 'unlock', render: toolUnlock },
  { id: 'repair', render: toolRepair },
];

/* Merge */
function toolMerge() {
  const v = toolShell('merge'); v.zipName = 'merged.zip';
  const body = v.querySelector('.body');
  const files = [];
  const add = async list => {
    for (const f of list) files.push({ file: f, name: f.name, meta: fmtSize(f.size) });
    draw();
  };
  function draw() {
    body.innerHTML = '';
    if (!files.length) { body.appendChild(dropZone({ accept: 'application/pdf,.pdf', multiple: true, label: t('chooseFiles'), onFiles: add })); return; }
    body.appendChild(fileList(files, draw));
    const row = h(`<div class="btn-row"></div>`);
    row.appendChild(addMoreButton('application/pdf,.pdf', add));
    const go = h(`<button class="btn primary" ${files.length < 2 ? 'disabled' : ''}>${esc(t('mergeBtn'))}</button>`);
    go.addEventListener('click', () => run(v, async () => {
      const out = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        await progress(`${files[i].name} (${i + 1}/${files.length})`);
        const src = await loadLib(await readBytes(files[i].file)).catch(e => { throw new Error(`${files[i].name}: ${e.message}`); });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
      }
      await showResult(v, [{ name: 'merged.pdf', data: await out.save() }]);
    }));
    row.appendChild(go);
    body.appendChild(row);
    if (files.length < 2) body.appendChild(h(`<p class="hint">${esc(t('mergeNeed2'))}</p>`));
  }
  draw();
  return v;
}

/* Split */
function toolSplit() {
  const v = toolShell('split');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const src = await loadLib(bytes);
    const total = src.getPageCount();
    const name = baseName(file.name);
    v.zipName = name + '-split.zip';
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: total }))}</p>
        <div class="field" style="margin-top:12px"><span>${esc(t('splitMode'))}</span>
          ${seg('mode', [['each', t('splitEach')], ['every', t('splitEvery')], ['ranges', t('splitRanges')], ['extract', t('splitExtract')]], 'each')}</div>
        <div class="opts">
          <label class="field hidden" data-for="every"><span>${esc(t('splitN'))}</span><input type="number" name="n" min="1" max="${total}" value="2"></label>
          <label class="field hidden" data-for="ranges"><span>${esc(t('splitRangesLabel'))}</span><input type="text" name="ranges" placeholder="1-3, 4-6" dir="ltr"><small class="hint">${esc(t('rangesHint'))}</small></label>
          <label class="field hidden" data-for="extract"><span>${esc(t('splitExtractLabel'))}</span><input type="text" name="extract" placeholder="1, 3, 5-7" dir="ltr"><small class="hint">${esc(t('rangesHint'))}</small></label>
        </div>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('splitBtn'))}</button></div></div>`);
    const sync = () => opts.querySelectorAll('[data-for]').forEach(n => n.classList.toggle('hidden', n.dataset.for !== val(opts, 'mode')));
    opts.addEventListener('change', sync); sync();
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const mode = val(opts, 'mode');
      let groups;
      if (mode === 'each') groups = src.getPageIndices().map(i => [i]);
      else if (mode === 'every') {
        const n = Math.max(1, parseInt(val(opts, 'n')) || 1); groups = [];
        for (let i = 0; i < total; i += n) groups.push(src.getPageIndices().slice(i, i + n));
      } else if (mode === 'ranges') groups = parseRanges(val(opts, 'ranges'), total);
      else groups = [parseRanges(val(opts, 'extract'), total).flat()];
      const outs = [];
      for (let gi = 0; gi < groups.length; gi++) {
        await progress(t('processingPage', { n: gi + 1, total: groups.length }));
        const g = groups[gi];
        const doc = await PDFDocument.create();
        (await doc.copyPages(src, g)).forEach(p => doc.addPage(p));
        const label = g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g[g.length - 1] + 1}`;
        outs.push({ name: `${name}-${mode === 'extract' ? 'extract' : label}.pdf`, data: await doc.save() });
      }
      await showResult(v, outs);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Organize / rotate / delete */
function toolOrganize(id) {
  const v = toolShell(id);
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const src = await loadLib(bytes);
    const js = await loadJs(bytes);
    const orig = () => src.getPages().map((p, i) => ({ src: i, rot: 0, base: p.getRotation().angle }));
    let pages = orig();
    const thumbs = new Map();
    const wrap = h(`<div>
        <p class="hint">${esc(t('orgHint'))}</p>
        <div class="btn-row">
          <button class="btn small" data-all="-90">${ICONS.rotL.replace('<svg', '<svg width="16" height="16"')} ${esc(t('rotAllLeft'))}</button>
          <button class="btn small" data-all="90">${ICONS.rotR.replace('<svg', '<svg width="16" height="16"')} ${esc(t('rotAllRight'))}</button>
          <button class="btn small" data-reset>${esc(t('reset'))}</button>
        </div>
        <div class="pages"></div>
        <div class="btn-row"><button class="btn primary" data-save>${esc(t('save'))}</button></div></div>`);
    const grid = wrap.querySelector('.pages');
    const io = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); loadThumb(+en.target.dataset.src, en.target); }
    }, { rootMargin: '300px' });
    let queue = Promise.resolve();
    function loadThumb(i, img) {
      if (thumbs.has(i)) { img.src = thumbs.get(i); return; }
      queue = queue.then(async () => {
        const { canvas } = await renderPage(js, i + 1, { width: 220 });
        const url = canvas.toDataURL('image/jpeg', 0.8);
        thumbs.set(i, url);
        grid.querySelectorAll(`img[data-src="${i}"]`).forEach(n => { n.src = url; });
      }).catch(console.error);
    }
    let dragFrom = null;
    function draw() {
      grid.innerHTML = '';
      pages.forEach((p, idx) => {
        const card = h(`<div class="pg" draggable="true">
            <span class="num">${idx + 1}</span>
            <div class="box"><img data-src="${p.src}" alt="" style="transform:rotate(${p.rot}deg)"></div>
            <div class="acts">
              <button class="icon-btn" data-a="back" title="${esc(t('moveUp'))}">${lang === 'ar' ? ICONS.right : ICONS.left}</button>
              <button class="icon-btn" data-a="l" title="${esc(t('rotLeft'))}">${ICONS.rotL}</button>
              <button class="icon-btn" data-a="del" title="${esc(t('remove'))}">${ICONS.trash}</button>
              <button class="icon-btn" data-a="r" title="${esc(t('rotRight'))}">${ICONS.rotR}</button>
              <button class="icon-btn" data-a="fwd" title="${esc(t('moveDown'))}">${lang === 'ar' ? ICONS.left : ICONS.right}</button>
            </div></div>`);
        const img = card.querySelector('img');
        if (thumbs.has(p.src)) img.src = thumbs.get(p.src); else io.observe(img);
        card.addEventListener('click', e => {
          const a = e.target.closest('button')?.dataset.a; if (!a) return;
          if (a === 'l') p.rot = (p.rot + 270) % 360;
          if (a === 'r') p.rot = (p.rot + 90) % 360;
          if (a === 'del') pages.splice(idx, 1);
          if (a === 'back' && idx > 0) [pages[idx - 1], pages[idx]] = [pages[idx], pages[idx - 1]];
          if (a === 'fwd' && idx < pages.length - 1) [pages[idx + 1], pages[idx]] = [pages[idx], pages[idx + 1]];
          draw();
        });
        card.addEventListener('dragstart', e => { dragFrom = idx; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(idx)); } catch {} });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drop-target'); });
        card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
        card.addEventListener('drop', e => {
          e.preventDefault();
          if (dragFrom === null || dragFrom === idx) return;
          const [m] = pages.splice(dragFrom, 1); pages.splice(idx, 0, m); dragFrom = null; draw();
        });
        grid.appendChild(card);
      });
    }
    wrap.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', () => { pages.forEach(p => { p.rot = (p.rot + 360 + +b.dataset.all) % 360; }); draw(); }));
    wrap.querySelector('[data-reset]').addEventListener('click', () => { pages = orig(); draw(); });
    wrap.querySelector('[data-save]').addEventListener('click', () => run(v, async () => {
      if (!pages.length) throw new Error(t('noPagesLeft'));
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, pages.map(p => p.src));
      copied.forEach((pg, i) => { pg.setRotation(degrees((pages[i].base + pages[i].rot) % 360)); out.addPage(pg); });
      await showResult(v, [{ name: baseName(file.name) + '-edited.pdf', data: await out.save() }]);
    }));
    body.appendChild(wrap);
    draw();
  });
  return v;
}

/* Images to PDF */
function toolImg2Pdf() {
  const v = toolShell('img2pdf');
  const body = v.querySelector('.body');
  const items = [];
  const accept = 'image/*';
  const add = list => {
    for (const f of list) items.push({ file: f, name: f.name, meta: fmtSize(f.size), thumb: URL.createObjectURL(f) });
    draw();
  };
  const opts = h(`<div class="opts">
      <div class="field"><span>${esc(t('pageSize'))}</span>${seg('size', [['a4', 'A4'], ['letter', 'Letter'], ['fit', t('sizeFit')]], 'a4')}</div>
      <div class="field"><span>${esc(t('orientation'))}</span>${seg('orient', [['auto', t('orAuto')], ['portrait', t('orPortrait')], ['landscape', t('orLandscape')]], 'auto')}</div>
      <div class="field"><span>${esc(t('margin'))}</span>${seg('margin', [['0', t('mNone')], ['20', t('mSmall')], ['40', t('mBig')]], '20')}</div>
    </div>`);
  function draw() {
    body.innerHTML = '';
    if (!items.length) { body.appendChild(dropZone({ accept, multiple: true, label: t('chooseImages'), onFiles: add })); return; }
    body.appendChild(fileList(items, draw));
    body.appendChild(opts);
    const row = h(`<div class="btn-row"></div>`);
    row.appendChild(addMoreButton(accept, add));
    const go = h(`<button class="btn primary">${esc(t('makePdf'))}</button>`);
    go.addEventListener('click', () => run(v, async () => {
      const out = await PDFDocument.create();
      const size = val(opts, 'size'), orient = val(opts, 'orient'), m = +val(opts, 'margin');
      for (let i = 0; i < items.length; i++) {
        await progress(t('processingPage', { n: i + 1, total: items.length }));
        const c = await imageToCanvas(items[i].file);
        const ctx = c.getContext('2d');
        ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        const blob = await canvasBlob(c, 'image/jpeg', 0.9);
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const iw = c.width, ih = c.height;
        let pw, ph;
        if (size === 'fit') { pw = iw * 0.75 + 2 * m; ph = ih * 0.75 + 2 * m; }
        else {
          [pw, ph] = size === 'a4' ? [595.28, 841.89] : [612, 792];
          const land = orient === 'landscape' || (orient === 'auto' && iw > ih);
          if (land) [pw, ph] = [ph, pw];
        }
        const s = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
        const w = iw * s, hh = ih * s;
        out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
      }
      const name = items.length === 1 ? baseName(items[0].name) + '.pdf' : 'images.pdf';
      await showResult(v, [{ name, data: await out.save() }]);
    }));
    row.appendChild(go);
    body.appendChild(row);
  }
  draw();
  return v;
}

/* PDF to images */
function toolPdf2Img() {
  const v = toolShell('pdf2img');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const name = baseName(file.name);
    v.zipName = name + '-images.zip';
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: js.numPages }))}</p>
        <div class="opts">
          <div class="field"><span>${esc(t('format'))}</span>${seg('fmt', [['jpg', 'JPG'], ['png', 'PNG']], 'jpg')}</div>
          <div class="field"><span>${esc(t('quality'))}</span>${seg('q', [['150', t('qNormal')], ['300', t('qHigh')]], '150')}</div>
          <label class="field"><span>${esc(t('whichPages'))}</span><input type="text" name="pages" placeholder="1-${js.numPages}" dir="ltr"></label>
        </div>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('convert'))}</button></div></div>`);
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const fmt = val(opts, 'fmt'), dpi = +val(opts, 'q');
      const sel = val(opts, 'pages').trim();
      const list = sel ? [...new Set(parseRanges(sel, js.numPages).flat())] : [...Array(js.numPages).keys()];
      const outs = [];
      for (let k = 0; k < list.length; k++) {
        await progress(t('processingPage', { n: k + 1, total: list.length }));
        const { canvas } = await renderPage(js, list[k] + 1, { scale: dpi / 72, maxSide: 5000 });
        const blob = await canvasBlob(canvas, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.9);
        canvas.width = canvas.height = 0;
        outs.push({ name: `${name}-${list[k] + 1}.${fmt}`, data: blob, type: blob.type });
      }
      await showResult(v, outs);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Page numbers */
function toolNumbers() {
  const v = toolShell('numbers');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const doc = await loadLib(bytes);
    const total = doc.getPageCount();
    const formats = [['{n}', '1'], ['{n} / {total}', '1 / ' + total], ['Page {n} of {total}', `Page 1 of ${total}`], ['- {n} -', '- 1 -'], ['صفحة {n} من {total}', `صفحة 1 من ${total}`]];
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: total }))}</p>
        <div class="opts">
          <label class="field"><span>${esc(t('position'))}</span><select name="pos">
            ${['BC', 'BR', 'BL', 'TC', 'TR', 'TL'].map(p => `<option value="${p}">${esc(t('pos' + p))}</option>`).join('')}</select></label>
          <label class="field"><span>${esc(t('numFormat'))}</span><select name="fmt">
            ${formats.map(([f, ex]) => `<option value="${esc(f)}">${esc(ex)}</option>`).join('')}</select></label>
          <label class="field"><span>${esc(t('startAt'))}</span><input type="number" name="start" value="1" min="0"></label>
          <label class="field"><span>${esc(t('fontSize'))}</span><input type="number" name="size" value="12" min="6" max="72"></label>
          <label class="field"><span>${esc(t('color'))}</span><input type="color" name="color" value="#000000"></label>
        </div>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="skip"> ${esc(t('skipFirst'))}</label>
        <label class="check" style="margin-top:8px"><input type="checkbox" name="ar"> ${esc(t('arabicDigits'))}</label>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('addNumbers'))}</button></div></div>`);
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const work = await loadLib(bytes);
      const font = await work.embedFont(StandardFonts.Helvetica);
      const pos = val(opts, 'pos'), fmt = opts.querySelector('[name=fmt]').value;
      const start = parseInt(val(opts, 'start')) || 1, size = Math.max(4, +val(opts, 'size') || 12);
      const colorHex = val(opts, 'color');
      const skip = opts.querySelector('[name=skip]').checked, arDigits = opts.querySelector('[name=ar]').checked;
      const pages = work.getPages();
      const counted = skip ? pages.length - 1 : pages.length;
      const lastNum = start + counted - 1;
      const toAr = s => s.replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
      for (let i = 0; i < pages.length; i++) {
        if (skip && i === 0) continue;
        await progress(t('processingPage', { n: i + 1, total: pages.length }));
        const n = start + i - (skip ? 1 : 0);
        let text = fmt.replace('{n}', n).replace('{total}', lastNum);
        if (arDigits) text = toAr(text);
        const page = pages[i];
        const box = visualBox(page);
        const margin = Math.max(18, size * 1.6);
        let w, hh, draw;
        if (/^[\x20-\x7E]*$/.test(text)) {
          w = font.widthOfTextAtSize(text, size); hh = size;
          draw = (vx, vy) => { const p = toUser(box, vx, vy); page.drawText(text, { x: p.x, y: p.y, size, font, color: hexToRgb(colorHex), rotate: degrees(box.rot) }); };
        } else {
          const tc = textCanvas(text, { px: size, color: colorHex, weight: '400' });
          const img = await embedCanvasPng(work, tc.canvas);
          w = tc.width; hh = tc.height;
          draw = (vx, vy) => drawImageVisual(page, box, img, vx + w / 2, vy + hh / 2 - size * 0.3, w, hh);
        }
        const vx = pos[1] === 'C' ? (box.vw - w) / 2 : pos[1] === 'L' ? margin : box.vw - margin - w;
        const vy = pos[0] === 'B' ? margin * 0.8 : box.vh - margin * 0.8 - size;
        draw(vx, vy);
      }
      await showResult(v, [{ name: baseName(file.name) + '-numbered.pdf', data: await work.save() }]);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Watermark */
function toolWatermark() {
  const v = toolShell('watermark');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const doc = await loadLib(bytes);
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: doc.getPageCount() }))}</p>
        <div class="opts">
          <label class="field" style="grid-column:1/-1"><span>${esc(t('wmText'))}</span><input type="text" name="text" value="${esc(t('wmDefault'))}"></label>
          <label class="field"><span>${esc(t('fontSize'))}</span><input type="number" name="size" value="60" min="8" max="300"></label>
          <label class="field"><span>${esc(t('color'))}</span><input type="color" name="color" value="#d6453d"></label>
          <label class="field"><span>${esc(t('opacity'))} <output>30%</output></span><input type="range" name="op" min="5" max="100" value="30"></label>
          <label class="field"><span>${esc(t('angle'))} <output>45°</output></span><input type="range" name="angle" min="-90" max="90" step="5" value="45"></label>
        </div>
        <div class="field" style="margin-top:12px"><span>${esc(t('layout'))}</span>${seg('layout', [['center', t('layCenter')], ['tile', t('layTile')]], 'center')}</div>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('addWatermark'))}</button></div></div>`);
    opts.querySelectorAll('input[type=range]').forEach(r => {
      const o = r.parentElement.querySelector('output');
      r.addEventListener('input', () => { o.textContent = r.name === 'op' ? r.value + '%' : r.value + '°'; });
    });
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const text = opts.querySelector('[name=text]').value.trim();
      if (!text) throw new Error(t('wmEmpty'));
      const work = await loadLib(bytes);
      const size = +val(opts, 'size') || 60, op = +val(opts, 'op') / 100, angle = +val(opts, 'angle');
      const tc = textCanvas(text, { px: size, color: val(opts, 'color'), family: 'system-ui, "Segoe UI", Tahoma, sans-serif' });
      const img = await embedCanvasPng(work, tc.canvas);
      const layout = val(opts, 'layout');
      const pages = work.getPages();
      for (let i = 0; i < pages.length; i++) {
        await progress(t('processingPage', { n: i + 1, total: pages.length }));
        const page = pages[i]; const box = visualBox(page);
        let w = tc.width, hh = tc.height;
        if (layout === 'center') {
          const fit = Math.min(1, (Math.hypot(box.vw, box.vh) * 0.85) / w);
          drawImageVisual(page, box, img, box.vw / 2, box.vh / 2, w * fit, hh * fit, angle, op);
        } else {
          const stepX = w + size * 2, stepY = hh + size * 2.5;
          for (let y = -box.vh * 0.2, row = 0; y < box.vh * 1.2; y += stepY, row++) {
            for (let x = -box.vw * 0.2 + (row % 2 ? stepX / 2 : 0); x < box.vw * 1.2; x += stepX) {
              drawImageVisual(page, box, img, x, y, w, hh, angle, op);
            }
          }
        }
      }
      await showResult(v, [{ name: baseName(file.name) + '-watermarked.pdf', data: await work.save() }]);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Sign */
function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 4;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function toolSign() {
  const v = toolShell('sign');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const total = js.numPages;
    let sig = null; // { url, aspect, canvas }
    const placements = []; // { page, x, y, w } as fractions of the page (top-left)
    let current = 1;

    const step1 = h(`<div style="margin-top:14px">
        <h3 style="margin:0 0 8px;font-size:16px">${esc(t('sigStep1'))}</h3>
        ${seg('sigmode', [['draw', t('sigDraw')], ['type', t('sigType')], ['upload', t('sigUpload')]], 'draw')}
        <div data-m="draw" style="margin-top:10px">
          <canvas class="sig-pad"></canvas>
          <div class="btn-row"><button class="btn small" data-clear>${esc(t('clear'))}</button>
            ${seg('pen', [['#111111', t('black')], ['#1a3fb0', t('blue')], ['#c0392b', t('red')]], '#1a3fb0')}</div>
        </div>
        <div data-m="type" class="hidden" style="margin-top:10px">
          <div class="opts" style="margin-top:0">
            <label class="field"><span>${esc(t('yourName'))}</span><input type="text" name="sname"></label>
            <label class="field"><span>${esc(t('style'))}</span><select name="sfont">
              <option value="'Segoe Script','Brush Script MT','Snell Roundhand',cursive">Script</option>
              <option value="'Lucida Handwriting','Bradley Hand','Comic Sans MS',cursive">Handwriting</option>
              <option value="Georgia,'Times New Roman',serif">Serif</option>
              <option value="system-ui,Tahoma,sans-serif">Sans</option></select></label>
          </div>
        </div>
        <div data-m="upload" class="hidden" style="margin-top:10px">
          <label class="btn">${esc(t('chooseImages'))}<input type="file" accept="image/*" hidden name="sfile"></label>
          <label class="check" style="margin-top:8px"><input type="checkbox" name="nowhite" checked> ${esc(t('removeWhite'))}</label>
          <div style="margin-top:8px"><img class="sig-preview hidden" alt=""></div>
        </div>
        <div class="btn-row"><button class="btn primary" data-use>${esc(t('useSig'))}</button></div>
      </div>`);
    const step2 = h(`<div class="hidden" style="margin-top:14px">
        <h3 style="margin:0 0 8px;font-size:16px">${esc(t('sigStep2'))}</h3>
        <div class="btn-row" style="margin-top:0"><img class="sig-preview" alt=""><button class="btn small" data-edit>${esc(t('editSig'))}</button></div>
        <p class="hint">${esc(t('sigPlaceHint'))}</p>
        <div class="pager"><button class="btn small" data-prev>${esc(t('prev'))}</button><span data-pn></span><button class="btn small" data-next>${esc(t('next'))}</button></div>
        <div class="stage-wrap"><div class="stage"><img alt=""></div></div>
        <div class="btn-row" style="justify-content:center"><button class="btn" data-here>${esc(t('placeHere'))}</button><button class="btn primary" data-save>${esc(t('signBtn'))}</button></div>
      </div>`);
    body.appendChild(step1); body.appendChild(step2);

    // mode switching
    step1.addEventListener('change', e => {
      if (e.target.name === 'sigmode') step1.querySelectorAll('[data-m]').forEach(n => n.classList.toggle('hidden', n.dataset.m !== e.target.value));
    });

    // drawing pad
    const pad = step1.querySelector('.sig-pad');
    const pctx = pad.getContext('2d');
    let drawn = false;
    function sizePad() {
      const r = pad.getBoundingClientRect(); const d = Math.min(window.devicePixelRatio || 1, 3);
      if (!r.width) return;
      pad.width = r.width * d; pad.height = r.height * d; pctx.setTransform(d, 0, 0, d, 0, 0);
      pctx.lineCap = 'round'; pctx.lineJoin = 'round'; drawn = false;
    }
    requestAnimationFrame(sizePad);
    let last = null;
    const pt = e => { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    pad.addEventListener('pointerdown', e => { e.preventDefault(); if (!pad.width || pad.width !== Math.round(pad.getBoundingClientRect().width * Math.min(window.devicePixelRatio || 1, 3))) { if (!drawn) sizePad(); } pad.setPointerCapture(e.pointerId); last = pt(e); });
    pad.addEventListener('pointermove', e => {
      if (!last) return; const p = pt(e);
      pctx.strokeStyle = val(step1, 'pen'); pctx.lineWidth = 2.6;
      pctx.beginPath(); pctx.moveTo(last.x, last.y); pctx.lineTo(p.x, p.y); pctx.stroke();
      last = p; drawn = true;
    });
    const endStroke = () => { last = null; };
    pad.addEventListener('pointerup', endStroke); pad.addEventListener('pointercancel', endStroke);
    step1.querySelector('[data-clear]').addEventListener('click', () => sizePad());

    // upload
    let uploaded = null;
    step1.querySelector('[name=sfile]').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { uploaded = await imageToCanvas(f, 1500); refreshUploadPreview(); }
      catch (err) { v.querySelector('.err-slot').textContent = err.message; }
    });
    step1.querySelector('[name=nowhite]').addEventListener('change', () => uploaded && refreshUploadPreview());
    function processedUpload() {
      const c = document.createElement('canvas'); c.width = uploaded.width; c.height = uploaded.height;
      const ctx = c.getContext('2d'); ctx.drawImage(uploaded, 0, 0);
      if (step1.querySelector('[name=nowhite]').checked) {
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const m = Math.min(d.data[i], d.data[i + 1], d.data[i + 2]);
          if (m > 200) d.data[i + 3] = 0; else if (m > 150) d.data[i + 3] = Math.round(255 * (200 - m) / 50);
        }
        ctx.putImageData(d, 0, 0);
      }
      return trimCanvas(c) || c;
    }
    function refreshUploadPreview() { const p = step1.querySelector('[data-m=upload] .sig-preview'); p.src = processedUpload().toDataURL(); p.classList.remove('hidden'); }

    step1.querySelector('[data-use]').addEventListener('click', () => {
      v.querySelector('.err-slot').textContent = '';
      const mode = val(step1, 'sigmode');
      let c = null;
      if (mode === 'draw') c = drawn ? trimCanvas(pad) : null;
      else if (mode === 'type') {
        const name = step1.querySelector('[name=sname]').value.trim();
        if (name) c = trimCanvas(textCanvas(name, { px: 40, color: val(step1, 'pen') || '#1a3fb0', family: step1.querySelector('[name=sfont]').value, weight: '400' }).canvas);
      } else if (uploaded) c = processedUpload();
      if (!c) { v.querySelector('.err-slot').textContent = t('sigEmpty'); return; }
      sig = { canvas: c, url: c.toDataURL('image/png'), aspect: c.width / c.height };
      step2.querySelector('.sig-preview').src = sig.url;
      step1.classList.add('hidden'); step2.classList.remove('hidden');
      placements.forEach(p => { p.h = undefined; });
      showPage(current);
    });
    step2.querySelector('[data-edit]').addEventListener('click', () => { step2.classList.add('hidden'); step1.classList.remove('hidden'); requestAnimationFrame(() => { if (!drawn) sizePad(); }); });

    // page stage
    const stage = step2.querySelector('.stage');
    const stageImg = stage.querySelector('img');
    let pageAspect = 1; // width / height
    const pageCache = new Map();
    async function showPage(n) {
      current = n;
      step2.querySelector('[data-pn]').textContent = `${n} / ${total}`;
      step2.querySelector('[data-prev]').disabled = n <= 1;
      step2.querySelector('[data-next]').disabled = n >= total;
      if (!pageCache.has(n)) {
        busy(true);
        try {
          const { canvas, width, height } = await renderPage(js, n, { width: Math.min(1400, Math.max(600, stage.parentElement.clientWidth * (window.devicePixelRatio || 1))) });
          pageCache.set(n, { url: canvas.toDataURL('image/jpeg', 0.85), aspect: width / height });
        } finally { busy(false); }
      }
      const pc = pageCache.get(n);
      pageAspect = pc.aspect;
      stageImg.src = pc.url;
      drawPlacements();
    }
    function drawPlacements() {
      stage.querySelectorAll('.placed').forEach(n => n.remove());
      placements.filter(p => p.page === current).forEach(p => {
        const el = h(`<div class="placed"><img src="${sig.url}" alt=""><button class="x" type="button">×</button><span class="rs"></span></div>`);
        const layout = () => {
          const hFrac = p.w * pageAspect / sig.aspect;
          el.style.left = p.x * 100 + '%'; el.style.top = p.y * 100 + '%';
          el.style.width = p.w * 100 + '%'; el.style.height = hFrac * 100 + '%';
        };
        layout();
        el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); placements.splice(placements.indexOf(p), 1); drawPlacements(); });
        el.querySelector('.x').addEventListener('pointerdown', e => e.stopPropagation());
        // move
        el.addEventListener('pointerdown', e => {
          if (e.target.classList.contains('rs') || e.target.classList.contains('x')) return;
          e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId);
          const r = stage.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY, ox = p.x, oy = p.y;
          const mv = ev => {
            const hFrac = p.w * pageAspect / sig.aspect;
            p.x = Math.min(1 - p.w, Math.max(0, ox + (ev.clientX - sx) / r.width));
            p.y = Math.min(1 - hFrac, Math.max(0, oy + (ev.clientY - sy) / r.height)); layout();
          };
          const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
          el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        });
        // resize
        const rs = el.querySelector('.rs');
        rs.addEventListener('pointerdown', e => {
          e.preventDefault(); e.stopPropagation(); rs.setPointerCapture(e.pointerId);
          const r = stage.getBoundingClientRect(); const sx = e.clientX, ow = p.w;
          const mv = ev => { p.w = Math.min(1 - p.x, Math.max(0.04, ow + (ev.clientX - sx) / r.width)); layout(); };
          const up = () => { rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); rs.removeEventListener('pointercancel', up); };
          rs.addEventListener('pointermove', mv); rs.addEventListener('pointerup', up); rs.addEventListener('pointercancel', up);
        });
        stage.appendChild(el);
      });
    }
    function addAt(fx, fy) {
      const w = 0.28; const hFrac = w * pageAspect / sig.aspect;
      placements.push({ page: current, w, x: Math.min(1 - w, Math.max(0, fx - w / 2)), y: Math.min(1 - hFrac, Math.max(0, fy - hFrac / 2)) });
      drawPlacements();
    }
    stage.addEventListener('click', e => {
      if (e.target !== stageImg) return;
      const r = stage.getBoundingClientRect();
      addAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
    step2.querySelector('[data-here]').addEventListener('click', () => addAt(0.7, 0.85));
    step2.querySelector('[data-prev]').addEventListener('click', () => showPage(current - 1));
    step2.querySelector('[data-next]').addEventListener('click', () => showPage(current + 1));
    step2.querySelector('[data-save]').addEventListener('click', () => run(v, async () => {
      if (!placements.length) throw new Error(t('noPlacements'));
      const doc = await loadLib(bytes);
      const img = await embedCanvasPng(doc, sig.canvas);
      const pages = doc.getPages();
      for (const p of placements) {
        const page = pages[p.page - 1]; const box = visualBox(page);
        const w = p.w * box.vw, hh = w / sig.aspect;
        const cx = p.x * box.vw + w / 2, cy = box.vh - p.y * box.vh - hh / 2;
        drawImageVisual(page, box, img, cx, cy, w, hh);
      }
      await showResult(v, [{ name: baseName(file.name) + '-signed.pdf', data: await doc.save() }]);
    }));
  });
  return v;
}

/* ---------------- lazy-loaded engines ---------------- */
const libUrl = p => new URL('lib/' + p, location.href).href;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src;
    s.onload = res; s.onerror = () => rej(new Error(t('loadFailed')));
    document.head.appendChild(s);
  });
}

let qpdfFactory = null;
/** Run qpdf (compiled to WebAssembly) on one input file. Returns { rc, out, errs }. */
async function runQpdf(input, args) {
  if (!qpdfFactory) { await loadScript(libUrl('qpdf/qpdf.js')); qpdfFactory = window.Module; }
  const errs = [];
  const q = await qpdfFactory({ locateFile: f => libUrl('qpdf/' + f), print: () => {}, printErr: m => errs.push(m) });
  q.FS.writeFile('/in.pdf', input);
  let rc;
  try { rc = q.callMain(args.map(a => a === '@in' ? '/in.pdf' : a === '@out' ? '/out.pdf' : a)); }
  catch (e) { rc = e && typeof e.status === 'number' ? e.status : 2; if (!(e && typeof e.status === 'number')) errs.push(String(e && e.message || e)); }
  let out = null; try { out = q.FS.readFile('/out.pdf'); } catch {}
  // qpdf exit codes: 0 = ok, 3 = ok with warnings, 2 = error
  return { rc, out: rc === 2 ? null : out, errs: errs.join('\n') };
}

/** Is this PDF locked? 'open' = needs a password to open, 'restricted' = opens but has edit restrictions, null = not protected. */
async function lockState(bytes) {
  try { const d = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise; d.destroy(); }
  catch (e) { if (e && e.name === 'PasswordException') return 'open'; throw new Error(friendlyError(e)); }
  try { await PDFDocument.load(bytes); return null; }
  catch (e) { if (/encrypt/i.test(String(e && e.message))) return 'restricted'; throw new Error(friendlyError(e)); }
}

function pwField(name, label) {
  return `<label class="field"><span>${esc(label)}</span><input type="password" name="${name}" autocomplete="new-password" dir="ltr"></label>`;
}
function wireShowPw(root) {
  const cb = root.querySelector('[name=showpw]');
  cb?.addEventListener('change', () => root.querySelectorAll('input[type=password],input[data-pw]').forEach(i => { i.dataset.pw = 1; i.type = cb.checked ? 'text' : 'password'; }));
}

/* Protect */
function toolProtect() {
  const v = toolShell('protect');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const state = await lockState(bytes);
    if (state) { body.appendChild(h(`<p class="warn">${esc(t('alreadyLocked'))}</p>`)); return; }
    const opts = h(`<div>
        <div class="opts">${pwField('pw', t('password'))}${pwField('pw2', t('passwordAgain'))}</div>
        <label class="check" style="margin-top:10px"><input type="checkbox" name="showpw"> ${esc(t('showPw'))}</label>
        <p class="hint">${esc(t('protectHint'))}</p>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('protectBtn'))}</button></div></div>`);
    wireShowPw(opts);
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const pw = opts.querySelector('[name=pw]').value, pw2 = opts.querySelector('[name=pw2]').value;
      if (!pw) throw new Error(t('pwEmpty'));
      if (pw !== pw2) throw new Error(t('pwMismatch'));
      const r = await runQpdf(bytes, ['--encrypt', `--user-password=${pw}`, `--owner-password=${pw}`, '--bits=256', '--', '@in', '@out']);
      if (!r.out) throw new Error(t('genericError', { msg: r.errs || 'qpdf' }));
      await showResult(v, [{ name: baseName(file.name) + '-protected.pdf', data: r.out }]);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Unlock */
function toolUnlock() {
  const v = toolShell('unlock');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const state = await lockState(bytes);
    if (!state) { body.appendChild(h(`<p class="hint">${esc(t('notLocked'))}</p>`)); return; }
    const opts = h(`<div>
        ${state === 'open'
          ? `<p class="hint">${esc(t('needsPw'))}</p><div class="opts">${pwField('pw', t('password'))}</div>
             <label class="check" style="margin-top:10px"><input type="checkbox" name="showpw"> ${esc(t('showPw'))}</label>`
          : `<p class="hint">${esc(t('restrictedOnly'))}</p>`}
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('unlockBtn'))}</button></div></div>`);
    wireShowPw(opts);
    const go = () => run(v, async () => {
      const pw = opts.querySelector('[name=pw]')?.value ?? '';
      if (state === 'open' && !pw) throw new Error(t('pwEmpty'));
      const r = await runQpdf(bytes, [`--password=${pw}`, '--decrypt', '@in', '@out']);
      if (!r.out) throw new Error(state === 'open' || /password/i.test(r.errs) ? t('wrongPw') : t('genericError', { msg: r.errs || 'qpdf' }));
      await showResult(v, [{ name: baseName(file.name) + '-unlocked.pdf', data: r.out }]);
    });
    opts.querySelector('[data-go]').addEventListener('click', go);
    opts.querySelector('[name=pw]')?.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    body.appendChild(opts);
  });
  return v;
}

/* OCR */
let tesseractLoaded = null;
function toolOcr() {
  const v = toolShell('ocr');
  const body = v.querySelector('.body');
  const accept = 'application/pdf,.pdf,image/*';
  body.appendChild(dropZone({ accept, multiple: true, label: t('chooseOcr'), onFiles: async files => {
    const pdf = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = pdf ? [] : files.filter(f => f.type.startsWith('image/'));
    if (!pdf && !imgs.length) return;
    let bytes = null, js = null;
    await run(v, async () => {
      if (pdf) {
        bytes = await readBytes(pdf);
        if (await lockState(bytes)) throw new Error(t('encrypted'));
        js = await loadJs(bytes);
      }
    });
    if (pdf && !js) return;
    const count = js ? js.numPages : imgs.length;
    body.innerHTML = '';
    const list = h(`<div class="file-list" style="margin:0"><li style="list-style:none"><span class="name">${esc(pdf ? pdf.name : imgs.map(f => f.name).join(', '))}</span>
        <span class="meta">${esc(t('pages', { n: count }))}</span><button class="btn small" data-change>${esc(t('change'))}</button></li></div>`);
    list.querySelector('[data-change]').addEventListener('click', () => route(true));
    const opts = h(`<div>
        <div class="field" style="margin-top:14px"><span>${esc(t('ocrLangs'))}</span>
          <div class="seg"><label><input type="checkbox" name="ara" checked>العربية</label><label><input type="checkbox" name="eng" checked>English</label></div></div>
        <div class="field" style="margin-top:12px"><span>${esc(t('ocrOutput'))}</span>
          ${seg('out', [['pdf', t('ocrSearchable')], ['txt', t('ocrText')]], 'pdf')}</div>
        <p class="hint">${esc(t('ocrHint'))}</p>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('ocrBtn'))}</button></div></div>`);
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const langs = ['ara', 'eng'].filter(l => opts.querySelector(`[name=${l}]`).checked);
      if (!langs.length) throw new Error(t('ocrPickLang'));
      const wantPdf = val(opts, 'out') === 'pdf';
      await progress(t('ocrLoading'));
      if (!tesseractLoaded) tesseractLoaded = loadScript(libUrl('tesseract/tesseract.min.js'));
      await tesseractLoaded;
      let pageNo = 0;
      const worker = await window.Tesseract.createWorker(langs, 1, {
        workerPath: libUrl('tesseract/worker.min.js'),
        corePath: libUrl('tesseract/'),
        langPath: libUrl('tessdata'),
        gzip: true,
        logger: m => {
          if (m.status === 'recognizing text' && pageNo) busyText.textContent = `${t('ocrPage', { n: pageNo, total: count })} ${Math.round((m.progress || 0) * 100)}%`;
          else if (/load/i.test(m.status || '')) busyText.textContent = t('ocrLoading') + (m.progress ? ` ${Math.round(m.progress * 100)}%` : '');
        },
      });
      try {
        const out = wantPdf ? (js ? await loadLib(bytes) : await PDFDocument.create()) : null;
        const outPages = out && js ? out.getPages() : null;
        const texts = [];
        for (let i = 0; i < count; i++) {
          pageNo = i + 1;
          busyText.textContent = t('ocrPage', { n: pageNo, total: count });
          let canvas, vw, vh;
          if (js) { const r = await renderPage(js, i + 1, { scale: 300 / 72, maxSide: 3500 }); canvas = r.canvas; vw = r.width; vh = r.height; }
          else { canvas = await imageToCanvas(imgs[i], 3500); vw = 595.28; vh = vw * canvas.height / canvas.width; }
          const { data } = await worker.recognize(canvas, { pdfTextOnly: true }, { text: true, pdf: wantPdf });
          texts.push(data.text || '');
          if (wantPdf) {
            const [layer] = await out.embedPdf(new Uint8Array(data.pdf));
            let page;
            if (js) page = outPages[i];
            else {
              const c2 = canvas; const ctx = c2.getContext('2d');
              ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c2.width, c2.height);
              const jpg = await out.embedJpg(new Uint8Array(await (await canvasBlob(c2, 'image/jpeg', 0.85)).arrayBuffer()));
              page = out.addPage([vw, vh]);
              page.drawImage(jpg, { x: 0, y: 0, width: vw, height: vh });
            }
            const box = visualBox(page);
            drawImageVisual(page, box, layer, box.vw / 2, box.vh / 2, box.vw, box.vh);
          }
          canvas.width = canvas.height = 0;
        }
        const name = pdf ? baseName(pdf.name) : (imgs.length === 1 ? baseName(imgs[0].name) : 'scan');
        const allText = texts.map((tx, i) => (count > 1 ? `--- ${t('page', { n: i + 1 })} ---\n` : '') + tx.trim()).join('\n\n');
        const textBox = `<label class="field" style="margin-top:10px"><span>${esc(t('ocrFound'))}</span><textarea rows="8" readonly dir="auto" style="width:100%">${esc(allText)}</textarea></label>
          <div class="btn-row"><button class="btn small" data-copy>${esc(t('copyText'))}</button></div>`;
        if (wantPdf) await showResult(v, [{ name: name + '-ocr.pdf', data: await out.save() }], textBox);
        else await showResult(v, [{ name: name + '.txt', data: new Blob(['﻿' + allText], { type: 'text/plain;charset=utf-8' }), type: 'text/plain' }], textBox);
        const ta = v.querySelector('.result textarea');
        v.querySelector('.result [data-copy]')?.addEventListener('click', e => {
          navigator.clipboard?.writeText(ta.value).then(() => { e.target.textContent = t('copied'); }).catch(() => { ta.select(); });
        });
      } finally { await worker.terminate(); }
    }));
    body.appendChild(list); body.appendChild(opts);
  } }));
  return v;
}

/* Edit: add text and white-out boxes */
function toolEdit() {
  const v = toolShell('edit');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const total = js.numPages;
    const items = []; // {page, kind:'text'|'box', x, y (top-left, fraction), w, h (fraction, box only), text, size, color}
    let current = 1, selected = null, vw = 1, vh = 1;
    const ui = h(`<div style="margin-top:14px">
        <div class="field"><span>${esc(t('editMode'))}</span>${seg('mode', [['text', t('modeText')], ['box', t('modeBox')]], 'text')}</div>
        <div class="opts" data-p="text">
          <label class="field" style="grid-column:1/-1"><span>${esc(t('yourText'))}</span><textarea name="text" rows="2" dir="auto"></textarea></label>
          <label class="field"><span>${esc(t('fontSize'))}</span><input type="number" name="size" value="14" min="4" max="200"></label>
          <label class="field"><span>${esc(t('color'))}</span><input type="color" name="tcolor" value="#000000"></label>
        </div>
        <div class="opts hidden" data-p="box">
          <label class="field"><span>${esc(t('boxColor'))}</span><input type="color" name="bcolor" value="#ffffff"></label>
        </div>
        <p class="hint" data-hint></p>
        <div class="pager"><button class="btn small" data-prev>${esc(t('prev'))}</button><span data-pn></span><button class="btn small" data-next>${esc(t('next'))}</button></div>
        <div class="stage-wrap"><div class="stage"><img alt=""></div></div>
        <div class="btn-row" style="justify-content:center"><button class="btn primary" data-save>${esc(t('save'))}</button></div>
      </div>`);
    body.appendChild(ui);
    const stage = ui.querySelector('.stage'), stageImg = stage.querySelector('img');
    const mode = () => val(ui, 'mode');
    const syncMode = () => {
      ui.querySelectorAll('[data-p]').forEach(n => n.classList.toggle('hidden', n.dataset.p !== mode()));
      ui.querySelector('[data-hint]').textContent = t(mode() === 'text' ? 'editHintText' : 'editHintBox');
    };
    ui.addEventListener('change', e => { if (e.target.name === 'mode') { selected = null; syncMode(); drawItems(); } });
    syncMode();

    const textImg = it => textCanvas(it.text || ' ', { px: it.size, color: it.color, weight: '400', scale: 2 });
    // live-edit the selected item
    const field = n => ui.querySelector(`[name=${n}]`);
    field('text').addEventListener('input', () => { if (selected?.kind === 'text') { selected.text = field('text').value; drawItems(); } });
    field('size').addEventListener('input', () => { if (selected?.kind === 'text') { selected.size = Math.max(4, +field('size').value || 14); drawItems(); } });
    field('tcolor').addEventListener('input', () => { if (selected?.kind === 'text') { selected.color = field('tcolor').value; drawItems(); } });
    field('bcolor').addEventListener('input', () => { if (selected?.kind === 'box') { selected.color = field('bcolor').value; drawItems(); } });

    const cache = new Map();
    async function showPage(n) {
      current = n; selected = null;
      ui.querySelector('[data-pn]').textContent = `${n} / ${total}`;
      ui.querySelector('[data-prev]').disabled = n <= 1;
      ui.querySelector('[data-next]').disabled = n >= total;
      if (!cache.has(n)) {
        busy(true);
        try {
          const r = await renderPage(js, n, { width: Math.min(1400, Math.max(600, stage.parentElement.clientWidth * (window.devicePixelRatio || 1))) });
          cache.set(n, { url: r.canvas.toDataURL('image/jpeg', 0.85), w: r.width, h: r.height });
        } finally { busy(false); }
      }
      const c = cache.get(n); vw = c.w; vh = c.h; stageImg.src = c.url;
      drawItems();
    }
    function select(it) {
      selected = it;
      if (it) {
        const m = ui.querySelector(`[name=mode][value=${it.kind}]`); if (!m.checked) { m.checked = true; syncMode(); }
        if (it.kind === 'text') { field('text').value = it.text; field('size').value = it.size; field('tcolor').value = it.color; }
        else field('bcolor').value = it.color;
      }
      stage.querySelectorAll('.placed').forEach(n => n.classList.toggle('sel', n._it === it));
    }
    function drawItems() {
      stage.querySelectorAll('.placed').forEach(n => n.remove());
      for (const it of items.filter(i => i.page === current)) {
        const el = h(`<div class="placed${it === selected ? ' sel' : ''}"><button class="x" type="button">×</button><span class="rs"></span></div>`);
        el._it = it;
        const layout = () => {
          let w = it.w, hh = it.h;
          if (it.kind === 'text') { const tc = textImg(it); w = tc.width / vw; hh = tc.height / vh; if (!el._img || el._txt !== it.text + it.size + it.color) { el._txt = it.text + it.size + it.color; el.querySelector('img')?.remove(); const im = document.createElement('img'); im.src = tc.canvas.toDataURL(); el.prepend(im); el._img = im; } }
          else el.style.background = it.color;
          el.style.left = it.x * 100 + '%'; el.style.top = it.y * 100 + '%';
          el.style.width = w * 100 + '%'; el.style.height = hh * 100 + '%';
        };
        layout();
        const x = el.querySelector('.x');
        x.addEventListener('pointerdown', e => e.stopPropagation());
        x.addEventListener('click', e => { e.stopPropagation(); items.splice(items.indexOf(it), 1); if (selected === it) selected = null; drawItems(); });
        el.addEventListener('pointerdown', e => {
          if (e.target.classList.contains('rs') || e.target.classList.contains('x')) return;
          e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); select(it);
          const r = stage.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY, ox = it.x, oy = it.y;
          const mv = ev => { it.x = Math.min(0.98, Math.max(0, ox + (ev.clientX - sx) / r.width)); it.y = Math.min(0.98, Math.max(0, oy + (ev.clientY - sy) / r.height)); layout(); };
          const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
          el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        });
        const rs = el.querySelector('.rs');
        rs.addEventListener('pointerdown', e => {
          e.preventDefault(); e.stopPropagation(); rs.setPointerCapture(e.pointerId); select(it);
          const r = stage.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY, ow = it.w, oh = it.h, os = it.size;
          const mv = ev => {
            const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height;
            if (it.kind === 'box') { it.w = Math.max(0.01, ow + dx); it.h = Math.max(0.005, oh + dy); }
            else { it.size = Math.max(4, Math.round(os * (1 + dx * r.width / Math.max(40, el.offsetWidth)))); field('size').value = it.size; }
            layout();
          };
          const up = () => { rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); rs.removeEventListener('pointercancel', up); };
          rs.addEventListener('pointermove', mv); rs.addEventListener('pointerup', up); rs.addEventListener('pointercancel', up);
        });
        stage.appendChild(el);
      }
    }
    stage.addEventListener('click', e => {
      if (e.target !== stageImg) return;
      const r = stage.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      if (selected) { select(null); return; }
      let it;
      if (mode() === 'text') {
        const text = field('text').value.trim() ? field('text').value : t('sampleText');
        it = { page: current, kind: 'text', text, size: Math.max(4, +field('size').value || 14), color: field('tcolor').value, x: fx, y: Math.max(0, fy - 0.01) };
      } else {
        it = { page: current, kind: 'box', color: field('bcolor').value, w: 0.25, h: 0.03, x: Math.max(0, fx - 0.125), y: Math.max(0, fy - 0.015) };
      }
      items.push(it); selected = it; drawItems(); select(it);
      if (it.kind === 'text' && it.text === t('sampleText')) { field('text').value = ''; field('text').placeholder = t('sampleText'); field('text').focus({ preventScroll: true }); }
    });
    ui.querySelector('[data-prev]').addEventListener('click', () => showPage(current - 1));
    ui.querySelector('[data-next]').addEventListener('click', () => showPage(current + 1));
    ui.querySelector('[data-save]').addEventListener('click', () => run(v, async () => {
      if (!items.length) throw new Error(t('editNothing'));
      const doc = await loadLib(bytes);
      const pages = doc.getPages();
      // boxes first so text can sit on top of them
      for (const it of [...items].sort((a, b) => (a.kind === 'box' ? 0 : 1) - (b.kind === 'box' ? 0 : 1))) {
        const page = pages[it.page - 1]; const box = visualBox(page);
        if (it.kind === 'box') {
          const w = it.w * box.vw, hh = it.h * box.vh;
          const p = toUser(box, it.x * box.vw, box.vh - it.y * box.vh - hh);
          page.drawRectangle({ x: p.x, y: p.y, width: w, height: hh, color: hexToRgb(it.color), rotate: degrees(box.rot) });
        } else {
          if (!it.text.trim()) continue;
          const tc = textCanvas(it.text, { px: it.size, color: it.color, weight: '400', scale: 4 });
          const img = await embedCanvasPng(doc, tc.canvas);
          drawImageVisual(page, box, img, it.x * box.vw + tc.width / 2, box.vh - it.y * box.vh - tc.height / 2, tc.width, tc.height);
        }
      }
      await showResult(v, [{ name: baseName(file.name) + '-edited.pdf', data: await doc.save() }]);
    }));
    showPage(1);
  });
  return v;
}

/* Fill forms */
function toolForms() {
  const v = toolShell('forms');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const doc = await loadLib(bytes);
    const fields = doc.getForm().getFields();
    const L = window.PDFLib;
    const kindOf = f => f instanceof L.PDFTextField ? 'TextField' : f instanceof L.PDFCheckBox ? 'CheckBox' : f instanceof L.PDFDropdown ? 'Dropdown'
      : f instanceof L.PDFRadioGroup ? 'RadioGroup' : f instanceof L.PDFOptionList ? 'OptionList' : 'Other';
    const usable = fields.filter(f => ['TextField', 'CheckBox', 'Dropdown', 'RadioGroup', 'OptionList'].includes(kindOf(f)) && !f.isReadOnly());
    if (!usable.length) { body.appendChild(h(`<p class="hint">${esc(t('noFields'))} <a href="#edit">${esc(t('t_edit'))}</a></p>`)); return; }
    const pretty = n => n.replace(/[._\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
    const form = h(`<div><p class="hint">${esc(t('fieldsFound', { n: usable.length }))}</p><div class="opts"></div>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="flatten"> ${esc(t('flatten'))}</label>
        <p class="hint">${esc(t('flattenHint'))}</p>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('save'))}</button></div></div>`);
    const grid = form.querySelector('.opts');
    usable.forEach((f, i) => {
      const k = kindOf(f), label = esc(pretty(f.getName()) || `#${i + 1}`);
      let html;
      if (k === 'TextField') html = f.isMultiline()
        ? `<label class="field" style="grid-column:1/-1"><span>${label}</span><textarea data-i="${i}" rows="3" dir="auto">${esc(f.getText() || '')}</textarea></label>`
        : `<label class="field"><span>${label}</span><input type="text" data-i="${i}" dir="auto" value="${esc(f.getText() || '')}"></label>`;
      else if (k === 'CheckBox') html = `<label class="check field" style="flex-direction:row"><input type="checkbox" data-i="${i}" ${f.isChecked() ? 'checked' : ''}> ${label}</label>`;
      else {
        const sel = k === 'RadioGroup' ? f.getSelected() : (f.getSelected() || [])[0];
        html = `<label class="field"><span>${label}</span><select data-i="${i}"><option value=""></option>${f.getOptions().map(o => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      }
      grid.appendChild(h(html));
    });
    form.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const work = await loadLib(bytes);
      const wf = work.getForm();
      const helv = await work.embedFont(StandardFonts.Helvetica);
      const flatten = form.querySelector('[name=flatten]').checked;
      const latin = s => /^[\x00-\xFF–—‘’“”€]*$/.test(s);
      let needsViewerAppearance = false;
      const afterFlatten = [];
      for (const el of form.querySelectorAll('[data-i]')) {
        const f = wf.getField(usable[+el.dataset.i].getName());
        const k = kindOf(f);
        if (k === 'TextField') {
          const val2 = el.value;
          if (latin(val2)) { f.setText(val2 || undefined); f.updateAppearances(helv); continue; }
          if (flatten) {
            // Draw non-Latin (e.g. Arabic) text as an image inside each widget box, then leave the field empty.
            for (const w of f.acroField.getWidgets()) {
              const page = wf.findWidgetPage(w); const r = w.getRectangle();
              const fs = f.isMultiline() ? 11 : Math.min(14, r.height * 0.65);
              const tc = textCanvas(val2, { px: fs, color: '#000', weight: '400', scale: 4 });
              const s = Math.min(1, (r.width - 4) / tc.width, (r.height - 2) / tc.height);
              const img = await embedCanvasPng(work, tc.canvas);
              const w2 = tc.width * s, h2 = tc.height * s;
              const rtl = hasArabic(val2);
              afterFlatten.push(() => page.drawImage(img, { x: rtl ? r.x + r.width - w2 - 2 : r.x + 2, y: r.y + (r.height - h2) / 2, width: w2, height: h2 }));
            }
            f.setText(undefined); f.updateAppearances(helv);
          } else { f.setText(val2); needsViewerAppearance = true; }
        } else if (k === 'CheckBox') { el.checked ? f.check() : f.uncheck(); f.updateAppearances(); }
        else if (k === 'RadioGroup') { if (el.value) f.select(el.value); else f.clear(); f.updateAppearances(); }
        else { if (el.value) f.select(el.value); else f.clear(); f.updateAppearances(helv); }
      }
      if (flatten) { wf.flatten({ updateFieldAppearances: false }); afterFlatten.forEach(fn => fn()); }
      if (needsViewerAppearance) wf.acroForm.dict.set(window.PDFLib.PDFName.of('NeedAppearances'), window.PDFLib.PDFBool.True);
      await showResult(v, [{ name: baseName(file.name) + '-filled.pdf', data: await work.save({ updateFieldAppearances: false }) }]);
    }));
    body.appendChild(form);
  });
  return v;
}

/* Compress (two modes: smart keeps text, maximum turns pages into images) */
async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function smartCompress(bytes, maxSide, quality) {
  const L = window.PDFLib; const { PDFName, PDFRawStream, PDFArray, PDFNumber } = L;
  const doc = await loadLib(bytes);
  const N = k => PDFName.of(k);
  const num = o => (o instanceof PDFNumber ? o.asNumber() : 0);
  const objs = doc.context.enumerateIndirectObjects();
  let changed = 0, k = 0;
  for (const [ref, obj] of objs) {
    k++;
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (String(d.get(N('Subtype'))) !== '/Image' || d.get(N('ImageMask')) || d.get(N('Decode'))) continue;
    const w = num(d.lookup(N('Width'))), hgt = num(d.lookup(N('Height')));
    if (w * hgt < 40000 || obj.contents.length < 15000) continue;
    let f = d.lookup(N('Filter'));
    if (f instanceof PDFArray) f = f.size() === 1 ? f.lookup(0) : null;
    const filter = f ? String(f) : '';
    let cs = d.lookup(N('ColorSpace')), comps = 0;
    if (cs instanceof PDFName) comps = { '/DeviceRGB': 3, '/DeviceGray': 1 }[String(cs)] || 0;
    else if (cs instanceof PDFArray && String(cs.lookup(0)) === '/ICCBased') { const s = cs.lookup(1); comps = s && s.dict ? num(s.dict.lookup(N('N'))) : 0; if (comps !== 1 && comps !== 3) comps = 0; }
    if (!comps) continue;
    if (k % 5 === 0) await progress(t('compressImages', { n: changed }));
    const scale = Math.min(1, maxSide / Math.max(w, hgt));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(hgt * scale));
    const ctx = c.getContext('2d');
    try {
      if (filter === '/DCTDecode') {
        const bmp = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
        ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
      } else if (filter === '/FlateDecode' && num(d.lookup(N('BitsPerComponent'))) === 8) {
        const dp = d.lookup(N('DecodeParms'));
        if (dp && num(dp.lookup?.(N('Predictor'))) > 1) continue;
        const raw = await inflate(obj.contents);
        if (raw.length < w * hgt * comps) continue;
        const id = new ImageData(w, hgt);
        for (let i = 0, j = 0; i < w * hgt; i++, j += comps) {
          const o = i * 4;
          if (comps === 3) { id.data[o] = raw[j]; id.data[o + 1] = raw[j + 1]; id.data[o + 2] = raw[j + 2]; }
          else id.data[o] = id.data[o + 1] = id.data[o + 2] = raw[j];
          id.data[o + 3] = 255;
        }
        const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = hgt; tmp.getContext('2d').putImageData(id, 0, 0);
        ctx.drawImage(tmp, 0, 0, c.width, c.height); tmp.width = tmp.height = 0;
      } else continue;
    } catch { continue; }
    const jpg = new Uint8Array(await (await canvasBlob(c, 'image/jpeg', quality)).arrayBuffer());
    c.width = c.height = 0;
    if (jpg.length >= obj.contents.length * 0.9) continue;
    const nd = doc.context.obj({});
    for (const [key, value] of d.entries()) {
      if (!['/Filter', '/DecodeParms', '/Length', '/Width', '/Height', '/ColorSpace', '/BitsPerComponent'].includes(String(key))) nd.set(key, value);
    }
    nd.set(N('Width'), PDFNumber.of(Math.max(1, Math.round(w * scale)))); nd.set(N('Height'), PDFNumber.of(Math.max(1, Math.round(hgt * scale))));
    nd.set(N('ColorSpace'), N('DeviceRGB')); nd.set(N('BitsPerComponent'), PDFNumber.of(8)); nd.set(N('Filter'), N('DCTDecode'));
    doc.context.assign(ref, PDFRawStream.of(nd, jpg));
    changed++;
  }
  return { data: await doc.save({ useObjectStreams: true }), changed };
}

function toolCompress() {
  const v = toolShell('compress');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: js.numPages }))}</p>
        <div class="field" style="margin-top:12px"><span>${esc(t('compressMode'))}</span>
          ${seg('mode', [['smart', t('modeSmart')], ['raster', t('modeRaster')]], 'smart')}</div>
        <div class="field" style="margin-top:12px"><span>${esc(t('level'))}</span>
          ${seg('lvl', [['light', t('lvlLight')], ['medium', t('lvlMedium')], ['strong', t('lvlStrong')]], 'medium')}</div>
        <p class="hint" data-note></p>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('compressBtn'))}</button></div></div>`);
    const note = () => { const n = opts.querySelector('[data-note]'); const smart = val(opts, 'mode') === 'smart'; n.textContent = t(smart ? 'smartNote' : 'compressNote'); n.className = smart ? 'hint' : 'warn'; };
    opts.addEventListener('change', note); note();
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const lvl = val(opts, 'lvl');
      let data;
      if (val(opts, 'mode') === 'smart') {
        const S = { light: [2400, 0.8], medium: [1600, 0.68], strong: [1100, 0.5] }[lvl];
        ({ data } = await smartCompress(bytes, S[0], S[1]));
      } else {
        const R = { light: [2, 0.75], medium: [1.5, 0.6], strong: [1.1, 0.45] }[lvl];
        const out = await PDFDocument.create();
        for (let i = 1; i <= js.numPages; i++) {
          await progress(t('processingPage', { n: i, total: js.numPages }));
          const { canvas, width, height } = await renderPage(js, i, { scale: R[0], maxSide: 3000 });
          const blob = await canvasBlob(canvas, 'image/jpeg', R[1]);
          canvas.width = canvas.height = 0;
          const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
          out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
        }
        data = await out.save();
      }
      const smaller = data.length < bytes.length * 0.98;
      const pct = Math.round((1 - data.length / bytes.length) * 100);
      const info = `<p>${esc(t('sizeChange', { a: fmtSize(bytes.length), b: fmtSize(smaller ? data.length : bytes.length) }))} ${smaller ? `(−${pct}%)` : ''}</p>`
        + (smaller ? '' : `<p class="warn">${esc(t(val(opts, 'mode') === 'smart' ? 'smartNoGain' : 'compressNoGain'))}</p>`);
      if (!smaller) data = bytes;
      await showResult(v, [{ name: baseName(file.name) + '-compressed.pdf', data }], info);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* ---------- small geometry helpers for the scanner ---------- */
function otsu(gray) {
  const hist = new Array(256).fill(0); for (const g of gray) hist[g]++;
  const total = gray.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sumB += i * hist[i]; const mB = sumB / wB, mF = (sum - sumB) / wF; const b = wB * wF * (mB - mF) ** 2;
    if (b > best) { best = b; th = i; }
  }
  return th;
}
/** Guess the paper's 4 corners in a photo. Returns fractions [tl, tr, br, bl] or null. */
function detectPaper(canvas) {
  const S = 240; const sc = S / Math.max(canvas.width, canvas.height);
  const w = Math.max(8, Math.round(canvas.width * sc)), hh = Math.max(8, Math.round(canvas.height * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const ctx = c.getContext('2d'); ctx.filter = 'blur(1px)'; ctx.drawImage(canvas, 0, 0, w, hh);
  const px = ctx.getImageData(0, 0, w, hh).data; const gray = new Uint8Array(w * hh);
  for (let i = 0; i < w * hh; i++) gray[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) | 0;
  const th = otsu(gray);
  const lab = new Int32Array(w * hh).fill(-1); let bestId = -1, bestSize = 0, id = 0; const stack = [];
  for (let s = 0; s < w * hh; s++) {
    if (gray[s] <= th || lab[s] !== -1) continue;
    let size = 0; stack.push(s); lab[s] = id;
    while (stack.length) {
      const p = stack.pop(); size++; const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < hh - 1 ? p + w : -1]) {
        if (q >= 0 && lab[q] === -1 && gray[q] > th) { lab[q] = id; stack.push(q); }
      }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestSize < w * hh * 0.15 || bestSize > w * hh * 0.97) return null;
  let tl, tr, br, bl, a = Infinity, b = -Infinity, cc = -Infinity, dd = Infinity;
  for (let p = 0; p < w * hh; p++) {
    if (lab[p] !== bestId) continue; const x = p % w, y = (p / w) | 0;
    if (x + y < a) { a = x + y; tl = [x, y]; } if (x + y > b) { b = x + y; br = [x, y]; }
    if (x - y > cc) { cc = x - y; tr = [x, y]; } if (x - y < dd) { dd = x - y; bl = [x, y]; }
  }
  return [tl, tr, br, bl].map(([x, y]) => ({ x: x / (w - 1), y: y / (hh - 1) }));
}
/** Perspective-correct the quad (pixel corners tl,tr,br,bl) of src into a flat rectangle. */
function warpQuad(src, q, maxOut = 2200) {
  const d = (p, r) => Math.hypot(p.x - r.x, p.y - r.y);
  let W = Math.max(d(q[0], q[1]), d(q[3], q[2])), H = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  const s = Math.min(1, maxOut / Math.max(W, H)); W = Math.max(2, Math.round(W * s)); H = Math.max(2, Math.round(H * s));
  // square -> quad homography
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den, hh = (dx1 * sy - sx * dy1) / den;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hh * p3.x, c = p0.x;
  const dd = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hh * p3.y, f = p0.y;
  const sctx = src.getContext('2d'); const sd = sctx.getImageData(0, 0, src.width, src.height).data; const SW = src.width, SH = src.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d'); const od = octx.createImageData(W, H); const o = od.data;
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1); const z = g * u + hh * v + 1;
      let X = (a * u + b * v + c) / z, Y = (dd * u + e * v + f) / z;
      X = Math.min(SW - 1.001, Math.max(0, X)); Y = Math.min(SH - 1.001, Math.max(0, Y));
      const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0;
      const i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4; const k = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        o[k + ch] = (sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx) * (1 - fy) + (sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx) * fy;
      }
      o[k + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}
/** Clean-up filters: 'color' (light boost), 'gray', 'doc' (flattened lighting, crisp black on white). */
function enhance(src, mode) {
  const W = src.width, H = src.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const ctx = out.getContext('2d'); ctx.drawImage(src, 0, 0);
  if (mode === 'original') return out;
  const id = ctx.getImageData(0, 0, W, H); const p = id.data;
  if (mode === 'color') {
    for (let i = 0; i < p.length; i += 4) for (let c = 0; c < 3; c++) p[i + c] = Math.min(255, Math.max(0, (p[i + c] - 128) * 1.15 + 140));
  } else {
    // background estimate: heavy blur at low resolution
    const bw = Math.max(4, Math.round(W / 24)), bh = Math.max(4, Math.round(H / 24));
    const b = document.createElement('canvas'); b.width = bw; b.height = bh; const bctx = b.getContext('2d');
    bctx.filter = 'blur(2px)'; bctx.drawImage(src, 0, 0, bw, bh);
    const big = document.createElement('canvas'); big.width = W; big.height = H; const g2 = big.getContext('2d');
    g2.imageSmoothingQuality = 'high'; g2.drawImage(b, 0, 0, W, H);
    const bg = g2.getImageData(0, 0, W, H).data;
    for (let i = 0; i < p.length; i += 4) {
      const gray = p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11;
      let vOut;
      if (mode === 'gray') vOut = gray;
      else {
        const bgv = Math.max(1, bg[i] * 0.3 + bg[i + 1] * 0.59 + bg[i + 2] * 0.11);
        let r = gray / bgv; // ~1 for paper, lower for ink
        r = (r - 0.55) / 0.33; // stretch
        vOut = 255 * Math.min(1, Math.max(0, r)) ** 1.6;
      }
      p[i] = p[i + 1] = p[i + 2] = vOut;
    }
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

/* Scan with camera */
function toolScan() {
  const v = toolShell('scan');
  const body = v.querySelector('.body');
  const pages = []; // {src: canvas, quad: [{x,y} fractions], rot: 0}
  let filter = 'doc';
  const pick = h(`<div>
      <div class="btn-row" style="margin-top:0">
        <label class="btn primary">${esc(t('takePhoto'))}<input type="file" accept="image/*" capture="environment" hidden data-cam></label>
        <label class="btn">${esc(t('chooseImages'))}<input type="file" accept="image/*" multiple hidden data-pick></label>
      </div>
      <p class="hint">${esc(t('scanHint'))}</p>
      <div data-editor></div>
      <div data-list></div>
    </div>`);
  body.appendChild(pick);
  const listEl = pick.querySelector('[data-list]'), editorEl = pick.querySelector('[data-editor]');
  async function addFiles(files) {
    await run(v, async () => {
      for (const f of files) {
        await progress(t('working'));
        const src = await imageToCanvas(f, 2400);
        const quad = detectPaper(src) || [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
        pages.push({ src, quad, rot: 0 });
      }
    });
    drawList();
    if (files.length === 1) editCorners(pages[pages.length - 1]);
  }
  pick.querySelectorAll('input[type=file]').forEach(i => i.addEventListener('change', () => { if (i.files.length) addFiles([...i.files]); i.value = ''; }));

  function processed(pg, maxOut = 2200) {
    const q = pg.quad.map(p => ({ x: p.x * (pg.src.width - 1), y: p.y * (pg.src.height - 1) }));
    let c = warpQuad(pg.src, q, maxOut);
    if (pg.rot) {
      const r = document.createElement('canvas'); const swap = pg.rot % 180 !== 0;
      r.width = swap ? c.height : c.width; r.height = swap ? c.width : c.height;
      const x = r.getContext('2d'); x.translate(r.width / 2, r.height / 2); x.rotate(pg.rot * Math.PI / 180); x.drawImage(c, -c.width / 2, -c.height / 2); c = r;
    }
    return enhance(c, filter);
  }
  function drawList() {
    listEl.innerHTML = '';
    if (!pages.length) return;
    const fl = h(`<div class="field" style="margin-top:14px"><span>${esc(t('scanLook'))}</span>
        ${seg('look', [['doc', t('lookDoc')], ['gray', t('lookGray')], ['color', t('lookColor')], ['original', t('lookOriginal')]], filter)}</div>`);
    fl.addEventListener('change', () => { filter = val(fl, 'look'); drawList(); });
    listEl.appendChild(fl);
    const grid = h('<div class="pages"></div>');
    pages.forEach((pg, i) => {
      const card = h(`<div class="pg" style="cursor:default"><span class="num">${i + 1}</span><div class="box"><img alt=""></div>
          <div class="acts">
            <button class="icon-btn" data-a="back" title="${esc(t('moveUp'))}">${lang === 'ar' ? ICONS.right : ICONS.left}</button>
            <button class="icon-btn" data-a="crop" title="${esc(t('adjustCorners'))}">${ICONS.crop}</button>
            <button class="icon-btn" data-a="rot" title="${esc(t('rotRight'))}">${ICONS.rotR}</button>
            <button class="icon-btn" data-a="del" title="${esc(t('remove'))}">${ICONS.trash}</button>
            <button class="icon-btn" data-a="fwd" title="${esc(t('moveDown'))}">${lang === 'ar' ? ICONS.left : ICONS.right}</button>
          </div></div>`);
      requestAnimationFrame(() => { card.querySelector('img').src = processed(pg, 500).toDataURL('image/jpeg', 0.8); });
      card.addEventListener('click', e => {
        const a = e.target.closest('button')?.dataset.a; if (!a) return;
        if (a === 'crop') return editCorners(pg);
        if (a === 'rot') pg.rot = (pg.rot + 90) % 360;
        if (a === 'del') pages.splice(i, 1);
        if (a === 'back' && i > 0) [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
        if (a === 'fwd' && i < pages.length - 1) [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
        drawList();
      });
      grid.appendChild(card);
    });
    listEl.appendChild(grid);
    const row = h(`<div class="btn-row"><button class="btn primary" data-go>${esc(t('makePdf'))}</button></div>`);
    row.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const out = await PDFDocument.create();
      for (let i = 0; i < pages.length; i++) {
        await progress(t('processingPage', { n: i + 1, total: pages.length }));
        const c = processed(pages[i]);
        const img = await out.embedJpg(new Uint8Array(await (await canvasBlob(c, 'image/jpeg', filter === 'doc' ? 0.7 : 0.8)).arrayBuffer()));
        let [pw, ph] = [595.28, 841.89]; if (c.width > c.height) [pw, ph] = [ph, pw];
        const s = Math.min(pw / c.width, ph / c.height); const w = c.width * s, hh = c.height * s;
        out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
        c.width = c.height = 0;
      }
      await showResult(v, [{ name: 'scan.pdf', data: await out.save() }]);
    }));
    listEl.appendChild(row);
  }
  function editCorners(pg) {
    editorEl.innerHTML = '';
    const q = pg.quad.map(p => ({ ...p }));
    const ed = h(`<div class="panel" style="margin-top:12px;padding:12px">
        <p class="hint" style="margin-top:0">${esc(t('cornersHint'))}</p>
        <div class="stage-wrap"><div class="stage quad-stage"><img alt="" src="${pg.src.toDataURL('image/jpeg', 0.8)}">
          <svg class="quad" preserveAspectRatio="none" viewBox="0 0 1000 1000"><polygon /></svg>
          ${[0, 1, 2, 3].map(i => `<span class="corner" data-c="${i}"></span>`).join('')}</div></div>
        <div class="btn-row" style="justify-content:center"><button class="btn" data-whole>${esc(t('wholePhoto'))}</button><button class="btn primary" data-done>${esc(t('doneBtn'))}</button></div></div>`);
    const stage = ed.querySelector('.stage'), poly = ed.querySelector('polygon');
    const lay = () => {
      ed.querySelectorAll('.corner').forEach((c, i) => { c.style.left = q[i].x * 100 + '%'; c.style.top = q[i].y * 100 + '%'; });
      poly.setAttribute('points', q.map(p => `${p.x * 1000},${p.y * 1000}`).join(' '));
    };
    lay();
    ed.querySelectorAll('.corner').forEach(c => c.addEventListener('pointerdown', e => {
      e.preventDefault(); c.setPointerCapture(e.pointerId); const i = +c.dataset.c; const r = stage.getBoundingClientRect();
      const mv = ev => { q[i].x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)); q[i].y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)); lay(); };
      const up = () => { c.removeEventListener('pointermove', mv); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); };
      c.addEventListener('pointermove', mv); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    }));
    ed.querySelector('[data-whole]').addEventListener('click', () => { q.splice(0, 4, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }); lay(); });
    ed.querySelector('[data-done]').addEventListener('click', () => { pg.quad = q; editorEl.innerHTML = ''; drawList(); });
    editorEl.appendChild(ed);
    ed.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return v;
}

/* Page viewer used by Crop and Redact */
function pageViewer(ui, js, onShow) {
  const total = js.numPages; const cache = new Map();
  const stage = ui.querySelector('.stage'), img = stage.querySelector('img');
  const view = { current: 1, w: 1, h: 1, stage, img };
  view.show = async n => {
    view.current = n;
    ui.querySelector('[data-pn]').textContent = `${n} / ${total}`;
    ui.querySelector('[data-prev]').disabled = n <= 1;
    ui.querySelector('[data-next]').disabled = n >= total;
    if (!cache.has(n)) {
      busy(true);
      try { const r = await renderPage(js, n, { width: Math.min(1400, Math.max(600, stage.parentElement.clientWidth * (window.devicePixelRatio || 1))) }); cache.set(n, { url: r.canvas.toDataURL('image/jpeg', 0.85), w: r.width, h: r.height }); }
      finally { busy(false); }
    }
    const c = cache.get(n); view.w = c.w; view.h = c.h; img.src = c.url; onShow(n);
  };
  ui.querySelector('[data-prev]').addEventListener('click', () => view.show(view.current - 1));
  ui.querySelector('[data-next]').addEventListener('click', () => view.show(view.current + 1));
  return view;
}
const pagerHtml = () => `<div class="pager"><button class="btn small" data-prev>${esc(t('prev'))}</button><span data-pn></span><button class="btn small" data-next>${esc(t('next'))}</button></div>
  <div class="stage-wrap"><div class="stage"><img alt=""></div></div>`;
/** Make a rectangle element draggable (move) and resizable (corner dot). r = {x,y,w,h} fractions. */
function rectDrag(el, stage, r, onChange) {
  const drag = (e, fn) => {
    e.preventDefault(); e.stopPropagation(); e.target.setPointerCapture(e.pointerId);
    const b = stage.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, o = { ...r };
    const mv = ev => { fn(o, (ev.clientX - sx) / b.width, (ev.clientY - sy) / b.height); onChange(); };
    const up = () => { e.target.removeEventListener('pointermove', mv); e.target.removeEventListener('pointerup', up); e.target.removeEventListener('pointercancel', up); };
    e.target.addEventListener('pointermove', mv); e.target.addEventListener('pointerup', up); e.target.addEventListener('pointercancel', up);
  };
  el.addEventListener('pointerdown', e => {
    if (e.target !== el) return;
    drag(e, (o, dx, dy) => { r.x = Math.min(1 - r.w, Math.max(0, o.x + dx)); r.y = Math.min(1 - r.h, Math.max(0, o.y + dy)); });
  });
  el.querySelectorAll('[data-h]').forEach(hd => hd.addEventListener('pointerdown', e => drag(e, (o, dx, dy) => {
    const k = hd.dataset.h;
    if (k.includes('l')) { const nx = Math.min(o.x + o.w - 0.02, Math.max(0, o.x + dx)); r.w = o.w + (o.x - nx); r.x = nx; }
    if (k.includes('r')) r.w = Math.min(1 - o.x, Math.max(0.02, o.w + dx));
    if (k.includes('t')) { const ny = Math.min(o.y + o.h - 0.02, Math.max(0, o.y + dy)); r.h = o.h + (o.y - ny); r.y = ny; }
    if (k.includes('b')) r.h = Math.min(1 - o.y, Math.max(0.01, o.h + dy));
  })));
}
const placeRect = (el, r) => { el.style.left = r.x * 100 + '%'; el.style.top = r.y * 100 + '%'; el.style.width = r.w * 100 + '%'; el.style.height = r.h * 100 + '%'; };
/** Visual rect (fractions, top-left origin) -> PDF user-space rectangle. */
function rectToUser(page, r) {
  const box = visualBox(page);
  const a = toUser(box, r.x * box.vw, box.vh - (r.y + r.h) * box.vh), b = toUser(box, (r.x + r.w) * box.vw, box.vh - r.y * box.vh);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/* Crop */
function toolCrop() {
  const v = toolShell('crop');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const r = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };
    const ui = h(`<div style="margin-top:14px">
        <p class="hint" style="margin-top:0">${esc(t('cropHint'))}</p>
        <div class="field"><span>${esc(t('applyTo'))}</span>${seg('scope', [['all', t('allPages')], ['this', t('thisPage')]], 'all')}</div>
        ${pagerHtml()}
        <div class="btn-row" style="justify-content:center"><button class="btn primary" data-save>${esc(t('cropBtn'))}</button></div></div>`);
    body.appendChild(ui);
    const view = pageViewer(ui, js, () => {});
    const el = h(`<div class="crop-rect">${['tl', 'tr', 'bl', 'br'].map(k => `<span class="hd" data-h="${k}"></span>`).join('')}</div>`);
    view.stage.appendChild(el); placeRect(el, r);
    rectDrag(el, view.stage, r, () => placeRect(el, r));
    ui.querySelector('[data-save]').addEventListener('click', () => run(v, async () => {
      const doc = await loadLib(bytes); const pages = doc.getPages();
      const targets = val(ui, 'scope') === 'all' ? pages : [pages[view.current - 1]];
      for (const p of targets) { const u = rectToUser(p, r); p.setMediaBox(u.x, u.y, u.width, u.height); p.setCropBox(u.x, u.y, u.width, u.height); }
      await showResult(v, [{ name: baseName(file.name) + '-cropped.pdf', data: await doc.save() }]);
    }));
    view.show(1);
  });
  return v;
}

/* Redact */
function toolRedact() {
  const v = toolShell('redact');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const boxes = []; // {page, x, y, w, h}
    const ui = h(`<div style="margin-top:14px">
        <p class="hint" style="margin-top:0">${esc(t('redactHint'))}</p>
        ${pagerHtml()}
        <p class="warn">${esc(t('redactNote'))}</p>
        <div class="btn-row" style="justify-content:center"><button class="btn primary" data-save>${esc(t('redactBtn'))}</button></div></div>`);
    body.appendChild(ui);
    const view = pageViewer(ui, js, () => draw());
    function draw() {
      view.stage.querySelectorAll('.redact-box').forEach(n => n.remove());
      for (const b of boxes.filter(x => x.page === view.current)) {
        const el = h(`<div class="redact-box"><button class="x" type="button">×</button><span class="hd" data-h="br"></span></div>`);
        placeRect(el, b);
        el.querySelector('.x').addEventListener('pointerdown', e => e.stopPropagation());
        el.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); boxes.splice(boxes.indexOf(b), 1); draw(); });
        rectDrag(el, view.stage, b, () => placeRect(el, b));
        view.stage.appendChild(el);
      }
    }
    view.stage.addEventListener('click', e => {
      if (e.target !== view.img) return;
      const r = view.stage.getBoundingClientRect(); const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const w = 0.3, hh = 0.035;
      boxes.push({ page: view.current, w, h: hh, x: Math.min(1 - w, Math.max(0, fx - w / 2)), y: Math.min(1 - hh, Math.max(0, fy - hh / 2)) });
      draw();
    });
    ui.querySelector('[data-save]').addEventListener('click', () => run(v, async () => {
      if (!boxes.length) throw new Error(t('redactNothing'));
      const doc = await loadLib(bytes);
      const pageNums = [...new Set(boxes.map(b => b.page))].sort((a, b) => a - b);
      for (const n of pageNums) {
        await progress(t('processingPage', { n, total: js.numPages }));
        const { canvas, width, height } = await renderPage(js, n, { scale: 200 / 72, maxSide: 3500 });
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000';
        for (const b of boxes.filter(x => x.page === n)) ctx.fillRect(b.x * canvas.width, b.y * canvas.height, b.w * canvas.width, b.h * canvas.height);
        const img = await doc.embedJpg(new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.85)).arrayBuffer()));
        canvas.width = canvas.height = 0;
        const np = doc.insertPage(n - 1, [width, height]);
        np.drawImage(img, { x: 0, y: 0, width, height });
        doc.removePage(n);
      }
      await showResult(v, [{ name: baseName(file.name) + '-redacted.pdf', data: await doc.save() }]);
    }));
    view.show(1);
  });
  return v;
}

/* Files shared into the app (Android share sheet, or "Open with" on desktop) */
let incomingFiles = null;
async function readSharedFiles() {
  try {
    const cache = await caches.open('shared-files');
    const keys = await cache.keys(); const files = [];
    for (const k of keys) {
      const r = await cache.match(k); const blob = await r.blob();
      files.push(new File([blob], decodeURIComponent(r.headers.get('x-name') || 'file'), { type: blob.type }));
      await cache.delete(k);
    }
    return files;
  } catch { return []; }
}
function sharedView() {
  const v = h(`<section><div class="tool-head"><a class="back" href="#">${lang === 'ar' ? '→' : '←'} ${esc(t('back'))}</a><h2>${esc(t('sharedTitle'))}</h2></div>
      <p class="tool-desc" data-names></p><div class="grid"></div></section>`);
  (async () => {
    if (!incomingFiles || !incomingFiles.length) incomingFiles = await readSharedFiles();
    const files = incomingFiles || [];
    if (!files.length) { v.querySelector('[data-names]').textContent = t('sharedNone'); return; }
    v.querySelector('[data-names]').textContent = t('sharedPick', { names: files.map(f => f.name).join(', ') });
    const isPdf = files.some(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const ids = isPdf ? TOOLS.map(x => x.id).filter(id => !['img2pdf', 'scan'].includes(id)) : ['img2pdf', 'scan', 'ocr'];
    const g = v.querySelector('.grid');
    for (const id of ids) g.appendChild(h(`<a class="tool-card" href="#${id}"><div class="ico">${ICONS[id]}</div><b>${esc(t('t_' + id))}</b><span>${esc(t('d_' + id))}</span></a>`));
  })();
  return v;
}
function feedIncoming(view) {
  if (!incomingFiles || !incomingFiles.length) return;
  const files = incomingFiles; incomingFiles = null;
  const inp = view.querySelector('.drop input, input[data-pick]');
  if (!inp) return;
  try { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); inp.files = dt.files; inp.dispatchEvent(new Event('change')); } catch {}
}
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files || !params.files.length) return;
    incomingFiles = await Promise.all(params.files.map(fh => fh.getFile()));
    location.hash = 'shared'; route(true);
  });
}

/* ---------------- home: search + recently used ---------------- */
function getRecent() { try { return JSON.parse(localStorage.getItem('recent') || '[]').filter(id => TOOLS.some(x => x.id === id)); } catch { return []; } }
function addRecent(id) { try { const r = [id, ...getRecent().filter(x => x !== id)].slice(0, 4); localStorage.setItem('recent', JSON.stringify(r)); } catch {} }
const toolCard = id => h(`<a class="tool-card" href="#${id}" data-id="${id}"><div class="ico">${ICONS[id]}</div><b>${esc(t('t_' + id))}</b><span>${esc(t('d_' + id))}</span></a>`);
const norm = s => String(s).toLowerCase().normalize('NFKC').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
function home() {
  const v = h(`<section>
      <div class="hero"><h1>${esc(t('heroTitle'))}</h1><p>${esc(t('heroSub'))}</p></div>
      <input class="tool-search" type="search" placeholder="${esc(t('searchTools'))}" aria-label="${esc(t('searchTools'))}">
      <div data-recent></div>
      <div class="grid" data-all></div>
      <p class="hint hidden" data-none>${esc(t('noToolsFound'))}</p></section>`);
  const recent = getRecent();
  if (recent.length) {
    const r = h(`<div style="margin-bottom:16px"><h3 class="sec-title">${esc(t('recentTools'))}</h3><div class="grid"></div></div>`);
    recent.forEach(id => r.querySelector('.grid').appendChild(toolCard(id)));
    v.querySelector('[data-recent]').appendChild(r);
  }
  const g = v.querySelector('[data-all]');
  for (const tool of TOOLS) g.appendChild(toolCard(tool.id));
  const input = v.querySelector('.tool-search');
  input.addEventListener('input', () => {
    const q = norm(input.value.trim());
    v.querySelector('[data-recent]').classList.toggle('hidden', !!q);
    let shown = 0;
    g.querySelectorAll('.tool-card').forEach(c => {
      const id = c.dataset.id;
      const hay = norm(['en', 'ar'].map(l => `${STRINGS[l]['t_' + id]} ${STRINGS[l]['d_' + id]}`).join(' ') + ' ' + id);
      const ok = !q || q.split(/\s+/).every(w => hay.includes(w));
      c.classList.toggle('hidden', !ok); if (ok) shown++;
    });
    v.querySelector('[data-none]').classList.toggle('hidden', shown > 0);
  });
  return v;
}

/* ---------------- "continue with another tool" ---------------- */
function addContinue(resultEl, file) {
  if (file.type !== 'application/pdf') return;
  const row = resultEl.querySelector('.btn-row');
  const btn = h(`<button class="btn" data-continue>${esc(t('continueWith'))}</button>`);
  row.appendChild(btn);
  btn.addEventListener('click', () => {
    if (resultEl.querySelector('.continue-list')) { resultEl.querySelector('.continue-list').remove(); return; }
    const list = h(`<div class="continue-list"><p class="hint">${esc(t('continueHint'))}</p><div class="chips"></div></div>`);
    for (const tool of TOOLS) {
      if (['img2pdf', 'scan'].includes(tool.id)) continue;
      const c = h(`<button class="chip">${ICONS[tool.id].replace('<svg', '<svg width="16" height="16"')}<span>${esc(t('t_' + tool.id))}</span></button>`);
      c.addEventListener('click', () => {
        incomingFiles = [file];
        if (location.hash.slice(1) === tool.id) route(true); else location.hash = tool.id;
      });
      list.querySelector('.chips').appendChild(c);
    }
    resultEl.appendChild(list);
  });
}

/* ---------------- Read PDF (viewer with search) ---------------- */
function toolView() {
  const v = toolShell('view');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const total = js.numPages;
    const ui = h(`<div style="margin-top:12px">
        <div class="search-row"><input type="search" name="q" placeholder="${esc(t('searchInPdf'))}" dir="auto"><button class="btn" data-find>${esc(t('find'))}</button></div>
        <div class="search-results hidden"></div>
        <div class="btn-row"><button class="btn small" data-zoom="-1">−</button><span data-zl style="align-self:center">100%</span><button class="btn small" data-zoom="1">+</button>
          <span class="hint" style="align-self:center;margin:0">${esc(t('pages', { n: total }))}</span></div>
        <div class="reader"></div></div>`);
    body.appendChild(ui);
    const reader = ui.querySelector('.reader');
    let zoom = 1;
    const sizes = [];
    for (let i = 1; i <= total; i++) { const pg = await js.getPage(i); const vp = pg.getViewport({ scale: 1 }); sizes.push([vp.width, vp.height]); }
    const rendered = new Map();
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) renderInto(e.target); }), { rootMargin: '600px' });
    let queue = Promise.resolve();
    function renderInto(el) {
      const n = +el.dataset.p; const want = Math.round(el.clientWidth * Math.min(2, window.devicePixelRatio || 1));
      if ((rendered.get(n) || 0) >= want) return;
      rendered.set(n, want);
      queue = queue.then(async () => { const { canvas } = await renderPage(js, n, { width: want }); el.querySelector('img').src = canvas.toDataURL('image/jpeg', 0.85); }).catch(console.error);
    }
    function layout() {
      reader.innerHTML = '';
      reader.style.setProperty('--zoom', zoom);
      ui.querySelector('[data-zl]').textContent = Math.round(zoom * 100) + '%';
      rendered.clear();
      sizes.forEach(([w, hh], i) => {
        const el = h(`<div class="rpage" data-p="${i + 1}" style="aspect-ratio:${w}/${hh}"><img alt=""><span class="num">${i + 1}</span></div>`);
        reader.appendChild(el); io.observe(el);
      });
    }
    ui.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => { zoom = Math.min(3, Math.max(0.5, zoom + 0.25 * +b.dataset.zoom)); layout(); }));
    let texts = null;
    async function find() {
      const q = norm(ui.querySelector('[name=q]').value.trim());
      const box = ui.querySelector('.search-results');
      if (!q) { box.classList.add('hidden'); return; }
      busy(true);
      try {
        if (!texts) { texts = []; for (let i = 1; i <= total; i++) { await progress(t('processingPage', { n: i, total })); const tc = await (await js.getPage(i)).getTextContent(); texts.push(tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('')); } }
      } finally { busy(false); }
      const hits = [];
      texts.forEach((tx, i) => {
        const n = norm(tx); let k = n.indexOf(q);
        while (k >= 0 && hits.length < 200) { hits.push({ page: i + 1, snip: tx.slice(Math.max(0, k - 30), k + q.length + 30).replace(/\s+/g, ' ') }); k = n.indexOf(q, k + q.length); }
      });
      box.classList.remove('hidden'); box.innerHTML = '';
      box.appendChild(h(`<p class="hint" style="margin:0 0 6px">${esc(hits.length ? t('foundN', { n: hits.length }) : t('notFound'))}</p>`));
      hits.forEach(hit => {
        const b = h(`<button class="hit"><b>${esc(t('page', { n: hit.page }))}</b> <span dir="auto">…${esc(hit.snip)}…</span></button>`);
        b.addEventListener('click', () => {
          const el = reader.querySelector(`[data-p="${hit.page}"]`); el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          reader.querySelectorAll('.rpage.hl').forEach(x => x.classList.remove('hl')); el.classList.add('hl');
        });
        box.appendChild(b);
      });
    }
    ui.querySelector('[data-find]').addEventListener('click', find);
    ui.querySelector('[name=q]').addEventListener('keydown', e => { if (e.key === 'Enter') find(); });
    layout();
  });
  return v;
}

/* Draw an embedded page into a cell, keeping its on-screen orientation. */
function drawEmbeddedFit(page, emb, rot, cx, cy, cw, ch) {
  rot = ((rot % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const vw = swap ? emb.height : emb.width, vh = swap ? emb.width : emb.height;
  const s = Math.min(cw / vw, ch / vh); const dw = vw * s, dh = vh * s;
  const left = cx - dw / 2, right = cx + dw / 2, bottom = cy - dh / 2, top = cy + dh / 2;
  const [x, y] = rot === 90 ? [left, top] : rot === 180 ? [right, top] : rot === 270 ? [right, bottom] : [left, bottom];
  page.drawPage(emb, { x, y, width: emb.width * s, height: emb.height * s, rotate: degrees(-rot) });
}

/* Pages per sheet / booklet */
function toolNup() {
  const v = toolShell('nup');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const src = await loadLib(bytes);
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: src.getPageCount() }))}</p>
        <div class="field" style="margin-top:12px"><span>${esc(t('layout'))}</span>${seg('mode', [['2', t('nup2')], ['4', t('nup4')], ['booklet', t('booklet')]], '2')}</div>
        <div class="opts">
          <div class="field"><span>${esc(t('pageSize'))}</span>${seg('paper', [['a4', 'A4'], ['letter', 'Letter']], 'a4')}</div>
        </div>
        <label class="check" style="margin-top:12px"><input type="checkbox" name="lines"> ${esc(t('drawLines'))}</label>
        <label class="check" style="margin-top:8px" data-rtl><input type="checkbox" name="rtl" ${lang === 'ar' ? 'checked' : ''}> ${esc(t('rtlBinding'))}</label>
        <p class="hint" data-bhint>${esc(t('bookletHint'))}</p>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('makePdf'))}</button></div></div>`);
    const sync = () => { const b = val(opts, 'mode') === 'booklet'; opts.querySelector('[data-bhint]').classList.toggle('hidden', !b); };
    opts.addEventListener('change', sync); sync();
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const mode = val(opts, 'mode'), rtl = opts.querySelector('[name=rtl]').checked, lines = opts.querySelector('[name=lines]').checked;
      let [W, H] = val(opts, 'paper') === 'a4' ? [595.28, 841.89] : [612, 792];
      const out = await PDFDocument.create();
      const srcPages = src.getPages();
      const embs = await out.embedPages(srcPages);
      const rots = srcPages.map(p => p.getRotation().angle);
      let order = srcPages.map((_, i) => i);
      let per = mode === '4' ? 4 : 2;
      if (mode === 'booklet') {
        const n = Math.ceil(order.length / 4) * 4; const seq = [];
        for (let i = 0; i < n / 4; i++) seq.push(n - 1 - 2 * i, 2 * i, 2 * i + 1, n - 2 - 2 * i);
        order = seq.map(i => (i < srcPages.length ? i : -1));
      }
      if (per === 2) [W, H] = [H, W];
      const cells = per === 2 ? [[0, 0], [1, 0]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
      const cols = 2, rows = per === 2 ? 1 : 2, m = 14;
      const cw = W / cols, ch = H / rows;
      for (let s = 0; s < order.length; s += per) {
        await progress(t('processingPage', { n: s / per + 1, total: Math.ceil(order.length / per) }));
        const sheet = out.addPage([W, H]);
        cells.forEach(([c, r], k) => {
          const idx = order[s + k]; const col = rtl ? cols - 1 - c : c;
          if (idx === undefined || idx < 0) return;
          drawEmbeddedFit(sheet, embs[idx], rots[idx], col * cw + cw / 2, H - (r * ch + ch / 2), cw - 2 * m, ch - 2 * m);
        });
        if (lines) {
          sheet.drawLine({ start: { x: W / 2, y: 0 }, end: { x: W / 2, y: H }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6), dashArray: [4, 4] });
          if (rows === 2) sheet.drawLine({ start: { x: 0, y: H / 2 }, end: { x: W, y: H / 2 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6), dashArray: [4, 4] });
        }
      }
      await showResult(v, [{ name: baseName(file.name) + (mode === 'booklet' ? '-booklet.pdf' : `-${per}up.pdf`), data: await out.save() }],
        mode === 'booklet' ? `<p class="hint">${esc(t('bookletPrint'))}</p>` : '');
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Add image or stamp */
function toolStamp() {
  const v = toolShell('stamp');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    let pic = null; // {canvas, aspect, url}
    const r = { x: 0.6, y: 0.75, w: 0.3, h: 0.1 };
    const ui = h(`<div style="margin-top:14px">
        <label class="btn primary">${esc(t('chooseStamp'))}<input type="file" accept="image/*" hidden name="pic"></label>
        <div data-rest class="hidden">
          <label class="check" style="margin-top:10px"><input type="checkbox" name="nowhite"> ${esc(t('removeWhite'))}</label>
          <div class="opts">
            <div class="field"><span>${esc(t('applyTo'))}</span>${seg('scope', [['all', t('allPages')], ['this', t('thisPage')]], 'all')}</div>
            <label class="field"><span>${esc(t('opacity'))} <output>100%</output></span><input type="range" name="op" min="10" max="100" value="100"></label>
          </div>
          <p class="hint">${esc(t('stampHint'))}</p>
          ${pagerHtml()}
          <div class="btn-row" style="justify-content:center"><button class="btn primary" data-save>${esc(t('save'))}</button></div>
        </div></div>`);
    body.appendChild(ui);
    let raw = null;
    const el = h(`<div class="placed stamp"><img alt=""><span class="hd" data-h="br"></span></div>`);
    const view = pageViewer(ui, js, () => fit());
    const pageAspect = () => view.w / view.h;
    function fit() { if (!pic) return; r.h = Math.min(1, r.w * pageAspect() / pic.aspect); r.x = Math.min(1 - r.w, r.x); r.y = Math.max(0, Math.min(1 - r.h, r.y)); placeRect(el, r); el.style.opacity = val(ui, 'op') / 100; }
    rectDrag(el, view.stage, r, () => { r.w = Math.min(r.w, 1 - r.x); fit(); });
    function makePic() {
      const c = document.createElement('canvas'); c.width = raw.width; c.height = raw.height; const ctx = c.getContext('2d'); ctx.drawImage(raw, 0, 0);
      if (ui.querySelector('[name=nowhite]').checked) {
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) { const mn = Math.min(d.data[i], d.data[i + 1], d.data[i + 2]); if (mn > 225) d.data[i + 3] = 0; else if (mn > 180) d.data[i + 3] = Math.round(255 * (225 - mn) / 45); }
        ctx.putImageData(d, 0, 0);
      }
      pic = { canvas: c, aspect: c.width / c.height, url: c.toDataURL('image/png') };
      el.querySelector('img').src = pic.url;
    }
    ui.querySelector('[name=pic]').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      await run(v, async () => { raw = await imageToCanvas(f, 1600); makePic(); });
      if (!pic) return;
      ui.querySelector('[data-rest]').classList.remove('hidden');
      if (!el.isConnected) { view.stage.appendChild(el); await view.show(1); }
      fit();
    });
    ui.querySelector('[name=nowhite]').addEventListener('change', () => { if (raw) { makePic(); fit(); } });
    ui.querySelector('[name=op]').addEventListener('input', e => { e.target.parentElement.querySelector('output').textContent = e.target.value + '%'; fit(); });
    ui.querySelector('[data-save]').addEventListener('click', () => run(v, async () => {
      const doc = await loadLib(bytes); const img = await embedCanvasPng(doc, pic.canvas);
      const pages = doc.getPages(); const targets = val(ui, 'scope') === 'all' ? pages : [pages[view.current - 1]];
      const op = val(ui, 'op') / 100;
      for (const p of targets) {
        const box = visualBox(p); const w = r.w * box.vw, hh = w / pic.aspect;
        drawImageVisual(p, box, img, r.x * box.vw + w / 2, box.vh - r.y * box.vh - hh / 2, w, hh, 0, op);
      }
      await showResult(v, [{ name: baseName(file.name) + '-stamped.pdf', data: await doc.save() }]);
    }));
  });
  return v;
}

/* Insert pages */
function toolInsert() {
  const v = toolShell('insert');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const doc0 = await loadLib(bytes); const n = doc0.getPageCount();
    let other = null;
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n }))}</p>
        <div class="field" style="margin-top:12px"><span>${esc(t('insertWhat'))}</span>${seg('what', [['blank', t('insBlank')], ['pdf', t('insPdf')]], 'blank')}</div>
        <div class="opts">
          <label class="field" data-for="blank"><span>${esc(t('howMany'))}</span><input type="number" name="count" value="1" min="1" max="100"></label>
          <div class="field hidden" data-for="pdf"><span>${esc(t('otherPdf'))}</span><label class="btn">${esc(t('chooseFile'))}<input type="file" accept="application/pdf,.pdf" hidden name="other"></label><small class="hint" data-oname></small></div>
          <label class="field"><span>${esc(t('where'))}</span><select name="pos">
            <option value="0">${esc(t('atStart'))}</option>
            ${Array.from({ length: n }, (_, i) => `<option value="${i + 1}" ${i === n - 1 ? 'selected' : ''}>${esc(i === n - 1 ? t('atEnd') : t('afterPage', { n: i + 1 }))}</option>`).join('')}
          </select></label>
        </div>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('insertBtn'))}</button></div></div>`);
    const sync = () => opts.querySelectorAll('[data-for]').forEach(x => x.classList.toggle('hidden', x.dataset.for !== val(opts, 'what')));
    opts.addEventListener('change', e => { if (e.target.name === 'what') sync(); }); sync();
    opts.querySelector('[name=other]').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      await run(v, async () => { const ob = await readBytes(f); const od = await loadLib(ob); other = od; opts.querySelector('[data-oname]').textContent = `${f.name} · ${t('pages', { n: od.getPageCount() })}`; });
    });
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const doc = await loadLib(bytes); const pos = +opts.querySelector('[name=pos]').value;
      if (val(opts, 'what') === 'blank') {
        const ref = doc.getPage(Math.max(0, Math.min(n - 1, pos - 1))); const { width, height } = ref.getSize();
        const count = Math.max(1, Math.min(100, +val(opts, 'count') || 1));
        for (let i = 0; i < count; i++) doc.insertPage(pos + i, [width, height]);
      } else {
        if (!other) throw new Error(t('pickOtherPdf'));
        const copied = await doc.copyPages(other, other.getPageIndices());
        copied.forEach((p, i) => doc.insertPage(pos + i, p));
      }
      await showResult(v, [{ name: baseName(file.name) + '-inserted.pdf', data: await doc.save() }]);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Extract images */
function toolExtract() {
  const v = toolShell('extract');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const name = baseName(file.name); v.zipName = name + '-images.zip';
    const row = h(`<div class="btn-row"><button class="btn primary" data-go>${esc(t('extractBtn'))}</button></div>`);
    row.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const L = window.PDFLib; const { PDFName, PDFRawStream, PDFArray, PDFNumber } = L; const N = k => PDFName.of(k);
      const num = o => (o instanceof PDFNumber ? o.asNumber() : 0);
      const doc = await loadLib(bytes); const outs = []; let k = 0;
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream)) continue; const d = obj.dict;
        if (String(d.get(N('Subtype'))) !== '/Image' || d.get(N('ImageMask'))) continue;
        const w = num(d.lookup(N('Width'))), hgt = num(d.lookup(N('Height')));
        if (w < 32 || hgt < 32) continue;
        let f = d.lookup(N('Filter')); if (f instanceof PDFArray) f = f.size() === 1 ? f.lookup(0) : null; const filter = f ? String(f) : '';
        k++; if (k % 5 === 0) await progress(t('foundN', { n: outs.length }));
        if (filter === '/DCTDecode') { outs.push({ name: `${name}-image-${outs.length + 1}.jpg`, data: obj.contents.slice(), type: 'image/jpeg' }); continue; }
        if (filter !== '/FlateDecode' || num(d.lookup(N('BitsPerComponent'))) !== 8) continue;
        const dp = d.lookup(N('DecodeParms')); if (dp && num(dp.lookup?.(N('Predictor'))) > 1) continue;
        let cs = d.lookup(N('ColorSpace')), comps = 0;
        if (cs instanceof PDFName) comps = { '/DeviceRGB': 3, '/DeviceGray': 1 }[String(cs)] || 0;
        else if (cs instanceof PDFArray && String(cs.lookup(0)) === '/ICCBased') { const s = cs.lookup(1); comps = s && s.dict ? num(s.dict.lookup(N('N'))) : 0; }
        if (comps !== 1 && comps !== 3) continue;
        try {
          const raw = await inflate(obj.contents); if (raw.length < w * hgt * comps) continue;
          const id = new ImageData(w, hgt);
          for (let i = 0, j = 0; i < w * hgt; i++, j += comps) { const o = i * 4; if (comps === 3) { id.data[o] = raw[j]; id.data[o + 1] = raw[j + 1]; id.data[o + 2] = raw[j + 2]; } else id.data[o] = id.data[o + 1] = id.data[o + 2] = raw[j]; id.data[o + 3] = 255; }
          const c = document.createElement('canvas'); c.width = w; c.height = hgt; c.getContext('2d').putImageData(id, 0, 0);
          outs.push({ name: `${name}-image-${outs.length + 1}.png`, data: await canvasBlob(c, 'image/png'), type: 'image/png' });
          c.width = c.height = 0;
        } catch {}
      }
      if (!outs.length) throw new Error(t('noImages'));
      await showResult(v, outs, `<p class="hint">${esc(t('foundN', { n: outs.length }))}</p>`);
    }));
    body.appendChild(row);
  });
  return v;
}

/* Black & white */
function toolGray() {
  const v = toolShell('gray');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: js.numPages }))}</p>
        <div class="field" style="margin-top:12px"><span>${esc(t('quality'))}</span>${seg('q', [['150', t('qNormal')], ['200', t('qHigh2')]], '150')}</div>
        <p class="warn">${esc(t('grayNote'))}</p>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('grayBtn'))}</button></div></div>`);
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const dpi = +val(opts, 'q'); const out = await PDFDocument.create();
      for (let i = 1; i <= js.numPages; i++) {
        await progress(t('processingPage', { n: i, total: js.numPages }));
        const { canvas, width, height } = await renderPage(js, i, { scale: dpi / 72, maxSide: 3000 });
        const ctx = canvas.getContext('2d'); const d = ctx.getImageData(0, 0, canvas.width, canvas.height); const p = d.data;
        for (let k = 0; k < p.length; k += 4) p[k] = p[k + 1] = p[k + 2] = p[k] * 0.3 + p[k + 1] * 0.59 + p[k + 2] * 0.11;
        ctx.putImageData(d, 0, 0);
        const img = await out.embedJpg(new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.8)).arrayBuffer()));
        canvas.width = canvas.height = 0;
        out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
      }
      await showResult(v, [{ name: baseName(file.name) + '-bw.pdf', data: await out.save() }]);
    }));
    body.appendChild(opts);
  });
  return v;
}

/* Repair */
function toolRepair() {
  const v = toolShell('repair');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const row = h(`<div><p class="hint">${esc(t('repairHint'))}</p><div class="btn-row"><button class="btn primary" data-go>${esc(t('repairBtn'))}</button></div></div>`);
    row.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      await progress(t('working'));
      const r = await runQpdf(bytes, ['--object-streams=generate', '@in', '@out']);
      let data = null, how = 'repairOk';
      if (r.out) { try { await PDFDocument.load(r.out); data = r.out; } catch (e) { if (/encrypt/i.test(String(e && e.message))) throw new Error(t('encrypted')); } }
      if (!data) {
        // Second try: pdf-lib reads objects one by one without trusting the cross-reference table, then writes a clean file.
        try {
          const d = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
          if (d.getPageCount() > 0) { const out = await d.save(); const chk = await pdfjsLib.getDocument({ data: out.slice(), isEvalSupported: false }).promise; await (await chk.getPage(1)).getOperatorList(); chk.destroy(); data = out; }
        } catch (e) { if (/encrypt/i.test(String(e && e.message))) throw new Error(t('encrypted')); }
      }
      if (!data) {
        // Last resort: if the pages can still be drawn, rebuild the file from page images.
        let js;
        try { js = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise; }
        catch (e) { if (e && e.name === 'PasswordException') throw new Error(t('encrypted')); throw new Error(t('repairFail')); }
        const out = await PDFDocument.create();
        for (let i = 1; i <= js.numPages; i++) {
          await progress(t('processingPage', { n: i, total: js.numPages }));
          try {
            const { canvas, width, height } = await renderPage(js, i, { scale: 2, maxSide: 3000 });
            const img = await out.embedJpg(new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.85)).arrayBuffer()));
            out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
          } catch {}
        }
        if (!out.getPageCount()) throw new Error(t('repairFail'));
        data = await out.save(); how = 'repairImages';
      }
      await showResult(v, [{ name: baseName(file.name) + '-repaired.pdf', data }], `<p class="hint">${esc(t(how))}</p>`);
    }));
    body.appendChild(row);
  });
  return v;
}

/* ---------------- router ---------------- */
let lastHash = null;
function route(force) {
  const id = location.hash.slice(1);
  if (!force && id === lastHash && $app.firstChild) return;
  lastHash = id;
  const tool = TOOLS.find(x => x.id === id);
  $app.innerHTML = '';
  const view = tool ? tool.render(tool.id) : id === 'shared' ? sharedView() : home();
  $app.appendChild(view);
  if (tool) { addRecent(tool.id); feedIncoming(view); }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => route());
applyLang();
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
