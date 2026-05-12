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

const COOKIE_JAR = {};
let passed = 0, failed = 0;

function fetch(method, path, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search };
    if (COOKIE_JAR[url.hostname]) opts.headers = { Cookie: COOKIE_JAR[url.hostname] };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      const setCookie = res.headers['set-cookie'];
      if (setCookie) COOKIE_JAR[url.hostname] = setCookie.join('; ');
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
  console.log('  🔑 Logging in as admin...');
  await fetch('POST', '/login', 'email=admin@recon.local&password=changeme123');
  // Check if login succeeded — if cookie wasn't set, most checks will 302
}

function formData(params) {
  return Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function main() {
  console.log(`=== E2E SMOKE (${base}) ===`);

  // Login first
  await login();

  for (const check of manifest) {
    const { label, method, path, expect: expected, auth } = check;

    // Skip auth-required checks if login failed (we still try)
    const res = await fetch(method, path);
    const status = res.status;
    const ok = status === expected;

    if (ok) {
      console.log(`  ✅ ${label} (${status})`);
      passed++;
    } else {
      console.log(`  ❌ ${label} — expected ${expected}, got ${status}`);
      failed++;
    }
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
