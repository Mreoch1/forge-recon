const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const ORIGINAL_ENV = { ...process.env };

function loadAI(env) {
  Object.keys(process.env).forEach((key) => {
    if (/^(AI|DEEPSEEK|OPENAI|GPT|ANTHROPIC)_/.test(key)) delete process.env[key];
  });
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/services/ai')];
  return require('../src/services/ai');
}

test.after(() => {
  Object.keys(process.env).forEach((key) => {
    if (/^(AI|DEEPSEEK|OPENAI|GPT|ANTHROPIC)_/.test(key)) delete process.env[key];
  });
  Object.assign(process.env, ORIGINAL_ENV);
});

test('AI provider routing keeps DeepSeek as the default low-cost path', () => {
  const ai = loadAI({
    AI_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'deepseek-test',
    OPENAI_API_KEY: 'openai-test',
  });

  assert.equal(ai.providerForTask('ai-chat'), 'deepseek');
  assert.equal(ai.modelName('deepseek'), 'deepseek-chat');
});

test('AI provider routing escalates vision/image tasks to OpenAI when configured', () => {
  const ai = loadAI({
    AI_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'deepseek-test',
    OPENAI_API_KEY: 'openai-test',
    OPENAI_MODEL: 'gpt-4o-mini',
  });

  assert.equal(ai.providerForTask('ai-chat-vision'), 'openai');
  assert.equal(ai.modelName('openai'), 'gpt-4o-mini');
});

test('AI configuration accepts OpenAI-only setup as a fallback', () => {
  const ai = loadAI({
    AI_PROVIDER: 'deepseek',
    OPENAI_API_KEY: 'openai-test',
  });

  assert.equal(ai.isConfigured(), true);
  assert.deepEqual(ai.configuredProviders(), ['openai']);
  assert.equal(ai.providerForTask('ai-chat'), 'openai');
});
