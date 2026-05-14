#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIRS = ['src/routes', 'src/services'];
const MUTATION_RE = /\.(insert|update|upsert|delete|rpc)\s*\(/;
const READ_RE = /\.select\s*\(/;
const BEST_EFFORT_RE = /best-effort|best effort|fire-and-forget|audit|optional/i;
const INCLUDE_READS = process.argv.includes('--include-reads');

function walk(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) return walk(path.relative(ROOT, full));
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

function hasErrorHandling(context) {
  return /\{\s*(data[^}]*,\s*)?error\b/.test(context) ||
    /\berror\s*:/.test(context) ||
    /\bthrow\b/.test(context) ||
    /\bif\s*\([^)]*Err/.test(context) ||
    BEST_EFFORT_RE.test(context);
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

const warnings = [];

for (const file of SEARCH_DIRS.flatMap(walk)) {
  const source = fs.readFileSync(file, 'utf8');
  const matches = source.matchAll(/await\s+supabase[\s\S]{0,260}?(?:;|\n\s*\})/g);
  for (const match of matches) {
    const snippet = match[0];
    const isWrite = MUTATION_RE.test(snippet);
    const isRead = INCLUDE_READS && READ_RE.test(snippet);
    if (!isWrite && !isRead) continue;

    const after = source.slice(match.index, match.index + 700);
    const before = source.slice(Math.max(0, match.index - 180), match.index);
    const context = `${before}\n${after}`;
    if (hasErrorHandling(context)) continue;

    warnings.push({
      file: path.relative(ROOT, file),
      line: lineNumber(source, match.index),
      kind: isWrite ? 'write' : 'read',
      snippet: snippet.replace(/\s+/g, ' ').slice(0, 180),
    });
  }
}

if (!warnings.length) {
  console.log('PASS audit:supabase-errors - no obvious unchecked Supabase awaits found');
  process.exit(0);
}

console.log(`WARN audit:supabase-errors - ${warnings.length} unchecked Supabase await(s) found`);
for (const warning of warnings) {
  console.log(`${warning.file}:${warning.line} [${warning.kind}] ${warning.snippet}`);
}
process.exit(1);
