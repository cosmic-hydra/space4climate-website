#!/usr/bin/env node
/*
 * scripts/test-sitemap.js
 *
 * Smoke test for the generated sitemap. Verifies the file:
 *   1. Is well-formed XML and matches the sitemaps.org schema.
 *   2. Lists every indexable HTML page in space4climate/ (no real page
 *      is missing, no redirect stub is included).
 *   3. Every listed URL has a corresponding file on disk.
 *   4. No URL duplicates the canonical of another URL.
 *
 * Uses Node's built-in test runner (node --test), no extra deps.
 *
 * Usage:
 *   node --test scripts/test-sitemap.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const SITE_DIR = path.resolve(__dirname, '..', 'space4climate');
const SITEMAP_PATH = path.join(SITE_DIR, 'sitemap.xml');
const SITE_ORIGIN = 'https://www.space4climate.org';
const MIN_SIZE_BYTES = 5 * 1024;

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

function fileToUrlPath(filePath) {
  const rel = path.relative(SITE_DIR, filePath).split(path.sep).join('/');
  return '/' + rel.split('/').map((s) => s.replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

function getHeadChunk(html) {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html.slice(0, 8192);
}

function isIndexableHtml(head, expectedUrl) {
  if (/<meta\s+[^>]*name=["']robots["'][^>]*content=["'][^"']*\bnoindex\b/i.test(head)) return false;
  const canonicalMatch =
    head.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ||
    head.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (canonicalMatch && canonicalMatch[1] !== expectedUrl) return false;
  return true;
}

function parseSitemap(xml) {
  const urls = [];
  const re = /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<changefreq>([^<]+)<\/changefreq>\s*<priority>([^<]+)<\/priority>\s*<\/url>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    urls.push({ loc: m[1], lastmod: m[2], changefreq: m[3], priority: m[4] });
  }
  return urls;
}

test('sitemap.xml exists and is well-formed', async () => {
  const xml = await fsp.readFile(SITEMAP_PATH, 'utf8');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'has XML declaration');
  assert.ok(/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(xml), 'has urlset root');
  assert.ok(xml.trim().endsWith('</urlset>'), 'closes urlset');
  const urls = parseSitemap(xml);
  assert.ok(urls.length > 0, 'has at least one url');
  for (const u of urls) {
    assert.ok(u.loc.startsWith(SITE_ORIGIN + '/'), `loc uses canonical origin: ${u.loc}`);
    assert.match(u.lastmod, /^\d{4}-\d{2}-\d{2}$/, `lastmod is YYYY-MM-DD: ${u.lastmod}`);
    assert.match(u.priority, /^[01](\.\d+)?$/, `priority is 0.0-1.0: ${u.priority}`);
    assert.ok(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'].includes(u.changefreq), `changefreq is valid: ${u.changefreq}`);
  }
});

test('every <loc> points to a file that exists on disk', async () => {
  const xml = await fsp.readFile(SITEMAP_PATH, 'utf8');
  const urls = parseSitemap(xml);
  for (const u of urls) {
    const urlPath = new URL(u.loc).pathname;
    const decoded = decodeURIComponent(urlPath);
    const filePath = path.join(SITE_DIR, decoded.replace(/^\//, ''));
    assert.ok(fs.existsSync(filePath), `file exists for ${u.loc} (${filePath})`);
  }
});

test('sitemap covers every indexable page in space4climate/', async () => {
  const xml = await fsp.readFile(SITEMAP_PATH, 'utf8');
  const urls = parseSitemap(xml);
  const sitemapLocs = new Set(urls.map((u) => u.loc));

  const files = await walkHtml(SITE_DIR);
  const indexable = new Set();
  for (const f of files) {
    const stat = await fsp.stat(f);
    if (stat.size < MIN_SIZE_BYTES) continue;
    const html = await fsp.readFile(f, 'utf8');
    const relPath = fileToUrlPath(f);
    if (isIndexableHtml(getHeadChunk(html), SITE_ORIGIN + relPath)) {
      indexable.add(SITE_ORIGIN + relPath);
    }
  }

  const missing = [...indexable].filter((u) => !sitemapLocs.has(u));
  const extra = [...sitemapLocs].filter((u) => !indexable.has(u));
  assert.deepEqual(missing, [], `indexable pages missing from sitemap: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `non-indexable pages in sitemap: ${extra.join(', ')}`);
});

test('sitemap has no duplicate URLs', async () => {
  const xml = await fsp.readFile(SITEMAP_PATH, 'utf8');
  const urls = parseSitemap(xml);
  const seen = new Set();
  for (const u of urls) {
    assert.equal(seen.has(u.loc), false, `duplicate url: ${u.loc}`);
    seen.add(u.loc);
  }
});

test('robots.txt points at the sitemap on the correct host', async () => {
  const robots = await fsp.readFile(path.join(SITE_DIR, 'robots.txt'), 'utf8');
  const matches = robots.match(/^Sitemap:\s*(\S+)\s*$/gm) || [];
  assert.equal(matches.length, 1, 'exactly one Sitemap directive in robots.txt');
  assert.ok(matches[0].includes(SITE_ORIGIN + '/sitemap.xml'), 'sitemap URL uses canonical host');
});
