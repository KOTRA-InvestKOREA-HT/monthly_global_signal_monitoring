import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MODEL_INPUT_VERSION, MODEL_CRITERIA_IDS, modelArticle, modelCandidate, modelTechnologyScope,
  technologyTranslationError } from '../scripts/model_input.mjs';
import { promptContract, reviewPromptDigest } from '../scripts/review_prompts.mjs';
import { GEMINI, NVIDIA } from '../scripts/review_providers.mjs';
import { groupArticles, sourceCandidates } from '../scripts/local_report.mjs';
import { policySection } from '../scripts/review_report.mjs';

const period = { from_date: '2026-08-01', to_date: '2026-08-31' };
const BODY = 'The company plans a new pilot plant and signed a joint research agreement. '.repeat(6);
const tech = { company: 'Acme', target_no: 1, technology_group: 'rare_earth_magnet_recycling',
  target_technology: '사용후 영구자석 고순도 희토류 추출',
  target_technology_en: 'rare earth extraction from end-of-life permanent magnets' };
const signal = { company: 'Acme', target_no: 1, url: 'https://example.com/a', title: 'Pilot plant',
  published_at: '2026-08-10T00:00:00Z', content_text: BODY };
const indicators = { indicators: [{ no: 1, id: 'supply_chain_geopolitical_risk',
  label_ko: '공급망·지정학 리스크 대응', label_en: 'Supply Chain & Geopolitical Risk',
  description_ko: '특정지역 의존도 축소·공급망 다변화·규제 리스크 대응 등' }] };

const prepared = (scopes = {}) => {
  const candidates = sourceCandidates([signal], { companies: [tech] }, indicators, period, scopes);
  return groupArticles(candidates.investment, candidates.relevant, period, 'policy');
};
const sentText = (article, provider = GEMINI) => {
  const body = provider.body({ article, policy: 'POLICY', model: provider.model });
  return provider.id === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content;
};
const hangul = text => (String(text).match(/[가-힣]/g) || []).length;

// 한 요청 안에 같은 정의가 두 벌 들어가 있었다. 판정 기준이 S1~S5 를 영어로 정의하는데, 후보마다
// 같은 지표를 한국어 indicator·description 으로 다시 실어 보냈다. 후보는 id 로 기준을 가리킨다.
test('a candidate points at its criteria by id instead of carrying them again', () => {
  const [article] = prepared();
  for (const candidate of article.candidates.map(({ row, ...rest }) => rest)) {
    assert.equal('indicator' in candidate, false, candidate.id);
    assert.equal('description' in candidate, false, candidate.id);
    assert.ok(MODEL_CRITERIA_IDS.includes(candidate.id), candidate.id);
  }
  // 기준 문서에는 그 id 마다 정의가 하나씩 있어야 한다. 후보에서 설명을 빼고 기준에도 없으면
  // 그 지표는 어디에도 정의되지 않은 채 판정된다.
  const criteria = policySection(fs.readFileSync('docs/local_report_review.md', 'utf8'));
  for (const id of MODEL_CRITERIA_IDS) {
    if (id === 'relevant') assert.match(criteria, /kind=relevant/);
    else assert.ok(criteria.includes(`\`${id}\``), id);
  }
  // 그리고 기준이 제거한 필드를 가리키면 안 된다.
  assert.equal(/candidate's `indicator` and `description`/.test(criteria), false);
});

// 회사별로 다른 정보라 id 로 대신할 수 없다. 표현만 영어로 바꾸고 한국어 원본은 그대로 둔다.
test('the model gets the English technology while the Korean original stays on the row', () => {
  const [article] = prepared();
  const candidate = article.candidates[0];
  assert.equal(candidate.target_technology, tech.target_technology_en);
  assert.equal(candidate.row.target_technology, tech.target_technology);
  assert.equal(hangul(candidate.target_technology), 0);
  // 설정 파일과 한국어 표기는 이 변환으로 바뀌지 않는다.
  const stored = JSON.parse(fs.readFileSync('data/company_technology_map.json', 'utf8'));
  assert.ok(stored.companies.every(item => item.target_technology));
});

// 번역 누락을 빈 문자열이나 한국어로 조용히 대체하지 않는다. 기술 그룹 ID 와 함께 드러낸다.
test('a missing technology translation stops preparation and names the technology group', () => {
  const missing = { ...tech, target_technology_en: '' };
  assert.throws(() => sourceCandidates([signal], { companies: [missing] }, indicators, period, {}),
    /Missing target_technology_en for Acme \(technology_group=rare_earth_magnet_recycling/);
  // groupArticles 를 직접 부르는 경로도 같은 검사를 지난다.
  assert.throws(() => modelCandidate({ kind: 'relevant', row: missing }), /Missing target_technology_en/);
  // 기술 면제는 번역 면제가 아니다. 면제 기업도 타겟 기술 자체는 가지고 있다.
  assert.throws(() => modelCandidate({ kind: 'relevant', row: { ...missing, excluded_from_relevance: true } }),
    /Missing target_technology_en/);
  // 기술 정보가 애초에 없는 후보와 번역 누락은 구별한다.
  assert.equal(technologyTranslationError({ company: 'Acme', target_technology: '' }), '');
});

// 판정 기준은 target_technology_scope.includes 와 .excludes 를 보라고 말하는데, 설정 파일의 키는
// includes_ko·excludes_ko·includes_en·excludes_en 이었다. 지시문이 부르는 키가 전달된 객체에 없었다.
test('the scope reaches the model under the key names the criteria use', () => {
  const scopes = { rare_earth_magnet_recycling: { includes_ko: '한국어 포함 범위', excludes_ko: '한국어 제외 범위',
    includes_en: 'magnet recycling lines', excludes_en: 'primary mining' } };
  const [article] = prepared(scopes);
  const scope = article.candidates[0].target_technology_scope;
  assert.deepEqual(scope, { includes: 'magnet recycling lines', excludes: 'primary mining' });
  const criteria = policySection(fs.readFileSync('docs/local_report_review.md', 'utf8'));
  assert.ok(criteria.includes('`target_technology_scope.includes`'));
  assert.equal(modelTechnologyScope(null), null);
  // 영어 범위가 하나도 없으면 필드를 붙이지 않는다. 한국어 범위를 대신 보내지 않는다.
  assert.equal(modelTechnologyScope({ includes_ko: '한국어만' }), null);
});

// date_label·date_note 가 말하는 것은 date_status·date_placement·published_at 에 이미 구조화돼 있다.
// 기사 객체에서는 지우지 않는다. 날짜 보강 목록과 사람이 읽는 표시가 그 두 필드를 쓴다.
test('display-only date wording is dropped in transit, not from the article', () => {
  const [article] = prepared();
  assert.ok('date_note' in article);
  assert.equal(modelArticle(article).date_note, undefined);
  assert.equal(modelArticle(article).date_label, undefined);
  for (const key of ['published_at', 'published_month', 'date_status', 'date_placement', 'reporting_period']) {
    assert.ok(key in modelArticle(article), key);
  }
});

// 1차·수리·2차 검증과 모든 변형이 같은 표현을 쓴다. 검증 요청이 후보를 좁히는 동작은 그대로다.
test('every provider and every retry mode sends the same model representation', () => {
  const [article] = prepared();
  const modes = [false, true, { reason: 'summary_ungrounded', candidate_ids: ['investment:1'] },
    { mode: 'verify', verify_candidate_ids: ['investment:1'], primary_decisions: [], flagged_because: [] }];
  for (const provider of [GEMINI, NVIDIA]) {
    for (const retry of modes) {
      const body = provider.body({ article, policy: 'POLICY', model: provider.model, retry });
      const user = (provider.id === 'gemini' ? body.contents[0].parts.map(p => p.text) : body.messages.slice(1).map(m => m.content)).join('\n');
      assert.equal(/"indicator"/.test(user), false, `${provider.id} ${JSON.stringify(retry)}`);
      assert.equal(/"description"/.test(user), false, `${provider.id} ${JSON.stringify(retry)}`);
      assert.equal(/date_label|date_note/.test(user), false, `${provider.id} ${JSON.stringify(retry)}`);
      assert.ok(user.includes(tech.target_technology_en));
    }
    // 검증 요청은 대상 후보만 싣는다. 이 동작은 바뀌지 않는다.
    const verified = sentText(article, provider);
    assert.ok(JSON.parse(verified).candidates.length >= 1);
  }
});

// 기사 원문은 번역하거나 지우지 않는다. 인용 검증이 원문 문장에 기대기 때문이다.
test('article evidence is left exactly as collected', () => {
  const korean = { ...signal, content_text: `${BODY} 이 회사는 국내 공장 증설을 검토 중이다.` };
  const candidates = sourceCandidates([korean], { companies: [tech] }, indicators, period, {});
  const [article] = groupArticles(candidates.investment, candidates.relevant, period, 'policy');
  const sent = JSON.parse(sentText(article));
  assert.ok(sent.evidence.some(block => block.includes('국내 공장 증설을 검토 중이다')));
});

// 전송에서만 빼는 필드는 기사 ID 를 바꾸지 않는다(원래부터 material 밖이다). 그 몫을 계약 버전이 맡는다.
test('the input contract version, not the article id, carries a send-time change', () => {
  assert.equal(promptContract().input, MODEL_INPUT_VERSION);
  const changed = { ...promptContract(), input: `${MODEL_INPUT_VERSION}-next` };
  assert.notEqual(reviewPromptDigest('policy', promptContract()), reviewPromptDigest('policy', changed));
});

// 기술 번역은 material 안에 있으므로, 한 기업의 번역을 고치면 그 기업의 기사 ID 만 달라진다.
test('changing one technology translation re-judges only that company', () => {
  const other = { ...tech, company: 'Other', target_no: 2 };
  const signals = [signal, { ...signal, company: 'Other', target_no: 2, url: 'https://example.com/b' }];
  const ids = companies => Object.fromEntries(groupArticles(
    ...(({ investment, relevant }) => [investment, relevant])(sourceCandidates(signals, { companies }, indicators, period, {})),
    period, 'policy').map(a => [a.company, a.id]));
  const before = ids([tech, other]);
  const after = ids([{ ...tech, target_technology_en: 'rare earth recovery from spent magnets' }, other]);
  assert.notEqual(before.Acme, after.Acme);
  assert.equal(before.Other, after.Other);
});
