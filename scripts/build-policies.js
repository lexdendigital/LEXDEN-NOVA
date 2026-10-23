#!/usr/bin/env node
// scripts/build-policies.js
//
// Builds the first-party Documents & Policies Centre (static HTML, GitHub-Pages friendly).
//   node scripts/build-policies.js [--out legal] [--check]
// * Sources: policies/src/{public,creator}/*.md  (internal/ + implementation/ are NEVER written to the static output)
// * Values (fees, windows) are read from api/core/config.js, so the page cannot disagree with the code.
// * Until POLICY_PUBLICATION_APPROVED=true at build time every page carries a DRAFT / REVIEW REQUIRED banner,
//   and unresolved placeholders ([EFFECTIVE DATE], [LEXDEN LEGAL ENTITY NAME] ...) are shown highlighted, NEVER invented.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../api/core/config');

const ROOT = path.join(__dirname, '..');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function values() {
  const pct = (bps) => String(bps / 100).replace(/\.0+$/, '');
  return {
    CREATOR_FEE_PCT: pct(cfg.CREATOR_COMMISSION_BPS),
    AFFILIATE_WITHDRAWAL_FEE_PCT: pct(cfg.AFFILIATE_WITHDRAWAL_FEE_BPS),
    DISPUTE_PHYSICAL_DAYS: String(cfg.DISPUTE_POLICIES.PHYSICAL.windowDays),
    DISPUTE_DIGITAL_DAYS: String(cfg.DISPUTE_POLICIES.DIGITAL.windowDays),
    DISPUTE_SERVICE_DAYS: String(cfg.DISPUTE_POLICIES.SERVICE.windowDays),
  };
}
/** Start-up operator details. Honest defaults; override with env once a legal entity exists. Nothing is invented. */
function operatorValues() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    'LEXDEN LEGAL ENTITY NAME': process.env.LEGAL_OPERATOR_NAME || 'LEXDEN NOVA (an unregistered start-up run by its founder)',
    'REGISTERED ADDRESS': process.env.LEGAL_ADDRESS || 'No registered office yet; we operate online from Nigeria',
    'LEGAL NOTICE EMAIL': process.env.LEGAL_CONTACT_EMAIL || 'the contact form on this website',
    'EFFECTIVE DATE': process.env.LEGAL_EFFECTIVE_DATE || today,
  };
}
function fillOperator(md) {
  const v = operatorValues();
  return md.replace(/\[(LEXDEN LEGAL ENTITY NAME|REGISTERED ADDRESS|LEGAL NOTICE EMAIL|EFFECTIVE DATE)\]/g, (m, k) => v[k]);
}
function applyValues(md, vals) {
  const unknown = [];
  const out = md.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => { if (k in vals) return vals[k]; unknown.push(k); return m; });
  if (unknown.length) throw new Error(`Unknown template value(s): ${unknown.join(', ')}`);
  return out;
}

const PLACEHOLDER = /\[([A-Z][A-Z0-9 \/_-]{2,60})\]/g;
function inline(t) {
  let s = esc(t);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|[a-z0-9\-_.]+\.html)\)/gi, '<a href="$2" rel="noopener">$1</a>');
  s = s.replace(PLACEHOLDER, '<mark class="ph" title="Not yet supplied by LEXDEN. Do not rely on this document until it is completed.">[$1]</mark>');
  return s;
}
/** Small, dependency-free Markdown subset: headings, paragraphs, lists, tables, code, bold, links. */
function mdToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0; let para = []; let list = null;
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flushP(); flushL(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { flushP(); flushL(); const n = Math.min(h[1].length + 0, 4); const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); out.push(`<h${n} id="${id}">${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\|.*\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushP(); flushL();
      const row = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l);
    if (li) { flushP(); const kind = /\d/.test(li[1]) ? 'ol' : 'ul'; if (list !== kind) { flushL(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(li[2])}</li>`); i++; continue; }
    if (/^\s*$/.test(l)) { flushP(); flushL(); i++; continue; }
    if (/^---+\s*$/.test(l)) { flushP(); flushL(); out.push('<hr>'); i++; continue; }
    flushL(); para.push(l.trim()); i++;
  }
  flushP(); flushL();
  return out.join('\n');
}

const CSS = `:root{--bg:#fff;--fg:#1b1f24;--mut:#5b6572;--line:#d9dee5;--acc:#0b5cff;--warn-bg:#fff4d6;--warn-fg:#6a4a00}
@media (prefers-color-scheme:dark){:root{--bg:#10141a;--fg:#e8ecf1;--mut:#9aa6b4;--line:#2a323d;--acc:#7aa7ff;--warn-bg:#3a2f0b;--warn-fg:#ffd98a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px 16px 64px}a{color:var(--acc)}h1{font-size:1.6rem;line-height:1.25}h2{font-size:1.2rem;margin-top:2rem}
.nav{display:flex;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line);font-size:.9rem}
.banner{background:var(--warn-bg);color:var(--warn-fg);border:1px solid var(--warn-fg);border-radius:8px;padding:12px 14px;margin:16px 0;font-size:.95rem}
.meta{color:var(--mut);font-size:.9rem}.ph{background:#ffe08a;color:#3a2a00;padding:0 3px;border-radius:3px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
pre{overflow-x:auto;background:rgba(127,127,127,.12);padding:10px;border-radius:6px}code{font-size:.92em}ul.docs{padding-left:18px}`;

const BANNER = '<div class="banner" role="note"><strong>DRAFT — REVIEW REQUIRED.</strong> This document has not been approved for publication. It may be incomplete or change, and highlighted items are details LEXDEN has not supplied yet. It is shown so you can see how NOVA works; it is not final legal advice or a final contract.</div>';

function page({ title, body, doc, approved, hash }) {
  const meta = doc ? `<p class="meta">Version ${esc(doc.version)} · Effective date: ${esc(doc.effectiveDate || operatorValues()['EFFECTIVE DATE'])} · Status: ${approved ? 'Published' : 'Draft'}${hash ? ` · Content ID ${hash}` : ''}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · LEXDEN NOVA</title><meta name="robots" content="${approved ? 'index,follow' : 'noindex'}"><style>${CSS}</style></head><body><nav class="nav"><a href="../index.html">LEXDEN NOVA</a><a href="index.html">Documents &amp; Policies</a></nav><main>${approved ? '' : BANNER}${meta}${body}</main></body></html>`;
}

function build({ out = path.join(ROOT, 'legal'), approved = cfg.flags().policyPublicationApproved, check = false } = {}) {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'policies', 'registry.json'), 'utf8'));
  const vals = values();
  const publicDocs = [];
  const problems = [];
  if (!check) { fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true }); }
  for (const d of registry.documents) {
    if (d.audience === 'internal') continue; // internal procedures never reach the static site
    const raw = fs.readFileSync(path.join(ROOT, 'policies', 'src', d.source), 'utf8');
    const md = fillOperator(applyValues(raw, vals));
    const hash = crypto.createHash('sha256').update(md).digest('hex').slice(0, 12);
    const placeholders = [...new Set([...md.matchAll(PLACEHOLDER)].map((m) => m[0]))];
    if (approved && placeholders.length && d.id !== 'creator-product-policy') problems.push(`${d.id}: unresolved placeholders ${placeholders.join(', ')}`);
    const html = page({ title: d.title, body: mdToHtml(md), doc: d, approved, hash });
    if (/google\.com\/search/i.test(html)) problems.push(`${d.id}: contains a search-engine link`);
    publicDocs.push({ id: d.id, title: d.title, audience: d.audience, route: d.route, version: d.version, effectiveDate: d.effectiveDate, status: approved ? 'PUBLISHED' : 'DRAFT', contentHash: hash, placeholders });
    if (!check) fs.writeFileSync(path.join(out, `${d.id}.html`), html);
  }
  const group = (aud, label) => `<h2>${label}</h2><ul class="docs">${publicDocs.filter((x) => x.audience === aud).map((x) => `<li><a href="${x.id}.html">${esc(x.title)}</a> <span class="meta">v${esc(x.version)}${x.status === 'DRAFT' ? ' · draft' : ''}</span></li>`).join('')}</ul>`;
  const indexHtml = page({ title: 'Documents & Policies', approved, body: `<h1>Documents &amp; Policies</h1><p>The rules that apply when you buy, sell or earn on LEXDEN NOVA.</p>${group('public', 'For everyone')}${group('creator', 'For creators (sellers)')}<p class="meta">Questions: lexdendigital@gmail.com</p>` });
  if (!check) {
    fs.writeFileSync(path.join(out, 'index.html'), indexHtml);
    fs.writeFileSync(path.join(out, 'registry.json'), JSON.stringify({ generatedFrom: 'policies/registry.json', approved, values: vals, documents: publicDocs }, null, 1));
  }
  return { documents: publicDocs, problems, approved };
}

module.exports = { build, mdToHtml, applyValues, values };
if (require.main === module) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : undefined;
  const r = build({ out, check: args.includes('--check') });
  console.log(`${r.documents.length} documents, status ${r.approved ? 'PUBLISHED' : 'DRAFT (review required)'}`);
  if (r.problems.length) { console.error(r.problems.join('\n')); process.exit(1); }
}
