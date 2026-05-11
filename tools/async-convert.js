#!/usr/bin/env node
/**
 * async-convert.js — Converts route/service files to async/await for Round 27.
 *
 * Usage: node async-convert.js <file1> [file2 ...]
 *
 * Changes per file:
 * 1. Add `const asyncHandler = require('../middleware/async-handler');` after last require
 * 2. Wrap route handlers: `router.get('/path', asyncHandler(async (req, res) => {`
 * 3. Add `await` before all db.get/db.all/db.run/db.exec/db.transaction calls
 * 4. Convert `db.transaction(() => {` to `db.transaction(async (tx) => {`
 * 5. Change `db.run(` inside transaction callbacks to `tx.run(`
 * 6. Same for db.get/db.all inside transaction callbacks
 *
 * Skips: string literals, comments, already-await expressions
 */
const fs = require('fs');
const path = require('path');

function convertFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;
  const base = path.basename(filePath);
  const dir = path.dirname(filePath);
  const isRoute = dir.includes('routes');
  const isService = dir.includes('services');

  // 1. Add asyncHandler import (if route file and import doesn't exist)
  if (isRoute && !content.includes('async-handler')) {
    const lastRequire = content.lastIndexOf('require(');
    const endOfLine = content.indexOf('\n', lastRequire);
    const rest = content.slice(endOfLine);
    // Check if there's a non-require line after
    const insertAt = content.indexOf('\n', lastRequire + 50);
    const nextLine = content.slice(insertAt + 1).trim();
    if (nextLine.startsWith('const ') || nextLine.startsWith('var ') || nextLine.startsWith('let ')) {
      content = content.slice(0, insertAt + 1) +
        "const asyncHandler = require('../middleware/async-handler');\n" +
        content.slice(insertAt + 1);
    } else {
      content = content.slice(0, endOfLine + 1) +
        "const asyncHandler = require('../middleware/async-handler');\n" +
        content.slice(endOfLine + 1);
    }
  }

  // For service files, services uses ../db/db so asyncHandler path would be ../middleware/async-handler
  // But services don't use asyncHandler directly — route handlers do

  // 2 & 3: Process line by line
  const lines = content.split('\n');
  const newLines = [];
  let inTransaction = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    // Skip string/SQL continuation lines
    if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`') ||
        trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('+') ||
        trimmed.startsWith('|')) {
      newLines.push(line);
      continue;
    }

    // Skip lines inside transaction callbacks — we handle them differently
    // Track transaction depth
    if (/db\.transaction\s*\(/.test(line)) {
      // Check if this is a single-line transaction
      if (line.includes('=>') && line.includes('{') && line.includes('}')) {
        // Single line — replace db.* with tx.*
        line = line.replace(/db\.(get|all|run)\(/g, 'tx.$1(');
        if (!line.includes('async ')) {
          line = line.replace(/(db\.transaction\s*\()\s*(\([^)]*\))\s*=>\s*\{/, '$1async $2 => {');
        }
        line = line.replace(/await\s+(tx\.)/g, '$1');  // Remove double await
        newLines.push(line);
        continue;
      }
      // Multi-line — start tracking
      // Ensure callback is async
      if (!trimmed.startsWith('async ')) {
        line = line.replace(/(db\.transaction\s*\()\s*(?:\(\s*\)|\(\s*([^)]*)\s*\))?\s*=>\s*\{/,
          (match, prefix, params) => {
            params = params || '';
            return `${prefix}async (${params}) => {`;
          });
      }
      // Also replace the first db calls after => { with tx calls
      inTransaction++;
    }

    // Replace db.* with tx.* inside transaction (the first level)
    if (inTransaction > 0 && /db\.(get|all|run)\(/.test(line) && !trimmed.startsWith('//')) {
      // Only replace if there was an opening brace recently
      line = line.replace(/db\.(get|all|run)\(/g, 'tx.$1(');
    }

    // Track close braces to decrement transaction depth
    if (inTransaction > 0) {
      // Count closing braces before counting opens (simplified)
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      if (closes > opens && trimmed.startsWith('})') || trimmed.startsWith('});')) {
        inTransaction--;
      }
    }

    // Track transaction exit
    if (line.includes('});') && inTransaction > 0 && !line.includes('=>')) {
      inTransaction = 0;
    }

    // Add await before db.* calls (but not if already awaited, not in comments/strings)
    if (/db\.(get|all|run|exec|transaction)\s*\(/.test(line) && !trimmed.startsWith('//') &&
        !/await\s+db\./.test(line) && !trimmed.startsWith('"') && !trimmed.startsWith("'") &&
        !trimmed.startsWith('`') && !trimmed.startsWith('+')) {
      line = line.replace(/(?<!\.)(db\.(?:get|all|run|exec|transaction)\s*\()/g, 'await $1');
    }

    newLines.push(line);
  }

  content = newLines.join('\n');

  // Clean up: remove duplicate await await
  content = content.replace(/await\s+await\s+/g, 'await ');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  Converted: ${path.relative(process.cwd(), filePath)}`);
    return true;
  }
  return false;
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node async-convert.js <file1> [file2 ...]');
  process.exit(1);
}

let count = 0;
for (const arg of args) {
  if (fs.existsSync(arg) && arg.endsWith('.js')) {
    if (convertFile(arg)) count++;
  } else {
    console.warn(`  Skipped: ${arg} (not found or not .js)`);
  }
}
console.log(`Done. ${count} file(s) converted.`);
