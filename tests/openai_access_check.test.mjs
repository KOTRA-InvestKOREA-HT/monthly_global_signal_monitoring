import assert from "node:assert/strict";
import test from "node:test";

import { classifyFailure } from "../scripts/check_openai_access.mjs";

test("an unusable key is told apart from a key without permission", () => {
  assert.equal(classifyFailure(401, "Incorrect API key provided").cause, "invalid_key");
  assert.equal(classifyFailure(403, "Project does not have access").cause, "forbidden");
});

test("a working key blocked on one model is reported as a model problem", () => {
  assert.equal(classifyFailure(404, "The model 'gpt-5.6-luna' does not exist").cause, "model_unavailable");
  assert.equal(classifyFailure(400, "You do not have access to this model").cause, "model_unavailable");
});

test("quota and rate limits are not mistaken for a bad key", () => {
  assert.equal(classifyFailure(429, "Rate limit reached").cause, "rate_or_quota");
  assert.equal(classifyFailure(400, "You exceeded your current quota").cause, "rate_or_quota");
});

test("a request shape the model cannot serve is called out separately", () => {
  assert.equal(classifyFailure(400, "Invalid schema for response_format").cause, "unsupported_request_shape");
});

test("a request that never left the machine is reported as a network problem", () => {
  assert.equal(classifyFailure(0, "fetch failed").cause, "network");
});

test("every classification carries advice on what to do next", () => {
  for (const [status, message] of [[401, "x"], [403, "x"], [404, "x"], [429, "x"], [400, "schema"], [0, "x"], [500, "x"]]) {
    assert.ok(classifyFailure(status, message).advice.length > 0);
  }
});
