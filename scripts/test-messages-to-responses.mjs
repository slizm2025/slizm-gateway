import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResponsesBody, responseToCompletion, parseCompletion, toChatStream } from '../src/providers/messages-to-responses.js';
import { openAIToAnthropicStream } from '../src/stream.js';

function sse(events) {
  const text = events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

test('Messages body converts text, image, tools and tool results to Responses input', () => {
  const body = buildResponsesBody({
    model: 'route-model',
    system: 'be concise',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'exec', input: { cmd: 'pwd' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
    ],
    tools: [{ name: 'exec', description: 'run command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'exec' },
    stream: true,
  }, 'real-model');
  assert.equal(body.model, 'real-model');
  assert.equal(body.instructions, 'be concise');
  assert.equal(body.input[0].content[0].text, 'inspect');
  assert.equal(body.input[1].content[0].image_url, 'https://example.test/a.png');
  assert.deepEqual(body.input[2], { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' });
  assert.deepEqual(body.input[3], { type: 'function_call_output', call_id: 'call_1', output: 'done' });
  assert.equal(body.tools[0].type, 'function');
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'exec' });
});

test('Messages body rejects unsupported protocol shapes instead of dropping them', () => {
  assert.throws(() => buildResponsesBody({ messages: [{ role: 'user', content: [{ type: 'document' }] }] }, 'm'), /Unsupported Messages content block/);
  assert.throws(() => buildResponsesBody({ stop_sequences: ['stop'], messages: [] }, 'm'), /stop_sequences/);
  assert.throws(() => buildResponsesBody({ thinking: { type: 'enabled' }, messages: [] }, 'm'), /thinking/);
});

test('Responses JSON converts text, tool calls and cache usage to Chat Completion', () => {
  const out = responseToCompletion({
    id: 'resp_1', status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' },
    ],
    usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 12 } },
  });
  assert.equal(out.choices[0].message.content, 'done');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'exec');
  assert.equal(out.usage.prompt_tokens, 20);
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 12);
});

test('Responses JSON and SSE failures are rejected', async () => {
  await assert.rejects(parseCompletion(new Response(JSON.stringify({ status: 'failed', error: { message: 'no' } }), { headers: { 'content-type': 'application/json' } })), /did not complete/);
  await assert.rejects(parseCompletion(sse([{ type: 'response.completed', response: { id: 'x', status: 'completed', output: [{ type: 'unsupported' }] } }])), /Unsupported Responses output item/);
  await assert.rejects(parseCompletion(new Response('data: {"type":"response.failed"}\n\n', { headers: { 'content-type': 'text/event-stream' } })), /failed/);
});

test('Responses SSE text and function argument deltas become Chat Completion SSE', async () => {
  const result = {
    id: 'resp_stream', status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' },
    ],
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  const output = await readStream(toChatStream(sse([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'exec' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"cmd":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"pwd"}' },
    { type: 'response.completed', response: result },
  ]).body));
  assert.match(output, /"content":"hello"/);
  assert.match(output, /"name":"exec"/);
  assert.match(output, /\\\"cmd\\\":/);
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.match(output, /"prompt_tokens":3/);
});

test('Responses SSE without terminal event fails', async () => {
  await assert.rejects(readStream(toChatStream(sse([{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' }]).body)), /ended without a terminal event/);
});

test('full Messages stream emits each tool exactly once after text/reasoning output indexes', async () => {
  const tools = [
    { type: 'function_call', call_id: 'a', name: 'exec', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call', call_id: 'b', name: 'read', arguments: '{"path":"file.txt"}' },
  ];
  const events = [
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'hello' },
    ...tools.flatMap((item, index) => [
      { type: 'response.output_item.added', output_index: index + 2, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: index + 2, delta: item.arguments },
    ]),
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [
      { type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'hello' }] }, ...tools,
    ], usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 12 } } } },
  ];
  const output = await readStream(openAIToAnthropicStream(toChatStream(sse(events).body), 'original-model'));
  const frames = output.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const blocks = frames.filter((frame) => frame.content_block?.type === 'tool_use');
  assert.deepEqual(blocks.map((frame) => [frame.content_block.id, frame.content_block.name]), [['a', 'exec'], ['b', 'read']]);
  assert.deepEqual(frames.filter((frame) => frame.delta?.type === 'input_json_delta').map((frame) => JSON.parse(frame.delta.partial_json)), [{ cmd: 'pwd' }, { path: 'file.txt' }]);
  assert.equal(frames.at(-1).type, 'message_stop');
  assert.equal(frames.find((frame) => frame.type === 'message_delta').usage.cache_read_input_tokens, 12);
  assert.equal(frames.some((frame) => frame.type === 'error'), false);
});

test('cancelling a Responses stream releases the upstream reader immediately', async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  const reader = toChatStream(upstream).getReader();
  const pending = reader.read();
  await reader.cancel();
  await pending;
  assert.equal(cancelled, true);
  assert.equal(upstream.locked, false);
});
