/**
 * Unit tests for src/services/feedback.js — D-088 unified inbox service.
 * Uses node:test with mocked Supabase client.
 */

const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const origRequire = Module.prototype.require;

// Shared mock state
let lastQuery = {};
let mockResolve = { data: null, count: 0, error: null };

// Build a thenable chain — each method records the call and returns this
function chain(obj) {
  const c = {};
  const methods = ['from', 'select', 'insert', 'update', 'eq', 'neq', 'order', 'limit', 'range', 'maybeSingle', 'single'];
  methods.forEach(m => {
    c[m] = (...args) => {
      lastQuery[m] = args;
      return c;
    };
  });
  // .then() resolves with mockResolve
  c.then = (resolve) => {
    resolve(mockResolve);
    return c;
  };
  c.catch = () => c;
  return c;
}

const mockSupabase = chain();

describe('FeedbackService', () => {
  let feedback;

  before(() => {
    Module.prototype.require = function(id) {
      if (id === '../db/supabase' || id === '../../db/supabase') return mockSupabase;
      return origRequire.apply(this, arguments);
    };
    feedback = require('../src/services/feedback');
  });

  after(() => {
    Module.prototype.require = origRequire;
  });

  test('submitFeedback inserts into user_feedback table', async () => {
    const inserted = { id: 1, subject: 'Test subject', message: 'Test message', status: 'new' };
    mockResolve = { data: inserted, error: null };

    // Override .single() to return our data
    let singleResolve = null;
    mockSupabase.single = () => ({
      then: (resolve) => { singleResolve = resolve; return { catch: () => {} }; },
    });

    // Override insert to call singleResolve when .select().single() is called
    mockSupabase.select = () => ({
      single: () => ({
        then: (resolve) => {
          resolve(mockResolve);
          return { catch: () => {} };
        },
      }),
    });

    mockSupabase.insert = (rows) => {
      lastQuery.insert = rows;
      return mockSupabase;
    };

    const result = await feedback.submitFeedback({
      userId: 1,
      subject: 'Test subject',
      message: 'Test message',
      pageUrl: 'http://test.com/page',
      userAgent: 'TestAgent/1.0',
    });

    assert.notEqual(result, null);
    assert.equal(result.subject, 'Test subject');
    assert.equal(result.status, 'new');
    assert.ok(lastQuery.from, 'user_feedback from() was called');
    assert.equal(lastQuery.from[0], 'user_feedback');
  });

  test('submitErrorReport inserts into ai_chat_errors', async () => {
    mockResolve = { data: { id: 1, error_type: 'unknown', tool_name: 'user_reported_error' }, error: null };
    mockSupabase.select = () => ({
      single: () => ({
        then: (resolve) => {
          resolve(mockResolve);
          return { catch: () => {} };
        },
      }),
    });

    // Reset query tracking
    lastQuery = {};
    mockSupabase.from = (table) => {
      lastQuery.from = [table];
      return mockSupabase;
    };

    const result = await feedback.submitErrorReport({
      userId: 1,
      errorType: 'unknown',
      errorMessage: 'Server error occurred',
      url: '/test',
      userEmail: 'user@test.com',
      errorCtx: { method: 'GET' },
    });

    assert.notEqual(result, null);
    assert.equal(result.error_type, 'unknown');
    assert.equal(lastQuery.from[0], 'ai_chat_errors');
  });

  test('getInboxFeed returns merged, sorted results', async () => {
    const feedbackRows = [
      { id: 1, subject: 'Bug report', message: 'Something broke', page_url: '/page1', user_agent: 'Mozilla', status: 'new', user_id: 1, created_at: '2026-05-15T12:00:00Z' },
      { id: 2, subject: 'Feature request', message: 'Add dark mode', page_url: '/page2', user_agent: null, status: 'new', user_id: 2, created_at: '2026-05-15T11:00:00Z' },
    ];
    const errorRows = [
      { id: 1, error_type: 'provider_error', error_message: 'API timeout', tool_name: 'ai-chat', created_at: '2026-05-15T12:30:00Z', user_id: 1, resolved_at: null },
      { id: 2, error_type: 'tool_error', error_message: 'Invalid params', tool_name: 'ai-tools', created_at: '2026-05-15T10:00:00Z', user_id: 2, resolved_at: '2026-05-15T11:00:00Z' },
    ];

    let callCount = 0;

    // Build a self-returning thenable chain
    function makeThenableQuery(data, count) {
      const obj = {
        select: () => obj,
        order: () => obj,
        limit: () => obj,
        eq: () => obj,
        neq: () => obj,
        range: () => obj,
        then: (onFulfilled) => {
          onFulfilled({ data, count, error: null });
        },
        catch: () => {},
      };
      return obj;
    }

    mockSupabase.from = (table) => {
      callCount++;
      lastQuery.from = [table, callCount];
      if (callCount === 1) return makeThenableQuery(feedbackRows, 2);
      if (callCount === 2) return makeThenableQuery(errorRows, 2);
      return makeThenableQuery([], 0);
    };

    const items = await feedback.getInboxFeed(50);

    assert.ok(Array.isArray(items));
    assert.equal(items.length, 4);
    // Should be sorted newest-first (12:30 > 12:00 > 11:00 > 10:00)
    assert.ok(new Date(items[0].createdAt) >= new Date(items[1].createdAt));
    // Check merged sources
    const sources = items.map(i => i.source);
    assert.ok(sources.includes('user_feedback'));
    assert.ok(sources.includes('ai_chat_errors'));
    // Error with resolved_at should have status 'fixed'
    const resolvedItem = items.find(i => i.status === 'fixed');
    assert.ok(resolvedItem);
    assert.equal(resolvedItem.source, 'ai_chat_errors');
    // New (unresolved) error should have status 'new'
    const newError = items.find(i => i.source === 'ai_chat_errors' && i.sourceId === 1);
    assert.ok(newError);
    assert.equal(newError.status, 'new');
  });

  test('getInboxFeed throws when a source query fails', async () => {
    const originalFrom = mockSupabase.from;
    const sourceError = new Error('user_feedback query failed');

    function makeFailingQuery() {
      const obj = {
        select: () => obj,
        order: () => obj,
        limit: () => obj,
        eq: () => obj,
        then: (onFulfilled) => {
          onFulfilled({ data: null, count: 0, error: sourceError });
        },
        catch: () => {},
      };
      return obj;
    }

    mockSupabase.from = () => makeFailingQuery();

    try {
      await assert.rejects(() => feedback.getInboxFeed(50), /user_feedback query failed/);
    } finally {
      mockSupabase.from = originalFrom;
    }
  });

  test('updateStatus updates user_feedback row', async () => {
    let updateCalled = false;
    let eqCalled = false;
    let eqCol, eqVal;

    mockSupabase.from = (table) => {
      lastQuery.from = [table];
      const ch = { ...mockSupabase };
      ch.update = (vals) => {
        updateCalled = true;
        lastQuery.update = vals;
        return {
          eq: (col, val) => {
            eqCalled = true;
            eqCol = col;
            eqVal = val;
            return { then: (resolve) => { resolve({ data: null, error: null }); return { catch: () => {} }; } };
          },
        };
      };
      ch.eq = () => ch;
      ch.select = () => ch;
      ch.single = () => ch;
      return ch;
    };

    await feedback.updateStatus('user_feedback', 1, 'fixed', 2);

    assert.ok(updateCalled);
    assert.ok(eqCalled);
    assert.equal(lastQuery.from[0], 'user_feedback');
    assert.equal(lastQuery.update.status, 'fixed');
    assert.ok(lastQuery.update.resolved_at);
    assert.equal(lastQuery.update.resolved_by, 2);
    assert.equal(eqCol, 'id');
    assert.equal(eqVal, 1);
  });

  test('updateStatus for ai_chat_errors is a no-op', async () => {
    let called = false;
    mockSupabase.from = () => {
      called = true;
      return mockSupabase;
    };

    await feedback.updateStatus('ai_chat_errors', 1, 'fixed', 2);
    // Should not call supabase.from for ai_chat_errors (handled by existing route)
    assert.ok(!called);
  });
});
