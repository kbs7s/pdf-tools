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
  page.drawImage(img, { x: p.x, y: p.y, width: w, height: hgt, rotate: degrees(box.rot + angle), opacity });
}

const hasArabic = s => /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(s);

/** Render text to a transparent PNG canvas (lets us use any language/font). */
function textCanvas(text, { px = 48, color = '#000', family = 'system-ui, sans-serif', weight = '700', scale = 3 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${weight} ${px * scale}px ${family}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width + px * scale * 0.4);
  const hh = Math.ceil(px * scale * 1.5);
  c.width = Math.max(w, 4); c.height = hh;
  ctx.font = font;
  const firstStrong = text.match(/[A-Za-z\u00C0-\u024F\u0590-\u08FF\uFB1D-\uFEFF]/);
  ctx.direction = firstStrong && hasArabic(firstStrong[0]) ? 'rtl' : 'ltr';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, c.height / 2);
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
  { id: 'merge', render: toolMerge },
  { id: 'split', render: toolSplit },
  { id: 'organize', render: toolOrganize },
  { id: 'rotate', render: toolOrganize },
  { id: 'delete', render: toolOrganize },
  { id: 'compress', render: toolCompress },
  { id: 'img2pdf', render: toolImg2Pdf },
  { id: 'pdf2img', render: toolPdf2Img },
  { id: 'numbers', render: toolNumbers },
  { id: 'watermark', render: toolWatermark },
  { id: 'sign', render: toolSign },
];

function home() {
  const v = h(`<section>
      <div class="hero"><h1>${esc(t('heroTitle'))}</h1><p>${esc(t('heroSub'))}</p></div>
      <div class="grid"></div></section>`);
  const g = v.querySelector('.grid');
  for (const tool of TOOLS) {
    g.appendChild(h(`<a class="tool-card" href="#${tool.id}"><div class="ico">${ICONS[tool.id]}</div><b>${esc(t('t_' + tool.id))}</b><span>${esc(t('d_' + tool.id))}</span></a>`));
  }
  return v;
}

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

/* Compress */
function toolCompress() {
  const v = toolShell('compress');
  const body = v.querySelector('.body');
  singlePdf(body, async (file, bytes) => {
    const js = await loadJs(bytes);
    const opts = h(`<div>
        <p class="hint">${esc(t('pages', { n: js.numPages }))}</p>
        <div class="field" style="margin-top:12px"><span>${esc(t('level'))}</span>
          ${seg('lvl', [['light', t('lvlLight')], ['medium', t('lvlMedium')], ['strong', t('lvlStrong')]], 'medium')}</div>
        <p class="warn">${esc(t('compressNote'))}</p>
        <div class="btn-row"><button class="btn primary" data-go>${esc(t('compressBtn'))}</button></div></div>`);
    opts.querySelector('[data-go]').addEventListener('click', () => run(v, async () => {
      const L = { light: [2, 0.75], medium: [1.5, 0.6], strong: [1.1, 0.45] }[val(opts, 'lvl')];
      const out = await PDFDocument.create();
      for (let i = 1; i <= js.numPages; i++) {
        await progress(t('processingPage', { n: i, total: js.numPages }));
        const { canvas, width, height } = await renderPage(js, i, { scale: L[0], maxSide: 3000 });
        const blob = await canvasBlob(canvas, 'image/jpeg', L[1]);
        canvas.width = canvas.height = 0;
        const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const page = out.addPage([width, height]);
        page.drawImage(img, { x: 0, y: 0, width, height });
      }
      let data = await out.save();
      const smaller = data.length < bytes.length;
      const pct = Math.round((1 - data.length / bytes.length) * 100);
      const info = `<p>${esc(t('sizeChange', { a: fmtSize(bytes.length), b: fmtSize(data.length) }))} ${pct > 0 ? `(−${pct}%)` : ''}</p>`
        + (smaller ? '' : `<p class="warn">${esc(t('compressNoGain'))}</p>`);
      if (!smaller) data = bytes;
      await showResult(v, [{ name: baseName(file.name) + '-compressed.pdf', data }], info);
    }));
    body.appendChild(opts);
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

/* ---------------- router ---------------- */
let lastHash = null;
function route(force) {
  const id = location.hash.slice(1);
  if (!force && id === lastHash && $app.firstChild) return;
  lastHash = id;
  const tool = TOOLS.find(x => x.id === id);
  $app.innerHTML = '';
  $app.appendChild(tool ? tool.render(tool.id) : home());
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => route());
applyLang();
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
