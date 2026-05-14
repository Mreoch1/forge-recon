// D-066 Tutorial state machine — chapter progression + quiz + cleanup
// Replaces D-063 v3 client-side walkthrough with server-side state.

const chapters = []; // Populated by content loader

const VALID_ACTIONS = ['next', 'back', 'skip_chapter', 'restart_chapter', 'exit', 'submit_quiz', 'select_chip'];

class TutorialState {
  constructor(sessionId, userId) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.currentChapter = 0;
    this.currentStep = 0;
    this.completedChapters = [];
    this.createdEntityIds = { customers: [], work_orders: [], estimates: [], invoices: [], payments: [] };
    this.quizAnswers = {};
    this.quizSubmitted = false;
    this.quizWeakSpots = [];      // D-076: persistent weak spots for remediation
    this.cleanupChosen = null;
    this.startedAt = new Date().toISOString();
  }

  static async load(sessionId, userId, supabase) {
    const { data } = await supabase
      .from('tutorial_sessions')
      .select('state_json')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (data?.state_json) return Object.assign(new TutorialState(sessionId, userId), data.state_json);
    return new TutorialState(sessionId, userId);
  }

  async save(supabase) {
    await supabase.from('tutorial_sessions').upsert({
      id: this.sessionId,
      user_id: this.userId,
      state_json: {
        currentChapter: this.currentChapter,
        currentStep: this.currentStep,
        completedChapters: this.completedChapters,
        createdEntityIds: this.createdEntityIds,
        quizAnswers: this.quizAnswers,
        quizSubmitted: this.quizSubmitted,
        quizWeakSpots: this.quizWeakSpots,
        cleanupChosen: this.cleanupChosen,
        startedAt: this.startedAt,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  }

  getCurrentChapter() {
    return chapters[this.currentChapter] || null;
  }

  getCurrentStep() {
    const ch = this.getCurrentChapter();
    return (ch?.steps || [])[this.currentStep] || null;
  }

  advance() {
    const ch = this.getCurrentChapter();
    if (!ch) return { done: true };

    const steps = ch.steps || [];
    if (this.currentStep < steps.length - 1) {
      this.currentStep++;
    } else if (this.currentChapter < chapters.length - 1) {
      if (!this.completedChapters.includes(this.currentChapter)) {
        this.completedChapters.push(this.currentChapter);
      }
      this.currentChapter++;
      this.currentStep = 0;
    } else {
      return { done: true };
    }
    return { done: false, chapter: this.getCurrentChapter(), step: this.currentStep };
  }

  goBack() {
    if (this.currentStep > 0) {
      this.currentStep--;
    } else if (this.currentChapter > 0) {
      this.currentChapter--;
      const prevCh = chapters[this.currentChapter];
      this.currentStep = (prevCh.steps || []).length - 1;
    }
    return { chapter: this.getCurrentChapter(), step: this.currentStep };
  }

  skipChapter() {
    if (this.currentChapter < chapters.length - 1) {
      this.completedChapters.push(this.currentChapter);
      this.currentChapter++;
      this.currentStep = 0;
    }
    return { chapter: this.getCurrentChapter(), step: this.currentStep };
  }

  restartChapter() {
    this.currentStep = 0;
    return { chapter: this.getCurrentChapter(), step: 0 };
  }

  /** Navigate to a specific chapter by id (REPLAY_CHAPTER or EXIT_TUTORIAL). */
  gotoChapter(chapterId) {
    if (chapterId === 'EXIT_TUTORIAL') {
      return { exit: true };
    }
    const idx = chapters.findIndex(c => c.id === chapterId);
    if (idx >= 0) {
      this.currentChapter = idx;
      this.currentStep = 0;
    }
    return { chapter: this.getCurrentChapter(), step: this.currentStep };
  }

  /** Process an action from the coach, including branch targets like REPLAY_CHAPTER:<id>. */
  processAction(action, payload, supabase) {
    // Check for REPLAY_CHAPTER or EXIT_TUTORIAL branches
    if (typeof action === 'string' && action.startsWith('REPLAY_CHAPTER:')) {
      const chapterId = action.replace('REPLAY_CHAPTER:', '');
      return this.gotoChapter(chapterId);
    }
    if (action === 'exit' || action === 'EXIT_TUTORIAL') {
      return { exit: true };
    }

    switch (action) {
      case 'next': return this.advance();
      case 'back': return this.goBack();
      case 'skip_chapter': return this.skipChapter();
      case 'restart_chapter': return this.restartChapter();
      case 'submit_quiz': return this.submitQuiz(payload?.answers || {});
      case 'select_chip': return this.selectChip(payload);
      default: return { error: `Unknown action: ${action}` };
    }
  }

  selectChip(payload) {
    const step = this.getCurrentStep();
    const key = payload?.value || payload?.query || payload?.label || '*';
    const target = step?.branches?.[key] || step?.branches?.['*'];
    if (!target) return this.advance();
    if (target === 'EXIT_TUTORIAL') return { exit: true };
    if (target === 'ADVANCE_CHAPTER') return this.skipChapter();
    if (typeof target === 'string' && target.startsWith('REPLAY_CHAPTER:')) {
      return this.gotoChapter(target.replace('REPLAY_CHAPTER:', ''));
    }
    const ch = this.getCurrentChapter();
    const idx = (ch?.steps || []).findIndex(s => s.id === target);
    if (idx >= 0) {
      this.currentStep = idx;
      return { chapter: this.getCurrentChapter(), step: this.currentStep };
    }
    return this.advance();
  }

  // Quiz
  submitQuiz(answers) {
    this.quizAnswers = answers;
    this.quizSubmitted = true;
    const result = this.scoreQuiz(answers);
    this.quizWeakSpots = result.weakSpots;
    return result;
  }

  scoreQuiz(answers) {
    const quiz = this.getCurrentChapter()?.quiz;
    if (!quiz) return { score: 0, total: 0, weakSpots: [] };
    const total = quiz.questions.length;
    let correct = 0;
    const weakSpots = [];
    quiz.questions.forEach((q) => {
      if (answers[q.id] === q.answer) {
        correct++;
      } else {
        weakSpots.push(q.id);
      }
    });
    return { score: correct, total, weakSpots };
  }

  /** Execute side_effects from a chapter step. */
  async executeSideEffects(sideEffects, supabase, userId) {
    if (!sideEffects || !sideEffects.length) return;
    for (const effect of sideEffects) {
      if (effect.record_completion) {
        await supabase.from('users').update({ completed_tutorial_at: new Date().toISOString() }).eq('id', userId);
      }
      if (effect.persist_weak_spots && this.quizWeakSpots.length) {
        await supabase.from('users').update({ tutorial_completion_weak_spots: JSON.stringify(this.quizWeakSpots) }).eq('id', userId);
      }
      if (effect.call_endpoint) {
        // effect.call_endpoint is a URL path like "POST /forge/tutorial/cleanup"
        // Handled by route handler, not state machine
      }
    }
  }
}

module.exports = { TutorialState, chapters, VALID_ACTIONS };
