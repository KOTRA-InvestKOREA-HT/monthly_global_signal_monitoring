# 영문 보고서 고정문구 기준

영문 보고서(`latest_report_en.pdf`)의 고정문구를 고칠 때 모든 사람과 에이전트가 읽는 단일 기준이다.
요청할 때마다 "어색함"을 새로 판단하면 같은 문구가 앞뒤로 뒤집힌다(2026-10-06~08 사이 지표 총칭이
early investment indicators → leading indicators, 품목 면 제목이 Business Trends by Product →
Global Business Developments by Company 로 바뀌었다). 이 문서에 없는 취향으로는 문구를 바꾸지 않는다.

- 범위: 코드에 박힌 영문 고정문구. 기사마다 모델이 쓰는 요약·사유는 범위 밖이다.
- 국문판은 바꾸지 않는다. 국문은 영문의 뜻을 맞출 기준으로만 읽는다.
- 이 문서의 §4 확정 문구와 §6 결정 기록은 사람이 승인한 것만 적는다.

## 1. 대상 위치

| 묶음 | 위치 | 비고 |
|---|---|---|
| A. 표지·면 제목·라벨·안내문 | `scripts/report_content.py` `TEXTS["en"]` | `{month}`, `{period}`, `{on}` 등 자리표시자는 그대로 둔다 |
| B. 지표 이름 | `SIGNAL_DESCRIPTIONS_EN` | 표지, 기업 카드 라벨, 매트릭스 범례에 같은 문자열이 나온다. 매트릭스 범례(`matrix_indicators()`)는 카드 라벨에서 만들므로 이 사전 하나만 바꾸면 된다 |
| C. 지표 설명 | `INDICATOR_DESCRIPTION_EN` | 표지에만 나온다 |
| D. 산업 태그 | `DETAILED_INDUSTRY_EN`, `EXEMPT_INDUSTRY`의 영문 값 | 기업 카드 머리의 알약 |
| E. 품목명 | `TARGET_TECHNOLOGY_DISPLAY_EN` | `data/company_technology_map.json`의 `target_technology_en`은 판정 캐시 키라 **건드리지 않는다** |
| F. 면 머리글(kicker) | `TEXTS`의 `matrix_kicker`, `detail_kicker`, `item_kicker` | 뷰 모델을 거쳐 `scripts/report_html.mjs`가 그린다. 국·영문 공통이다 |
| G. 날짜·기간 문구 | `report_content.py`의 `format_date`, `format_row_date`, `matrix_period_label`, `report_month_label` 의 영문 분기 | "in August 2026", "from ... to ...", "Aug 20, 2026" |

범위 밖: `COUNTRY_EN`(국가명), 기업명(`display_name`), 로고 글자("Invest KOREA", "Promotion Agency"),
`config/investment_signal_indicators.json`(판정 캐시 키).

## 2. 용어집

한 개념에는 한 단어만 쓴다. 표에 없는 개념을 새로 이름 붙여야 하면 제안으로 올리고 승인 후 여기에 적는다.

| 개념 | 쓰는 말 | 쓰지 않는 말 |
|---|---|---|
| 5개 분류(①~⑤) | key investment signals (표지 머리글은 "The 5 Key Investment Signals", 2026-10-22부터) | leading indicators (2026-10-22 교체), early investment indicators, pre-decision indicators, signal categories |
| 분류에 걸려 포착된 개별 건 | signal(s) | detection, AI detection, hit |
| 보고 범위(최종 결정 전 단계) | pre-decision (표지 범위 문구에서만) | — |
| 77개 기업 | target companies | targeted companies, focus companies |
| 기업별 투자유치 대상 품목·기술 | target technology | item, product (라벨로서), Korea seeks investment in |
| 시그널이 아닌 일반 사업 소식 | business developments. 품목 면 머리글에서만 축약형 **KEY DEVELOPMENTS** 허용 | 기업 하나의 개별 사건을 부를 때 trends, updates, news. 단수 "Business Development"(BD 직무)와 "Corporate Development"(M&A 부서)는 직무명이라 쓰지 않는다 |
| 최종 투자 확정 | final investment decision(s) | FID (약어 단독 사용) |
| 발행 부처 | MOTIR | MOTIE (구 명칭) |
| 발행처 | Invest KOREA | Invest Korea, KOTRA (본문 문구에서) |

용어 근거 (2026-10-12 조사)
- **developments**: 기업 하나의 개별 사건을 부르는 투자업계 표준어다. S&P Capital IQ의 기업 사건 데이터베이스 이름이
  "Key Developments"(경영진 교체, 자사주 매입, 제품 출시 등)이고, SEC 10-K에는 "Recent Developments" 항목이 있다.
- **trends**: 사전 뜻이 여러 변화가 쌓여 보이는 전반적 방향이다(Collins, Cambridge). 여러 기업에 걸친 흐름을 분석하는
  면에서만 쓴다. fDi Intelligence도 기업 소식(News)과 흐름 분석(corporate trends and investment patterns)을 나눠 쓴다.
- **product**: 카드를 품목별로 묶던 시절의 말이다. 지금은 카드가 기업별이고, 내용도 제품 소식이 아니라 사업 전반이다.

## 3. 문체 규칙

변경 제안은 반드시 아래 규칙 번호 중 하나 이상을 근거로 단다. 규칙 번호가 없는 변경은 받지 않는다.

- **R1 번역투**: 국문 어순·명사 나열을 옮겨 영어 화자가 쓰지 않는 표현(예: 동명사를 명사 뒤에 붙인
  "Liquidity Securing"류, 국문 낱말마다 옮겨 붙인 제목).
- **R2 오독**: 영어 독자가 다른 뜻으로 읽을 수 있음(예: "Korea seeks investment in"은 한국이 투자하는 쪽으로도 읽혔다,
  "delivery vehicles"는 운송 차량으로 읽혔다, "unannounced site visits"는 "site"가 붙어 현장 점검처럼 읽힐 수 있다).
  어떻게 오독되는지 구체적으로 적는다. 특정 뜻으로만 쓰인다고 단정하지 말고, **이 보고서의 문맥에서** 어떻게 읽히는지를
  근거로 든다(예: "unannounced visit" 자체는 정상의 깜짝 방문 기사에서도 흔히 쓰는 말이다).
  - 낱말 뜻은 맞아도 어감이 원문보다 세거나 좁으면 오독이다(예: "change executives"는 사람을 갈아치운다는 교체로
    좁아져, 선임·퇴임·이동을 다 담는 국문 "C-Level 이동"과 맞지 않는다. "confidential"은 기밀을 입수해 공개하는
    감시처럼 읽힌다).
  - 나열의 각 항목을 **따로 떼어** 읽어도 한 가지로만 읽혀야 한다. "-ing"로 시작하는 항목은 동명사(행위)와
    형용사("changing trends"처럼 '변하는 ~') 두 가지로 읽히지 않는지 본다.
  - 금융 용어는 업계에서 굳은 뜻을 확인한다(예: "liquidity support"는 중앙은행·모회사의 긴급 자금 지원, 곧
    구제금융으로 읽힌다).
- **R3 용어 불일치**: §2 용어집 위반, 또는 같은 면·인접 면에서 같은 대상을 다른 말로 부름(제목과 머리글 포함).
  용어 통일은 §2의 개념 이름과 제목·머리글에 적용한다. 설명문에서 지표 이름의 낱말을 되풀이하려고 영어의 굳은 짝
  (collocation, 예: "leadership change", "raise capital")을 깨지 않는다. 둘이 부딪히면 R1·R2가 앞선다.
- **R4 국문과 뜻 차이**: 국문 원문보다 뜻이 좁거나 넓음(예: 지분투자 "타진"을 완료된 지분투자로 읽히게 옮김).
  국문의 "등"은 매번 옮기지 않아도 된다. 짧은 예시 나열은 영어에서도 예시로 읽힌다. 문맥상 독자가 나열을 배타적인
  정의로 오해할 여지가 있을 때만 R4로 본다.
- **R5 문법·형식**
  - 제목, 지표 이름, 산업 태그, 면 제목은 Title Case. 설명, 안내문, 품목명, 범례는 sentence case.
  - 이름·태그 안의 결합은 `&`, 문장 안에서는 `and`. "R&D"가 들어간 이름은 `and`.
  - 각 설명 내부의 나열은 병렬 구조를 맞춘다(전부 동명사구 또는 전부 명사구). 설명 간 형식 통일(예: 지표 설명 5개를
    모두 동명사구로)은 자연스러움과 의미 보존을 해치지 않는 범위에서만 적용한다. 마지막 항목 앞의 접속사와 연속 쉼표는
    모든 나열에 일관되게 적용한다. (2026-10-12 명확화: 설명 간 통일을 강제해 ⑤가 "Undergoing leadership changes"처럼
    수동적이고 범위가 넓어졌던 일이 있었다.)
  - 라벨이 전치사로 끝나지 않는다.
- **R6 칸 넘침**: 보고서 빌드(`scripts/build_html_report.mjs`)의 `cut_text` 목록에 항목이 생기거나(줄 수 제한·한 줄 칸
  말줄임·푸터 선 아래로 넘친 쪽), 줄 수가 늘어 배치가 밀림.
- **R7 시점**: 본문 문구는 보고 달 이름을 쓴다(10월호는 9월을 다룬다). "this month"는 매트릭스 제목에서만 쓴다.
- **R8 업계 용례**: 해당 업계·IR 문서에서 실제로 쓰는 이름과 다름(근거 출처나 용례를 적는다).

**보수 원칙**: 확실히 위 규칙에 걸릴 때만 바꾼다. "더 나을 것 같다"는 변경 사유가 아니다.
위반이 분명해도 고친 문구가 다른 규칙을 새로 어기면(특히 R6) 바꾸지 않고 보고만 한다.

## 4. 확정 문구 (바꾸지 않음)

사람이 승인한 결정이다. 고치려면 에이전트가 직접 바꾸지 않고 "재검토 요청"으로 올린다.

| 키 | 문구 | 결정 근거 |
|---|---|---|
| `cover_titles` | Investment Signals | 828adb5, 31bcce6: 국문 제목을 낱말마다 옮긴 이전 제목이 영어로 읽히지 않음 |
| `cover_kicker` | GLOBAL INVESTMENT SIGNAL MONITOR | f9dd324: 국·영문 표지 공통 보고서 이름 |
| `cover_line_2` 후반 | Pre-decision signals only | c87062d: 보고 범위를 말함 |
| `cover_indicator_heading` | The 5 Key Investment Signals | 2026-10-22 사용자 표지 수정안("표지 수정 1020") |
| `SIGNAL_DESCRIPTIONS_EN`, `INDICATOR_DESCRIPTION_EN` | 2026-10-22 사용자 표지 수정안의 지표 이름·설명 5개 | 2026-10-22 사용자 표지 수정안 |
| `matrix_title` | This Month's Signal Matrix | 3905c25: 국문 "이번 달 시그널 매트릭스"에 맞춤(2026-10 결정) |
| `item_target_label` | Target technology | e749a7c |
| `cover_line_1`의 MOTIR | MOTIR | 산업통상부 공식 영문 약칭 |
| `cover_subtitle` | Monthly monitoring of investment signals across 77 target companies | 2026-10-12 사용자 승인, 2026-10-20 at → across 사용자 승인. 뜻은 "매달 77개 타겟기업의 투자 시그널 모니터링"으로 고정한다. 이 뜻을 바꾸는 재해석(결정 전 조짐, 기업이 하는 일 등)은 제안하지 않는다 |

## 5. 다시 제안하지 않는 문구

이미 쓰다가 버린 문구다. 같은 문구나 사실상 같은 문구를 다시 제안하지 않는다.

| 버린 문구 | 자리 | 버린 이유 |
|---|---|---|
| Target-Company Global Investment Signal Monitor | 표지 제목 | 국문을 낱말마다 옮김 |
| Company Signals | 표지 제목 | 31bcce6에서 Investment Signals 로 |
| Korea seeks investment in | 품목 라벨 | 전치사로 끝남, 한국이 투자하는 쪽으로 읽힘 |
| Target product / technology | 품목 라벨 | 누구의 대상인지 불명확했음 → Target technology 로 정리 |
| Supply Chain Risk Management | 지표 ① | 회사 내부 부서 업무처럼 읽힘 |
| Supply Chain Shifts, Supply Chain & Geopolitical Risk | 지표 ① | 2026-10 개정 전 이름 |
| Geographical Diversification, Production Expansion & New Sites | 지표 ② | 길고 번역투 / 2026-10 개정 전 이름 |
| Capital Raising & Liquidity | 지표 ③ | 2026-10 개정 전 이름 |
| Capital Raising & Liquidity Securing | 지표 ③ | 2026-10-12 교체: 명사 뒤에 동명사를 붙인 번역투(R1) |
| executing capital increases | 지표 ③ 설명 | 2026-10-12 교체: 유럽식 번역투(R1) |
| C-Suite Actions, Leadership Moves & Visits, Executive Moves & Korea Visits, Executive Moves | 지표 ⑤ | 무엇을 하는지 불명확 / 방한에 한정됨 / 2026-10 개정 전 이름 |
| early investment indicators, Pre-Decision Indicators | 지표 총칭 | 818ae68, 82a62a3 |
| No signal this month | 카드 빈칸 | R7: 10월호는 9월을 다룸 |
| item (품목) | 전체 | d279a13 |
| AI detection | 매트릭스 범례 | 7ba37ef: 탐지 주체가 아니라 포착된 시그널을 말함 |
| delivery vehicles | 품목명 | 운송 차량으로 읽힘 |
| Capital Raising & Liquidity Buffers | 지표 ③ | 2026-10-12 검수 반려: buffer는 쌓아 둔 방어용 잔고(상태)라 국문 "확보"(마련하는 행위)와 다름 |
| Capital Raising & Liquidity Actions | 지표 ③ | 2026-10-12 검수 반려: 어떤 조치든 될 수 있어 너무 넓고, 유동성 위기 대응처럼 어둡게 읽힘 |
| Capital Raising & Liquidity Support | 지표 ③ | 2026-10-12: "liquidity support"는 구제금융(긴급 자금 지원)으로 읽힘(R2) |
| Changing C-level executives, Changing C-level leaders, Changing C-level leadership | 지표 ⑤ 설명 | 2026-10-12 사용자 지적: "임원을 교체한다"로 좁아져 선임·퇴임·이동을 다 담는 "C-Level 이동"과 맞지 않고, '변하는 임원들'로도 읽힘. "C-level leaders"는 흔한 말이 아님 |
| unannounced site visits | 지표 ⑤ 설명 | "site"가 붙어 현장 점검처럼 읽힐 수 있고, 국문 "극비 방한"의 방한을 전하지 못함. "unannounced visits to Korea"는 이 행에 해당하지 않는다 |
| confidential visits to Korea | 지표 ⑤ 설명 | 2026-10-12 검수 반려: 기밀을 입수해 공개하는 감시처럼 읽힘(어조) |
| Monthly Pre-Decision Indicators Across 77 Priority Companies | 표지 부제 | 다섯 분류를 leading indicators 와 다른 이름으로, 77개사를 target companies 와 다른 이름으로 부름 |
| Monthly monitoring of early signs ahead of investment decisions | 표지 부제 | 2026-10-12 교체: 명사 나열 관청투, early 와 ahead of 가 같은 뜻을 겹쳐 말함 |
| What multinationals are doing before they commit capital (및 What (global) companies do before they commit capital 류) | 표지 부제 | 사용자 지적: 원래 뜻(매달 / 77개사 / 투자 시그널)에서 너무 멀어짐 |
| Tracking the groundwork (that) companies lay before they invest | 표지 부제 | 사용자 거부: groundwork 같은 건설 비유 |
| Early signs of investment decisions, … / Early signs that companies may invest, … | 표지 부제 | "signs of a decision"은 이미 내린 결정의 흔적으로도 읽힘 / 원래 뜻(77개사·투자 시그널)이 빠짐 |
| Monthly investment signals from 77 companies | 표지 부제 | 검수 반려: monthly 가 signals 를 꾸며 월 구독형 매매 신호로 읽히고, from 은 기업의 공식 발표로 좁게 읽힘 |
| Monthly signals of investment at 77 companies | 표지 부제 | 검수 반려: signals of investment 는 번역투이고 이미 이루어진 투자의 흔적으로 읽힘. 77개사가 투자받는 쪽으로도 읽힘 |
| PRODUCT TRENDS | 품목 면 머리글 | 카드가 기업별이고 내용이 개별 사건이라 product, trends 모두 맞지 않음(§2 용어 근거) |
| C-suite shifts | 지표 ⑤ 설명 | 원어민 3명: shifts 가 전략·우선순위 변화로 읽혀 사람의 이동이 드러나지 않음 |
| 5 Leading Investment Indicators / 5 leading investment indicators tracked per company | 표지 5대 지표 머리글·정보 줄 | 원어민 3명 반려: leading 이 "top"으로, investment indicators 가 투자자용 지표나 LEI 같은 계량 지수로 읽힘. leading indicators 는 붙여 쓰고 of investment 로 대상을 밝힌다 |
| 5 Leading Indicators of Investment / 5 leading indicators tracked per company | 표지 5대 지표 머리글·정보 줄 | 2026-10-22 사용자 표지 수정안으로 교체 |
| Geopolitical Supply Chain Resilience, Production Expansion & Footprint Diversification, Debt & Equity Financing, R&D and Technology Partnerships, C-Level Executive Moves | 지표 ①~⑤ | 2026-10-22 사용자 표지 수정안으로 교체 |

## 6. 결정 기록

변경이 반영될 때마다 아래에 한 줄씩 덧붙인다. 지우지 않는다.

| 날짜 | 키 | 이전 → 이후 | 규칙 | 승인 |
|---|---|---|---|---|
| 2026-10-12 | — | 기준 문서 작성 | — | 사용자 요청 |
| 2026-10-12 | §2, R2, R4, R5, §5 | 기준 보완: KEY DEVELOPMENTS 허용과 용어 근거, R5 설명 간 통일을 조건부로, "등" 기준, 단정적 근거 완화, 버린 문구 추가 (`report_wording_review_en_2026-10-12.md` 반영) | — | 사용자 요청 (보고서 문구 변경 승인은 아님) |
| 2026-10-12 | 품목 면 머리글 (`build_pdf_report.py`, `report_view_model.py`) | PRODUCT TRENDS → KEY DEVELOPMENTS (국·영문 공통) | R3, R8 | 사용자 승인, 원어민 최종 검수 통과 |
| 2026-10-12 | `TARGET_TECHNOLOGY_DISPLAY_EN["autonomous_imu_rf_baseband"]` | IMU, RF and → IMU, RF, and | R5 | 사용자 승인, 원어민 최종 검수 통과 |
| 2026-10-12 | `SIGNAL_DESCRIPTIONS_EN[3]`, `matrix_indicators` ③ | Capital Raising & Liquidity Securing → Debt & Equity Financing | R1, R8 | 사용자 승인(일관성 검수의 경계선 반려 "유동성 확보 누락"을 알고 결정), 원어민 최종 검수 통과 |
| 2026-10-12 | `INDICATOR_DESCRIPTION_EN[3]` | Issuing large-scale corporate bonds, executing capital increases, securing credit facilities → Large-scale funding through corporate bonds, equity raises, and credit facilities | R1, R4, R5 | 사용자 승인, 원어민 최종 검수 통과 |
| 2026-10-12 | `INDICATOR_DESCRIPTION_EN[4]` | …PoCs and equity-stake talks → …PoCs, and equity-stake talks | R5 | 사용자 승인, 원어민 최종 검수 통과 |
| 2026-10-12 | `INDICATOR_DESCRIPTION_EN[5]` | C-suite shifts, unannounced site visits, due diligence coordination → C-suite shifts, low-profile visits to Korea, and due diligence coordination | R2, R4, R5 | 사용자 승인, 원어민 최종 검수 통과. Korea 포함 결정(§5 "Korea Visits"는 이름에 대한 결정으로 해석) |
| 2026-10-12 | `cover_line_1` | (변경 안 함) "selected by MOTIR" 위치 이동 제안 | R4 | 사용자 결정으로 보류 |
| 2026-10-12 | `cover_subtitle` | Monthly monitoring of early signs ahead of investment decisions → Monthly monitoring of investment signals at 77 target companies | R1, R3 | 사용자 승인, 원어민·일관성 최종 검수 통과 (후보는 원어민 3명 교차 채점 4라운드를 거침) |
| 2026-10-12 | `item_note` (국·영문), `item_exempt_note` 삭제 | 기술 관련성 확인 면제 기업 카드 설명 문장 삭제: 영문 "Cards without a target technology cover all of a company's businesses." | — | 사용자 결정: 타겟기술을 매칭하지 않은 면제 기업은 품목 면에 싣지 않음 (`build_item_trend_entries`) |
| 2026-10-12 | `cover_line_2`, `cover_indicator_heading` | (변경 안 함) 5 leading indicators → 5 leading investment indicators, 5 Leading Indicators of Investment → 5 Leading Investment Indicators | R1 | 원어민 3명 모두 반려: "leading"이 "top"으로, "investment indicators"가 투자자용 지표(P/E·ROI)나 LEI 같은 계량 지수로 읽힘 |
| 2026-10-12 | `INDICATOR_DESCRIPTION_EN[5]` | C-suite shifts → C-suite changes (low-profile visits to Korea 는 유지) | R2 | 사용자 승인. 사전 정보 없는 원어민 3명 모두 "shifts"가 전략·우선순위 변화로도 읽혀 모호하다고 봄. changes 는 국문 "C-Level 이동"의 선임·이동·퇴임을 모두 덮음. low-profile 은 2명 유지, 1명 unpublicized 제안(다른 1명은 unpublicized 가 더 감시처럼 읽힌다고 반대) |
| 2026-10-20 | `cover_subtitle` | …investment signals at 77 target companies → …investment signals across 77 target companies | R8 | 사용자 승인(검수 에이전트를 거치지 않음). 부제는 77개사 전체를 살피는 범위를 말하는 자리라 across 가 보고서 부제의 흔한 용례에 맞음. 시그널이 잡힌 기업을 말하는 매트릭스 문구(`matrix_desc`, `matrix_footnote`)는 at 유지. 한 줄 폭 411pt / 454pt |
| 2026-10-22 | `cover_indicator_heading`, `cover_line_2` | 5 Leading Indicators of Investment → The 5 Key Investment Signals, 5 leading indicators tracked per company → 5 key investment signals tracked per company | R3 | 사용자 표지 수정안(검수 에이전트를 거치지 않음). 정보 줄은 머리글과 총칭을 맞추려고 함께 바꿈 |
| 2026-10-22 | `SIGNAL_DESCRIPTIONS_EN` ①~⑤ (표지, 매트릭스 범례, 기업 카드 라벨) | Geopolitical Supply Chain Resilience → Supply Chain & Political Risk Management, Production Expansion & Footprint Diversification → Factory Expansion & Diversification of Production Bases, Debt & Equity Financing → Capital Raising & Securing Liquidity, R&D and Technology Partnerships → Tech Partnerships & Joint Research, C-Level Executive Moves → Top Executive Actions | — | 사용자 표지 수정안(검수 에이전트를 거치지 않음). §5의 "Supply Chain Risk Management" 반려와 겹치지만 사용자 결정으로 반영. 수정안의 ②③ 소문자는 R5 Title Case로 맞춤. 영문 PDF 잘림 없음, 카드 라벨 ②가 가장 김 |
| 2026-10-22 | `INDICATOR_DESCRIPTION_EN` ②~⑤ | ② Evaluating new APAC facility expansions… → New factory opening or facility construction in the Asia-Pacific (APAC) region, ③ Large-scale funding through… → Getting extra cash by issuing corporate bonds, new share issuance, or bank loans, ④ Joint R&D, technology licensing, PoCs, and equity-stake talks → Joint R&D, sharing tech licenses, testing new ideas, or buying shares in partner companies, ⑤ C-suite changes… → C-level bosses moving to new positions, making quiet trips to Korea, or checking out local business sites | — | 사용자 표지 수정안(검수 에이전트를 거치지 않음). ①은 그대로. ② 끝 마침표는 다른 설명에 맞춰 뺐고, ⑤ "business site"는 "sites"로 고침. 표지 설명 모두 한 줄 |
| 2026-10-22 | `SIGNAL_DESCRIPTIONS_EN[5]`, `INDICATOR_DESCRIPTION_EN[5]` | Top Executive Actions → Top Executives' Activities, C-level bosses moving to new positions, making quiet trips to Korea, … → C-level executives moving to new positions, business trips to Korea, or checking out local business sites | — | 사용자 수정 요청(검수 에이전트를 거치지 않음). 수정안의 "business site"는 앞 결정과 같이 "sites"로 둠. 영문 PDF 잘림 없음 |

## 7. 진행 절차

0. **뜻부터 고정한다.** 제목·부제처럼 뜻이 핵심인 문구는 고쳐 쓰기 전에 사람에게 담아야 할 뜻(핵심 요소)을 확인하고,
   그 요소를 조건으로 건다. 지금 문구의 낱말에서 뜻을 추측하지 않는다. 반복을 피하려고 핵심어를 금지하지 않는다
   (2026-10-12: 부제에서 signals·77·monitor 를 금지했더니 후보가 모두 원래 뜻 "매달 77개사의 투자 시그널"에서 벗어났다).
1. **고쳐 쓰기** (`en-wording-rewriter`): §1 대상을 읽고 §3 위반만 찾아 변경안을 낸다. 코드는 고치지 않는다.
2. **검수** (서로 독립, 고쳐 쓴 쪽의 근거 설명은 넘기지 않고 전후 문구만 넘긴다)
   - `en-reader-reviewer`: 영어 독자 관점에서 아직 어색하거나 오독되는가(R1, R2, R8)
   - `en-consistency-reviewer`: 용어집, 국문과 뜻, 면 사이 용어 통일, 확정·폐기 문구 위반(R3, R4, R5, R7, §4, §5)
   - `en-layout-reviewer`: PDF를 실제로 그려 잘림·밀림이 없는가(R6)
3. 반려된 항목만 고쳐 쓰기로 한 번 더 돌린다. 두 번째에도 반려되면 바꾸지 않고 사람에게 올린다.
   2차 검수는 바뀐 낱말만 보지 않고 **문구 전체를 처음 보는 것처럼** 다시 읽는다(2026-10-12: 2차 안에서 Korea, discreetly만
   보고 넘어가 "Changing C-level executives"의 어색함을 놓쳤다).
4. 사람이 승인한 항목만 코드에 반영하고, `python tests/test_report_snapshot.py --update`와
   `UPDATE_REPORT_SNAPSHOT=1 node --test tests/report_snapshot.test.mjs`로 기대값을 다시 만든 뒤
   `node --test`와 `python -m unittest discover tests`를 돌리고, §6에 기록한다.
