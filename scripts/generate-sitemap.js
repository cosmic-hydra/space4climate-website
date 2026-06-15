#!/usr/bin/env node
/*
 * scripts/generate-sitemap.js
 *
 * Walks space4climate/ and writes space4climate/sitemap.xml using the
 * sitemaps.org XML protocol. Only pages that should be indexed are
 * included; tiny redirect stubs, `noindex` pages, and pages whose
 * canonical points to a different URL are skipped.
 *
 * No external dependencies - runs on Node 16+ with built-in modules only.
 *
 * Usage:
 *   node scripts/generate-sitemap.js            # write space4climate/sitemap.xml
 *   node scripts/generate-sitemap.js --check    # exit 0 if sitemap is up to date
 *   node scripts/generate-sitemap.js --stdout   # print to stdout instead of writing
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SITE_DIR = path.resolve(__dirname, '..', 'space4climate');
const SITEMAP_PATH = path.join(SITE_DIR, 'sitemap.xml');
const SITE_ORIGIN = 'https://www.space4climate.org';

// Anything smaller than this is treated as a redirect stub (the stub
// pages in case-studies/, programs/, projects/ etc. are all ~850 bytes).
const MIN_SIZE_BYTES = 5 * 1024;

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

function fileToUrlPath(filePath) {
  const rel = path.relative(SITE_DIR, filePath).split(path.sep).join('/');
  return '/' + rel.split('/').map(encodePathSegment).join('/');
}

// URL-encode a single path segment. Mirrors the encoding the Webflow
// export uses in its canonical links: only the characters that have
// special meaning in URLs (`?`, `#`) are percent-encoded; everything
// else (including `=`, `&`, spaces) is left as-is so the generated URL
// matches the page's declared canonical.
function encodePathSegment(segment) {
  return segment.replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function walkHtml(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkHtml(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

function getHeadChunk(html) {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html.slice(0, 8192);
}

function checkIndexable(head, expectedUrl) {
  if (/<meta\s+[^>]*name=["']robots["'][^>]*content=["'][^"']*\bnoindex\b/i.test(head)) {
    return { ok: false, reason: 'meta robots noindex' };
  }
  const canonicalMatch =
    head.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ||
    head.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (canonicalMatch) {
    const canonicalUrl = canonicalMatch[1];
    if (canonicalUrl !== expectedUrl) {
      return { ok: false, reason: `canonical -> ${canonicalUrl}` };
    }
  }
  return { ok: true };
}

function classify(relPath) {
  if (relPath === '/index.html') {
    return { priority: '1.0', changefreq: 'weekly' };
  }
  if (relPath === '/login.html') {
    return { priority: '0.3', changefreq: 'yearly' };
  }
  if (relPath === '/commonboard.html' || relPath === '/commonboard-instructions.html') {
    return { priority: '0.5', changefreq: 'monthly' };
  }
  if (relPath.startsWith('/legal/')) {
    return { priority: '0.3', changefreq: 'yearly' };
  }
  if (/^\/lab-notes%3F/i.test(relPath)) {
    return { priority: '0.5', changefreq: 'weekly' };
  }
  if (['/press.html', '/lab-notes.html', '/projects.html', '/case-studies.html', '/news/our-story.html'].includes(relPath)) {
    return { priority: '0.8', changefreq: 'weekly' };
  }
  if (relPath.startsWith('/lab-notes/')) {
    return { priority: '0.7', changefreq: 'monthly' };
  }
  return { priority: '0.6', changefreq: 'monthly' };
}

async function buildEntries(verbose) {
  const files = await walkHtml(SITE_DIR);
  const entries = [];
  for (const file of files) {
    const stat = await fsp.stat(file);
    if (stat.size < MIN_SIZE_BYTES) continue;
    const html = await fsp.readFile(file, 'utf8');
    const relPath = fileToUrlPath(file);
    const expectedUrl = SITE_ORIGIN + relPath;
    const head = getHeadChunk(html);
    const check = checkIndexable(head, expectedUrl);
    if (!check.ok) {
      if (verbose) process.stdout.write(`skip  ${relPath}  (${check.reason})\n`);
      continue;
    }
    const lastmod = stat.mtime.toISOString().slice(0, 10);
    const cls = classify(relPath);
    entries.push({ loc: expectedUrl, lastmod, ...cls });
  }
  entries.sort((a, b) => {
    if (a.loc === SITE_ORIGIN + '/index.html') return -1;
    if (b.loc === SITE_ORIGIN + '/index.html') return 1;
    return a.loc.localeCompare(b.loc);
  });
  return entries;
}

function renderSitemap(entries) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const e of entries) {
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(e.loc)}</loc>`);
    lines.push(`    <lastmod>${e.lastmod}</lastmod>`);
    lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
    lines.push(`    <priority>${e.priority}</priority>`);
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check');
  const toStdout = args.has('--stdout');
  const verbose = args.has('--verbose') || args.has('-v');

  const entries = await buildEntries(verbose);
  const xml = renderSitemap(entries);

  if (toStdout) {
    process.stdout.write(xml);
    return;
  }

  if (checkOnly) {
    let existing = null;
    try {
      existing = await fsp.readFile(SITEMAP_PATH, 'utf8');
    } catch (_) {
      process.stdout.write(`sitemap missing: ${path.relative(process.cwd(), SITEMAP_PATH)} (${entries.length} URLs would be written)\n`);
      process.exit(1);
    }
    if (existing === xml) {
      process.stdout.write(`sitemap up to date: ${entries.length} URLs\n`);
      process.exit(0);
    }
    process.stdout.write(`sitemap out of date: regenerating (${entries.length} URLs)\n`);
    await fsp.writeFile(SITEMAP_PATH, xml, 'utf8');
    process.exit(0);
  }

  await fsp.writeFile(SITEMAP_PATH, xml, 'utf8');
  process.stdout.write(`wrote ${path.relative(process.cwd(), SITEMAP_PATH)} (${entries.length} URLs)\n`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
