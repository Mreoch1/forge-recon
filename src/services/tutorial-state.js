// D-066 Tutorial state machine — chapter progression + quiz + cleanup
// Replaces D-063 v3 client-side walkthrough with server-side state.

const chapters = []; // Populated by content loader

const VALID_ACTIONS = ['next', 'back', 'skip_chapter', 'restart_chapter', 'exit', 'submit_quiz', 'select_chip'];

class TutorialState {
  constructor(sessionId, userId) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.currentChapter = 0;
    this.currentStep = 0; // step within chapter: narration → wait_for_action → reaction
    this.completedChapters = [];
    this.createdEntityIds = { customers: [], work_orders: [], estimates: [], invoices: [], payments: [] };
    this.quizAnswers = {};
    this.quizSubmitted = false;
    this.cleanupChosen = null; // 'cleanup' | 'keep' | null
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
        cleanupChosen: this.cleanupChosen,
        startedAt: this.startedAt,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  }

  // Get current chapter content
  getCurrentChapter() {
    return chapters[this.currentChapter] || null;
  }

  // Advance to next step/chapter
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
      return { done: true }; // tutorial complete
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

  // Quiz
  submitQuiz(answers) {
    this.quizAnswers = answers;
    this.quizSubmitted = true;
    return this.scoreQuiz(answers);
  }

  scoreQuiz(answers) {
    const quiz = this.getCurrentChapter()?.quiz;
    if (!quiz) return { score: 0, total: 0, weakSpots: [] };
    const total = quiz.questions.length;
    let correct = 0;
    const weakSpots = [];
    quiz.questions.forEach((q, i) => {
      if (answers[q.id] === q.answer) {
        correct++;
      } else {
        weakSpots.push(q.id);
      }
    });
    return { score: correct, total, weakSpots };
  }
}

module.exports = { TutorialState, chapters, VALID_ACTIONS };
