#!/usr/bin/env node
/**
 * write-feedback-log.js — D-088: snapshot writer
 *
 * Queries the unified inbox feed for NEW items and writes them to
 * bridges/FEEDBACK_AND_ERRORS_LOG.md so Cowork and GPT can read
 * without DB access.
 *
 * Usage: node scripts/write-feedback-log.js
 * Output: updates ~/forge-recon/bridges/FEEDBACK_AND_ERRORS_LOG.md
 *
 * Designed to be called from the watcher cycle or manually.
 * Idempotent — overwrites, doesn't append.
 */

const path = require('path');
const fs = require('fs');

// Resolve paths relative to project root
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BRIDGES_DIR = path.resolve(PROJECT_ROOT, '..', 'bridges');
const LOG_FILE = path.join(BRIDGES_DIR, 'FEEDBACK_AND_ERRORS_LOG.md');

async function main() {
  // Load env from .env if available
  try {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      envContent.split('\n').forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = rest.join('=').trim();
        }
      });
    }
  } catch(e) {
    console.warn('[write-feedback-log] could not load .env:', e.message);
  }

  try {
    const feedback = require(path.join(PROJECT_ROOT, 'src', 'services', 'feedback'));
    const items = await feedback.getInboxFeed(30);

    const newItems = items.filter(i => i.status === 'new');
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';

    let content = `# FEEDBACK AND ERRORS LOG (D-088 auto-snapshot)\n\n`;
    content += `> Last updated: ${ts}\n`;
    content += `> Source: unified inbox feed (user_feedback + ai_chat_errors)\n\n`;
    content += `---\n\n`;

    if (newItems.length === 0) {
      content += `## No new items — all clear. 🟢\n\n`;
      content += `All ${items.length} total items have been triaged (none in 'new' status).\n\n`;
    } else {
      content += `## New items (${newItems.length}):\n\n`;

      newItems.forEach((item, i) => {
        content += `### ${i + 1}. [${item.source === 'user_feedback' ? 'Feedback' : 'Error'}] ${item.title}\n`;
        content += `- **Source:** \`${item.source}\` (#${item.sourceId})\n`;
        content += `- **Time:** ${new Date(item.createdAt).toISOString()}\n`;
        content += `- **User ID:** ${item.userId || 'anonymous'}\n`;
        if (item.pageUrl) content += `- **Page:** ${item.pageUrl}\n`;
        content += `- **Body:** ${item.body.slice(0, 300)}${item.body.length > 300 ? '...' : ''}\n`;
        content += `- **Status action:** \`/admin/inbox?status=new\`\n\n`;
      });

      content += `---\n\n`;
      content += `## All items (${items.length} total):\n\n`;
      content += `| # | Source | Status | Preview | Time |\n`;
      content += `|---|---|---|---|---|\n`;
      items.forEach((item, i) => {
        const preview = item.body.slice(0, 60).replace(/\n/g, ' ');
        content += `| ${i+1} | ${item.source === 'user_feedback' ? '📝' : '⚠️'} | ${item.status} | ${preview}... | ${new Date(item.createdAt).toISOString().slice(0, 16)} |\n`;
      });
    }

    // Ensure bridges dir exists
    if (!fs.existsSync(BRIDGES_DIR)) {
      fs.mkdirSync(BRIDGES_DIR, { recursive: true });
    }

    fs.writeFileSync(LOG_FILE, content, 'utf-8');
    console.log(`[write-feedback-log] Wrote ${LOG_FILE} (${newItems.length} new items, ${items.length} total)`);
    process.exit(0);
  } catch (e) {
    console.error('[write-feedback-log] ERROR:', e.message);
    // Write error state to file so the log isn't stale
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    const errorContent = `# FEEDBACK AND ERRORS LOG (D-088 auto-snapshot)\n\n`;
    const errorFile = errorContent + `> Last updated: ${ts}\n> Status: ERROR — ${e.message}\n>\n> The snapshot writer failed. Check Vercel logs or run manually:\n> \`\`\`\n> node scripts/write-feedback-log.js\n> \`\`\`\n`;
    fs.writeFileSync(LOG_FILE, errorContent, 'utf-8');
    console.error(`[write-feedback-log] Wrote error state to ${LOG_FILE}`);
    process.exit(1);
  }
}

main();
