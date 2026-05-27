const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const content = require('../src/services/tutorial-content');
const { TutorialState, chapters } = require('../src/services/tutorial-state');

describe('D-066 tutorial content flow', () => {
  before(() => {
    content.loadChapters();
  });

  test('loads the current WO, estimate, invoice, and payment tour', () => {
    assert.equal(content.totalChapters(), 8);
    assert.equal(chapters[0].id, '00-welcome');
    assert.equal(chapters.at(-1).id, '07-record-payment');

    const allText = JSON.stringify(chapters).toLowerCase();
    for (const required of ['work order', 'estimate', 'invoice', 'payment']) {
      assert.match(allText, new RegExp(required));
    }
  });

  test('every branch points to a valid step or supported flow command', () => {
    const chapterIds = new Set(chapters.map(ch => ch.id));
    for (const chapter of chapters) {
      const stepIds = new Set((chapter.steps || []).map(step => step.id));
      for (const step of chapter.steps || []) {
        for (const target of Object.values(step.branches || {})) {
          if (target === 'ADVANCE_CHAPTER' || target === 'EXIT_TUTORIAL') continue;
          if (typeof target === 'string' && target.startsWith('REPLAY_CHAPTER:')) {
            assert.equal(chapterIds.has(target.replace('REPLAY_CHAPTER:', '')), true, `${chapter.id}.${step.id} points to missing chapter ${target}`);
            continue;
          }
          assert.equal(stepIds.has(target), true, `${chapter.id}.${step.id} points to missing step ${target}`);
        }
      }
    }
  });

  test('hands-on chapters stay inside the tutorial practice surface', () => {
    const supportedActions = new Set([
      'auto_advance',
      'chip_or_text',
      'click_or_route_change',
      'click_or_dom_change',
      'form_field_filled',
      'form_field_filled_multiple',
      'form_submit',
    ]);
    const allText = JSON.stringify(chapters);
    assert.doesNotMatch(allText, /left navigation|Click \*\*Customers\*\*|click back to the \*\*customer\*\*/i);
    assert.doesNotMatch(allText, /practice button|practice Save|practice customer/i);

    for (const chapter of chapters) {
      for (const step of chapter.steps || []) {
        assert.equal(supportedActions.has(step.expected_action), true, `${chapter.id}.${step.id} uses unsupported action ${step.expected_action}`);
      }
    }
  });

  test('happy path can walk the current tutorial without dangling steps', () => {
    const state = new TutorialState('tutorial-flow', 1);
    const choiceByStep = {
      'checkpoint-real-vs-tutorial': 'got_it',
      'ready-prompt': 'start',
      'comprehension-check': 'wo_before_est',
      'numbering-comprehension': 'correct',
    };
    const visited = [];

    for (let guard = 0; guard < 200; guard++) {
      const chapter = state.getCurrentChapter();
      const step = state.getCurrentStep();
      assert.ok(chapter, 'current chapter should exist');
      assert.ok(step, `current step should exist in ${chapter.id}`);
      visited.push(`${chapter.id}:${step.id}`);
      state.recordStepAnswer(step.record_answer);

      const choice = choiceByStep[step.id];
      const result = choice
        ? state.processAction('select_chip', { value: choice })
        : state.processAction('next');
      if (result.exit || result.done) break;
    }

    assert.ok(visited.includes('04-create-wo:form-arrived'));
    assert.ok(visited.includes('05-add-estimate:after-save'));
    assert.ok(visited.includes('06-convert-to-invoice:after-convert'));
    assert.ok(visited.some(step => step.startsWith('07-record-payment:')));
  });
});
