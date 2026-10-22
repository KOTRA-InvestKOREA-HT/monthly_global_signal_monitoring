// 뷰 모델 → renderReport 를 끝까지 돌려 쪽별 글자를 고정한다.
//
// tests/test_report_snapshot.py 가 픽스처로 만든 뷰 모델(expected_view_model_*.json)을 고정하고, 여기서는
// 그 JSON 을 실제 보고서와 같은 HTML 로 그려 쪽마다 찍히는 글자를 expected_pages_*.txt 와 대조한다.
// 뷰 모델의 키 이름이 바뀌면 HTML 은 오류 없이 빈칸이나 "undefined"를 찍는다. 그것을 여기서 잡는다.
// 품목 카드의 장 나눔은 Chrome 이 잰 높이로 정하므로 여기서는 나누지 않은 한 장으로 그린다.
//
// 규칙을 바꿔 출력이 달라졌으면 기대값을 다시 만들고 그 차이를 커밋에 남긴다.
//   UPDATE_REPORT_SNAPSHOT=1 node --test tests/report_snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderReport } from '../scripts/report_html.mjs';

const FIXTURES = path.resolve('tests/fixtures/report_snapshot');
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const BLOCK_END = /<\/(?:p|li|h1|h2|h3|tr|th|header|footer|div|article|section|ol|ul)>|<br\s*\/?>/gi;

// 쪽마다 사람이 읽는 글자만. 블록이 끝나는 자리에서 줄을 바꾸고, 줄 안의 공백은 하나로 접는다.
// 머리글의 자간 공백("S I G N A L")도 접히지만 쪽끼리 비교하는 데는 지장이 없다.
export function pageTexts(html) {
  return html.split('<section class="page').slice(1).map(section => section
    .replace(/^[^>]*>/, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/\s+/g, ' ')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity])
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n'));
}

const joinPages = texts => texts.map((text, index) => `===== PAGE ${index + 1} =====\n${text}\n`).join('\n');

async function model(lang) {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, `expected_view_model_${lang}.json`), 'utf8'));
}

for (const lang of ['ko', 'en']) {
  test(`the ${lang} report prints the same text on every page`, async () => {
    const actual = joinPages(pageTexts(renderReport(await model(lang))));
    const file = path.join(FIXTURES, `expected_pages_${lang}.txt`);
    if (process.env.UPDATE_REPORT_SNAPSHOT === '1') await fs.writeFile(file, actual, 'utf8');
    // 체크아웃이 줄끝을 CRLF 로 바꿔도(core.autocrlf) 같은 글자로 본다.
    assert.equal(actual, (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n'));
  });

  // 스냅샷을 다시 찍어도 통과하지 못하게, 뷰 모델의 값이 실제로 쪽에 찍혔는지 따로 본다.
  test(`every ${lang} view-model text reaches the page it belongs on`, async () => {
    const vm = await model(lang);
    const pages = pageTexts(renderReport(vm));
    const all = pages.join('\n');
    for (const missing of ['undefined', 'null', 'NaN', '[object Object]']) assert.ok(!all.includes(missing), missing);
    const squash = value => String(value).replace(/\s+/g, ' ').trim();
    const printed = (page, value) => assert.ok(pages[page].includes(squash(value)), `page ${page + 1} lacks ${value}`);
    printed(0, vm.issue.label);
    vm.cover.titles.forEach(title => printed(0, title));
    vm.cover.indicators.forEach(item => { printed(0, item.label); printed(0, item.description); });
    printed(1, vm.matrix.title);
    printed(1, vm.matrix.footnote);
    vm.matrix.rows.forEach(row => printed(1, row.company));
    vm.details.pages.forEach((entry, index) => {
      const page = 2 + index;
      printed(page, vm.footer);
      printed(page, entry.company);
      if (entry.business) {
        printed(page, entry.business.body);
        printed(page, entry.business.source);
      }
      for (const signal of entry.signals) {
        printed(page, signal.label);
        printed(page, signal.active ? (signal.headline || signal.plain) : signal.empty);
        if (signal.active) { printed(page, signal.source); if (signal.detail) printed(page, signal.detail); }
      }
    });
    const itemPage = 2 + vm.details.pages.length;
    printed(itemPage, vm.items.title);
    vm.items.cards.forEach(card => { printed(itemPage, card.company); printed(itemPage, card.body); printed(itemPage, card.source); });
    assert.equal(pages.length, itemPage + 1);
  });
}
