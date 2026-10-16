# 영문 보고서 1페이지 이해도 검토 — 2026-10-16

## 대상과 결론

현재 로컬의 latest JSON과 보고서 생성 코드를 사용해 2026년 10월호(9월 1~30일 대상), Issue 4 영문 PDF를 재생성했다. 새 기사 수집이나 AI 재판정은 하지 않았다. 산출물은 `outputs/readability_review_2026-10-16/report_en.pdf`이며 1페이지의 문구를 평가했다.

**초6~중학생이 설명 없이 이해할 수 있는 영어라는 기준에는 미달한다.** 문법이 복잡해서라기보다 금융·기업전략 전문용어, 설명 없는 약어, 명사 나열이 원인이다. 영어권 해당 학년 독자에게도 배경지식이 필요하며, 한국의 일반 초6~중학생 영어 학습자라면 더 어렵다고 판단한다. 이는 문구를 대상으로 한 정성 평가이며 학생 독해 실험이나 표준화된 학년 판정 결과는 아니다.

## 문구별 판단

| 현재 문구 | 판단 및 이유 |
|---|---|
| Investment Signals | 비교적 짧지만 signals가 투자 가능성을 보여 주는 징후라는 설명이 필요하다. |
| Monthly monitoring of investment signals at 77 target companies | 구조는 단순하다. monitoring, investment signals, target companies의 업무상 의미가 장벽이다. |
| 30 major investment promotion projects · 77 target companies selected by MOTIR | investment promotion의 의미와 MOTIR가 설명되지 않는다. projects와 companies의 수식 관계도 주의가 필요하다. |
| 5 leading indicators tracked per company · Pre-decision signals only | leading indicators와 pre-decision을 알아야 보고서 범위를 이해한다. 어떤 결정 전인지도 생략되어 있다. |
| 5 Leading Indicators of Investment | 단어 수는 적지만 leading이 '앞서 나타나는'이라는 뜻임을 알아야 한다. |
| Geopolitical Supply Chain Resilience | geopolitical, supply chain, resilience 세 개념이 겹친다. 매우 어렵다. |
| Reducing regional dependency, diversifying supply chains, and addressing regulatory risks | 지역 의존, 공급망 다변화, 규제 위험을 모두 알아야 한다. 동작도 추상적이다. |
| Production Expansion & Footprint Diversification | footprint가 발자국이 아니라 생산시설의 지역적 분포라는 비유다. diversification도 어렵다. |
| Evaluating new APAC facility expansions and conducting production site feasibility studies | APAC 약어와 feasibility studies라는 사업성 검토 개념이 설명되지 않는다. |
| Debt & Equity Financing | debt보다 equity와 financing의 결합이 어렵다. 차입과 지분을 통한 조달의 차이를 알아야 한다. |
| Large-scale funding through corporate bonds, equity raises, and credit facilities | 회사채, 증자, 대출 약정이라는 서로 다른 금융 수단이 설명 없이 나열된다. facilities를 건물로 오독할 수도 있다. |
| R&D and Technology Partnerships | partnerships는 비교적 이해하기 쉽지만 R&D의 풀이가 필요하다. |
| Joint R&D, technology licensing, PoCs, and equity-stake talks | 연구개발, 기술 사용권, 개념검증, 지분투자 협의를 모두 압축했다. PoCs가 특히 불투명하다. |
| C-Level Executive Moves | C-Level과 executive가 어렵고 moves가 인사 이동인지 물리적 이동인지 설명이 필요하다. |
| C-suite changes, low-profile visits to Korea, and due diligence coordination | C-suite, low-profile, due diligence 세 표현이 모두 관용적·전문적이다. |

## 쉬운 표현의 방향 — 적용하지 않은 예시

기존 문구의 전문적 정확성을 유지하려면 이름을 짧게 만드는 것만으로 부족하다. 다음처럼 쉬운 설명을 붙이는 방식이 적합하다. 아래 예시는 이해를 돕는 초안으로, 그대로 교체할 완성 번역이나 학년 적합성이 검증된 문장은 아니다. 기존 표지 공간에 들어가는지도 별도 확인해야 한다.

- 범위: “We look for signs that companies may invest. We focus on activities before a final investment decision.”
- ①: “Companies try to rely less on one region for supplies. They also prepare for risks from politics and rules.”
- ②: “Companies study whether to build or expand factories in Asia and the Pacific.”
- ③: “Companies seek large amounts of money by borrowing or selling shares. A share is a small part of a company.”
- ④: “Companies discuss doing research together, paying to use technology, testing ideas, or buying a share of another company.”
- ⑤: “We track changes in top managers, visits to Korea with little publicity, and plans to check a business before investing.”

③의 회사채·신용공여 차이, ④의 PoC와 일반 시험 차이, ⑤의 실사 범위까지 정확히 전달하려면 보충 설명이 필요하다. 쉬운 문장으로 바꿔도 금융 배경지식 자체가 자동으로 해결되지는 않는다.

## 평가 근거와 한계

CDC의 plain-language 지침은 독자가 아는 단어 사용, 능동 표현, 한 문장에 한 가지 생각을 권한다. [Plain Language Materials & Resources](https://www.cdc.gov/health-literacy/php/develop-materials/plain-language.html)

또한 단어·문장 길이로 계산한 가독성 수치는 실제 이해도를 완전히 설명하지 못한다. 이 표지는 완전한 문장보다 제목과 나열구가 많아 수치 하나로 '몇 학년 수준'이라고 단정하지 않았다. [Get to the Point: Write for Immediate Understanding](https://www.cdc.gov/nceh/clearwriting/mod2/index.html)

최종 권고는 **전문가용 영어로는 사용할 수 있지만 초6~중학생용 쉬운 영어라고 보기는 어렵다**는 것이다. 우선 ③·④·⑤의 금융 용어와 약어를 풀고, ①·②의 추상적 제목을 구체적인 행동 설명으로 보완하는 것이 좋다. 실제 적합성 확인에는 대상 독자에게 각 항목의 뜻을 자기 말로 설명해 달라고 하는 검토가 필요하다.
