import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { FACT_PROPERTIES, PROMPT_VARIANTS, SHARED_FACTS_INSTRUCTION, SUMMARY_ELIGIBILITY_INSTRUCTION,
  SUMMARY_ENGLISH_FIRST_INSTRUCTION, SUMMARY_ENGLISH_STYLE_INSTRUCTION, SUMMARY_FACT_BASIS_INSTRUCTION,
  SUMMARY_GROUNDING_INSTRUCTION, SUMMARY_INDEPENDENCE_INSTRUCTION, SUMMARY_INSTRUCTION,
  SUMMARY_STYLE_INSTRUCTION, buildSystemInstruction, promptContract, promptVariant,
  reviewPromptDigest } from '../scripts/review_prompts.mjs';
import { GEMINI, NVIDIA, decisionsEnvelopeFor } from '../scripts/review_providers.mjs';
import { GOLDEN_SETS, goldenEntries, selectGoldenArticles } from '../scripts/golden_review.mjs';
import { buildSheet, cell, factLine, indexRun } from '../scripts/summary_sheet.mjs';

// 비교 실험을 하려면 두 가지가 동시에 참이어야 한다. 기본 경로가 한 글자도 바뀌지 않는 것과,
// 변형 실행이 기본 판정과 같은 자리에 저장되지 않는 것이다. 둘 다 여기서 고정한다.

test('the default path is byte-identical to the contract before variants existed', () => {
  assert.deepEqual(promptContract(), promptContract('baseline'));
  assert.equal('variant' in promptContract(), false);
  assert.equal(buildSystemInstruction('policy text'), buildSystemInstruction('policy text', 'baseline'));
  assert.ok(buildSystemInstruction('', 'baseline').includes(SUMMARY_INSTRUCTION));
  assert.deepEqual(decisionsEnvelopeFor(), decisionsEnvelopeFor('baseline'));
});

test('a variant replaces only the summary section and only in that variant', () => {
  const baseline = buildSystemInstruction('', 'baseline');
  const shared = buildSystemInstruction('', 'shared_facts');
  assert.notEqual(baseline, shared);
  // 바뀌는 것은 문안 작성 지시뿐이다. 근거·판정·날짜 지시는 그대로여야 같은 판정을 비교할 수 있다.
  // shared_facts 가 바꾸는 것은 사실 목록 단계 하나뿐이다. 명시적 facts 절이 암묵적 절을 대신하고,
  // 출력 순서 절은 기본 경로와 같은 것을 쓴다.
  assert.ok(shared.includes(SHARED_FACTS_INSTRUCTION));
  assert.equal(shared.includes(SUMMARY_FACT_BASIS_INSTRUCTION), false);
  assert.ok(shared.includes(SUMMARY_INDEPENDENCE_INSTRUCTION));
  const sections = text => new Map(text.split('\n## ').slice(1)
    .map(part => [part.split('\n')[0], part.split('\n').slice(1).join('\n')]));
  const [before, after] = [sections(baseline), sections(shared)];
  assert.equal(before.size, after.size);
  for (const title of ['1. Extract candidate evidence', '6. Article-level publication date',
    '2–4. Judge candidates using the supplied report criteria', 'Output contract']) {
    assert.ok(before.has(title), `missing section: ${title}`);
    assert.equal(after.get(title), before.get(title), title);
  }
  // 제목도 지시문이라 함께 바뀐다. 본문만 갈아 끼우면 제목이 옛 지시를 계속 말한다.
  const heading = text => [...sections(text).keys()].find(title => title.startsWith('5.'));
  assert.match(heading(baseline), /each language on its own$/);
  assert.match(heading(shared), /one shared fact list, each language on its own$/);
});

test('an unknown variant is refused by name rather than silently ignored', () => {
  assert.throws(() => promptVariant('shared-facts'), /Unknown prompt variant: shared-facts/);
  assert.throws(() => promptContract('nope'), /Known: baseline, shared_facts/);
  assert.equal(promptVariant(undefined).id, 'baseline');
});

test('a variant run cannot be read back as a default judgement', () => {
  const digest = variant => reviewPromptDigest('policy', promptContract(variant));
  assert.equal(digest(), digest('baseline'));
  assert.notEqual(digest('baseline'), digest('shared_facts'));
});

// 구조화 출력의 키 순서가 모델이 답을 쓰는 순서다. facts 가 문안 뒤에 오면 "먼저 사실을 정하고
// 그것만으로 쓴다"는 지시가 형식과 어긋나, 문안을 쓴 뒤 사실을 맞춰 적게 된다.
test('facts are asked for before the summaries and only under the variant', () => {
  for (const provider of [GEMINI, NVIDIA]) {
    const of = variant => {
      const body = provider.body({ article: { candidates: [] }, policy: '', retry: false, model: provider.model, variant });
      const json = JSON.stringify(body);
      return { json, hasFacts: json.includes('"counterparty"') };
    };
    assert.equal(of('baseline').hasFacts, false, provider.id);
    assert.equal(of('shared_facts').hasFacts, true, provider.id);
    assert.equal(of(undefined).hasFacts, false, provider.id);
  }
  const keys = Object.keys(decisionsEnvelopeFor('shared_facts').properties.decisions.items.properties);
  assert.ok(keys.indexOf('facts') < keys.indexOf('summary_ko'));
  assert.ok(keys.indexOf('facts') > keys.indexOf('quality'));
  // 기본 스키마의 필드를 변형이 빼먹지 않는다. 판정 필드가 빠지면 비교가 아니라 다른 실험이 된다.
  for (const key of Object.keys(decisionsEnvelopeFor('baseline').properties.decisions.items.properties)) {
    assert.ok(keys.includes(key), key);
  }
  assert.deepEqual(keys.filter(key => !Object.keys(decisionsEnvelopeFor('baseline').properties.decisions.items.properties).includes(key)), ['facts']);
});

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

// 스키마만 바뀌는 변경은 예전에 판정 캐시를 무효화하지 못했다. 키 순서가 곧 모델이 답을 쓰는
// 순서이므로 답은 달라지는데, system 문자열이 그대로라 digest 가 같았고 저장된 판정이 재사용됐다.
// 순서를 바꿔 돌린 실험이 아무것도 재지 못한다는 뜻이다.
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

test('a change to the response schema alone invalidates the judgement cache', () => {
  const baseline = promptContract('baseline');
  assert.ok(baseline.schema, '스키마가 계약에 들어 있어야 digest 가 그것을 읽는다');
  // system 은 그대로 두고 스키마만 바꾼다. 예전 계약에는 schema 키가 없어 이 차이를 표현조차 못 했다.
  const schemaOnly = { ...baseline, schema: promptContract('english_first').schema };
  assert.equal(schemaOnly.system, baseline.system);
  assert.notEqual(reviewPromptDigest('policy', schemaOnly), reviewPromptDigest('policy', baseline));
  // 변형마다 다른 기사 id 를 얻는다. 한 변형의 판정이 다른 변형의 결과로 읽히지 않는다.
  const digests = Object.keys(PROMPT_VARIANTS).map(name => reviewPromptDigest('policy', promptContract(name)));
  assert.equal(new Set(digests).size, digests.length);
});

// 변형이 고르는 것은 사실 목록 단계와 출력 순서 둘뿐이다. 영어 문체 규칙은 어느 변형에서도 같다.
// 예전에는 영어 문체가 한국어 우선 절 안에만 있어서, 그 절을 쓰지 않는 shared_facts 가 영어 표제
// 금지 규칙을 한 줄도 받지 못했다. 바로 그 변형이 고치려던 Skyworks "… - …" 표제를 막는 규칙이다.
test('every variant carries the same English style rules', () => {
  for (const variant of Object.keys(PROMPT_VARIANTS)) {
    const system = buildSystemInstruction('policy text', variant);
    assert.ok(system.includes(SUMMARY_ENGLISH_STYLE_INSTRUCTION), variant);
    assert.ok(system.includes('no " - " headline form and no leading label'), variant);
    assert.ok(system.includes('complete sentences with finite verbs'), variant);
    assert.ok(system.includes('ordinary English articles, prepositions and collocations'), variant);
    // 한국어 문체와 판정 기준도 공통이다. 변형이 이것들을 건드리면 문안 실험이 판정 실험이 된다.
    assert.ok(system.includes(SUMMARY_STYLE_INSTRUCTION), variant);
    assert.ok(system.includes(SUMMARY_ELIGIBILITY_INSTRUCTION), variant);
    assert.ok(system.includes(SUMMARY_GROUNDING_INSTRUCTION), variant);
    // 공통 규칙은 한 번만 나온다. 두 번 나오면 같은 규칙을 다른 말로 읽을 여지를 준다.
    assert.equal(system.split('no " - " headline form').length - 1, 1, variant);
    assert.equal(system.split('First fix the facts this summary reports').length - 1,
      variant.startsWith('shared_facts') ? 0 : 1, variant);
  }
});

// 변형 간 차이는 이 두 축뿐이어야 한다. 축이 늘면 무엇이 효과를 냈는지 갈라 볼 수 없다.
test('a variant differs from the default only in its fact step and its language order', () => {
  const axes = {
    baseline: { facts: false, englishFirst: false },
    shared_facts: { facts: true, englishFirst: false },
    english_first: { facts: false, englishFirst: true },
    shared_facts_english_first: { facts: true, englishFirst: true },
  };
  assert.deepEqual(Object.keys(axes), Object.keys(PROMPT_VARIANTS));
  for (const [variant, { facts, englishFirst }] of Object.entries(axes)) {
    const system = buildSystemInstruction('policy text', variant);
    // 사실 목록 단계: 명시적 facts 절과 암묵적 절은 서로를 배제한다.
    assert.equal(system.includes(SHARED_FACTS_INSTRUCTION), facts, variant);
    assert.equal(system.includes(SUMMARY_FACT_BASIS_INSTRUCTION), !facts, variant);
    assert.equal('facts' in PROMPT_VARIANTS[variant].decisionExtras, facts, variant);
    // 출력 순서: 지시문과 스키마가 같은 말을 해야 한다.
    assert.equal(system.includes(SUMMARY_ENGLISH_FIRST_INSTRUCTION), englishFirst, variant);
    assert.equal(system.includes(SUMMARY_INDEPENDENCE_INSTRUCTION), !englishFirst, variant);
    const order = Object.keys(decisionsEnvelopeFor(variant).properties.decisions.items.properties)
      .filter(key => key.startsWith('summary_'));
    assert.deepEqual(order, englishFirst ? ['summary_en', 'summary_ko'] : ['summary_ko', 'summary_en'], variant);
    // 제목도 두 축을 그대로 말한다. 본문만 갈아 끼우면 제목이 옛 지시를 계속 말한다.
    const heading = PROMPT_VARIANTS[variant].heading;
    assert.equal(/one shared fact list/.test(heading), facts, variant);
    assert.equal(/English before Korean/.test(heading), englishFirst, variant);
  }
});

test('the english-first variants write English before Korean, and say so', () => {
  const order = variant => Object.keys(decisionsEnvelopeFor(variant).properties.decisions.items.properties)
    .filter(key => key.startsWith('summary_'));
  assert.deepEqual(order('baseline'), ['summary_ko', 'summary_en']);
  assert.deepEqual(order('shared_facts'), ['summary_ko', 'summary_en']);
  assert.deepEqual(order('english_first'), ['summary_en', 'summary_ko']);
  assert.deepEqual(order('shared_facts_english_first'), ['summary_en', 'summary_ko']);
  // 사실 목록은 어느 조합에서도 문안보다 앞이다. 뒤로 가면 문안을 쓰고 사실을 맞춰 적게 된다.
  for (const variant of ['shared_facts', 'shared_facts_english_first']) {
    const keys = Object.keys(decisionsEnvelopeFor(variant).properties.decisions.items.properties);
    assert.ok(keys.indexOf('facts') < keys.indexOf('summary_ko'), variant);
    assert.ok(keys.indexOf('facts') < keys.indexOf('summary_en'), variant);
  }
  // 지시문이 스키마와 같은 순서를 말해야 한다. 본문만 두고 순서를 뒤집으면 제목과 본문이 어긋난다.
  for (const variant of ['english_first', 'shared_facts_english_first']) {
    const system = buildSystemInstruction('', variant);
    assert.ok(system.includes(SUMMARY_ENGLISH_FIRST_INSTRUCTION), variant);
    assert.ok(system.includes('English before Korean'), variant);
    assert.equal(system.includes(SUMMARY_INDEPENDENCE_INSTRUCTION), false, variant);
  }
  // 기본 경로는 영어 우선 지시를 한 글자도 받지 않는다.
  assert.equal(buildSystemInstruction('', 'baseline').includes(SUMMARY_ENGLISH_FIRST_INSTRUCTION), false);
});

// 두 provider 모두 스키마의 모든 필드를 required 로 만든다. status 가 세 값만 받으면 탈락 후보와
// 근거가 애매한 사건까지 확정 단계를 하나 골라야 하고, 그것은 이 프롬프트가 금지한 격상이다.
test('a fact field can say the evidence gave nothing instead of picking a stage', () => {
  assert.deepEqual(FACT_PROPERTIES.status, { type: 'STRING' });
  assert.equal('enum' in FACT_PROPERTIES.status, false);
  for (const [name, shape] of Object.entries(FACT_PROPERTIES)) {
    assert.deepEqual(shape, { type: 'STRING' }, name);
  }
  assert.ok(SHARED_FACTS_INSTRUCTION.includes('empty when it says nothing'));
  // 판정용 단계는 여전히 enum 이다. 문안용 사실 상태와 의미가 섞이지 않는다.
  assert.ok(decisionsEnvelopeFor('shared_facts').properties.decisions.items.properties.event_stage.enum.length > 0);
});

test('the variant list is the only place a variant is defined', () => {
  assert.deepEqual(Object.keys(PROMPT_VARIANTS),
    ['baseline', 'shared_facts', 'english_first', 'shared_facts_english_first']);
  for (const [name, variant] of Object.entries(PROMPT_VARIANTS)) assert.equal(variant.id, name);
});
