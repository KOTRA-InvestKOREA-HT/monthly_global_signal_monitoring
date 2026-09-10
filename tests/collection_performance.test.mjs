import test from 'node:test';
import assert from 'node:assert/strict';
import { detailSourceUrl, readLimitedPdf } from '../scripts/collect_company_signals.mjs';

test('unresolved Google rows skip detail requests but known publisher links remain usable', () => {
  const row = { url: 'https://news.google.com/rss/articles/opaque', title: 'Original RSS title' };
  assert.equal(detailSourceUrl(row), null);
  assert.equal(detailSourceUrl({ ...row, source_direct_url: 'https://news.google.com/articles/opaque' }), null);
  assert.equal(detailSourceUrl({ ...row, source_direct_url: 'https://publisher.example/article' }), 'https://publisher.example/article');
  assert.equal(detailSourceUrl({ url: 'https://publisher.example/press.pdf' }), 'https://publisher.example/press.pdf');
  assert.equal(row.title, 'Original RSS title');
});

test('oversized PDF headers cancel the body before downloading it', async () => {
  let read = false, cancelled = false;
  const body = { cancel: async () => { cancelled = true; }, getReader: () => { read = true; assert.fail(); } };
  await assert.rejects(readLimitedPdf({ headers: new Headers({ 'content-length': '11' }), body }, 10), /pdf_too_large/);
  assert.equal(cancelled, true);
  assert.equal(read, false);
});

test('unknown or understated PDF size is limited while streaming', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(6)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(readLimitedPdf(new Response(body, { headers }), 10), /pdf_too_large/);
    assert.equal(cancelled, true);
  }
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.deepEqual(await readLimitedPdf(new Response(bytes), 4), Buffer.from(bytes));
});
