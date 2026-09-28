// Responses transport for Messages clients; reuse the Chat -> Messages output
// adapter to retain tool validation, cancellation and usage accounting.
import { upstreamFetch, readResponseText } from '../upstream-fetch.js';
import { buildOpenAIHeaders, parseToolInput } from './openai.js';
import { ssePayloads } from '../sse.js';

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((p) => p?.type !== 'text')) throw new Error('Responses adapter requires text-only system/tool-result content');
  return content.map((p) => p.text ?? '').join('\n');
}

export function buildResponsesBody(body, targetModel) {
  if (body.stop_sequences?.length) throw new Error('Responses adapter does not support stop_sequences');
  if (body.thinking && body.thinking.type !== 'disabled') throw new Error('Responses adapter does not support Anthropic thinking controls');
  const input = [];
  const systems = body.system ? [text(body.system)] : [];
  for (const message of body.messages ?? []) {
    if (message.role === 'system') { systems.push(text(message.content)); continue; }
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Unsupported Messages role');
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    for (const block of blocks ?? []) {
      if (block.type === 'text') {
        input.push({ role: message.role, content: [{ type: 'input_text', text: block.text ?? '' }] });
      } else if (block.type === 'image' && message.role === 'user') {
        const source = block.source;
        const imageUrl = source?.type === 'url' ? source.url : source?.type === 'base64' ? 'data:' + source.media_type + ';base64,' + source.data : undefined;
        if (!imageUrl) throw new Error('Unsupported Messages image source');
        input.push({ role: 'user', content: [{ type: 'input_image', image_url: imageUrl }] });
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        if (!block.id || !block.name) throw new Error('Tool use requires id and name');
        const args = JSON.stringify(block.input ?? {});
        parseToolInput(args);
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: args });
      } else if (block.type === 'tool_result' && message.role === 'user') {
        if (!block.tool_use_id) throw new Error('Tool result requires tool_use_id');
        const output = text(block.content ?? '');
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.is_error ? 'Tool error: ' + output : output });
      } else throw new Error('Unsupported Messages content block: ' + (block.type ?? '(missing)'));
    }
  }
  const result = { model: targetModel, input, stream: Boolean(body.stream), max_output_tokens: body.max_tokens ?? 4096, store: false };
  if (systems.length) result.instructions = systems.join('\n\n');
  for (const key of ['temperature', 'top_p']) if (typeof body[key] === 'number') result[key] = body[key];
  if (body.tools?.length) {
    result.tools = body.tools.map((tool) => {
      if (tool.type && tool.type !== 'custom') throw new Error('Responses adapter supports custom function tools only');
      return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema ?? { type: 'object', properties: {} }, strict: false };
    });
    const choice = body.tool_choice;
    result.tool_choice = choice?.type === 'tool' ? { type: 'function', name: choice.name }
      : choice?.type === 'any' ? 'required' : choice?.type === 'none' ? 'none' : 'auto';
    if (choice?.disable_parallel_tool_use !== undefined) result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  return result;
}

export function callOpenAI(provider, body, targetModel, signal, incomingHeaders = {}, options = {}) {
  return upstreamFetch(provider, provider.baseUrl + '/responses', {
    method: 'POST', headers: buildOpenAIHeaders(provider, incomingHeaders, { ...options, targetModel }),
    body: JSON.stringify(buildResponsesBody(body, targetModel)), signal,
  });
}

function completionUsage(usage) {
  if (!usage) return undefined;
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
    ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}) };
}

export function responseToCompletion(response) {
  if (!response || response.error || !['completed', 'incomplete'].includes(response.status)) throw new Error('Responses upstream did not complete successfully');
  if (response.status === 'incomplete' && response.incomplete_details?.reason !== 'max_output_tokens') throw new Error('Unsupported incomplete Responses result');
  if (!Array.isArray(response.output)) throw new Error('Responses upstream omitted output');
  const parts = [];
  const tools = [];
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') parts.push(part.text ?? '');
        else if (part.type === 'refusal') parts.push(part.refusal ?? '');
        else throw new Error('Unsupported Responses output content: ' + part.type);
      }
    } else if (item.type === 'function_call') {
      if (!item.call_id || !item.name) throw new Error('Responses tool call requires call_id and name');
      parseToolInput(item.arguments);
      tools.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
    } else if (item.type !== 'reasoning') throw new Error('Unsupported Responses output item: ' + item.type);
  }
  return { id: response.id, choices: [{ index: 0, message: { role: 'assistant', content: parts.join(''), tool_calls: tools },
    finish_reason: response.status === 'incomplete' ? 'length' : tools.length ? 'tool_calls' : 'stop' }], usage: completionUsage(response.usage) };
}

export async function parseCompletion(response) {
  if (!(response.headers.get('content-type') ?? '').includes('event-stream')) return responseToCompletion(JSON.parse(await readResponseText(response)));
  for await (const payload of ssePayloads(response.body)) {
    const event = JSON.parse(payload);
    if (event.type === 'error' || event.type === 'response.failed') throw new Error('Responses upstream failed');
    if (event.type === 'response.completed' || event.type === 'response.incomplete') return responseToCompletion(event.response);
  }
  throw new Error('Responses stream ended without a terminal event');
}

export function toChatStream(body) {
  const reader = body?.getReader();
  const input = { async *[Symbol.asyncIterator]() {
    if (!reader) throw new Error('Responses upstream omitted body');
    try { while (true) { const { done, value } = await reader.read(); if (done) break; yield value; } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } };
  const encoder = new TextEncoder();
  const frame = (value) => encoder.encode('data: ' + JSON.stringify(value) + '\n\n');
  async function* chunks() {
    const emitted = new Map();
    let size = 0;
    for await (const payload of ssePayloads(input)) {
      const event = JSON.parse(payload);
      if (event.type === 'error' || event.type === 'response.failed') throw new Error('Responses upstream failed');
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        const key = event.output_index + ':' + event.content_index;
        const delta = event.delta ?? '';
        emitted.set(key, (emitted.get(key) ?? '') + delta);
        size += delta.length;
        if (size > 64 * 1024 * 1024) throw new Error('Responses output exceeds buffer limit');
        yield frame({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        const complete = responseToCompletion(event.response);
        // Compatible endpoints may only send the final output snapshot.
        for (const [index, item] of event.response.output.entries()) {
          if (item.type !== 'message') continue;
          for (const [contentIndex, part] of (item.content ?? []).entries()) {
            const full = part.text ?? part.refusal ?? '';
            const prior = emitted.get(index + ':' + contentIndex) ?? '';
            if (!full.startsWith(prior)) throw new Error('Responses terminal text disagrees with deltas');
            const tail = full.slice(prior.length);
            if (tail) yield frame({ choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] });
          }
        }
        const choice = complete.choices[0];
        // The Messages converter requires complete validated tools. Emit once
        // from the terminal snapshot; Responses output indexes also count text.
        yield frame({ id: complete.id, choices: [{ index: 0, delta: { tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool, index })) }, finish_reason: choice.finish_reason }], usage: complete.usage });
        return;
      }
    }
    throw new Error('Responses stream ended without a terminal event');
  }
  const iterator = chunks();
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try { const { done, value } = await iterator.next(); if (!cancelled) { if (done) controller.close(); else controller.enqueue(value); } }
      catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel(reason) {
      cancelled = true;
      await reader?.cancel(reason).catch(() => {});
      await iterator.return();
      // A consumer may cancel before the generator's first pull/finally.
      try { reader?.releaseLock(); } catch {}
    },
  });
}
