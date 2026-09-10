import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublisherProbe, detailSourceUrl, readLimitedPdf } from '../scripts/collect_company_signals.mjs';

test('Google rows are probed unless a publisher URL is already known', () => {
  const row = { url: 'https://news.google.com/rss/articles/opaque', title: 'Original RSS title' };
  assert.equal(detailSourceUrl(row), row.url);
  assert.equal(detailSourceUrl({ ...row, source_direct_url: 'https://news.google.com/articles/opaque' }), row.url);
  assert.equal(detailSourceUrl({ ...row, source_direct_url: 'https://publisher.example/article' }), 'https://publisher.example/article');
  assert.equal(detailSourceUrl({ url: 'https://publisher.example/press.pdf' }), 'https://publisher.example/press.pdf');
  assert.equal(row.title, 'Original RSS title');
});

test('parallel Google work stops after three unresolved probes, and resets next run', async () => {
  const probe = createPublisherProbe();
  let calls = 0;
  const fail = async () => { calls++; throw new Error('publisher_url_unresolved'); };
  const results = await Promise.allSettled(Array.from({ length: 115 }, (_, i) =>
    probe(`https://news.google.com/rss/articles/${i}`, fail)));
  assert.equal(calls, 3);
  assert.equal(results.filter(r => r.status === 'rejected').length, 3);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value === null).length, 112);
  assert.equal(await probe('https://publisher.example/story', async () => 'body'), 'body');
  assert.equal(await createPublisherProbe()('https://news.google.com/new', async () => 'body'), 'body');
});

test('successful redirects and unrelated errors break the unresolved failure streak', async () => {
  const probe = createPublisherProbe();
  const url = 'https://news.google.com/rss/articles/sample';
  const fail = () => probe(url, async () => { throw new Error('publisher_url_unresolved'); });
  for (const outcome of ['success', 'HTTP 503']) {
    await assert.rejects(fail());
    await assert.rejects(fail());
    if (outcome === 'success') assert.equal(await probe(url, async () => 'publisher body'), 'publisher body');
    else await assert.rejects(probe(url, async () => { throw new Error(outcome); }), /HTTP 503/);
  }
  assert.equal(await probe(url, async () => 'still probing'), 'still probing');
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
