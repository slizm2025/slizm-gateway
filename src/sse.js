// Shared parser for streamed and buffered OpenAI-compatible responses.
const MAX_EVENT_CHARS = 4 * 1024 * 1024;

export function createSseDecoder(onPayload) {
  const decoder = new TextDecoder();
  let pending = '';
  let data = [];
  let size = 0;
  function line(text) {
    if (!text) {
      const payload = data.length ? data.join('\n') : undefined;
      data = []; size = 0;
      return payload;
    }
    if (text.startsWith('data:') || text === 'data') {
      const value = text.slice(5).replace(/^ /, '');
      size += value.length + 1;
      if (size > MAX_EVENT_CHARS) throw new Error('上游 SSE 事件超过 4MiB 上限');
      data.push(value);
    }
  }
  function drain(final = false) {
    let match;
    while ((match = /[\r\n]/.exec(pending))) {
      const i = match.index;
      if (!final && pending[i] === '\r' && i === pending.length - 1) break;
      const text = pending.slice(0, i);
      pending = pending.slice(i + (pending[i] === '\r' && pending[i + 1] === '\n' ? 2 : 1));
      const payload = line(text);
      if (payload !== undefined) onPayload(payload);
    }
    if (pending.length + size > MAX_EVENT_CHARS) throw new Error('上游 SSE 事件超过 4MiB 上限');
  }
  return {
    push(chunk) { pending += decoder.decode(chunk, { stream: true }); drain(); },
    end() {
      pending += decoder.decode(); drain(true);
      if (data.length || pending.startsWith('data:')) throw new Error('上游 SSE 事件未以空行结束');
    },
  };
}

export async function* ssePayloads(body) {
  if (!body) throw new Error('上游缺少响应体');
  let payloads = [];
  const decoder = createSseDecoder((payload) => payloads.push(payload));
  function* decode(fn) {
    let failure;
    try { fn(); } catch (e) { failure = e; }
    yield* payloads;
    payloads = [];
    if (failure) throw failure;
  }
  for await (const chunk of body) {
    yield* decode(() => decoder.push(chunk));
  }
  yield* decode(() => decoder.end());
}

export async function* openAIChunks(body) {
  let complete = false;
  let seenChoice = false;
  for await (const payload of ssePayloads(body)) {
    if (!payload.trim()) continue;
    if (payload.trim() === '[DONE]') break;
    let value;
    try { value = JSON.parse(payload); } catch { throw new Error('上游 SSE data 不是合法 JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上游 SSE 格式错误');
    if (value.error || value.type === 'error') throw new Error('上游返回 SSE 错误事件');
    const choice = value.choices?.find((c) => (c.index ?? 0) === 0);
    if (choice) {
      seenChoice = true;
      if (choice.finish_reason) complete = true;
    }
    yield value;
  }
  if (!complete || !seenChoice) throw new Error('上游 SSE 提前结束，缺少有效完成标记');
}
