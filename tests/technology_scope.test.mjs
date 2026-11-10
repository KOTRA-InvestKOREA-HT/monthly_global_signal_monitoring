// 2026-10 판정: Renishaw 의 Miskin 공장 1단계 완공(엔코더 생산 증설)이 "위치 엔코더라 리니어 스케일이 아니다"로 품목 무관 처리됐다.
// 리니어 스케일은 리니어 엔코더이고 위치 측정 엔코더 제품군에 속한다. 그 범위를 판정 모델에 넘긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TECHNOLOGY_SCOPES } from '../scripts/local_report.mjs';
import { modelTechnologyScope } from '../scripts/model_input.mjs';

test('the linear-scale group tells the model that linear encoders and encoder lines are the target', async () => {
  const scope = modelTechnologyScope(TECHNOLOGY_SCOPES.linear_scale);
  assert.ok(scope, 'linear_scale scope is configured');
  assert.match(scope.includes, /linear encoders/i);
  assert.match(scope.includes, /position-encoder product line/i);
  assert.match(scope.excludes, /coordinate measuring machines/i);
  assert.match(scope.excludes, /additive manufacturing/i);
  // 범위는 기술 그룹으로 붙는다. 두 기업 모두 이 그룹이다.
  const map = JSON.parse(await fs.readFile('data/company_technology_map.json', 'utf8'));
  const linear = map.companies.filter(company => company.technology_group === 'linear_scale').map(company => company.company).sort();
  assert.deepEqual(linear, ['Heidenhain', 'Renishaw']);
});
