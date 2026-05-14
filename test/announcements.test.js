/**
 * Unit tests for src/services/announcements.js — D-090 dynamic banner service.
 * Uses node:test with mocked Supabase client.
 */

const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

// Mock the supabase module before requiring announcements
const mockSupabase = {
  from: () => mockSupabase,
  select: () => mockSupabase,
  insert: () => mockSupabase,
  update: () => mockSupabase,
  eq: () => mockSupabase,
  order: () => mockSupabase,
  limit: () => mockSupabase,
  range: () => mockSupabase,
  maybeSingle: () => mockSupabase,
  single: () => mockSupabase,
};

let lastQuery = null;
let mockResult = { data: null, count: 0, error: null };

// Intercept all chained calls
mockSupabase.from = (table) => { lastQuery = { table }; return mockSupabase; };
mockSupabase.select = (fields, opts) => {
  lastQuery = { ...lastQuery, select: fields, opts };
  return mockSupabase;
};
mockSupabase.insert = (rows) => { lastQuery = { ...lastQuery, insert: rows }; return mockSupabase; };
mockSupabase.update = (vals) => { lastQuery = { ...lastQuery, update: vals }; return mockSupabase; };
mockSupabase.eq = (col, val) => { lastQuery = { ...lastQuery, eq: { col, val } }; return mockSupabase; };
mockSupabase.order = (col, dir) => { lastQuery = { ...lastQuery, order: { col, dir } }; return mockSupabase; };
mockSupabase.limit = (n) => { lastQuery = { ...lastQuery, limit: n }; return mockSupabase; };
mockSupabase.range = (a, b) => { lastQuery = { ...lastQuery, range: [a, b] }; return mockSupabase; };
mockSupabase.maybeSingle = () => {
  lastQuery = { ...lastQuery, mode: 'maybeSingle' };
  // Simulate empty state
  if (mockResult.error) return Promise.resolve({ data: null, error: mockResult.error });
  return Promise.resolve({ data: mockResult.data, error: null, count: mockResult.count });
};
mockSupabase.single = () => {
  lastQuery = { ...lastQuery, mode: 'single' };
  if (mockResult.error) return Promise.resolve({ data: null, error: mockResult.error });
  return Promise.resolve({ data: mockResult.data, error: null });
};

// Save original require and inject mock
const Module = require('module');
const origRequire = Module.prototype.require;

describe('AnnouncementsService', () => {
  let announcements;

  before(() => {
    // Replace the supabase module with our mock
    Module.prototype.require = function(id) {
      if (id === '../db/supabase' || id === '../../db/supabase') return mockSupabase;
      return origRequire.apply(this, arguments);
    };
    announcements = require('../src/services/announcements');
  });

  after(() => {
    Module.prototype.require = origRequire;
    announcements.invalidateCache();
  });

  test('getActiveAnnouncement returns null when no data', async () => {
    mockResult = { data: null, count: 0, error: null };
    const result = await announcements.getActiveAnnouncement();
    assert.equal(result, null);
    assert.equal(lastQuery.table, 'app_announcements');
    assert.equal(lastQuery.mode, 'maybeSingle');
  });

  test('getActiveAnnouncement returns announcement when active exists', async () => {
    const fakeAnnouncement = {
      id: 1, message: 'Test announcement', created_at: new Date().toISOString(), created_by_name: 'Test'
    };
    mockResult = { data: fakeAnnouncement, count: 1, error: null };
    announcements.invalidateCache();
    const result = await announcements.getActiveAnnouncement();
    assert.notEqual(result, null);
    assert.equal(result.id, 1);
    assert.equal(result.message, 'Test announcement');
    assert.ok(lastQuery.eq.col === 'active' && lastQuery.eq.val === true);
  });

  test('getActiveAnnouncement returns cached data on second call', async () => {
    // Second call within 1 min should return cached data without hitting mock
    const result = await announcements.getActiveAnnouncement();
    assert.notEqual(result, null);
    assert.equal(result.id, 1);
  });

  test('listAll returns empty array when no data', async () => {
    mockResult = { data: [], count: 0, error: null };
    // Override the range handler to return count properly
    mockSupabase.range = (a, b) => {
      lastQuery = { ...lastQuery, range: [a, b] };
      return {
        then: (resolve) => {
          resolve({ data: mockResult.data, count: mockResult.count, error: mockResult.error });
        },
      };
    };
    const { data, count } = await announcements.listAll();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
    assert.equal(count, 0);
    assert.equal(lastQuery.table, 'app_announcements');
  });

  test('createAnnouncement inserts and deactivates old ones', async () => {
    // First call: deactivate existing
    mockResult = { data: null, error: null };

    // Track the calls manually since mock fires sequentially
    let callCount = 0;
    const origFrom = mockSupabase.from;
    mockSupabase.from = (table) => {
      callCount++;
      if (callCount === 1) {
        // First call: deactivate
        lastQuery = { table, action: 'deactivate' };
        // Return chain that returns success
        const chain = { ...mockSupabase };
        chain.update = (vals) => {
          lastQuery = { ...lastQuery, update: vals };
          const chain2 = { ...mockSupabase };
          chain2.eq = () => Promise.resolve({ data: null, error: null });
          chain2.select = () => chain2;
          chain2.single = () => chain2;
          return chain2;
        };
        chain.eq = () => chain;
        chain.select = () => chain;
        chain.single = () => chain;
        return chain;
      }
      // Second call: insert new
      lastQuery = { table, action: 'insert' };
      const chain = { ...mockSupabase };
      chain.insert = (rows) => {
        lastQuery = { ...lastQuery, insert: rows };
        const chain2 = { ...mockSupabase };
        chain2.select = () => {
          const chain3 = { ...mockSupabase };
          chain3.single = () => Promise.resolve({
            data: { id: 2, message: rows.message, active: true },
            error: null
          });
          return chain3;
        };
        return chain2;
      };
      chain.eq = () => chain;
      chain.select = () => chain;
      chain.single = () => chain;
      return chain;
    };

    const result = await announcements.createAnnouncement({
      message: 'New announcement',
      createdById: 1,
      createdByName: 'Test',
    });

    assert.notEqual(result, null);
    assert.equal(result.message, 'New announcement');

    // Restore mock
    mockSupabase.from = origFrom;
  });

  test('deactivate updates announcement active=false', async () => {
    mockSupabase.from = (table) => {
      lastQuery = { table, action: 'deactivate' };
      const chain = { ...mockSupabase };
      chain.update = (vals) => {
        lastQuery = { ...lastQuery, update: vals };
        return {
          eq: (col, val) => {
            lastQuery = { ...lastQuery, eq: { col, val } };
            return Promise.resolve({ data: null, error: null });
          },
        };
      };
      chain.eq = () => chain;
      chain.select = () => chain;
      chain.single = () => chain;
      return chain;
    };

    await announcements.deactivate(1);
    assert.ok(lastQuery.update.active === false);
    assert.equal(lastQuery.eq.col, 'id');
    assert.equal(lastQuery.eq.val, 1);
  });
});
