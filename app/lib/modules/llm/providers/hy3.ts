/**
 * Hy3 Provider — wraps the Tencent Hy3 model served via HuggingFace Spaces Gradio API.
 * No API key required: the endpoint is publicly accessible.
 *
 * Original CLI agent by user (main.py) uses the same endpoint:
 *   POST https://tencent-hy3-preview.hf.space/gradio_api/call/chat  →  {event_id}
 *   GET  …/call/chat/{event_id}                                       →  SSE stream
 *
 * Here we wrap that flow in a LanguageModelV1 so bolt.diy can use Hy3
 * like any other provider — select it from the model picker and generate
 * web apps, backends, or anything else with bolt.diy's native workflow.
 */

import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';

// ── Constants ────────────────────────────────────────────────────────────────

const HY3_API_BASE = 'https://tencent-hy3-preview.hf.space/gradio_api/call/chat';

// ── Custom LanguageModelV1 implementation ────────────────────────────────────

class Hy3Model implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider = 'Hy3';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  // ── Message conversion ─────────────────────────────────────────────────────

  /**
   * Convert a Vercel AI SDK prompt array into the Hy3 Gradio payload:
   *   data[0] = current user message (with system prompt prepended when present)
   *   data[1] = "" (unused system slot in Gradio schema)
   *   data[2] = prior conversation history [{role, content}]
   *   data[3..7] = fixed quality / padding values
   */
  private buildPayload(prompt: LanguageModelV1CallOptions['prompt']): {
    currentMessage: string;
    history: Array<{ role: string; content: string }>;
  } {
    let systemText = '';
    const turns: Array<{ role: string; content: string }> = [];

    for (const msg of prompt) {
      if (msg.role === 'system') {
        // System messages are strings
        systemText += (systemText ? '\n\n' : '') + msg.content;
        continue;
      }

      if (msg.role === 'user') {
        const text = msg.content
          .filter((p) => p.type === 'text')
          .map((p) => (p as { type: 'text'; text: string }).text)
          .join('');
        turns.push({ role: 'user', content: text });
        continue;
      }

      if (msg.role === 'assistant') {
        const content = msg.content;
        const text =
          typeof content === 'string'
            ? content
            : content
                .filter((p) => p.type === 'text')
                .map((p) => (p as { type: 'text'; text: string }).text)
                .join('');
        turns.push({ role: 'assistant', content: text });
        continue;
      }
    }

    // The last turn must be the current user message — extract it from history
    let currentMessage = '';

    if (turns.length > 0 && turns[turns.length - 1].role === 'user') {
      currentMessage = turns[turns.length - 1].content;
      turns.pop();
    }

    // Prepend system prompt to the current message so Hy3 (which has no system
    // role) still respects bolt.diy's formatting instructions.
    if (systemText) {
      currentMessage = `${systemText}\n\n${currentMessage}`;
    }

    return { currentMessage, history: turns };
  }

  // ── doStream ───────────────────────────────────────────────────────────────

  async doStream(options: LanguageModelV1CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV1StreamPart>;
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const { currentMessage, history } = this.buildPayload(options.prompt);

    // Step 1 — queue generation job
    const postRes = await fetch(HY3_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [currentMessage, '', history, 'high', null, 0, 0, ''],
      }),
    });

    if (!postRes.ok) {
      throw new Error(`Hy3: failed to start generation (${postRes.status} ${postRes.statusText})`);
    }

    const { event_id } = (await postRes.json()) as { event_id: string };

    // Step 2 — open SSE stream for results
    const sseRes = await fetch(`${HY3_API_BASE}/${event_id}`, {
      headers: { Accept: 'text/event-stream' },
    });

    if (!sseRes.ok || !sseRes.body) {
      throw new Error(`Hy3: failed to open SSE stream (${sseRes.status})`);
    }

    const sseBody = sseRes.body;

    // Step 3 — convert Gradio SSE chunks → LanguageModelV1StreamPart
    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        const reader = sseBody.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';
        let previousAnswer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            lineBuffer += decoder.decode(value, { stream: true });

            // Process complete lines
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? ''; // keep the incomplete last fragment

            for (const line of lines) {
              if (!line.startsWith('data: ')) {
                continue;
              }

              const rawJson = line.slice(6).trim();

              try {
                const parsed = JSON.parse(rawJson);

                /**
                 * Gradio streams the full accumulated answer each time:
                 *   [[answer_text, ...], ...]
                 * We diff against previousAnswer to emit only new characters.
                 */
                if (
                  Array.isArray(parsed) &&
                  parsed.length > 0 &&
                  Array.isArray(parsed[0]) &&
                  parsed[0].length > 0 &&
                  typeof parsed[0][0] === 'string'
                ) {
                  const fullAnswer: string = parsed[0][0];

                  if (fullAnswer.length > previousAnswer.length) {
                    const delta = fullAnswer.slice(previousAnswer.length);
                    controller.enqueue({ type: 'text-delta', textDelta: delta });
                    previousAnswer = fullAnswer;
                  }
                }
              } catch {
                // Non-JSON SSE control lines (e.g. "event: complete") — skip
              }
            }
          }
        } catch (err) {
          controller.error(err);
          return;
        }

        controller.enqueue({
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
        });
        controller.close();
      },
    });

    return {
      stream,
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }

  // ── doGenerate ─────────────────────────────────────────────────────────────

  async doGenerate(options: LanguageModelV1CallOptions): Promise<{
    text?: string;
    finishReason: 'stop';
    usage: { promptTokens: number; completionTokens: number };
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value.type === 'text-delta') {
        fullText += value.textDelta;
      }
    }

    return {
      text: fullText,
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }
}

// ── BaseProvider subclass ────────────────────────────────────────────────────

export default class Hy3Provider extends BaseProvider {
  name = 'Hy3';

  // No API key is required — Hy3 is a free public HuggingFace Space.
  getApiKeyLink = 'https://tencent-hy3-preview.hf.space';
  labelForGetApiKey = 'No API key needed';

  config = {
    apiTokenKey: '', // intentionally empty — no key required
  };

  staticModels: ModelInfo[] = [
    {
      name: 'hy3-coding',
      label: 'Hy3 Coding Agent (Free · No Key)',
      provider: 'Hy3',
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
    return new Hy3Model(options.model);
  }
}
