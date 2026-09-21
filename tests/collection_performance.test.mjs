import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublisherProbe, detailSourceUrl, enrichOfficialRowsWithContent, mapWithConcurrency, rankCompanyRows, readLimitedResponse } from '../scripts/collect_company_signals.mjs';

test('Google rows are probed unless a publisher URL is already known', () => {
  const row = { url: 'https://news.google.com/rss/articles/opaque', title: 'Original RSS title' };
  assert.equal(detailSourceUrl(row), row.url);
  assert.equal(detailSourceUrl({ ...row, source_direct_url: 'https://news.google.com/articles/opaque' }), row.url);
  assert.equal(detailSourceUrl({ ...row, source_direct_url: 'https://publisher.example/article' }), 'https://publisher.example/article');
  assert.equal(detailSourceUrl({ url: 'https://publisher.example/press.pdf' }), 'https://publisher.example/press.pdf');
  assert.equal(row.title, 'Original RSS title');
});

test('parallel Google work pauses after three unresolved probes, stops after repeated pauses, and resets next run', async () => {
  const pauses = [];
  const probe = createPublisherProbe(3, { pauseMs: 60000, maxPauses: 3, sleepFn: async (ms) => { pauses.push(ms); } });
  let calls = 0;
  const fail = async () => { calls++; throw new Error('publisher_url_unresolved'); };
  const results = await Promise.allSettled(Array.from({ length: 115 }, (_, i) =>
    probe(`https://news.google.com/rss/articles/${i}`, fail)));
  // Three failures, then three pause-and-retry rounds of three failures each, then stop.
  assert.deepEqual(pauses, [60000, 60000, 60000]);
  assert.equal(calls, 12);
  assert.equal(results.filter(r => r.status === 'rejected').length, 12);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value === null).length, 103);
  assert.equal(await probe('https://publisher.example/story', async () => 'body'), 'body');
  assert.equal(await createPublisherProbe()('https://news.google.com/new', async () => 'body'), 'body');
});

test('a pause that clears the block lets probing continue', async () => {
  const probe = createPublisherProbe(3, { pauseMs: 1, sleepFn: async () => {} });
  const url = 'https://news.google.com/rss/articles/sample';
  for (let i = 0; i < 3; i += 1) await assert.rejects(probe(url, async () => { throw new Error('publisher_url_unresolved'); }));
  assert.equal(await probe(url, async () => 'publisher body'), 'publisher body');
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
  await assert.rejects(readLimitedResponse({ headers: new Headers({ 'content-length': '11' }), body }, 10), /document_too_large/);
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
    await assert.rejects(readLimitedResponse(new Response(body, { headers }), 10), /document_too_large/);
    assert.equal(cancelled, true);
  }
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.deepEqual(await readLimitedResponse(new Response(bytes), 4), Buffer.from(bytes));
});

// 2026-09-15 실행: Google 차례가 발행사 본문 다운로드까지 기다려서 다른 기업의 Google 링크가 그 뒤에 섰다.
test('the Google lane only decodes; a slow publisher download does not hold the next Google link', async () => {
  const realFetch = globalThis.fetch;
  let releaseA, bFetched = false;
  const gate = new Promise(resolve => { releaseA = resolve; });
  const timer = setTimeout(releaseA, 2000);
  globalThis.fetch = async (url, init = {}) => {
    const id = String(url).match(/\/articles\/(CBMi\w+)/)?.[1];
    if (id) return new Response(`<div data-n-a-sg="SIG" data-n-a-ts="1757000000"></div>`);
    if (String(url).includes('/batchexecute')) {
      const target = decodeURIComponent(init.body).includes('CBMiAAA') ? 'a' : 'b';
      return new Response(")]}'\n\n" + JSON.stringify([['wrb.fr', 'Fbv4je',
        JSON.stringify(['garturlres', `https://publisher.example/${target}`, 1])]]));
    }
    if (url === 'https://publisher.example/a') await gate;
    if (url === 'https://publisher.example/b') { bFetched = true; releaseA(); }
    return new Response('<title>Story</title><article>Publisher story</article>');
  };
  const args = { fetchOfficialContent: true, maxVerifyPerCompany: 0, maxDetailPerCompany: 10, timeoutSeconds: 5,
    contentCharLimit: 20000, contentExcerptLimit: 800, rateLimitSeconds: 0 };
  const row = (company, id) => ({ company, target_no: 1, source_type: 'news', link_verdict: 'accept', date_candidates: [],
    title: `${company} expands its production plant`, url: `https://news.google.com/rss/articles/${id}` });
  try {
    let aDone = false;
    const a = enrichOfficialRowsWithContent([row('Alpha', 'CBMiAAA')], args, '2026-09-15T00:00:00Z', { company: 'Alpha' })
      .then(() => { aDone = true; });
    await enrichOfficialRowsWithContent([row('Beta', 'CBMiBBB')], args, '2026-09-15T00:00:00Z', { company: 'Beta' });
    assert.equal(bFetched, true);
    assert.equal(aDone, false);
    await a;
  } finally {
    clearTimeout(timer);
    globalThis.fetch = realFetch;
  }
});

test('a company waiting on the Google lane lends its slot and gets it back before new companies start', async () => {
  const log = [];
  let openLane;
  const lane = new Promise(resolve => { openLane = resolve; });
  const results = await mapWithConcurrency(['a', 'b', 'c'], 1, async (item, index, yieldSlot) => {
    log.push(`start ${item}`);
    if (item === 'a') { await yieldSlot(() => lane); log.push('a resumed'); }
    if (item === 'b') { openLane(); await new Promise(resolve => setTimeout(resolve, 10)); }
    log.push(`end ${item}`);
    return item.toUpperCase();
  });
  assert.deepEqual(results, ['A', 'B', 'C']);
  assert.deepEqual(log, ['start a', 'start b', 'end b', 'a resumed', 'end a', 'start c', 'end c']);
});

// 34921453566: BASF 는 이번 달 기사가 없어 Google News 를 찾았지만, 받아 보니 기간 밖이던 공식 기사 10건 뒤에 서서
// 대체 기사가 하나도 남지 않았다.
test('official rows dated outside the period after fetching stand behind the fallback for company slots', () => {
  const dateRange = { from_date: '2026-08-01', to_date: '2026-08-31' };
  const row = (title, published_at, source_type = 'official') => ({ company: 'BASF', title, source_type,
    url: `https://example.com/${encodeURIComponent(title)}`, published_at, published_at_source: 'jsonld' });
  const inMonth = row('August capacity expansion announced', '2026-08-12');
  const undated = { ...row('Annual press conference', ''), published_at_source: '' };
  const september = row('September trade fair appearance', '2026-09-03');
  const old = row('Annual shareholders meeting 2025', '2025-05-02');
  const fallback = [row('Google story about a new plant', '2026-08-20', 'news'), row('Google story about a partnership', '2026-08-21', 'news')];
  const ranked = rankCompanyRows({ usable: [inMonth], rows: [september, inMonth, old, undated], fallbackRows: fallback, dateRange, limit: 4 });
  assert.deepEqual(ranked.map(r => r.title), ['August capacity expansion announced', 'Annual press conference',
    'Google story about a new plant', 'Google story about a partnership']);
  // 자리가 남으면 기간 밖 공식 기사도 원래 순서대로 뒤에 남는다.
  assert.deepEqual(rankCompanyRows({ usable: [inMonth], rows: [september, inMonth, old, undated], fallbackRows: fallback, dateRange, limit: 10 })
    .slice(4).map(r => r.title), ['September trade fair appearance', 'Annual shareholders meeting 2025']);
});
