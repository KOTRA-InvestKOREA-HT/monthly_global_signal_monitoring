// 판정 파일은 판정·문안·검토 단계가 모두 같은 도우미로 쓴다. 끊긴 쓰기가 반쪽 JSON 을 남기지 않아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../scripts/atomic_json.mjs';
import { pruneReviewWork } from '../scripts/review_report.mjs';

test('an atomic JSON write replaces the file whole and leaves no temporary file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-json-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'review.json');
  await writeJsonAtomic(file, { a: 1 });
  await writeJsonAtomic(file, { a: 2, b: [1] });
  assert.equal(await fs.readFile(file, 'utf8'), '{\n  "a": 2,\n  "b": [\n    1\n  ]\n}\n');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['review.json']);
});

test('a failed atomic write keeps the previous file and removes its temporary file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-json-fail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review.json');
  await writeJsonAtomic(file, { kept: true });
  const circular = {}; circular.self = circular;
  await assert.rejects(writeJsonAtomic(file, circular), /circular/i);
  // 대상이 디렉터리라 이름 바꾸기가 실패해도 임시 파일은 남지 않는다.
  const blocked = path.join(dir, 'blocked.json');
  await fs.mkdir(path.join(blocked, 'inside'), { recursive: true });
  await assert.rejects(writeJsonAtomic(blocked, { a: 1 }));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { kept: true });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['blocked.json', 'review.json']);
});

test('the review workspace also drops temporary files a cut-off write left behind', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-work-tmp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'reviews'), { recursive: true });
  for (const name of ['keep.json', 'keep.json.1234-abcd1234.tmp', 'old.json.tmp']) await fs.writeFile(path.join(root, 'reviews', name), '{');
  const removed = await pruneReviewWork(root, path.join(root, 'run'), [{ id: 'keep' }]);
  assert.equal(removed.reviews, 2);
  assert.deepEqual(await fs.readdir(path.join(root, 'reviews')), ['keep.json']);
});
