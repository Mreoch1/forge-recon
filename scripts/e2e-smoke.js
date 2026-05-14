#!/usr/bin/env node
/**
 * e2e-smoke.js — Cross-platform E2E smoke test runner.
 * Reads scripts/smoke-manifest.json and checks each route.
 * Usage: node scripts/e2e-smoke.js [base_url]
 * Default base: https://forge-recon.vercel.app
 */
const base = process.argv[2] || process.env.SMOKE_BASE || 'https://forge-recon.vercel.app';
const manifest = require('./smoke-manifest.json');
const http = require('http');
const https = require('https');
const smokeEmail = process.env.SMOKE_ADMIN_EMAIL || process.env.SMOKE_EMAIL || 'admin@recon.local';
const smokePassword = process.env.SMOKE_ADMIN_PASSWORD || process.env.SMOKE_PASSWORD || 'changeme123';
const usingDefaultSmokeCreds = smokeEmail === 'admin@recon.local' && smokePassword === 'changeme123';

const COOKIE_JAR = {};
let passed = 0, failed = 0;

function fetch(method, path, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers = {};
    if (COOKIE_JAR[url.hostname]) headers.Cookie = COOKIE_JAR[url.hostname];
    if (data) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        const existing = COOKIE_JAR[url.hostname] ? COOKIE_JAR[url.hostname].split(/;\s*/) : [];
        const next = setCookie.map(c => c.split(';')[0]);
        COOKIE_JAR[url.hostname] = [...existing, ...next].join('; ');
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  console.log(`  Logging in as ${smokeEmail}...`);
  let res = await fetch('POST', '/login', formData({ email: smokeEmail, password: smokePassword }));
  // Rate-limit backoff
  if (res.status === 429) {
    console.log('  ⏳ Rate limited. Waiting 15s...');
    await new Promise(r => setTimeout(r, 15000));
    res = await fetch('POST', '/login', formData({ email: smokeEmail, password: smokePassword }));
  }
  if (res.status !== 302 || !COOKIE_JAR[new URL(base).hostname]) {
    const hint = usingDefaultSmokeCreds
      ? ' Set SMOKE_ADMIN_EMAIL/SMOKE_ADMIN_PASSWORD or SMOKE_EMAIL/SMOKE_PASSWORD for production smoke.'
      : '';
    throw new Error(`Login failed for ${smokeEmail}: expected 302 with session cookie, got ${res.status}.${hint}`);
  }
}

function formData(params) {
  return Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function main() {
  console.log(`=== E2E SMOKE (${base}) ===`);

  for (const check of manifest.filter(c => !c.auth)) {
    await runCheck(check);
  }

  await login();

  for (const check of manifest.filter(c => c.auth)) {
    await runCheck(check);
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

async function runCheck(check) {
  const { label, method, path, expect: expected } = check;
  const res = await fetch(method, path);
  const status = res.status;
  const ok = status === expected;

  if (ok) {
    console.log(`  PASS ${label} (${status})`);
    passed++;
  } else {
    console.log(`  FAIL ${label} - expected ${expected}, got ${status}`);
    failed++;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
