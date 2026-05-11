#!/usr/bin/env node
/**
 * Convert route/service files for Round 27 async.
 * With express-async-errors installed, handlers just need 'async' + 'await'.
 */
const fs = require('fs');
const path = require('path');

function convertFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;
  let modified = false;

  // 1. Make route handler callbacks async
  // Pattern: router.get('/path', (req, res) => {  →  async (req, res) => {
  // But NOT error handlers: (err, req, res, next) =>
  content = content.replace(
    /(router\.(?:get|post|use|put|delete)\([^,]+,\s*)\(req,\s*res\)\s*=>\s*\{/g,
    (match, prefix) => { modified = true; return prefix + 'async (req, res) => {'; }
  );

  // Also app.get/post/use
  content = content.replace(
    /(app\.(?:get|post|use|put|delete)\([^,]+,\s*)\(req,\s*res\)\s*=>\s*\{/g,
    (match, prefix) => { modified = true; return prefix + 'async (req, res) => {'; }
  );

  // 2. Make standalone functions that call db.* async
  content = content.replace(
    /^(\s*)function\s+(\w+)\s*\(/gm,
    (match, indent, name) => {
      // Check if the function body contains db calls
      const rest = content.slice(content.indexOf(match) + match.length);
      const bodyEnd = rest.indexOf('function ') >= 0 ?
        Math.min(rest.indexOf('function '), rest.indexOf('\n\n')) :
        rest.indexOf('\n\n');
      const body = rest.slice(0, bodyEnd > 0 ? bodyEnd : 200);
      if (/db\.(get|all|run|exec|transaction)\s*\(/.test(body)) {
        modified = true;
        return indent + 'async function ' + name + '(';
      }
      return match;
    }
  );

  // 3. Add await before db.get/db.all/db.run/db.exec/db.transaction calls
  // Skip lines that are clearly inside string literals
  const lines = content.split('\n');
  const newLines = [];
  let inTransaction = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    // Skip comment/SQL string continuation lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') ||
        trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`')) {
      newLines.push(line);
      continue;
    }

    // Track transaction depth
    if (/db\.transaction\s*\(/.test(line)) {
      // Make the callback async
      line = line.replace(
        /(db\.transaction\s*\()\s*(\(\s*\))?\s*=>\s*\{/,
        (m, pre, params) => pre + 'async (tx) => {'
      );
      inTransaction++;
    }

    // Inside transaction, replace db.* with tx.*
    if (inTransaction > 0 && /db\.(get|all|run)\(/.test(line) && !trimmed.startsWith('//')) {
      line = line.replace(/db\.(get|all|run)\(/g, 'tx.$1(');
    }

    // Track transaction exit
    if (inTransaction > 0) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      if (closes > opens) inTransaction--;
    }

    // Add await before db.* calls (if not already awaited)
    if (!/await\s+db\./.test(line) && /db\.(get|all|run|exec|transaction)\s*\(/.test(line) && !trimmed.startsWith('//')) {
      line = line.replace(/(?<![.\w])db\.(get|all|run|exec|transaction)\s*\(/g, 'await db.$1(');
    }

    newLines.push(line);
  }

  content = newLines.join('\n');
  // Clean up any 'await await'
  content = content.replace(/await\s+await\s+/g, 'await ');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) { console.error('Usage: node convert.js <files...>'); process.exit(1); }

let count = 0;
for (const arg of args) {
  if (fs.existsSync(arg) && arg.endsWith('.js')) {
    if (convertFile(arg)) count++;
  }
}
console.log(`Done. ${count} file(s) converted.`);
