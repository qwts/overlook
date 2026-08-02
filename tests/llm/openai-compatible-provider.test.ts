import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';

import { OpenAiCompatibleProvider, type OpenAiClientLike } from '../../src/main/llm/openai-compatible-provider.js';
import { LlmRefusalError, LlmRequestError, type LlmQaCall } from '../../src/main/llm/provider.js';

const CALL: LlmQaCall = {
  prompt: 'describe it',
  image: { bytes: Buffer.from('imgbytes'), mediaType: 'image/webp' },
  maxOutputTokens: 400,
};

interface CapturedBody {
  model: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  messages: Array<{ role: string; content: unknown }>;
}

function clientReturning(response: unknown): { client: OpenAiClientLike; lastBody: () => CapturedBody | null } {
  let captured: CapturedBody | null = null;
  const client: OpenAiClientLike = {
    chat: {
      completions: {
        create: (body) => {
          captured = body as unknown as CapturedBody;
          return Promise.resolve(response as never);
        },
      },
    },
    models: { list: () => Promise.resolve([]) },
  };
  return { client, lastBody: () => captured };
}

const OK_RESPONSE = {
  choices: [{ message: { content: 'A red bicycle.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
};

describe('openai-compatible provider adapter', () => {
  test('installed SDK exposes the client surface used by the adapter', () => {
    const client = new OpenAI({ apiKey: 'test-key' });

    assert.equal(typeof client.chat.completions.create, 'function');
    assert.equal(typeof client.models.list, 'function');
  });

  test('openai uses max_completion_tokens and the openai balanced model; normalises usage', async () => {
    const { client, lastBody } = clientReturning(OK_RESPONSE);
    const provider = new OpenAiCompatibleProvider({ id: 'openai', tokenParam: 'max_completion_tokens' }, () => client);
    const outcome = await provider.qa(CALL, 'sk-openai');

    assert.equal(outcome.answer, 'A red bicycle.');
    assert.equal(outcome.modelId, 'gpt-5.6-terra');
    // OpenAI's prompt_tokens already includes cached; cached is the subset.
    assert.deepEqual(outcome.usage, { inputTokens: 900, cachedInputTokens: 100, outputTokens: 30 });

    const body = lastBody();
    assert.equal(body?.max_completion_tokens, 400);
    assert.equal(body?.max_tokens, undefined, 'openai does not receive the legacy token field');
  });

  test('xai uses max_tokens, the x.ai model, and tolerates missing cached usage', async () => {
    const { client, lastBody } = clientReturning({
      choices: [{ message: { content: 'grok says hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 800, completion_tokens: 20 },
    });
    const provider = new OpenAiCompatibleProvider({ id: 'xai', baseUrl: 'https://api.x.ai/v1', tokenParam: 'max_tokens' }, () => client);
    const outcome = await provider.qa(CALL, 'xai-key');

    assert.equal(outcome.modelId, 'grok-4.5');
    assert.deepEqual(outcome.usage, { inputTokens: 800, cachedInputTokens: 0, outputTokens: 20 });
    assert.equal(lastBody()?.max_tokens, 400);
    assert.equal(lastBody()?.max_completion_tokens, undefined);
  });

  test('a content_filter finish reason is a refusal', async () => {
    const { client } = clientReturning({
      choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const provider = new OpenAiCompatibleProvider({ id: 'openai', tokenParam: 'max_completion_tokens' }, () => client);
    await assert.rejects(() => provider.qa(CALL, 'sk'), LlmRefusalError);
  });

  test('an empty answer with a normal finish reason fails rather than returning blank', async () => {
    const { client } = clientReturning({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const provider = new OpenAiCompatibleProvider({ id: 'openai', tokenParam: 'max_completion_tokens' }, () => client);
    await assert.rejects(() => provider.qa(CALL, 'sk'), LlmRequestError);
  });

  test('an explicit refusal message is a refusal', async () => {
    const { client } = clientReturning({
      choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const provider = new OpenAiCompatibleProvider({ id: 'openai', tokenParam: 'max_completion_tokens' }, () => client);
    await assert.rejects(() => provider.qa(CALL, 'sk'), LlmRefusalError);
  });
});
