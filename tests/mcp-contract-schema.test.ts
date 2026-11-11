import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv } from 'ajv';

import { ERROR_CODES, createSearchError, searchOutcomeSchema } from '../src/contracts.ts';
import {
  MANY_TOOL_INPUT_SCHEMA, MANY_TOOL_OUTPUT_SCHEMA, TOOL_INPUT_SCHEMA, TOOL_OUTPUT_SCHEMA, manyToolResult, toolResult,
} from '../src/mcp.ts';
import { RESULT_FIXTURES, resultFixture } from './fixtures/contracts.ts';

// This independent JSON Schema validator checks the contract actually advertised
// to MCP clients, rather than parsing output with the runtime contract a second time.
const validator = new Ajv({ allErrors: true, strict: true });
const validateOutput = validator.compile(TOOL_OUTPUT_SCHEMA);
const validateManyOutput = validator.compile(MANY_TOOL_OUTPUT_SCHEMA);

for (const kind of RESULT_FIXTURES) {
  test(`advertised MCP schema accepts the validated ${kind} result`, () => {
    const outcome = searchOutcomeSchema.parse(resultFixture(kind));
    const payload = toolResult(outcome).structuredContent;
    assert.equal(validateOutput(payload), true, validator.errorsText(validateOutput.errors));
    assert.equal(validateManyOutput(manyToolResult([outcome]).structuredContent), true,
      validator.errorsText(validateManyOutput.errors));
  });
}

test('every compact error satisfies the advertised MCP schema', () => {
  for (const code of ERROR_CODES) {
    const payload = toolResult(createSearchError(code, 'schema-parity')).structuredContent;
    assert.equal(validateOutput(payload), true, validator.errorsText(validateOutput.errors));
    assert.equal(validateManyOutput(manyToolResult([payload]).structuredContent), true,
      validator.errorsText(validateManyOutput.errors));
  }
});

test('the advertised excerpt contract requires code and rejects the former text field', () => {
  const result = resultFixture();
  assert.ok(result.excerpts.length > 0);
  assert.equal(validateOutput(result), true, validator.errorsText(validateOutput.errors));
  const excerpt = result.excerpts[0]!;
  const { code, ...fields } = excerpt;
  for (const replacement of [fields, { ...fields, text: code }, { ...excerpt, score: '0.9' }]) {
    assert.equal(validateOutput({ ...result, excerpts: [replacement] }), false);
  }
});

test('generated input schemas enforce structural multiquestion limits', () => {
  const single = validator.compile(TOOL_INPUT_SCHEMA);
  const many = validator.compile(MANY_TOOL_INPUT_SCHEMA);
  assert.equal(single({ query: 'cache', max_input_tokens: 100 }), true);
  assert.equal(many({ questions: [{ query: 'cache' }], max_search_ms: 100 }), true);
  for (const input of [
    {}, { questions: [] }, { questions: Array.from({ length: 17 }, () => ({ query: 'cache' })) },
    { questions: [{ query: 'cache', continuation: 'unsupported' }] },
    { questions: [{ scope: ['src'] }] }, { questions: [{ query: 1 }] },
    { questions: [{ query: 'cache' }], extra: true },
  ]) assert.equal(many(input), false);
});
