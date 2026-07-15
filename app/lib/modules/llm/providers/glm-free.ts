/**
 * GLM Free Provider — wraps DeepInfra's public OpenAI-compatible endpoint used
 * by deepinfra.com's web playground. No API key is required, so GLM models can
 * be used freely from bolt.diy.
 *
 * Based on the user's Python client (zai-org-GLM-4.5.py):
 *   POST https://api.deepinfra.com/v1/openai/chat/completions
 *     headers: web-page identity headers
 *     body:    { model, messages, stream: true }
 *   → OpenAI-style SSE (`data: {choices:[{delta:{content}}]}`).
 */

import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';
import { toOpenAIMessages, readOpenAISSE, collectText } from './free-utils';

const DEEPINFRA_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';

class GLMFreeModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider = 'GLMFree';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async doStream(options: LanguageModelV1CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV1StreamPart>;
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const messages = toOpenAIMessages(options.prompt);

    const headers: Record<string, string> = {
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      Origin: 'https://deepinfra.com',
      Referer: 'https://deepinfra.com/',
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      'X-Deepinfra-Source': 'web-page',
      accept: 'text/event-stream',
    };

    const payload = {
      model: this.modelId,
      messages,
      stream: true,
      stream_options: {
        include_usage: true,
        continuous_usage_stats: true,
      },
    };

    const res = await fetch(DEEPINFRA_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `GLM Free: request failed (${res.status} ${res.statusText})${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
    }

    return {
      stream: readOpenAISSE(res.body),
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }

  async doGenerate(options: LanguageModelV1CallOptions): Promise<{
    text?: string;
    finishReason: 'stop';
    usage: { promptTokens: number; completionTokens: number };
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const { stream } = await this.doStream(options);
    const text = await collectText(stream);

    return {
      text,
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }
}

export default class GLMFreeProvider extends BaseProvider {
  name = 'GLMFree';

  getApiKeyLink = 'https://deepinfra.com';
  labelForGetApiKey = 'No API key needed';

  config = {
    apiTokenKey: '', // no key required
  };

  staticModels: ModelInfo[] = [
    {
      name: 'zai-org/GLM-4.5',
      label: 'GLM-4.5 (Free · Unlimited)',
      provider: 'GLMFree',
      maxTokenAllowed: 8000,
      maxCompletionTokens: 8000,
    },
    {
      name: 'zai-org/GLM-4.5-Air',
      label: 'GLM-4.5 Air (Free · Unlimited)',
      provider: 'GLMFree',
      maxTokenAllowed: 8000,
      maxCompletionTokens: 8000,
    },
  ];

  getModelInstance(options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    return new GLMFreeModel(options.model);
  }
}
