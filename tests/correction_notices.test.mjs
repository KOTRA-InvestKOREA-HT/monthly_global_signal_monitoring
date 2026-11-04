import assert from 'node:assert/strict';
import test from 'node:test';
import { correctionsLast, orderPageRows, trimByRank } from '../scripts/collect_company_signals.mjs';

// 2026-09 Nabtesco 피드: 9/30 정정 공시들이 맨 위를 채워 9/15 감속기 보도자료가 출처당 상한에서 잘렸다.
const notices = [
  '(Correction / Numerical Data Correction) Regarding a Partial Correction of the Summary',
  'Notice Regarding Submission of Amendments to Internal Control Reports',
  'Notice of Filing Amended Annual Securities Reports and Amended Quarterly Reports',
  '「決算短信」の一部訂正について',
];
const release = 'First-Generation Precision Reduction Gear RV Registered as a "Future Technology Heritage"';

test('correction notices move behind other items without being dropped', () => {
  const rows = [...notices.map(title => ({ title })), { title: release }, { title: 'Investment in LOMBY Inc.' }];
  const ordered = correctionsLast(rows).map(row => row.title);
  assert.deepEqual(ordered.slice(0, 2), [release, 'Investment in LOMBY Inc.']);
  assert.equal(ordered.length, rows.length);
  assert.deepEqual(correctionsLast(rows).slice(0, 2).map(row => row.title), ordered.slice(0, 2));
});

test('ordinary titles that mention corrections or amendments keep their place', () => {
  const rows = [{ title: 'Company completes acquisition' }, { title: 'New corrective lens coating launched' },
    { title: 'Shareholders approve amendment to articles' }];
  assert.deepEqual(correctionsLast(rows), rows);
});

test('page and company caps prefer releases over correction notices at the same rank', () => {
  const rows = [...notices.map(title => ({ title, link_rank: 0 })), { title: release, link_rank: 0 }];
  assert.equal(trimByRank(rows, 1)[0].title, release);
  assert.equal(orderPageRows(rows.map(row => ({ ...row, published_at: '2026-09-15' })))[0].title, release);
  // 링크 순위가 먼저다.
  assert.equal(trimByRank([{ title: notices[0], link_rank: 0 }, { title: release, link_rank: 1 }], 1)[0].title, notices[0]);
});

// 공식 출처의 정례 공지(실적 발표 일정·배당·지분 공시)도 같은 출처 안에서 뒤로 간다. 버리지는 않는다.
// 공식 제목은 소문자 URL 조각인 경우가 많다. 실적 발표 자체("dow reports ...")는 제자리에 있다.
test('official routine notices move behind releases but before correction notices, and stay', () => {
  const rows = [{ title: 'dow to report third quarter 2026 results on october 23' }, { title: notices[0] },
    { title: 'dow reports third quarter 2026 results' }, { title: 'Umicore: Disclosure of transactions in own shares' },
    { title: 'ouster acquires stereolabs to expand into vision' }];
  assert.deepEqual(correctionsLast(rows).map(row => row.title), ['dow reports third quarter 2026 results',
    'ouster acquires stereolabs to expand into vision', 'dow to report third quarter 2026 results on october 23',
    'Umicore: Disclosure of transactions in own shares', notices[0]]);
  assert.equal(trimByRank(rows.map(row => ({ ...row, link_rank: 0 })), 2).map(row => row.title)
    .includes('dow to report third quarter 2026 results on october 23'), false);
});
