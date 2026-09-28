import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceResponseModel } from '../src/providers/response-body.js';

test('model routing replaces only the top-level token, preserving raw numbers and whitespace', () => {
  const raw = '{\n  "model" : "alias", "integer":9007199254740993, "n":1.20e+09, "input":[{"model":"nested"}], "text":"model alias"\n}'.replaceAll('\\n', '\n');
  assert.equal(replaceResponseModel(raw, 'upstream'), raw.replace('"alias"', '"upstream"'));
});

test('escaped keys, strings and repeated model keys are handled without rewriting other fields', () => {
  const raw = String.raw`{"mo\u0064el":"one","text":"quoted \"model\":\"one\" and \\ end","nested":{"model":"one"},"model":"two"}`;
  JSON.parse(raw);
  const expected = raw.replace('"one"', '"target"').replace('"two"', '"target"');
  assert.equal(replaceResponseModel(raw, 'target'), expected);
});

test('replacement model is escaped as a JSON string', () => {
  const target = 'a"b\\c';
  assert.equal(JSON.parse(replaceResponseModel('{"model":"alias"}', target)).model, target);
});

test('nested models are never mistaken for a top-level model', () => {
  const raw = '{"input":[{"model":"nested"}],"model":"alias","tail":{"model":"tail"}}';
  assert.equal(replaceResponseModel(raw, 'target'), raw.replace('"alias"', '"target"'));
});

test('ambiguous non-string duplicate models are rejected', () => {
  assert.throws(() => replaceResponseModel('{"model":42,"model":"alias"}', 'target'), /must be a string/);
  assert.throws(() => replaceResponseModel('{"model":{},"model":"alias"}', 'target'), /must be a string/);
});
