// D-066 Tutorial YAML content loader
// Reads chapter files from src/content/tutorial/d066/*.yml
// Populates the chapter definitions in tutorial-state.js

const fs = require('fs');
const path = require('path');

const CHAPTERS_DIR = path.join(__dirname, '..', 'content', 'tutorial', 'd066');
const DIAGRAMS_DIR = path.join(__dirname, '..', 'views', 'forge', 'tutorial', 'diagrams');
const CHAPTER_ORDER = [
  '00-welcome',
  '01-three-things',
  '02-numbering',
  '03-create-customer',
  '04-create-wo',
  '05-add-estimate',
  '06-convert-to-invoice',
  '07-record-payment',
  '08-side-quest-loose-estimate',
  '09-quiz',
  '09-5-cleanup-explanation',
];

let loaded = false;
let loadedSignature = '';
let yamlAvailable = false;

try { require('js-yaml'); yamlAvailable = true; } catch (e) { /* js-yaml not installed, use JSON fallback */ }

function getContentSignature() {
  return CHAPTER_ORDER.map((fileBase) => {
    const filePath = path.join(CHAPTERS_DIR, `${fileBase}.yml`);
    if (!fs.existsSync(filePath)) return `${fileBase}:missing`;
    const stats = fs.statSync(filePath);
    return `${fileBase}:${stats.mtimeMs}:${stats.size}`;
  }).join('|');
}

function loadChapters() {
  const signature = getContentSignature();
  if (loaded && signature === loadedSignature) return;
  const YAML = yamlAvailable ? require('js-yaml') : null;
  const { chapters } = require('./tutorial-state');
  chapters.length = 0;

  for (const fileBase of CHAPTER_ORDER) {
    const filePath = path.join(CHAPTERS_DIR, `${fileBase}.yml`);
    if (!fs.existsSync(filePath)) continue;
    let doc;
    if (YAML) {
      doc = YAML.load(fs.readFileSync(filePath, 'utf8'));
    } else {
      try { doc = JSON.parse(fs.readFileSync(filePath.replace('.yml', '.json'), 'utf8')); }
      catch (e) { continue; }
    }
    if (doc) chapters.push(doc);
  }

  loaded = true;
  loadedSignature = signature;
}

function getChapter(index) {
  loadChapters();
  const { chapters } = require('./tutorial-state');
  return chapters[index] || null;
}

function totalChapters() {
  loadChapters();
  const { chapters } = require('./tutorial-state');
  return chapters.length;
}

module.exports = { loadChapters, getChapter, totalChapters, interpolateNarration, getDiagramPath };

/** Replace {{tokens}} in narration with user data. */
function interpolateNarration(text, user) {
  if (!text) return '';
  const name = user?.name || 'there';
  const firstName = name.split(/\s+/)[0] || name;
  const vars = {
    userName: name,
    first_name: firstName,
    firstName,
    userEmail: user?.email || '',
  };
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || `{{${key}}}`);
}

/** Get the file path for a diagram SVG by name. */
function getDiagramPath(diagramId) {
  const p = path.join(DIAGRAMS_DIR, `${diagramId}.svg`);
  return fs.existsSync(p) ? p : null;
}
