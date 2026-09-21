import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APPROVAL_POLICY, validateRows } from '../scripts/validate_report_inputs.mjs';

// 승인 규칙은 판정·검증(JS)과 발행(Python)에 각각 구현돼 있다. 상수는 이제
// config/approval_policy.json 하나에서 오지만 규칙을 읽는 코드는 여전히 둘이라,
// 한쪽만 고치면 검증을 통과한 행을 발행 단계가 말없이 떨어뜨린다. 지표 3·5 의 품목
// 연결 해제 때도 네 곳을 함께 고쳐야 했다. 같은 입력에 같은 답이 나오는지 직접 맞춘다.

const PYTHON = process.env.PYTHON || process.env.PYTHON_PATH || 'python';

// 두 구현이 같은 질문에 답하도록 입력을 맞춘다. JS 검증은 승인 행에 한·영 문안을 요구하지만
// Python 의 signal_supported 는 문안을 보지 않는다(그쪽은 signal_publishable 이 따로 본다).
// 문안은 항상 채워 두고, 근거 판정만 비교한다.
function row(overrides = {}) {
  return {
    company: 'Example',
    title: 'Example announces a financing',
    url: 'https://example.com/news/financing',
    ai_summary_ko: '자금 조달 발표 - 구체적 상세',
    ai_summary_en: 'Financing announced - concrete detail',
    ai_summary_reason: '기업과 지표 사건이 본문에서 직접 확인됨',
    ai_summary_quality: 'pass',
    ai_signal_supported: true,
    ai_entity_supported: true,
    ai_target_technology_supported: true,
    ai_indicator_supported: true,
    ai_leading_indicator_supported: true,
    ai_event_stage: 'exploratory',
    ...overrides,
  };
}

const STAGES = ['exploratory', 'planned', 'precursor', 'committed', 'completed', 'not_applicable', 'unclear'];
const DENIAL_REASON = '지표 사건은 확인되나 타겟 기술과의 직접적 연계성은 확인되지 않음';

function matrix() {
  const rows = [];
  // 사업동향(지표 번호 없음)과 다섯 지표를 모두 돈다.
  for (const no of [undefined, 1, 2, 3, 4, 5]) {
    for (const stage of STAGES) {
      for (const tech of [true, false]) {
        for (const exemption of [null, { excluded_from_relevance: true }, { technology_gate_decision: 'relevance_exempt' }]) {
          const base = { investment_signal_no: no, ai_event_stage: stage, ai_target_technology_supported: tech, ...(exemption || {}) };
          rows.push(row(base));
          rows.push(row({ ...base, ai_summary_reason: DENIAL_REASON }));
          // 승인되지 않은 근접 후보도 양쪽이 똑같이 제외해야 한다.
          rows.push(row({ ...base, ai_signal_supported: false, ai_summary_ko: '', ai_summary_en: '' }));
          for (const field of ['ai_entity_supported', 'ai_indicator_supported', 'ai_leading_indicator_supported']) {
            rows.push(row({ ...base, [field]: false }));
          }
          rows.push(row({ ...base, ai_summary_quality: 'needs_review' }));
        }
      }
    }
  }
  return rows;
}

function jsApproved(item) {
  const kind = item.investment_signal_no === undefined ? 'relevant' : 'investment';
  return item.ai_signal_supported === true && validateRows([item], kind).length === 0;
}

test('the JavaScript and Python approval rules agree on every input', async t => {
  const rows = matrix();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-parity-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const inputFile = path.join(temp, 'rows.json');
  await fs.writeFile(inputFile, JSON.stringify(rows));

  const script = [
    'import json, sys',
    'from pathlib import Path',
    'sys.path.insert(0, str(Path("scripts").resolve()))',
    'import build_pdf_report as pdf',
    'rows = json.load(open(sys.argv[1], encoding="utf-8"))',
    'print(json.dumps([bool(pdf.signal_supported(r)) for r in rows]))',
  ].join('\n');
  const result = spawnSync(PYTHON, ['-c', script, inputFile], { encoding: 'utf8' });
  if (result.status !== 0) {
    // reportlab 이 없는 환경에서는 발행 쪽을 부를 수 없다. 조용히 통과시키지 않고 건너뛴 것을 남긴다.
    t.skip(`Python approval rule unavailable: ${(result.stderr || result.error?.message || '').trim().split('\n').at(-1)}`);
    return;
  }

  const python = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(python.length, rows.length);
  const disagreements = rows
    .map((item, index) => ({ item, js: jsApproved(item), py: python[index] }))
    .filter(({ js, py }) => js !== py)
    .map(({ item, js, py }) => `${JSON.stringify({
      no: item.investment_signal_no, stage: item.ai_event_stage, tech: item.ai_target_technology_supported,
      exempt: item.excluded_from_relevance === true || item.technology_gate_decision === 'relevance_exempt',
      supported: item.ai_signal_supported, quality: item.ai_summary_quality,
    })} js=${js} python=${py}`);
  assert.deepEqual(disagreements, [], `${disagreements.length}/${rows.length} inputs judged differently`);

  // 빈 비교가 통과로 보이지 않도록, 두 답이 모두 참인 경우와 모두 거짓인 경우가 있었는지 본다.
  assert.ok(python.some(Boolean), 'the matrix must contain approvals');
  assert.ok(python.some(value => !value), 'the matrix must contain rejections');
});

// 상수가 한 파일에서 오는지도 확인한다. 값을 도로 코드에 적어 넣으면 이 테스트만으로는
// 두 구현이 갈라진 것을 못 잡는다.
test('both implementations read the approval constants from the shared config', async () => {
  assert.deepEqual(APPROVAL_POLICY.company_level_indicators, [3, 5]);
  const js = await fs.readFile('scripts/validate_report_inputs.mjs', 'utf8');
  const py = await fs.readFile('scripts/build_pdf_report.py', 'utf8');
  assert.match(js, /approval_policy\.json/);
  assert.match(py, /approval_policy\.json/);
  // 예전에 양쪽에 흩어져 있던 값들이 코드로 되돌아오지 않았는지 본다.
  for (const source of [js, py]) {
    assert.doesNotMatch(source, /\[1,\s*3,\s*4,\s*5\]|\{"1",\s*"3",\s*"4",\s*"5"\}/);
    assert.doesNotMatch(source, /no direct \(\?:evidence/);
  }
});
