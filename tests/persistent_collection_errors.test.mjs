// 2026-11-10 수집: 한 실행의 다섯 번 수집에서 같은 주소가 같은 오류로 실패해 5개 기업이 늘 재시도 대상으로 남았다.
// Amkor(Global Sources 429)·Veolia(Smart Water Magazine 429)·Schmalz(MBC Radio 연결 실패)는 외부 매체가 봇 요청을 늘 막았고,
// magniX 는 /news 페이지가 늘 연결을 끊었고, HyproMag 는 Mkango 가 mkango.ca 에서 새 도메인으로 옮겨 옛 주소가 막혔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { markUnreadableOutletErrors } from '../scripts/collect_company_signals.mjs';
import { retryableCollection, retryableError } from '../scripts/collection_resilience.mjs';

const sourceConfig = JSON.parse(await fs.readFile('config/company_sources.json', 'utf8'));
const detail = (source_name, error, source = 'official_detail') => ({ target_no: 16, company: 'Amkor Technology', source,
  source_url: 'https://news.google.com/rss/articles/CBMisgF', source_name, error });

test('detail errors from outlets that never give a body do not make the company retryable', () => {
  const errors = markUnreadableOutletErrors([
    detail('Google News: Global Sources', 'HTTP 429 Too Many Requests'),
    detail('Google News: Smart Water Magazine', 'HTTP 429 Too Many Requests'),
    detail('Google News: MBC Radio', 'fetch failed'),
  ], sourceConfig);
  assert.ok(errors.every(error => error.unreadable_outlet === true));
  assert.ok(errors.every(error => !retryableError(error)));
  // 오류 기록은 그대로 남는다.
  assert.equal(errors[0].error, 'HTTP 429 Too Many Requests');
  assert.equal(retryableCollection({ errors }), false);
});

test('other outlets, Google pauses and official pages stay retryable as before', () => {
  const errors = markUnreadableOutletErrors([
    detail('Google News: Recycling Today', 'HTTP 429 Too Many Requests'),
    detail('Google News: Global Sources', 'google_probe_paused'),
    { company: 'Magnix', source: 'official_pages', source_url: 'https://www.magnix.aero/', source_name: 'Global Sources page', error: 'fetch failed' },
  ], sourceConfig);
  assert.deepEqual(errors.map(error => Boolean(error.unreadable_outlet)), [false, false, false]);
  assert.deepEqual(errors.map(retryableError), [true, true, true]);
});

test('the sources that failed the same way on every pass are gone from the config', () => {
  const urls = JSON.stringify([sourceConfig.official_feeds, sourceConfig.official_pages]);
  assert.doesNotMatch(urls, /mkango\.ca/);
  assert.doesNotMatch(urls, /magnix\.aero\/news"/);
  // magniX 의 기사 목록은 news.json 피드가 그대로 받는다.
  assert.match(JSON.stringify(sourceConfig.official_feeds.Magnix), /magnix\.aero\/data\/news\.json/);
  assert.match(JSON.stringify(sourceConfig.official_pages.HyproMag), /mkangomagneticmaterials\.com/);
  for (const outlet of ['Global Sources', 'Smart Water Magazine', 'MBC Radio']) {
    assert.ok(sourceConfig.external_news_unreadable_outlets.includes(outlet), outlet);
  }
});
