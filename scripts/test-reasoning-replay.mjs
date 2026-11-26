// 回归测试：Anthropic thinking 块 → Chat Completions reasoning_content 的回填规则。
// DeepSeek 思考模式在请求以 tool 结果结尾时要求最后一条 assistant 消息带回 reasoning_content，
// 缺字段或 null 会被上游 400（"The `reasoning_content` in the thinking mode must be passed back"）。
// 空字符串可以通过校验；其它上游没有这个字段，不能凭空加。
import assert from 'node:assert/strict';
import { buildOpenAIBody, toOpenAIMessages } from '../src/providers/openai.js';

const toolCallAssistant = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'I should call get_weather.', signature: '' },
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
  ],
};
const toolResultUser = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny, 22C' }],
};
const body = () => ({ messages: [{ role: 'user', content: 'weather?' }, toolCallAssistant, toolResultUser] });

// 1. DeepSeek 模型：思考文本回填到带 tool_calls 的 assistant 消息，原文与 tool_calls 不变。
const deepseek = buildOpenAIBody(body(), 'deepseek-v4.1-flash-1017');
assert.equal(deepseek.messages.length, 3);
assert.equal(deepseek.messages[1].role, 'assistant');
assert.equal(deepseek.messages[1].content, 'Let me check.');
assert.equal(deepseek.messages[1].reasoning_content, 'I should call get_weather.');
assert.deepEqual(deepseek.messages[1].tool_calls, [
  { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
]);
assert.equal(deepseek.messages[2].role, 'tool');

// 2. DeepSeek 模型但没有可重放的思考块：仍要显式给空串（上游拒绝缺失/null，接受空串）。
const bare = buildOpenAIBody(
  {
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'get_weather', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'sunny' }] },
    ],
  },
  'deepseek-flash',
);
assert.equal(bare.messages[1].reasoning_content, '');
assert.equal(bare.messages[1].content, null);

// 3. 非 DeepSeek 上游：不加 reasoning_content，thinking 块按原行为丢弃。
const gpt = buildOpenAIBody(body(), 'gpt-6-sol');
assert.ok(!('reasoning_content' in gpt.messages[1]));
assert.equal(gpt.messages[1].content, 'Let me check.');

// 4. 直接调用 toOpenAIMessages 时默认不回填，显式开启才回填。
const off = toOpenAIMessages(undefined, body().messages);
assert.ok(!('reasoning_content' in off[1]));
const on = toOpenAIMessages(undefined, body().messages, { replayReasoning: true });
assert.equal(on[1].reasoning_content, 'I should call get_weather.');

console.log('✓ thinking 块回填 reasoning_content 的规则通过（DeepSeek 回填、其它上游不加、缺失时回填空串）');
