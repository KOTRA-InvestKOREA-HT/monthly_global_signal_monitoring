# 영문 보고서 고정문구 — 비전문가 이해도 조사 (2026-10-16)

## 기준과 범위
- 질문: 금융·기업전략·투자유치 배경지식이 없는 독자가 설명 없이 알아들을 수 있는가. 대략 초등 고학년~중학생이 따라올 수 있는 수준을 기준으로 삼았다.
- 대상: 템플릿에 박힌 영문 고정문구다. 기사별 AI 문안은 보지 않았다.
  - `report_content.py`의 `TEXTS["en"]`, `SIGNAL_DESCRIPTIONS_EN`, `INDICATOR_DESCRIPTION_EN`, `DETAILED_INDUSTRY_EN`, `TARGET_TECHNOLOGY_DISPLAY_EN`
  - `report_view_model.py`와 `report_html.mjs`에 박힌 문자열
- 방법: 서브에이전트 2개가 읽기 전용으로 조사했다. 하나는 표지·1면·매트릭스 면을, 다른 하나는 상세 면·품목 면·작은 라벨을 맡았다. 지면 모습은 `tests/fixtures/report_snapshot/expected_pages_en.txt`(9월호, 8월분)로 확인했다.
- 1면은 같은 날 만든 `report_page1_readability_en_2026-10-16.md`를 이어받아, 그 문서에 없던 것만 더했다.
- 판정 표기: ○ 이해 가능 · △ 설명 있으면 가능 · × 어려움
- 대안 문구는 모두 원어민·일관성·레이아웃 검수를 거치지 않은 초안이다.

## 결론
**기준에 미달한다.** 표지·매트릭스 면 문구의 약 2/3, 산업 태그와 대상 기술 이름 대부분이 ×다. 원인은 문법이 아니라 다음 네 가지다.
1. **일상어와 겹치는 전문어 때문에 거꾸로 읽힌다.**
   - 금융어: debt는 부실, equity는 공정, raises는 급여 인상, bonds는 유대, credit facilities는 건물로 읽힌다.
   - 그 밖의 말: footprint는 탄소 발자국, resilience는 심리학의 회복탄력성, stake는 스테이크·말뚝으로 읽힌다.
   - 품목·산업 말: target, packaging, mask, delivery, binder, drives, press, issue, developments가 다른 뜻으로 읽힌다.
2. **약어를 풀지 않는다.**
   - MOTIR, APAC, R&D, PoC, C-Level/C-suite, EUV, RF, OLED, GMP, IMU, CVD, PVDF, SEC, E-Propulsion, Lidar
   - PFS·HDS·TGV처럼 괄호로 푼 약어도 있지만, 그 풀이가 다시 은어다.
   - 보고서 어디에도 약어 풀이 목록이 없다.
3. **핵심 개념이 정의되지 않는다.**
   - "지표(5개 분류)"와 "시그널(거기에 걸린 개별 건)"의 관계가 어디에도 없다.
   - 같은 개념을 leading, pre-decision, early, preparatory로 다르게 부른다.
   - 표지에 "한국으로 투자를 끌어오려고 본다"는 방향이 없다. 그래서 "Investment Signals"가 주식 매매 신호로 읽힐 수 있다.
4. **다루는 달이 세 가지로 적혀 있다.** 표지는 "September 2026", 매트릭스 제목은 "This Month's", 설명은 "in August 2026"이다.

## 가장 해로운 항목
| 순위 | 항목 | 문제 |
|---|---|---|
| 1 | 날짜 세 갈래 (`issue_month`, `matrix_title`, `matrix_period_label`) | 9월호가 8월 자료를 다룬다는 사실이 드러나지 않아, 다루는 달 자체를 잘못 읽는다 |
| 2 | `matrix_desc` | 무엇을 셌는지 정하는 유일한 문장이다. "completed projects are excluded"와 "financing (even if completed) … count"가 모순처럼 읽힌다. 끝의 "R&D partnerships count"는 "파트너십 개수"로 읽힌다 |
| 3 | `Target technology` (`item_target_label`) | 상세 면과 품목 카드마다 나온다. "그 기업이 노리는 기술"로 읽히고, 국문의 "투자유치 필요 품목" 뜻이 빠졌다(R4) |
| 4 | ③ 지표 이름·설명 (Debt & Equity Financing / bonds, equity raises, credit facilities) | 성장 자금 조달을 위기 신호로 거꾸로 읽을 수 있다 |
| 5 | ④·⑤ 지표 설명 | PoCs는 해독 불가다. equity-stake, due diligence, low-profile(하급 인사로 읽힘)도 걸린다. ⑤는 같은 칸에서 C-Level과 C-suite를 섞어 쓴다(R3) |
| 6 | 산업 태그와 대상 기술 이름 | 모든 기업 머리에 나온다. Sputtering Targets, Drug Delivery & Fill-Finish, Diversified Industrials, Excipients, EUV·RF·OLED 등이다 |
| 7 | `item_note` | 품목 면의 유일한 설명문인데 reported, tied directly, their target technologies, emerging이 겹친다. 이 중 reported는 제3자 뉴스도 실리므로 사실과도 어긋난다 |
| 8 | ② "Footprint Diversification", "APAC … feasibility studies" | 환경 지표로 오해할 수 있다 |
| 9 | 상세 면 지표 알약에 설명 없음 | 표지를 건너뛴 독자는 5개 행을 해석할 수 없다 |
| 10 | "1/6"(면 머리글 분수), "Issue 3"(꼬리말) | "1/6"은 날짜로, "Issue 3"은 "3번째 문제"로 읽힌다 |

## 세부 — 표지·1면·매트릭스 면

| 문구 (위치) | 판정 | 걸리는 점 | 쉬운 대안 (글자 수 차) / 잃는 것 | 지침 충돌 |
|---|---|---|---|---|
| `cover_kicker` GLOBAL INVESTMENT SIGNAL MONITOR (`report_content.py:347`) | △ | 명사 4개가 쌓였다. monitor를 화면으로 읽을 수 있다 | WATCHING GLOBAL INVESTMENT SIGNALS (+2) | §4 확정. 국문 표지·꼬리말과 같은 이름이라 함께 바꿔야 한다 |
| 발행 월 "September 2026" (`issue_month`, 583-594) | × 오독 | 내용은 8월분이다 | "Covers August 2026" (+4) 또는 "Sep 2026 · August data" (+9) | 함수 출력이다. R7 취지에 맞는다 |
| `cover_titles` Investment Signals (350) | △ | 주식 매매 신호로 읽힌다. 투자 방향이 없다 | 제목은 두고 cover_line_1에서 방향을 푼다 | §4 확정 |
| `cover_subtitle` Monthly monitoring of investment signals at 77 target companies (354) | △ | monitoring은 추상어다 | 대안을 내지 않는다 | §4가 뜻을 고정했다 |
| `cover_line_1` 30 major investment promotion projects · 77 target companies selected by MOTIR (357) | × | promotion을 승진·판촉으로 읽는다. MOTIR를 풀지 않았다. 30과 77의 관계가 불명확하다 | 30 key projects to bring investment to Korea · 77 target companies chosen by MOTIR (+4, 재측정 필요) / promotion이라는 정책 용어 | MOTIR 풀어쓰기는 금지되지 않았지만 +20이라 한 줄에 들어가지 않는다 |
| `cover_line_2` 5 leading indicators tracked per company · Pre-decision signals only (358) | × | leading을 "최고"로 읽는다. 무슨 결정 전인지가 없다 | 5 types of early signs per company · Before any final investment decision (+5) | §2 용어집, §4 확정 |
| `cover_indicator_heading` 5 Leading Indicators of Investment (359) | △ | 위와 같다 | 5 Early Signs of Investment (−7) | §2, §4 |
| ① Geopolitical Supply Chain Resilience (183) | × | 명사 4개가 쌓였다. resilience가 어렵다 | Protecting Supply Chains from Global Risks (+6) / 지정학이라는 원인 특정 | — |
| ① 설명 Reducing regional dependency, diversifying supply chains, and addressing regulatory risks (191) | × | dependency를 중독으로, addressing을 주소로 읽는다 | Relying less on one region, using more suppliers, and dealing with risks from new rules (−2) | 없음 |
| ② Production Expansion & Footprint Diversification (184) | × | footprint를 탄소 발자국으로 읽는다 | Expanding Production to New Locations (−11) / 위험 분산이라는 의도 | §5 폐기안과 일부 겹친다 |
| ② 설명 Evaluating new APAC facility expansions and conducting production site feasibility studies (193) | × | APAC을 풀지 않았다. facility를 편의시설로 읽는다. 명사 4개가 쌓였다 | Weighing new or bigger plants in Asia-Pacific and studying whether new factory sites work (−1) | 없음 |
| ③ Debt & Equity Financing (185) | × | debt는 부실, equity는 공정으로 읽는다 | Borrowing & Selling New Shares (+7) / IR 표준어 | §6 승인 |
| ③ 설명 Large-scale funding through corporate bonds, equity raises, and credit facilities (195) | × | bonds, raises, facilities | Raising large sums through bonds, new shares, and bank credit lines (−14) | §6 승인 |
| ④ R&D and Technology Partnerships (186) | △ | R&D를 풀지 않았다 | Research & Technology Partnerships (+3) | R5에 맞음 |
| ④ 설명 Joint R&D, technology licensing, PoCs, and equity-stake talks (196) | × | PoCs, equity-stake | Joint research, licensing deals, trial projects, and share-purchase talks (+12) / PoC와 일반 시범의 구분 | §6 승인 |
| ⑤ C-Level Executive Moves (187) | × | C-Level을 풀지 않았다. 설명의 C-suite와 다른 말이다(R3) | Top Executive Moves (−4) | §5 개정 전 이름과 비슷하다 |
| ⑤ 설명 C-suite changes, low-profile visits to Korea, and due diligence coordination (199) | × | low-profile, due diligence | Top executive changes, quiet visits to Korea, and planning pre-deal checks (−2) | low-profile은 원어민 2명이 지지했다 |
| `matrix_kicker` SIGNAL MATRIX (319, 국·영 공통) | △ | matrix를 행렬로 읽는다 | SIGNAL TABLE (−1) | 국문판도 함께 바뀐다 |
| `matrix_title` This Month's Signal Matrix (362) | × 시점 | 날짜 세 갈래 | August Signals at a Glance (±0) | §4 확정. R7 예외 자리 |
| `matrix_desc` (363) | × | 위 가장 해로운 항목 2 | Early signs of investment at the 77 target companies in August 2026. A gold cell marks a signal found. Final decisions and finished projects are left out; earlier steps such as raising money (even if done) and research partnerships are included. (−6) | 없음 |
| `matrix_company` Company (364)와 번호 열 | △ 구조 | 번호 1~77을 순위로 읽는다 | 각주 한 줄: "Numbers follow MOTIR's list, not a ranking." | 새 문자열 |
| `matrix_legend_on` Signal detected (365) | ○ | — | Signal found (−3) | — |
| `matrix_legend_off` No signal (366) | △ | "연결 끊김"으로 읽힌다. 검토를 끝내지 못한 기업도 이 칸이 된다 | No signal found (+6) | — |
| `matrix_footnote` 계열 (368-370) | ○ | — | Signals found at 6 companies; none at the other 71. (−2) | — |

## 세부 — 상세 면·품목 면·라벨

| 문구 (위치) | 판정 | 걸리는 점 | 쉬운 대안 (글자 수 차) / 잃는 것 | 지침 충돌 |
|---|---|---|---|---|
| `detail_kicker`의 "· 1/6" (`report_html.mjs:131`) | × | 날짜나 분수로 읽힌다 | 1 of 6 (+3) | 없음 |
| `item_kicker` KEY DEVELOPMENTS (321) | △ | development를 개발·성장으로 읽는다 | — | §6 승인 |
| `item_title` Global Business Developments by Company (381) | × | 명사 4개가 쌓였다. 시그널이 없는 기업이라는 말이 없다 | Business Developments at Other Companies (+1, 22pt 한 줄 한계 근처) / 국문 "글로벌" | R4 경계 |
| 꼬리말 … · Issue 3 (344) | △ | "Issue 3"을 "3번째 문제"로 읽는다 | No. 3 (−2) | 표지 머리의 Issue와 함께 바꿔야 한다 |
| `item_target_label` Target technology (385) | × | 위 가장 해로운 항목 3 | Target for investment in Korea (+13, 품목 카드 말줄임 위험). 또는 라벨은 두고 `item_note`에서 한 번 풀어 준다 | §4 확정. §5에서 "Korea seeks investment in"은 버렸다 |
| `business_heading` Business Developments (373) | △ | 시그널 행과의 차이가 설명되지 않는다 | 구조 문제다. 같은 기사가 두 칸에 모두 실릴 수 있다 | — |
| `source_press_release` Press release (379) | △ | 출처 이름과 Press가 세 번 겹친다 | Company release (+2) | 없음 |
| 출처 이름(`company_sources.json` → `source_display_name`) | × | 메뉴 경로가 그대로 찍힌다(Boeing - News Releases and Statements / Press Releases / Statements). SEC를 풀지 않았다 | 발행처와 페이지 종류만 남긴다(Boeing newsroom). 코드 수정이 필요하다 | 지침 범위 밖 |
| `Aug 2026 (exact date unknown)` (579) | ○ | — | (day unknown) (−7) | — |
| `item_note` (387) | × | 위 가장 해로운 항목 7 | These companies had no signals in {month}, but had business developments linked to their target technologies. We keep watching them for new signals. (−3) | "We" 주어는 선례가 없다 |
| `item_trend_label` {month} Developments (386) | △ | 옆 알약과 대소문자 규칙이 다르다(R5) | Developments in {month} (+3) | R5 근거 가능 |
| `no_signal`, `business_empty`, `Source:`, `Online source`, 날짜 표기 | ○ | — | — | — |

### 산업 태그 (`DETAILED_INDUSTRY_EN`, 알약 최대 190pt ≈ 36자)
- × 와 대안
  - Drug Delivery & Fill-Finish → Injection Devices & Drug Filling (+5)
  - Sputtering Targets → Chip Coating Metals (+1). 보고서 핵심어 target과 겹친다.
  - Diversified Industrials → Many Industries (−8)
  - Pharmaceutical Excipients → Inactive Drug Ingredients (0)
  - Nylon Intermediates → Nylon Raw Materials (0)
  - Solar Metallization Pastes → Metal Pastes for Solar Cells (+2)
  - Precipitated Silica for Tires → Silica Filler for Tires (−6)
  - EUV Mask Substrates → Glass for Chipmaking Masks (+7)
  - OLED Fine Metal Masks → OLED Screen Stencils (−1)
  - Lithography Equipment → Chip Printing Machines (+1)
  - RF & Radar Semiconductors → Radio & Radar Chips (−6)
  - Semiconductor Glass Substrates → Glass Base Plates for Chips (−3)
  - Aerospace & E-Propulsion → Aerospace & Electric Motors (+3)
  - Non-Ferrous Metals & Recycling → Aluminum & Metal Recycling (−4)
- × 인데 짧은 대안이 없음
  - Packaging 계열 3개: 상자 포장으로 읽힌다.
  - Ion-Exchange Membranes
- △ 걸리는 말: biologics, cathode, anode, binder, drives, Lidar, PVDF, semiconductor
  - 예: Chips for Cars (−11)
- 그 밖: Chip과 Semiconductor가 섞여 있다. Lidar와 LiDAR 표기도 다르다.

### 대상 기술 이름 (`TARGET_TECHNOLOGY_DISPLAY_EN`)
- 품목 카드에서는 한 줄로 고정되고 넘치면 말줄임된다(약 65~70자). 70자 안팎인 이름은 지금도 한계에 걸려 있다.
- × 예시
  - Virus validation and master/working cell bank characterization → Virus safety testing of cell stocks used to make drugs (−8)
  - CVD silicon-carbon (Si-C) anode materials: CVD를 빼면 국문 "증착형"과 어긋나 R4 위반이 된다.
  - Hexamethylenediamine (HMD) production technology for nylon → Technology to make HMD, a key nylon ingredient (−12)
  - Linear scales (linear encoders) → Linear scales (sensors that measure position) (+14)
  - Pharmaceutical excipients → Inactive drug ingredients (excipients) (+13)
- EUV·IMU·RF·GMP는 풀지 않았다. PFS·HDS·TGV·W2W·ISP는 괄호로 풀었지만 그 풀이가 다시 은어다.

## 범위 밖으로 남은 것
- `report_html.mjs:348`: PDF 문서 제목(메타데이터)이 꼬리말 문자열이다.
- 간격을 둔 머리글(G L O B A L …)은 PDF 문자 추출·검색·화면낭독에서 낱글자로 나온다. 문구가 아니라 표시 방식의 문제다.

## 고치려면 먼저 정할 것
1. **문구 가이드에 "쉬운 말" 규칙(가칭 R9)을 둘지.**
   - 지금 R1~R8은 해외 기업 임원·IR 담당자를 독자로 잡고 있다.
   - R8(업계 용례)은 쉬운 말로 바꾸는 것을 오히려 막는다.
   - 대안 대부분이 §2 용어집, §4 확정 문구, §6 승인 기록과 부딪힌다.
   - 이 규칙 없이 지금 기준으로 통과할 수 있는 것은 R2(오독)·R3·R4·R5로 근거를 댈 수 있는 항목뿐이다: 날짜 세 갈래, `matrix_desc`, ⑤ C-Level/C-suite, `item_note`, `item_trend_label`, "1/6".
2. **정밀도와 쉬움 중 무엇을 우선할지.** 쉬운 말로 바꾸면 회사채·신용공여, PoC, 실사, CVD 같은 구분이 흐려진다.
   - 대안: 이름은 두고 약어·용어 풀이 상자를 한 곳(예: 표지 뒤나 매트릭스 면 아래)에 둔다.
3. **바꿀 때는 기존 절차(§7)를 탄다.** `en-wording-rewriter`가 변경안을 내고, reader·consistency·layout 검수를 거친 뒤 반영한다. 지면이 빠듯해서 layout 검수는 빼면 안 된다.
