import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';

import { AnthropicProvider, type AnthropicClientLike } from '../../src/main/llm/anthropic-provider.js';
import { LlmRefusalError, LlmRequestError, type LlmQaCall } from '../../src/main/llm/provider.js';

const CALL: LlmQaCall = {
  prompt: 'what is this?',
  image: { bytes: Buffer.from('imgbytes'), mediaType: 'image/webp' },
  context: { takenAt: '2026-01-02', cameraModel: 'Pixel' },
  maxOutputTokens: 512,
};

interface CapturedBody {
  model: string;
  max_tokens: number;
  messages: Array<{ content: Array<{ type: string; source?: { data?: string }; text?: string }> }>;
}

function clientReturning(message: unknown): { client: AnthropicClientLike; lastBody: () => CapturedBody | null } {
  let captured: CapturedBody | null = null;
  const client: AnthropicClientLike = {
    messages: {
      create: (body) => {
        captured = body as unknown as CapturedBody;
        return Promise.resolve(message as never);
      },
    },
    models: { list: () => Promise.resolve([]) },
  };
  return { client, lastBody: () => captured };
}

describe('anthropic provider adapter', () => {
  test('installed SDK exposes the client surface used by the adapter', () => {
    const client = new Anthropic({ apiKey: 'test-key' });

    assert.equal(typeof client.messages.create, 'function');
    assert.equal(typeof client.models.list, 'function');
  });

  test('sends the balanced model, image, and composed prompt; normalises usage', async () => {
    const { client, lastBody } = clientReturning({
      content: [{ type: 'text', text: 'A cat on a sofa.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 300 },
    });
    const outcome = await new AnthropicProvider(() => client).qa(CALL, 'sk-ant');

    assert.equal(outcome.answer, 'A cat on a sofa.');
    assert.equal(outcome.modelId, 'claude-sonnet-5');
    // Total input = uncached remainder (1200) + cache reads (300); cached is the subset.
    assert.deepEqual(outcome.usage, { inputTokens: 1500, cachedInputTokens: 300, outputTokens: 40 });

    const body = lastBody();
    assert.equal(body?.model, 'claude-sonnet-5');
    assert.equal(body?.max_tokens, 512);
    const content = body?.messages[0]?.content ?? [];
    assert.equal(content[0]?.source?.data, Buffer.from('imgbytes').toString('base64'));
    assert.match(content[1]?.text ?? '', /Pixel/u, 'display context is included');
    assert.match(content[1]?.text ?? '', /what is this\?/u);
  });

  test('a refusal stop reason surfaces as LlmRefusalError', async () => {
    const { client } = clientReturning({ content: [], stop_reason: 'refusal', usage: {} });
    await assert.rejects(() => new AnthropicProvider(() => client).qa(CALL, 'sk-ant'), LlmRefusalError);
  });

  test('a successful response with no text blocks fails rather than returning a blank answer', async () => {
    const { client } = clientReturning({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 0 } });
    await assert.rejects(() => new AnthropicProvider(() => client).qa(CALL, 'sk-ant'), LlmRequestError);
  });

  test('a thrown SDK error surfaces as LlmRequestError', async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: () => Promise.reject(new Error('401 unauthorized')),
      },
      models: { list: () => Promise.resolve([]) },
    };
    await assert.rejects(() => new AnthropicProvider(() => client).qa(CALL, 'bad'), LlmRequestError);
  });

  test('validateKey lists models and wraps failures', async () => {
    const okClient: AnthropicClientLike = {
      messages: { create: () => Promise.resolve({} as never) },
      models: { list: () => Promise.resolve([]) },
    };
    await new AnthropicProvider(() => okClient).validateKey('sk-ant');

    const badClient: AnthropicClientLike = {
      messages: { create: () => Promise.resolve({} as never) },
      models: { list: () => Promise.reject(new Error('401')) },
    };
    await assert.rejects(() => new AnthropicProvider(() => badClient).validateKey('bad'), LlmRequestError);
  });
});
