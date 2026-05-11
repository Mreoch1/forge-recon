#!/usr/bin/env node
/**
 * convert-routes-to-async.js — Converts route handlers to async/await for pg mode.
 *
 * This is a one-shot migration tool. Run it once, then verify.
 * It converts:
 *   router.get('/path', (req, res) => { → async (req, res) => {
 *   router.post('/path', (req, res) => { → async (req, res) => {
 *   router.use('/path', (req, res) => { → async (req, res) => {
 *   app.get(...), app.post(...) → same
 *
 * And adds `await` before db.get(, db.all(, db.run(, db.transaction( calls that
 * are used as expressions (not already in an await context).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const ROUTES = path.join(SRC, 'routes');
const SERVICES = path.join(SRC, 'services');
const SERVER = path.join(SRC, 'server.js');

function convertFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // 1. Convert handler signatures: router.get|post|use → async
  // Matches: router.get('/path', (req, res) => {
  // But NOT (err, req, res, next) patterns
  content = content.replace(
    /(router\.(?:get|post|use)\([^,]+,\s*)\(req,\s*res\)\s*=>\s*\{/g,
    (match, prefix) => {
      modified = true;
      return prefix + 'async (req, res) => {';
    }
  );
  // Also handle app.get/post/use/delete/put
  content = content.replace(
    /(app\.(?:get|post|use|put|delete)\([^,]+,\s*)\(req,\s*res\)\s*=>\s*\{/g,
    (match, prefix) => {
      modified = true;
      return prefix + 'async (req, res) => {';
    }
  );

  // 2. Add await before db.get(, db.all(, db.run(, db.transaction(
  // Only if NOT already preceded by await, and not in a comment
  // We do line-by-line to be more careful
  const lines = content.split('\n');
  const newLines = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    // Skip comments and template literal continuation lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      newLines.push(line);
      continue;
    }

    // Skip lines that are clearly template string continuation or SQL
    if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`') ||
        trimmed.startsWith('+') || trimmed.startsWith('|')) {
      newLines.push(line);
      continue;
    }

    // Add await before db.get(, db.all(, db.run(, db.transaction(
    // Pattern: not preceded by 'await ', not inside a string
    line = line.replace(
      /(?<![.\w])(?<!await\s)(db\.(?:get|all|run|transaction)\s*\()/g,
      (match, capture) => {
        // Check if this is inside a string literal (very rough check)
        // Skip if the line is a SQL string or contains SQL-like patterns
        if (/^\s*(['"`])/.test(line) || /^\s*\+/.test(line)) return match;
        modified = true;
        return 'await ' + capture;
      }
    );

    newLines.push(line);
  }
  content = newLines.join('\n');

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  Converted: ${path.relative(SRC, filePath)}`);
  }
  return modified;
}

// Main
console.log('Converting route handlers to async...');

// Routes
const routeFiles = fs.readdirSync(ROUTES).filter(f => f.endsWith('.js'));
routeFiles.forEach(f => convertFile(path.join(ROUTES, f)));

// Server
convertFile(SERVER);

// Services (check for route-like patterns)
const serviceFiles = fs.readdirSync(SERVICES).filter(f => f.endsWith('.js'));
serviceFiles.forEach(f => convertFile(path.join(SERVICES, f)));

console.log('Done.');
