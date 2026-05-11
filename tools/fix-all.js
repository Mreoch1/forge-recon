#!/usr/bin/env node
/**
 * Final fix: make every function containing 'await' + 'db.'/'tx.' async.
 * Handles edge cases: IIFE, forEach callbacks, middleware-chained handlers.
 */
const fs = require('fs');
const path = require('path');

const WATCH = process.argv.slice(2);
if (WATCH.length === 0) { console.error('Usage: node fix-all.js <files...>'); process.exit(1); }

for (const filePath of WATCH) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;
  const lines = content.split('\n');
  const newLines = [...lines];

  // Strategy: find every line with 'await' + 'db.'/'tx.' that isn't in an async context
  // and make the enclosing function async.

  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/await/.test(line) || !/(?:db|tx)\.(?:get|all|run|exec|transaction)\s*\(/.test(line)) continue;

    // Walk upward to find the enclosing function
    let asyncFound = false;
    let funcLine = -1;

    for (let j = i; j >= 0; j--) {
      const l = lines[j];
      if (/\basync\b/.test(l) && /=>\s*\{/.test(l)) { asyncFound = true; break; }
      if (/async\s+function\b/.test(l)) { asyncFound = true; break; }

      // Found a non-async function definition or callback
      if (/router\.(?:get|post|use|put|delete)\([^,]+,\s*(?:require\w+,\s*)*\(req,\s*res/.test(l) && !/\basync\b/.test(l)) {
        // Wrap with async
        if (l.includes('(req, res, next)')) {
          newLines[j] = l.replace('(req, res, next)', 'async (req, res, next)');
        } else {
          newLines[j] = l.replace('(req, res)', 'async (req, res)');
        }
        changed = true;
        break;
      }
      if (/app\.(?:get|post|use)\([^,]+,\s*(?:require\w+,\s*)*\(req,\s*res/.test(l) && !/\basync\b/.test(l)) {
        newLines[j] = l.replace('(req, res)', 'async (req, res)');
        changed = true;
        break;
      }
      if (/function\s+\w+\s*\(/.test(l) && !/async\s+function/.test(l)) {
        newLines[j] = l.replace('function ', 'async function ');
        changed = true;
        break;
      }
      // Arrow function callback like: .forEach((x) => { or .forEach(x => {
      if (/(\.\w+)\s*\(\s*\(/.test(l) && /=>\s*\{/.test(l) && !/\basync\b/.test(l)) {
        newLines[j] = l.replace(/\(([^)]*)\)\s*=>\s*\{/, 'async ($1) => {');
        changed = true;
        break;
      }

      // Arrow function: (params) => { or params => {
      const arrowMatch = l.match(/^(.*?)(?:\(\s*([^)]*)\s*\)|(\w+))\s*=>\s*\{/);
      if (arrowMatch && !/\basync\b/.test(l) && !/function\b/.test(l)) {
        const prefix = arrowMatch[1];
        const params = arrowMatch[2] || arrowMatch[3] || '';
        // Skip if it's inside something like a template literal
        if (params.includes(';') || params.includes('=')) break;
        newLines[j] = `${prefix}async (${params}) => {`;
        changed = true;
        break;
      }

      // IIFE: (() => { ... })()
      if (/^\s*\(\s*\(\s*\)\s*=>\s*\{/.test(l) && !/\basync\b/.test(l)) {
        newLines[j] = l.replace(/^(\s*)\(\s*\(\s*\)\s*=>\s*\{/, '$1(async () => {');
        // Also find the closing })() and add await
        for (let k = i; k < lines.length; k++) {
          if (/^\s*\}\)/.test(lines[k]) || /^\s*\}\)\(\)/.test(lines[k])) {
            newLines[k] = lines[k].replace(/^\s*\}\)\(\)/, '})()');
            newLines[k] = '      ' + lines[funcLine > 0 ? funcLine : j] + '\n' + lines[k];
            break;
          }
        }
        break;
      }
    }
  }

  content = newLines.join('\n');
  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  Fixed: ${path.relative(process.cwd(), filePath)}`);
  }
}
console.log('Done.');
