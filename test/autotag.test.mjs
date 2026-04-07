/**
 * Unit tests for inferTags() — the sync dictionary-based tagger.
 * No external APIs, no filesystem writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTags, loadWikiTags } from '../bin/lib/autotag.mjs';

test('inferTags: matches AI/LLM terms', () => {
  const tags = inferTags('machine learning and LLM agents');
  assert.ok(tags.includes('ia'), 'should include "ia"');
  assert.ok(tags.includes('llm'), 'should include "llm"');
});

test('inferTags: matches frontend terms', () => {
  const tags = inferTags('react typescript frontend application');
  assert.ok(tags.includes('javascript'), 'should include "javascript"');
  assert.ok(tags.includes('frontend'), 'should include "frontend"');
});

test('inferTags: matches devops terms', () => {
  const tags = inferTags('docker kubernetes deployment pipeline');
  assert.ok(tags.includes('devops'), 'should include "devops"');
});

test('inferTags: matches backend/architecture terms', () => {
  const tags = inferTags('microservice hexagonal architecture api rest');
  assert.ok(tags.includes('arquitectura'), 'should include "arquitectura"');
  assert.ok(tags.includes('backend'), 'should include "backend"');
});

test('inferTags: matches startup/business terms', () => {
  const tags = inferTags('saas startup mrr revenue growth');
  assert.ok(tags.includes('saas'), 'should include "saas"');
  assert.ok(tags.includes('negocio'), 'should include "negocio"');
});

test('inferTags: returns at most 5 tags', () => {
  const tags = inferTags('react typescript docker machine learning llm startup saas redis cache kubernetes');
  assert.ok(tags.length <= 5, `should return at most 5 tags, got ${tags.length}`);
});

test('inferTags: returns empty array for unrecognized text', () => {
  const tags = inferTags('completely unrelated xyz zyx zzz nothing here matches');
  assert.equal(tags.length, 0, 'should return empty array for unknown text');
});

test('inferTags: is case-insensitive', () => {
  const lower = inferTags('docker');
  const upper = inferTags('DOCKER');
  assert.deepEqual(lower, upper, 'should match regardless of case');
});

test('inferTags: returns an array', () => {
  const tags = inferTags('some text');
  assert.ok(Array.isArray(tags), 'should always return an array');
});

test('loadWikiTags: returns a Set without crashing when wiki/ is missing', () => {
  const tags = loadWikiTags();
  assert.ok(tags instanceof Set, 'should return a Set');
});
