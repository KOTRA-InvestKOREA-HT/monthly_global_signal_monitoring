// 리디렉트되는 공식 목록 페이지의 상대 링크. 2026-09 수집(4호)에서 설정의 www.asml.com/en/news 가
// investor.asml.com/news(Q4 IR 플랫폼)로 넘어갔는데, 수집기는 그 페이지의 "/news-releases/news-release-details/..."
// 링크를 설정 주소(www.asml.com) 기준으로 풀었다. ASML 공식 기사 10건이 모두 없는 주소(404)가 됐다.
// 네트워크 없이 가짜 fetch 로 같은 상황을 만든다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCompany, fetchPage, pageBaseUrl, parseArgs } from '../scripts/collect_company_signals.mjs';

const company = { target_no: 28, company: 'ASML', query_aliases: [] };
const configured = 'https://www.asml.com/en/news';
const landed = 'https://investor.asml.com/news';
const slug = 'intel-foundry-and-asml-collaborate-accelerate-industry-readiness-high-na-euv';
const title = 'Intel Foundry and ASML Collaborate to Accelerate Industry Readiness for High-NA EUV';
const sourceConfig = { official_pages: { ASML: [{ url: configured, source: 'ASML - ASML News / Newsroom / News' }] } };
const dateRange = { mode: 'explicit', fromDate: '2026-09-01', toDate: '2026-09-30', from_date: '2026-09-01',
  to_date: '2026-09-30', fromMs: Date.parse('2026-09-01T00:00:00Z'), toMs: Date.parse('2026-09-30T23:59:59Z'), lookbackDays: 45 };
const args = { ...parseArgs([]), rateLimitSeconds: 0, timeoutSeconds: 5, maxPerSource: 6, maxPerCompany: 10, maxDetailPerCompany: 3 };
const trend = { technologyMap: { companies: [] }, keywordConfig: { groups: {} }, searchTerms: {} };
const always = (url, request) => request();

// Q4 플랫폼 목록처럼 호스트 없는 경로로 기사를 건다.
const listing = `<html><body><ul>
  <li><span>September 8, 2026</span> <a href="/news-releases/news-release-details/${slug}">${title}</a></li>
</ul></body></html>`;
const article = `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>
  <p>September 8, 2026 - ${'Intel Foundry and ASML agreed to work together on High-NA EUV readiness for volume manufacturing. '.repeat(8)}</p>
  </article></body></html>`;

// 실제 fetch 는 리디렉트를 따라간 뒤 response.url 에 최종 주소를 싣는다. 직접 만든 Response 는 url 이 빈 문자열이라 덮어쓴다.
function redirected(body, finalUrl) {
  const response = new Response(body);
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}

function fakeNetwork() {
  const requested = [];
  const fetch = async (url) => {
    url = String(url);
    requested.push(url);
    if (url === configured) return redirected(listing, landed);
    if (url === `https://investor.asml.com/news-releases/news-release-details/${slug}`) return new Response(article);
    return new Response('not found', { status: 404 });
  };
  return { fetch, requested };
}

async function withNetwork(network, task) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try { return await task(); } finally { globalThis.fetch = realFetch; }
}

test('relative links resolve against the page the server actually returned', () => {
  assert.equal(pageBaseUrl(configured, landed), landed);
  // 직접 만든 응답처럼 주소가 비었거나 http 가 아니면 요청 주소를 쓴다.
  assert.equal(pageBaseUrl(configured, ''), configured);
  assert.equal(pageBaseUrl(configured, undefined), configured);
  assert.equal(pageBaseUrl(configured, 'about:blank'), configured);
});

test('fetchPage reports the final URL after redirects', async () => {
  const page = await withNetwork(fakeNetwork(), () => fetchPage(configured, 5));
  assert.equal(page.url, landed);
  assert.match(page.text, /news-release-details/);
});

test('an official page that redirects to another host keeps article links on that host', async () => {
  const network = fakeNetwork();
  const result = await withNetwork(network, () =>
    collectCompany(company, sourceConfig, ['official_pages'], args, dateRange, '2026-10-13T07:00:00Z', { probe: always, trend }));
  const rows = result.rows.filter((row) => row.collector === 'official_page');
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.url, `https://investor.asml.com/news-releases/news-release-details/${slug}`);
  assert.equal(row.source_direct_url, row.url);
  assert.equal(row.content_fetch_status, 'fetched');
  // 행이 어느 설정 출처에서 왔는지는 설정 주소로 남는다.
  assert.equal(row.query, configured);
  assert.equal(row.official_source_url, configured);
  // 설정 호스트 위로 잘못 붙인 주소는 요청하지 않는다.
  assert.ok(!network.requested.some((url) => url.startsWith('https://www.asml.com/news-releases/')));
  assert.deepEqual(result.errors, []);
});
