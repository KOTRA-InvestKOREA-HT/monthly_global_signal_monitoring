// 사업동향(kind=relevant) 탐색. 공식 자료가 있어도 도는 별도 Google News 질의이고,
// 비용은 기업당 요청 1회와 후보 상한으로 묶인다. 키워드는 LLM 검토 후보를 고르는 데만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TREND_DISCOVERY_PER_COMPANY, TREND_QUERY_KEYWORD_LIMIT, buildTrendQuery, trendKeywords,
  matchedTrendKeywords, isDuplicateTrendRow, selectTrendRows, trendDigestInputs, trendSearchWindow,
  rankTrendQueryTerms, trendTermRank, selectTrendQueryTerms, companySearchTerms,
} from '../scripts/collect_company_signals.mjs';

const company = { target_no: 31, company: 'Norsk Hydro', query_aliases: ['Hydro'] };
const technology = { target_no: 31, company: 'Norsk Hydro', technology_group: 'nonferrous_scrap_recycling',
  target_technology: '비철금속 소재 스크랩 활용률 극대화', target_technology_en: 'non-ferrous scrap utilisation' };
const keywordConfig = { groups: { nonferrous_scrap_recycling: { keywords: [
  'recycled aluminium', 'post-consumer scrap', 'scrap utilisation', 'aluminium recycling',
  '재활용 알루미늄', '스크랩', 'secondary aluminium', 'closed loop recycling', 'remelting'] } } };

// 보고 기간. 검색 창은 이 기간에 맞추고 실행 시점과 무관해야 한다.
const august = { mode: 'explicit', fromDate: '2026-08-01', toDate: '2026-08-31', lookbackDays: 50 };

const row = (overrides = {}) => ({ company: 'Norsk Hydro', title: 'Hydro brings high-recycled aluminium to GM',
  url: 'https://news.google.com/rss/articles/a', discovery_snippet: 'Hydro CIRCAL uses post-consumer scrap',
  ...overrides });

test('the query pairs the company names with its own technology terms', () => {
  const query = buildTrendQuery(company, technology, keywordConfig, august);
  // 이름 선택은 기존 relevantAliases 를 그대로 쓴다. "Hydro" 처럼 흔한 약칭은 검색에서 빠진다.
  assert.match(query, /^"Norsk Hydro" \(/);
  assert.match(query, /"recycled aluminium"/);
  // 자동 생성된 기술명은 실제 기사 표현 여섯 자리를 밀어내지 않는다.
  assert.equal(query.includes('non-ferrous scrap utilisation'), false);
  assert.match(query, /after:2026-08-01 before:2026-09-01$/);
  // 한글 키워드는 영문 뉴스 결과에 걸리지 않으면서 질의만 길게 만든다.
  assert.equal(query.includes('재활용 알루미늄'), false);
  // 질의어 수를 묶어 둔다. Google 이 뒤쪽 항을 버리면 검색 자체가 무의미해진다.
  assert.ok((query.match(/ OR /g) || []).length <= TREND_QUERY_KEYWORD_LIMIT + 1);
});

test('a company whose alias survives the name rule searches both names', () => {
  const withAlias = { target_no: 1, company: 'Australian Strategic Metals',
    query_aliases: ['Australian Strategic Materials'] };
  const query = buildTrendQuery(withAlias, technology, keywordConfig, august);
  assert.match(query, /^\("Australian Strategic Metals" OR "Australian Strategic Materials"\) \(/);
});

// when:Nd 는 요청 시점 기준이라, 마감 한참 뒤에 돌리면 그 사이 새 기사가 결과 자리를 채우고
// 정작 그 달 기사가 밀려난다. 보고 기간을 받으면 그 기간을 직접 지정한다.
test('an explicit reporting period is searched by date, not by days before now', () => {
  assert.equal(trendSearchWindow(august), 'after:2026-08-01 before:2026-09-01');
  // 끝날을 포함해야 하므로 before 는 하루 뒤다. 월말·연말 경계도 넘어간다.
  assert.equal(trendSearchWindow({ mode: 'explicit', fromDate: '2026-12-01', toDate: '2026-12-31' }),
    'after:2026-12-01 before:2027-01-01');
  // 기간을 지정하지 않은 조회용 실행은 예전처럼 상대 창을 쓴다.
  assert.equal(trendSearchWindow({ mode: 'lookback', lookbackDays: 30 }), 'when:30d');
  assert.equal(trendSearchWindow({ mode: 'explicit', fromDate: '', toDate: '', lookbackDays: 45 }), 'when:45d');
  assert.equal(trendSearchWindow(undefined), 'when:45d');
});

test('no latin technology term means no query and no request', () => {
  const koreanOnly = { groups: { g: { keywords: ['비전센서', '머신비전'] } } };
  const query = buildTrendQuery(company, { technology_group: 'g', target_technology: '3D 비전센서' }, koreanOnly, august);
  assert.equal(query, '');
});

test('keywords come from the group list and the mapped technology, without duplicates', () => {
  const terms = trendKeywords(technology, keywordConfig);
  assert.equal(terms[0], 'non-ferrous scrap utilisation');
  assert.ok(terms.includes('스크랩'), 'the pre-filter still reads Korean terms');
  assert.equal(new Set(terms.map(t => t.toLowerCase())).size, terms.length);
  assert.deepEqual(trendKeywords(null, keywordConfig), []);
  assert.deepEqual(trendKeywords({ technology_group: 'unknown' }, keywordConfig), []);
});

test('the pre-filter keeps only articles whose title or snippet names the technology', () => {
  const terms = trendKeywords(technology, keywordConfig);
  assert.deepEqual(matchedTrendKeywords(row(), terms), ['recycled aluminium', 'post-consumer scrap']);
  // 회사명만 맞는 기사는 버린다. Google 은 OR 를 느슨하게 해석해 이런 기사를 함께 준다.
  assert.deepEqual(matchedTrendKeywords(row({ title: 'Hydro reports second quarter results',
    discovery_snippet: 'Revenue rose on higher prices' }), terms), []);
  // 제목에만 있어도 받는다.
  assert.deepEqual(matchedTrendKeywords(row({ title: 'Hydro expands aluminium recycling in Michigan',
    discovery_snippet: '' }), terms), ['aluminium recycling']);
  assert.deepEqual(matchedTrendKeywords(row({ title: '', discovery_snippet: '' }), terms), []);
});

test('a two-character term never matches, so short keywords cannot open the gate', () => {
  assert.deepEqual(matchedTrendKeywords(row({ title: 'AI at Hydro' }), ['AI']), []);
});

test('a generic single term matches a word, not part of another word', () => {
  assert.deepEqual(matchedTrendKeywords(row({ title: 'Cars made from post-consumer scrap', discovery_snippet: '' }),
    ['scrap']), ['scrap']);
  assert.deepEqual(matchedTrendKeywords(row({ title: 'Mercedes builds EVs from scrapped cars', discovery_snippet: '' }),
    ['scrap']), []);
});

test('an article already collected for the company is not added again', () => {
  const existing = [{ url: 'https://www.hydro.com/news/circal?utm_source=rss', title: 'Hydro brings high-recycled aluminium to GM' }];
  // 같은 주소는 추적 파라미터만 달라도 같은 기사다.
  assert.equal(isDuplicateTrendRow(row({ url: 'https://www.hydro.com/news/circal' }), existing), true);
  // 주소가 달라도 제목이 같으면 중계 링크와 원문이라 한 기사다.
  assert.equal(isDuplicateTrendRow(row(), existing), true);
  assert.equal(isDuplicateTrendRow(row({ title: 'Hydro signs a power contract with Statkraft' }), existing), false);
  // 짧은 제목은 우연히 겹칠 수 있어 제목만으로 버리지 않는다.
  assert.equal(isDuplicateTrendRow({ url: 'https://example.com/x', title: 'Hydro news' },
    [{ url: '', title: 'Hydro news' }]), false);
});

test('selection filters, dedupes and stops at the per-company cap', () => {
  const terms = trendKeywords(technology, keywordConfig);
  const existing = [{ url: 'https://www.hydro.com/news/circal', title: 'Already collected press release' }];
  const found = [
    row({ title: 'Hydro reports second quarter results', url: 'https://example.com/1',
      discovery_snippet: 'Revenue rose on higher prices' }),
    row({ title: 'Hydro brings recycled aluminium to GM', url: 'https://example.com/2' }),
    row({ title: 'Already collected press release', url: 'https://www.hydro.com/news/circal',
      discovery_snippet: 'post-consumer scrap' }),
    row({ title: 'Hydro expands aluminium recycling in Michigan', url: 'https://example.com/4' }),
    row({ title: 'Hydro opens a scrap utilisation line', url: 'https://example.com/5' }),
  ];
  const selected = selectTrendRows(found, existing, terms, 2);
  assert.equal(selected.length, 2, 'the cap holds');
  assert.deepEqual(selected.map(item => item.url), ['https://example.com/2', 'https://example.com/4']);
  // 왜 뽑혔는지 행에 남는다. 이 값은 판정에 쓰이지 않고 사람이 되짚을 때만 쓴다.
  assert.equal(selected[0].trend_discovery, true);
  assert.ok(selected[0].trend_matched_terms.length > 0);
  // 같은 결과에서 두 번 고르지 않는다.
  const twice = selectTrendRows([found[1], found[1]], existing, terms, 2);
  assert.equal(twice.length, 1);
  assert.deepEqual(selectTrendRows(found, existing, terms, 0), []);
});

// 키워드 목록은 일부러 넓어서 "scrap" 하나로도 통과한다. 자리가 둘뿐이므로 구체적으로 맞은 기사를 먼저 쓴다.
test('the limited slots go to the most specific matches, not the first results', () => {
  const terms = ['scrap', 'recycling', 'post-consumer scrap', 'recycled aluminium'];
  const found = [
    { title: 'Scrap prices ease across Europe', url: 'https://example.com/generic', discovery_snippet: '' },
    { title: 'Hydro supplies recycled aluminium made with post-consumer scrap',
      url: 'https://example.com/specific', discovery_snippet: '' },
  ];
  assert.deepEqual(selectTrendRows(found, [], terms, 1).map(item => item.url), ['https://example.com/specific']);
  // 넓은 기사도 자리가 남으면 후보로 남는다. 최종 판정은 LLM 이 한다.
  assert.equal(selectTrendRows(found, [], terms, 2).length, 2);
});

test('the collection identity carries the discovery inputs, and drops them when discovery is off', () => {
  // 2026-08 전수 probe 뒤 비용 상한을 1건으로 확정했다(최종 로직 31개 후보).
  assert.equal(TREND_DISCOVERY_PER_COMPANY, 1);
  const on = trendDigestInputs({ maxTrendDiscovery: 2 }, technology, keywordConfig);
  assert.equal(on.maxTrendDiscovery, 2);
  assert.equal(on.keywordConfig, keywordConfig);
  // 키워드를 고치면 식별자가 달라져 캐시된 수집을 다시 돈다.
  const edited = trendDigestInputs({ maxTrendDiscovery: 2 }, technology,
    { groups: { nonferrous_scrap_recycling: { keywords: ['recycled aluminium'] } } });
  assert.notEqual(JSON.stringify(on), JSON.stringify(edited));
  assert.equal(trendDigestInputs({ maxTrendDiscovery: 0 }, technology, keywordConfig), null);
});

// 질의어 여섯 자리는 설정 파일 순서가 아니라 구체성으로 채운다. 카탈로그가 일부러 넓어서,
// "scrap" 같은 일반어가 앞자리를 차지하면 그 회사의 아무 기사나 걸려 자리를 낭비한다.
test('query terms are ranked by specificity, not by config order', () => {
  const keywords = ['scrap', 'PEM', 'recycled aluminium', 'remelting', 'recycling', 'closed loop recycling'];
  assert.deepEqual(rankTrendQueryTerms(keywords),
    ['recycled aluminium', 'closed loop recycling', 'remelting', 'scrap', 'PEM', 'recycling']);
});

test('generic single words and short acronyms rank last', () => {
  // 등급 3: 일반어와 짧은 대문자 약어. 앞 등급으로 자리가 차지 않을 때만 쓴다.
  for (const term of ['scrap', 'recycling', 'PEM', 'AEM', 'EUV']) assert.equal(trendTermRank(term), 3, term);
  // 등급 2: 한 낱말이되 분야어.
  for (const term of ['remelting', 'electrodialysis']) assert.equal(trendTermRank(term), 2, term);
  // 등급 1: 두 낱말 이상의 구.
  for (const term of ['recycled aluminium', 'machine vision']) assert.equal(trendTermRank(term), 1, term);
  // 등급 0: 기업별로 손으로 적은 검색어. 대소문자는 가리지 않는다.
  assert.equal(trendTermRank('scrap', ['SCRAP']), 0);
});

test('the same keywords always produce the same query order', () => {
  const keywords = ['alpha beta', 'gamma delta', 'epsilon'];
  assert.deepEqual(rankTrendQueryTerms(keywords), rankTrendQueryTerms(keywords));
  // 같은 등급이면 원래 순서를 지켜 질의가 실행마다 흔들리지 않는다.
  assert.deepEqual(rankTrendQueryTerms(['aa bb', 'cc dd']), ['aa bb', 'cc dd']);
});

test('selection prioritizes curated terms and demotes generic and generated terms', () => {
  const keywords = ['generated technology phrase', 'scrap', 'PEM', 'machine vision', 'remelting', 'recycling'];
  assert.deepEqual(selectTrendQueryTerms(keywords, ['remelting'], 4, ['generated technology phrase']),
    ['remelting', 'machine vision', 'scrap', 'PEM']);
  assert.equal(trendTermRank('generated technology phrase', [], ['generated technology phrase']), 4);
});

// 카탈로그는 기술 그룹 단위라 제품명·시장 표현을 담지 못한다. Norsk Hydro 의 8월 기사가 그 틈으로 빠졌다:
// 외부 보도 제목이 "recycled alu alloy" 였고 그룹 키워드에는 그 표현도 미국식 철자도 없었다.
test('per-company search terms lead the query and open the pre-filter', () => {
  const searchTerms = { companies: { 'Norsk Hydro':
    ['Hydro CIRCAL', 'recycled aluminium', 'recycled aluminum', 'recycled alu'] } };
  const query = buildTrendQuery(company, technology, keywordConfig, august, searchTerms);
  // 기업별 제품명으로 범위를 좁힌 경우에는 짧은 별칭도 복원한다. 목표 기사 제목은 Norsk Hydro가
  // 아니라 "Hydro brings ... Hydro CIRCAL"로 시작한다.
  assert.match(query, /^\("Norsk Hydro" OR "Hydro"\) \(/);
  for (const term of ['Hydro CIRCAL', 'recycled aluminium', 'recycled aluminum', 'recycled alu']) {
    assert.ok(query.includes(`"${term}"`), term);
  }
  // 사전 필터도 같은 말을 받는다. 그래야 그 기사가 실제로 후보가 된다.
  const terms = trendKeywords(technology, keywordConfig, company, searchTerms);
  assert.deepEqual(matchedTrendKeywords({ title: 'GM commits to Circal recycled alu alloy' }, terms), ['recycled alu']);
  // 다른 기업의 검색어는 가져오지 않는다.
  assert.deepEqual(companySearchTerms({ company: 'Jenoptik' }, searchTerms), []);
  // 파일이 없어도 카탈로그만으로 그대로 돈다.
  assert.deepEqual(companySearchTerms(company, null), []);
  assert.ok(buildTrendQuery(company, technology, keywordConfig, august, null).length > 0);
});

test('the collection identity also covers the per-company search terms', () => {
  const base = trendDigestInputs({ maxTrendDiscovery: 2 }, technology, keywordConfig, { companies: {} });
  const edited = trendDigestInputs({ maxTrendDiscovery: 2 }, technology, keywordConfig,
    { companies: { 'Norsk Hydro': ['CIRCAL'] } });
  assert.notEqual(JSON.stringify(base), JSON.stringify(edited));
});
