/**
 * Unit tests for src/services/tutorial-state.js — chapter progression,
 * quiz scoring, cleanup state management.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Clear any pre-loaded chapters
const tutState = require('../src/services/tutorial-state');

describe('TutorialState', () => {
  let state;

  before(() => {
    // Populate the chapters array with test data
    const { chapters } = tutState;
    chapters.length = 0;
    chapters.push(
      { id: 'welcome', title: 'Welcome', steps: ['narration', 'wait_for_action', 'reaction'] },
      { id: 'concept-a', title: 'Concept A', steps: ['narration', 'wait_for_action'] },
      { id: 'quiz-chapter', title: 'Quiz', steps: ['narration', 'wait_for_action'],
        quiz: {
          questions: [
            { id: 'q1', text: 'T/F question', options: [
              { value: true, label: 'True' }, { value: false, label: 'False' }
            ], answer: false },
            { id: 'q2', text: 'Multiple choice', options: [
              { value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }
            ], answer: 'a' },
          ]
        }
      }
    );
    state = new tutState.TutorialState('test-session', 1);
  });

  test('initial state is chapter 0, step 0', () => {
    assert.equal(state.currentChapter, 0);
    assert.equal(state.currentStep, 0);
    assert.equal(state.quizSubmitted, false);
    assert.equal(state.cleanupChosen, null);
  });

  test('advance moves within chapter', () => {
    const r = state.advance();
    assert.equal(r.done, false);
    assert.equal(state.currentStep, 1);
  });

  test('advance to next chapter when steps exhausted', () => {
    const fresh = new tutState.TutorialState('next-ch', 1);
    fresh.currentStep = 2; // last step (index 2 of 3) in chapter 0
    const r = fresh.advance();
    assert.equal(r.done, false);
    assert.equal(fresh.currentChapter, 1);
    assert.equal(fresh.currentStep, 0);
    assert.deepEqual(fresh.completedChapters, [0]);
  });

  test('advance returns done=true when at last chapter last step', () => {
    state.currentChapter = 2;  // Last chapter
    state.currentStep = 0;
    // Advance within chapter (step 0 -> 1 still has wait_for_action)
    const r1 = state.advance();
    assert.equal(r1.done, false);
    assert.equal(state.currentChapter, 2);
    assert.equal(state.currentStep, 1);
    // Advance from last step of last chapter
    const r2 = state.advance();
    assert.equal(r2.done, true);
  });

  test('goBack goes to previous step within chapter', () => {
    state.currentChapter = 0;
    state.currentStep = 1;
    const r = state.goBack();
    assert.equal(state.currentStep, 0);
    assert.equal(state.currentChapter, 0);
  });

  test('goBack goes to previous chapter if at first step', () => {
    state.currentChapter = 1;
    state.currentStep = 0;
    const r = state.goBack();
    assert.equal(state.currentChapter, 0);
    assert.equal(state.currentStep, 2); // steps.length - 1 = 2
  });

  test('goBack at chapter 0 step 0 stays put', () => {
    state.currentChapter = 0;
    state.currentStep = 0;
    const r = state.goBack();
    assert.equal(state.currentChapter, 0);
    assert.equal(state.currentStep, 0);
  });

  test('skipChapter advances to next chapter', () => {
    state.currentChapter = 0;
    state.currentStep = 0;
    const r = state.skipChapter();
    assert.equal(state.currentChapter, 1);
    assert.equal(state.currentStep, 0);
    assert.deepEqual(state.completedChapters, [0]);
  });

  test('skipChapter at last chapter stays', () => {
    state.currentChapter = 2;
    state.currentStep = 0;
    const r = state.skipChapter();
    assert.equal(state.currentChapter, 2);
    assert.equal(state.currentStep, 0);
  });

  test('restartChapter resets step to 0', () => {
    state.currentChapter = 1;
    state.currentStep = 1;
    const r = state.restartChapter();
    assert.equal(state.currentStep, 0);
    assert.equal(state.currentChapter, 1);
  });

  test('selectChip follows step branch targets', () => {
    const { chapters } = tutState;
    const branchIndex = chapters.length;
    chapters.push({
      id: 'branching',
      title: 'Branching',
      steps: [
        { id: 'choice', coach_text: 'Choose', branches: { yes: 'target' } },
        { id: 'target', coach_text: 'Target' },
      ],
    });
    const fresh = new tutState.TutorialState('branch-test', 1);
    fresh.currentChapter = branchIndex;
    fresh.currentStep = 0;
    const r = fresh.processAction('select_chip', { value: 'yes' });
    assert.equal(r.step, 1);
    assert.equal(fresh.currentStep, 1);
    assert.equal(fresh.getCurrentStep().id, 'target');
    chapters.pop();
  });

  describe('quiz scoring', () => {
    test('recordStepAnswer stores correctness and weak spot', () => {
      const fresh = new tutState.TutorialState('quiz-step-answer', 1);
      fresh.recordStepAnswer({ question: 'numbering', correct: false, weak_spot: 'numbering' });
      assert.deepEqual(fresh.quizAnswers, { numbering: false });
      assert.deepEqual(fresh.quizWeakSpots, ['numbering']);

      fresh.recordStepAnswer({ question: 'numbering_retry', correct: true, weak_spot: 'numbering' });
      assert.equal(fresh.quizAnswers.numbering_retry, true);
      assert.deepEqual(fresh.quizWeakSpots, ['numbering']);
    });

    test('submitQuiz marks quizSubmitted = true', () => {
      const fresh = new tutState.TutorialState('quiz-test', 1);
      fresh.currentChapter = 2; // quiz-chapter
      fresh.submitQuiz({ q1: false, q2: 'a' });
      assert.equal(fresh.quizSubmitted, true);
    });

    test('scoreQuiz returns correct count for all right', () => {
      const fresh = new tutState.TutorialState('quiz-test', 1);
      fresh.currentChapter = 2;
      const result = fresh.submitQuiz({ q1: false, q2: 'a' });
      assert.equal(result.score, 2);
      assert.equal(result.total, 2);
      assert.deepEqual(result.weakSpots, []);
    });

    test('scoreQuiz returns weak spots for wrong answers', () => {
      const fresh = new tutState.TutorialState('quiz-test', 1);
      fresh.currentChapter = 2;
      const result = fresh.submitQuiz({ q1: true, q2: 'a' }); // q1 wrong
      assert.equal(result.score, 1);
      assert.equal(result.total, 2);
      assert.deepEqual(result.weakSpots, ['q1']);
    });

    test('scoreQuiz returns weak spots for all wrong', () => {
      const fresh = new tutState.TutorialState('quiz-test', 1);
      fresh.currentChapter = 2;
      const result = fresh.submitQuiz({ q1: true, q2: 'c' });
      assert.equal(result.score, 0);
      assert.equal(result.total, 2);
      assert.deepEqual(result.weakSpots, ['q1', 'q2']);
    });

    test('submitQuiz returns empty result for non-quiz chapter', () => {
      const fresh = new tutState.TutorialState('quiz-test', 1);
      fresh.currentChapter = 0; // welcome — no quiz
      const result = fresh.submitQuiz({});
      assert.equal(result.score, 0);
      assert.equal(result.total, 0);
      assert.deepEqual(result.weakSpots, []);
    });
  });

  describe('cleanup state', () => {
    test('cleanupChosen starts null', () => {
      const fresh = new tutState.TutorialState('cleanup-test', 1);
      assert.equal(fresh.cleanupChosen, null);
    });

    test('created entity IDs initialized empty', () => {
      const fresh = new tutState.TutorialState('entity-test', 1);
      assert.deepEqual(fresh.createdEntityIds, {
        customers: [], work_orders: [], estimates: [], invoices: [], payments: []
      });
    });
  });

  describe('persistence errors', () => {
    function makeSupabaseResult(result) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        upsert: () => chain,
        maybeSingle: () => Promise.resolve(result),
      };
      return {
        from: () => chain,
      };
    }

    test('load throws when Supabase returns an error', async () => {
      const supabase = makeSupabaseResult({ data: null, error: new Error('load failed') });
      await assert.rejects(
        () => tutState.TutorialState.load('bad-load', 1, supabase),
        /load failed/
      );
    });

    test('save throws when Supabase returns an error', async () => {
      const saveError = new Error('save failed');
      const supabase = {
        from: () => ({
          upsert: () => Promise.resolve({ data: null, error: saveError }),
        }),
      };
      const fresh = new tutState.TutorialState('bad-save', 1);
      await assert.rejects(() => fresh.save(supabase), /save failed/);
    });

    test('executeSideEffects throws when completion update fails', async () => {
      const updateError = new Error('completion failed');
      const supabase = {
        from: () => ({
          update: () => ({
            eq: () => Promise.resolve({ data: null, error: updateError }),
          }),
        }),
      };
      const fresh = new tutState.TutorialState('bad-side-effect', 1);
      await assert.rejects(
        () => fresh.executeSideEffects([{ record_completion: true }], supabase, 1),
        /completion failed/
      );
    });
  });

  describe('chapter content', () => {
    test('getCurrentChapter returns correct chapter by index', () => {
      state.currentChapter = 1;
      const ch = state.getCurrentChapter();
      assert.equal(ch.id, 'concept-a');
      assert.equal(ch.title, 'Concept A');
    });

    test('getCurrentChapter returns null for out-of-bounds', () => {
      state.currentChapter = 99;
      assert.equal(state.getCurrentChapter(), null);
    });
  });
});
