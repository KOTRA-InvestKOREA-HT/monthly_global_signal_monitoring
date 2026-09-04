import assert from "node:assert/strict";
import test from "node:test";

import { indicatorProximity } from "../scripts/classify_investment_signals.mjs";
import { renderShadowReport } from "../scripts/report_proximity_shadow.mjs";

// 지표 용어가 기사 어딘가에 있기만 해도 점수가 붙는 탓에, 상용문구 한 줄로 시그널이 생긴다.
// 이 규칙은 그 용어가 회사를 가리키는 문장 안에 있는지를 본다.
test("an indicator term in the same sentence as the company counts as near", () => {
  const signal = {
    company: "Nexeon",
    content_text: "Nexeon will expand its Gunsan plant capacity next year. Unrelated closing paragraph.",
  };
  const result = indicatorProximity(signal, ["expand"]);
  assert.equal(result.near, true);
  assert.match(result.sentence, /Nexeon will expand/);
});

test("an indicator term in a different sentence than the company does not count", () => {
  const signal = {
    company: "Nexeon",
    content_text: "Nexeon reported quarterly results. The industry will expand through 2030.",
  };
  assert.equal(indicatorProximity(signal, ["expand"]).near, false);
});

// 실제로 걸러내고 싶었던 것: 네비게이션과 상용문구에 섞인 지표 용어.
test("boilerplate that never names the company is filtered out", () => {
  const signal = {
    company: "Cytiva",
    title: "Industry outlook",
    content_text: "Home About Investment Careers\nOur customers plan capacity expansion worldwide.",
  };
  assert.equal(indicatorProximity(signal, ["expansion", "investment"]).near, false);
});

test("the headline counts as evidence, not only the body", () => {
  const signal = { company: "Umicore", title: "Umicore announces new plant investment", content_text: "" };
  assert.equal(indicatorProximity(signal, ["investment"]).near, true);
});

// 회사명은 넓게 잡는다. 좁게 잡아 놓치면 진짜 시그널이 사라지고, 넓게 잡아 남는 것은 뒤에서
// 판정을 받는다. 틀릴 때 남는 쪽으로 틀려야 한다.
test("a single token of a multi-word company name is enough to identify it", () => {
  const signal = {
    company: "Australian Strategic Metals",
    content_text: "Strategic has committed to a new refinery investment in Korea.",
  };
  assert.equal(indicatorProximity(signal, ["investment"]).near, true);
});

test("rows with no matched terms or no company are never called near", () => {
  assert.equal(indicatorProximity({ company: "Nexeon", content_text: "Nexeon will expand." }, []).near, false);
  assert.equal(indicatorProximity({ company: "", content_text: "will expand" }, ["expand"]).near, false);
});

test("a row without any text is not treated as evidence", () => {
  assert.equal(indicatorProximity({ company: "Nexeon" }, ["expand"]).near, false);
});

// 규칙을 켤지 판단하려면 "얼마나 줄어드는가"와 "무엇이 사라지는가"가 같이 보여야 한다.
test("the shadow report names what would have been dropped", () => {
  const report = renderShadowReport({
    indicator_proximity: {
      mode: "shadow",
      evaluated: 109,
      near_company: 55,
      far_from_company: 54,
      would_drop: [{ company: "HyproMag", indicator: "공급망·지정학 리스크 대응", score: 9, title: "Welcome to Mkango" }],
    },
  });
  assert.match(report, /54건\(50%\)/);
  assert.match(report, /HyproMag/);
  assert.match(report, /Welcome to Mkango/);
});

test("a pipe in a headline does not break the table", () => {
  const report = renderShadowReport({
    indicator_proximity: { mode: "shadow", evaluated: 1, near_company: 0, far_from_company: 1, would_drop: [{ company: "A", title: "x | y" }] },
  });
  assert.match(report, /x \\\| y/);
});

test("enforce mode reports what it removed and lists nothing", () => {
  const report = renderShadowReport({
    indicator_proximity: { mode: "enforce", evaluated: 109, near_company: 55, far_from_company: 54, would_drop: [] },
  });
  assert.match(report, /적용됨/);
  assert.doesNotMatch(report, /\| 기업 \|/);
});

test("a summary without the record explains itself instead of throwing", () => {
  assert.match(renderShadowReport({}), /판정 기록이 없습니다/);
  assert.match(renderShadowReport({ indicator_proximity: { mode: "off" } }), /꺼져 있습니다/);
});
