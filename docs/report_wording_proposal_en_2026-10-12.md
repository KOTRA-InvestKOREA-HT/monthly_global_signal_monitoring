# 영문 보고서 고정문구 변경 제안 (2026-10-12, 검토 반영판)

`docs/report_wording_guide_en.md` 기준으로 에이전트 팀(고쳐쓰기 1, 검수 3)이 영문 고정문구를 두 번 검토했다.
이 문서는 그 결과에 다음 두 가지를 합친 최종 제안이다.
- [검토서](report_wording_review_en_2026-10-12.md)의 의견
- 머리글 용어 조사(developments, trends, product)

## 반영 결과 (2026-10-12)

사용자가 아래 항목을 골랐고, 새 원어민 검수 에이전트의 최종 검수에서 6개 모두 통과해 코드에 반영했다.
승인 기록은 기준 문서 §6에 있다.

| 항목 | 반영 문구 |
|---|---|
| 품목 면 머리글 (국·영문 공통) | K E Y   D E V E L O P M E N T S |
| IMU 품목명 | IMU, RF, and baseband chips for autonomous vehicles |
| 지표 ③ 이름 (표지·카드·범례) | Debt & Equity Financing |
| 지표 ③ 설명 | Large-scale funding through corporate bonds, equity raises, and credit facilities |
| 지표 ④ 설명 | Joint R&D, technology licensing, PoCs, and equity-stake talks |
| 지표 ⑤ 설명 | C-suite shifts, low-profile visits to Korea, and due diligence coordination |

- **반영하지 않음**: C2(표지 "selected by MOTIR" 위치 이동). 사용자 결정으로 보류했다.
- **확인**: 스냅샷 기대값을 다시 만들었다(영문 12줄, 국문 머리글 1줄만 바뀜. 내용 판단 스냅샷은 그대로). `node --test` 440개 통과, `python -m unittest discover tests` 75개 통과. 반영 조합의 영문 PDF는 9쪽 그대로이고 잘림이 없다.
- **최종 검수 의견** (반려 아님):
  - ③ 설명의 "funding through credit facilities"는 약정만 맺은 한도까지 담는 데는 이전 "securing"보다 조금 덜 정확하다.
  - 바꾸지 않은 ⑤ 이름의 "Executive Moves"는 업계에서 주로 인사(선임·퇴임)를 뜻해, 설명의 방한·실사 조율과 약간 어긋날 수 있다.
  - 바꾸지 않은 ② 설명 "Evaluating new APAC facility expansions"는 조금 무겁게 읽힌다.

아래는 반영 전에 작성한 제안 내용이다.

## 요약

- **반영 권장 5건**: 머리글, 표지 둘째 줄, 품목명, 지표 ④ 설명, 지표 ③④⑤ 설명의 쉼표 규칙
- **후보 중에서 고를 것 2건**: 지표 ③ 설명, 지표 ⑤ 설명. 검수를 통과한 안과, 검토 과정에서 나온 더 나은 후보가 함께 있다.
- **보류 1건**: 지표 ③ 이름. 이름이 포괄할 범위부터 정하고 대안을 다시 비교한다.
- 확정 문구 7개는 두 번 검토했고 **변경 제안이 없다**.
- 아래 권장 문구를 모두 넣어 PDF를 그려 봐도 9쪽 그대로이고, 잘림·줄 수 변화가 없다.
- 이전 판의 "설명 5개를 동명사구로 통일" 권장은 **철회**했다. 기준 R5를 "각 설명 내부의 병렬 구조 우선, 설명 사이 통일은 조건부"로 고쳤다(§3).

표의 "검수" 열은 다음 뜻이다.
- **3명 통과**: 원어민·일관성·레이아웃 에이전트가 모두 통과시킨 문구
- **미검수**: 검토 과정에서 새로 나와 레이아웃만 잰 문구. 에이전트 검수는 돌리지 않았다.

## 1. 반영 권장

| id | 자리 | 지금 | 제안 | 검수 | 이유 |
|---|---|---|---|---|---|
| C1 | 품목 면 머리글 (PDF와 화면, 국·영문 공통) | P R O D U C T   T R E N D S | **K E Y   D E V E L O P M E N T S** | 미검수 (조사와 검토서 권장. 같은 뜻의 BUSINESS DEVELOPMENTS는 3명 통과) | 카드가 기업별 개별 사건이라 product, trends 모두 맞지 않는다. "Key Developments"는 S&P Capital IQ의 기업 사건 데이터베이스 이름이라 투자 독자에게 익숙하다. BUSINESS DEVELOPMENTS는 자간을 띄운 대문자에서 끝의 S가 잘 안 보여 BD(영업개발) 직무명처럼 보일 수 있다 |
| C2 | 표지 둘째 줄 | 30 major investment promotion projects · 77 target companies selected by MOTIR | 30 major investment promotion projects selected by MOTIR · 77 target companies | 3명 통과, 검토서 수용 | 국문은 "산업부 **선정** 30대 프로젝트"인데, 지금 영문은 MOTIR가 77개 기업을 고른 것으로 읽힌다 |
| C3 | 품목명 (해당 기업 카드) | IMU, RF and baseband chips for autonomous vehicles | IMU, RF, and baseband chips for autonomous vehicles | 3명 통과, 검토서 수용 | 문법 오류 수정이 아니라 기준의 연속 쉼표 규칙을 적용한 것이다 |
| C4 | 표지 지표 ④ 설명 | Joint R&D, technology licensing, PoCs and equity-stake talks | Joint R&D, technology licensing, PoCs, and equity-stake talks | 3명 통과, 검토서 권장 | 명사구는 그대로 두고 연속 쉼표만 적용한다. 동명사구로 바꾸는 "Pursuing …"안도 통과했지만, R5를 고친 뒤로는 필수가 아니다 |

C1 머리글은 국문판에도 그대로 적용된다(국문판 품목 면 머리글도 KEY DEVELOPMENTS가 됨). 반영할 때 결정 기록에 이 범위를 적는다.

## 2. 후보 중에서 고를 것

### 지표 ③ 설명

지금 문구: `Issuing large-scale corporate bonds, executing capital increases, securing credit facilities`
- "executing capital increases"는 유럽식 번역투다.
- "large-scale corporate bonds"는 규모가 발행 행위가 아니라 채권에 붙어 어색하다.
- 국문 표지는 "회사채·증자·신용공여 등 **대규모 자금 조달**"이라, "대규모"가 조달 전체에 걸린다.

| 후보 | 칸 비율 | 검수 | 특징 |
|---|---|---|---|
| Issuing large-scale corporate bonds, raising equity, and securing credit facilities | 0.703 | 3명 통과 | "raising equity"만 고친 안. "large-scale bonds"의 어색함은 남는다 |
| Issuing corporate bonds on a large scale, raising equity, and securing credit facilities | 0.742 | 미검수 (검토서 권장) | 규모가 발행 행위에 붙는다. 다만 대규모가 회사채에만 걸리고 조금 길다 |
| **Large-scale funding through corporate bonds, equity raises, and credit facilities** | 0.702 | 미검수 (**추천**) | 국문 표지 구조("…등 대규모 자금 조달")를 그대로 따라 대규모가 조달 전체에 걸린다. 가장 짧다. 명사구지만 고친 R5에서는 문제없다 |

### 지표 ⑤ 설명

지금 문구: `C-suite shifts, unannounced site visits, due diligence coordination`
- "unannounced **site** visits"는 현장 점검처럼 읽힐 수 있다.
- 국문 "극비 **방한**"의 방한을 전하지 못한다.

| 후보 | 칸 비율 | 검수 | 특징 |
|---|---|---|---|
| C-suite shifts, low-profile visits to Korea, and due diligence coordination | 0.635 | 3명 통과 | 무난하다. 원어민 의견: "C-suite changes"가 "shifts"보다 흔하고, "low-profile"은 "극비"보다 약하다 |
| C-suite changes, low-profile visits to Korea, and due diligence coordination | 0.662 | 미검수 (검토서 권장) | 위 안에 원어민 의견("changes")을 반영했다 |
| **C-suite changes, unannounced visits to Korea, and due diligence coordination** | 0.688 | 미검수 (**추천**) | "unannounced visit"는 정상의 깜짝 방문 기사에서 흔히 쓰는 말이라, 점검 느낌을 준 "site"만 빼면 자연스럽다. low-profile보다 "극비"에 가깝고, confidential 같은 감시 어감도 없다 |

Korea는 넣는 것을 권한다. 국문 원문이 "방한"이고, 설명의 예시 하나에 Korea가 들어간다고 지표 전체가 방한으로 한정되지는 않는다(검토서, 두 번의 일관성 검수 모두 같은 판단).
"등"은 옮기지 않아도 된다(기준 R4 보완).

## 3. 보류: 지표 ③ 이름

지금 문구는 `Capital Raising & Liquidity Securing`이다. "Liquidity Securing"은 번역투(R1)지만, 아직 바꾸지 않는다.

| 후보 | 판단 |
|---|---|
| Debt & Equity Financing | 원어민은 IR 표준 용어라며 선호했다. 일관성 검수는 "유동성 확보"가 빠지고 수단이 둘로 좁아진다며 두 번 경계선 반려했다. 검토서도 보류를 권한다 |
| Capital Raising & Liquidity Buffers | 반려: 쌓아 둔 잔고(상태)라 "확보"(행위)와 다름 |
| Capital Raising & Liquidity Actions | 반려: 너무 넓고, 위기 대응처럼 어둡게 읽힘 |
| Capital Raising & Liquidity Support | 제외: "liquidity support"는 구제금융(중앙은행·모회사의 긴급 자금 지원)으로 읽힌다 |

이전 판은 "Debt & Equity Financing 아니면 지금 문구 유지"의 양자택일로 썼는데, 검토서 지적대로 과했다.
"조건을 다 만족하는 안을 찾지 못했다"는 것은 아직 다른 대안이 없다는 뜻이 아니다. 다음 순서로 정한다.

1. 이름이 포괄할 범위를 먼저 정한다. 질문: 부채·지분 조달만인가, 유동성 확보(신용한도, 자산 매각 등)까지인가?
2. 그 범위에 맞춰 대안을 다시 비교한다.

## 4. 이전 판에서 고친 것

| 항목 | 이전 판 | 고친 내용 | 근거 |
|---|---|---|---|
| 머리글 | BUSINESS DEVELOPMENTS | KEY DEVELOPMENTS | 용어 조사, 검토서 |
| 설명 ③④⑤ | 동명사구 세트로 통일 권장 | 철회. 설명마다 자연스러운 형식을 쓰고 쉼표 규칙만 통일 | 검토서. ⑤ "Undergoing leadership changes"는 수동적이고 범위가 넓었다 |
| ③ 이름 | 판단 요청(양자택일) | 보류. 범위를 정한 뒤 대안 비교 | 검토서 |
| "unannounced site visits" 근거 | 규제기관 불시 점검을 뜻하는 굳은 표현 | "site"가 붙어 점검처럼 읽힐 수 있고, 방한을 전하지 못함 | 검토서. "unannounced visit" 자체는 흔한 말이다 |
| "confidential" 반려 근거 | 감시 어감 + 보도와 모순 | 감시 어감만. 비공개였다가 나중에 알려질 수 있으니 모순은 아니다 | 검토서 |
| "Changing C-level executives" 근거 | 형용사로 읽힘 + 교체 어감 | 주된 문제는 "임원 교체"로 좁아지는 것 | 검토서 |
| 국문 "등" 누락 | 판단 필요 항목 | 문제 아님. 배타적 정의로 오해될 때만 본다 | 검토서 |

기준 문서도 같이 고쳤다(§2 용어 근거와 KEY DEVELOPMENTS, R2 근거 완화, R4 "등", R5 명확화, §5 버린 문구 추가, §6 기록).
일관성 검수자 지시(`.claude/agents/en-consistency-reviewer.md`)도 새 R5에 맞췄다.

## 5. 남은 판단

1. **설명 ③, ⑤ 후보 고르기** (§2). 추천안 두 개는 미검수다. 바로 고르거나, 에이전트 검수를 한 번 돌린 뒤 고른다.
2. **지표 ③ 이름의 범위** (§3)
3. **머리글을 국문판에도 적용할지** (C1). 국문 제목 "품목별 글로벌 사업동향"과는 뜻이 맞지만, "국문판은 바꾸지 않는다"는 원칙의 예외가 된다.

## 6. 레이아웃 확인

저장소 파일을 고치지 않고, 변경안을 메모리에서만 덮어써 고정 픽스처로 영문 PDF를 그려 쟀다.

- 검토서 권장 세트(C1 KEY DEVELOPMENTS, C2, C3, ③ "on a large scale"안, ④ 명사구, ⑤ "C-suite changes, low-profile"안): 9쪽, 잘림 0건, 줄 수 변화 없음
- ③ "Large-scale funding …"안, ⑤ "unannounced visits to Korea"안: 각각 따로 넣어 잼, 잘림 없음(칸 비율은 §2 표)
- 앞선 두 번의 실행에서 잰 세트 6개: 모두 9쪽, 잘림 0건
- 폭의 95% 이상이 찬 칸은 `signal_source`(0.96) 하나뿐이고, 변경 전부터 있던 것이라 이번 제안과 무관하다.
- C3 품목은 고정 픽스처에 해당 기업이 없어, 같은 칸에 넣어 따로 쟀다(0.658 → 0.665).

## 7. 반영하지 않은 의견 (참고)

- 표지 "investment promotion projects": 해외 임원은 "투자를 홍보하는 사업"으로 읽을 수 있다는 원어민 의견
- C2 반영 후 77개 기업을 누가 골랐는지 말하지 않게 된다. MOTIR가 기업도 골랐다면 그 사실이 영문에서 사라진다.
- 설명 ④ "PoCs": 미국 독자에게 people of color(POCs)가 먼저 떠오를 여지가 조금 있다. R&D 맥락이라 실제 오독 가능성은 낮다.
- 품목 카드 라벨 "{month} Developments"(Title Case)와 "Target technology"(sentence case)의 대소문자 차이: 기준에 라벨 규칙이 없다.
- 품목명 "Maximizing recycled (scrap) content …"만 동명사구다. 품목명은 나열이 아니라서 문제가 아니다.
- 테스트 입력값 `'T A R G E T - P R O D U C T   S I G N A L S'`(`tests/report_html.test.mjs:177`, `tests/report_pdf_web.test.mjs:16`)에 옛 용어가 남아 있다. 보고서에는 나오지 않는다.

## 8. 진행 기록

1. 첫 실행: 고쳐쓰기 → 검수 3명 → 반려 항목 2차. 사용자가 ⑤ "Changing C-level executives"의 어색함을 지적했다.
2. 기준·에이전트 지시 보완 후 재실행: 이전 결과를 모르는 새 에이전트로 처음부터 돌렸다.
   - 확정 문구, C1~C3, ⑤ Korea 넣기는 첫 실행과 같은 결론이 나왔다.
   - R5 해석에서만 결과가 갈렸다.
3. 머리글 용어 조사: developments가 표준어이고, trends와 product는 이 페이지에 맞지 않는다는 결론을 냈다.
4. 검토서 검토: 대부분 수용했다. "Liquidity Support"는 제외했고, ③ "Large-scale funding …"안과 ⑤ "unannounced visits to Korea"안을 추가했다.

## 9. 반영할 때 바뀌는 것

| 파일 | 바뀌는 곳 |
|---|---|
| `scripts/report_content.py` | `TEXTS["en"]["cover_line_1"]`, `TARGET_TECHNOLOGY_DISPLAY_EN["autonomous_imu_rf_baseband"]`, `INDICATOR_DESCRIPTION_EN[3]`·`[4]`·`[5]` |
| `scripts/build_pdf_report.py` | 품목 면 `report.header` 머리글 (1151행 부근) |
| `scripts/report_view_model.py` | 품목 면 `"kicker"` (153행 부근) |
| `tests/fixtures/report_snapshot/expected_pages_en.txt` | `python tests/test_report_snapshot.py --update`로 다시 생성 |
| `tests/fixtures/report_snapshot/expected_pages_ko.txt` | C1 머리글 한 줄(197행 부근) |
| `docs/report_wording_guide_en.md` | §6에 반영 항목과 승인 기록 추가 |
