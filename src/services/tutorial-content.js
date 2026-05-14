// D-066 Tutorial YAML content loader
// Reads chapter files from src/content/tutorial/d066/*.yml
// Populates the chapter definitions in tutorial-state.js

const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');

const CHAPTERS_DIR = path.join(__dirname, '..', 'content', 'tutorial', 'd066');
const CHAPTER_ORDER = [
  '00-welcome',
  '01-concept-three-things',
  '02-concept-numbering',
  '03-do-customer',
  '04-do-work-order',
  '05-do-estimate',
  '06-do-invoice',
  '07-do-payment',
  '08-side-quest-quick-quote',
  '09-wrap-up',
];

let loaded = false;

function loadChapters() {
  if (loaded) return;
  const { chapters } = require('./tutorial-state');
  chapters.length = 0;

  for (const fileBase of CHAPTER_ORDER) {
    const filePath = path.join(CHAPTERS_DIR, `${fileBase}.yml`);
    if (!fs.existsSync(filePath)) continue;
    const doc = YAML.load(fs.readFileSync(filePath, 'utf8'));
    if (doc) {
      chapters.push(doc);
    }
  }

  loaded = true;
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

module.exports = { loadChapters, getChapter, totalChapters };
