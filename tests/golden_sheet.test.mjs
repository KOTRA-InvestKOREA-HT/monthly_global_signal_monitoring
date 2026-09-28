import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { GOLDEN_SETS, goldenEntries, selectGoldenArticles } from '../scripts/golden_review.mjs';
import { buildSheet, cell, factLine, indexRun } from '../scripts/summary_sheet.mjs';

// 개발용 기사에서만 좋아진 결과를 일반화된 개선으로 읽지 않으려면, 두 묶음이 코드에서 갈라져야 한다.
test('dev and holdout articles are separated and never overlap', () => {
  const golden = { articles: [
    { company: 'A', url: 'u1', set: 'dev' }, { company: 'B', url: 'u2', set: 'holdout' },
    { company: 'C', url: 'u3' }] };
  assert.deepEqual(goldenEntries(golden, 'dev').map(e => e.url), ['u1']);
  // set 을 적지 않은 항목은 holdout 이다. 표시를 잊은 기사가 개발용으로 새지 않는다.
  assert.deepEqual(goldenEntries(golden, 'holdout').map(e => e.url), ['u2', 'u3']);
  assert.equal(goldenEntries(golden, 'all').length, 3);
  assert.throws(() => goldenEntries(golden, 'train'), /Unknown set: train/);
  assert.deepEqual(GOLDEN_SETS, ['dev', 'holdout', 'all']);

  const articles = ['u1', 'u2', 'u3'].map((url, i) => ({ id: `id${i}`, company: 'ABC'[i], url, candidates: [] }));
  assert.deepEqual(selectGoldenArticles(articles, golden, 'dev').selected.map(a => a.url), ['u1']);
  assert.deepEqual(selectGoldenArticles(articles, golden).selected.length, 3);
  // 목록에 있는데 수집본에 없는 기사는 조용히 빠지지 않는다. 빠지면 비교 대상이 달라진다.
  assert.deepEqual(selectGoldenArticles([articles[0]], golden, 'holdout').missing.map(e => e.url), ['u2', 'u3']);
});

test('every golden entry declares which set it belongs to', () => {
  const golden = JSON.parse(fs.readFileSync(new URL('../config/golden_articles.json', import.meta.url), 'utf8'));
  for (const entry of golden.articles) {
    assert.ok(['dev', 'holdout'].includes(entry.set), `${entry.company} ${entry.url}`);
    // 개발용 기사는 무엇을 보고 개발용으로 분류했는지 함께 남긴다. 그것이 이 회차의 평가 사례다.
    if (entry.set === 'dev') assert.ok(entry.defects?.length, entry.url);
  }
  assert.ok(goldenEntries(golden, 'dev').length >= 5);
  assert.ok(goldenEntries(golden, 'holdout').length >= 10);
});

// 채점지는 같은 후보의 두 문안을 한 줄씩 나란히 놓아야 한다. 한쪽만 실리면 비교가 아니라 열람이다.
test('the sheet pairs the two runs candidate by candidate', () => {
  const report = (variant, ko, en) => ({ provider: 'gemini', model: 'm1', variant, set: 'dev',
    comparisons: [{ article_id: `art-${variant}`, company: 'Acme', url: 'https://example.com/a',
      set: 'dev', defects: ['pending 를 보류로 옮겼다'], expect: 'unknown',
      candidates: [{ candidate_id: 'investment:4', kind: 'investment',
        after: { supported: true, summary_ko: ko, summary_en: en } }] }] });
  // 두 실행의 사실 목록을 한 곳에 모으지 않는다. 기사 id 가 같을 때 서로의 목록으로 실리기 때문이다.
  const detail = {
    a: new Map([['art-baseline', new Map([['investment:4', { quotes: ['Acme signed a | deal.'] }]])]]),
    b: new Map([['art-shared_facts', new Map([['investment:4', { quotes: ['Acme signed a | deal.'],
      facts: { actor: 'Acme', action: 'signed a deal', counterparty: '', amount: 'USD 5m' } }]])]]) };
  const sheet = buildSheet({ reportA: report('baseline', '가나', 'alpha'),
    reportB: report('shared_facts', '다라', 'beta'), detail });

  assert.match(sheet, /gemini \/ m1 \/ baseline \| ko \| 가나/);
  assert.match(sheet, /gemini \/ m1 \/ shared_facts \| ko \| 다라/);
  assert.match(sheet, /gemini \/ m1 \/ shared_facts \| en \| beta/);
  assert.match(sheet, /\[dev\]/);
  assert.match(sheet, /pending 를 보류로 옮겼다/);
  // 근거가 문안 위에 있어야 사실 확인이 가능하다. 표를 깨뜨리는 파이프는 지우지 않고 벗긴다.
  assert.match(sheet, /> Acme signed a \\\| deal\./);
  assert.ok(sheet.indexOf('Acme signed a') < sheet.indexOf('| ko | 가나'));
  assert.equal(cell('a|b\nc'), 'a\\|b c');
  assert.equal(cell(''), '(없음)');

  // 사실 목록은 적은 실행 쪽에만 붙고, 빈 칸은 싣지 않는다.
  assert.match(sheet, /사실 목록 \(gemini \/ m1 \/ shared_facts\): actor=Acme · action=signed a deal · amount=USD 5m/);
  assert.equal(/사실 목록 \(gemini \/ m1 \/ baseline\)/.test(sheet), false);
  assert.equal(/counterparty/.test(sheet), false);
  assert.equal(factLine(null), '');
  assert.equal(factLine({ actor: ' ', date: '2026-08' }), 'date=2026-08');

  // 세트를 좁히면 그 세트만 남는다. dev 와 holdout 을 섞어 세지 않기 위한 것이다.
  const holdoutOnly = buildSheet({ reportA: report('baseline', '가나', 'alpha'), reportB: null,
    detail, set: 'holdout' });
  assert.equal(/투자|investment:4/.test(holdoutOnly), false);
  assert.equal(indexRun(report('baseline', '가나', 'alpha')).size, 1);
});

// 두 실행이 서로 다른 문장을 인용하면 각자의 근거를 싣는다. 예전에는 A 의 인용만 싣고 두 문안을
// 그 아래 놓아, 채점자가 A 의 근거로 B 의 문안을 읽고 근거 있는 요약을 근거 없음으로 적게 됐다.
test('the sheet shows each run its own evidence when the two runs quoted differently', () => {
  const report = (variant, ko) => ({ provider: 'gemini', model: 'm1', variant, set: 'dev',
    comparisons: [{ article_id: `art-${variant}`, company: 'Acme', url: 'https://example.com/a',
      set: 'dev', defects: [], expect: 'unknown',
      candidates: [{ candidate_id: 'investment:4', kind: 'investment',
        after: { supported: true, summary_ko: ko, summary_en: 'en' } }] }] });
  const detail = (aQuote, bQuote) => ({
    a: new Map([['art-baseline', new Map([['investment:4', { quotes: [aQuote] }]])]]),
    b: new Map([['art-english_first', new Map([['investment:4', { quotes: [bQuote] }]])]]) });
  const build = (aQuote, bQuote) => buildSheet({ reportA: report('baseline', '가나'),
    reportB: report('english_first', '다라'), detail: detail(aQuote, bQuote) });

  const differing = build('Acme signed a deal.', 'Acme opened a plant.');
  assert.match(differing, /근거 \(gemini \/ m1 \/ baseline\)/);
  assert.match(differing, /근거 \(gemini \/ m1 \/ english_first\)/);
  assert.match(differing, /> Acme signed a deal\./);
  assert.match(differing, /> Acme opened a plant\./);
  // 두 근거 모두 문안 표보다 위에 있어야 채점할 때 눈이 위로 올라간다.
  assert.ok(differing.indexOf('Acme opened a plant.') < differing.indexOf('| ko | 가나'));

  // 같은 문장을 인용했으면 한 번만 싣는다. 채점지가 길어지는 것은 그 자체로 비용이다.
  const same = build('Acme signed a deal.', 'Acme signed a deal.');
  assert.equal(same.match(/> Acme signed a deal\./g).length, 1);
  assert.equal(/근거 \(gemini/.test(same), false);
});
