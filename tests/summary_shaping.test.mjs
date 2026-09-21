import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// 출력 단계는 승인된 문안을 다시 쓰지 않는다. 예전에는 화면과 PDF 가 각자 조사·연결어미를 지워
// "생산 능력을 확대하고 있으며"가 "확대 있으며"가 되고, 문장 사이 마침표가 쉼표로 바뀌어 세 문장이
// 한 줄로 붙었다. 저장된 투자 시그널 8건이 모두 화면에서 달라져 있었다. 규칙이 돌아오면 잡는다.
// 동작 자체는 tests/test_pdf_layout.py 의 KoreanShapingTests 가 문장으로 확인한다.

const DELETED_RULES = [
  // 연결어미를 지워 두 절을 붙이던 표(체결하고 → 체결).
  { pattern: /"체결하고":\s*"체결"|체결하고.*체결/, name: 'connector map' },
  // 관형형 어미 삭제("강화하는 기술" → "강화 기술").
  { pattern: /하는\\s\+/, name: 'relative-clause ending deletion' },
  // 목적격·부사격 조사 삭제("계약을 체결" → "계약 체결").
  { pattern: /\(을\|를\)\\s\+\(발표\|공개/, name: 'object particle deletion' },
  // 문장과 절로 쪼갠 뒤 쉼표로 다시 이어 붙이던 처리. 세 문장이 한 줄이 됐다.
  { pattern: /\\s\*;\\s\*/, name: 'clause split and comma rejoin' },
  // 로마자 이름 뒤 관형격 조사 삭제("National Wealth Fund의" → "National Wealth Fund").
  { pattern: /\[A-Za-z0-9\(\)\.·&\/-\]\*\)의/, name: 'genitive particle deletion' },
];

const SOURCES = [
  ['app/page.jsx', 'the dashboard'],
  ['scripts/report_content.py', 'the report content layer'],
];

for (const [file, label] of SOURCES) {
  test(`${label} no longer rewrites approved Korean prose`, async () => {
    const source = await fs.readFile(file, 'utf8');
    for (const { pattern, name } of DELETED_RULES) {
      assert.doesNotMatch(source, pattern, `${file} brought back the ${name}`);
    }
  });
}

test('the dashboard shows the detail body as written and only trims it to width', async () => {
  const source = await fs.readFile('app/page.jsx', 'utf8');
  // 상세는 표제용 정리를 거치지 않는다. compactSummaryPhrase 가 다시 상세에 걸리면 안 된다.
  assert.match(source, /function compactSummaryDetail/);
  assert.doesNotMatch(source, /detail: compactSummaryPhrase|const detail = compactSummaryPhrase/);
  // 사업동향은 예전부터 원문 그대로 싣는다.
  assert.match(source, /function BusinessSummaryText[\s\S]{0,200}normalizeSummaryText\(item\?\.ai_summary_ko\)/);
});

// 관형형 어미 앞의 "하/되"를 조사로 읽으면 상대방이 지워진다("오션윈즈와 협력하는 …" → "…").
// 행동의 주인이 달라지므로 두 구현이 같은 예외를 둬야 한다.
test('both implementations refuse to read a relative-clause ending as a subject particle', async () => {
  for (const [file] of SOURCES) {
    const source = await fs.readFile(file, 'utf8');
    assert.match(source, /\(\?<!\[하되\]\)/, `${file} must guard the subject particle`);
  }
});
