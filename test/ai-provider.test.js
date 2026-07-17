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

test('AI file extraction sends PDFs as application/pdf data URLs', async () => {
  const ai = loadAI({ OPENAI_API_KEY: 'openai-test' });
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (url, options) => {
    if (!String(url).includes('api.openai.com')) {
      return new Response('[]', { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
        choices: [{ message: { content: '{"title":"LED Vanity Light"}' } }],
        usage: { total_tokens: 12 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await ai.extractFiles({
      system: 'Return JSON.',
      user: 'Read the attached PDF.',
      files: [{ fileName: 'fixture.pdf', buffer: Buffer.from('%PDF-test') }],
      taskName: 'submittal-product-spec-pdf-vision',
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.title, 'LED Vanity Light');
    const fileData = requestBody.messages[1].content[1].file.file_data;
    assert.match(fileData, /^data:application\/pdf;base64,/);
    assert.equal(requestBody.messages[1].content[1].file.filename, 'fixture.pdf');
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    global.fetch = originalFetch;
  }
});
