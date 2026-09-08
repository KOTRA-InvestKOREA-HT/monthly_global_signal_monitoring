# 2026-08 AI review 오탈락 조사 및 변경 계획

조사일: 2026-09-08. 대상 브랜치: `feat/local-monthly-report`, HEAD `76b6bff`.
코드·프롬프트·리뷰·캐시·게시 산출물을 수정하지 않았고, 모델 API와 워크플로를 실행하지 않았다. 이 문서만 추가했다. 최근 날짜 처리와 DATE_HINT_VERSION의 동작·수정은 조사에서 제외했다.

**추천안은 하나다. 승인식을 유지하고, 프롬프트에서 기술 적합성·구체적 활동·선행성·사건 단계·근거 충분성을 독립적으로 판정하도록 명확히 한다. 특히 기존 기술 면제의 우회 무효화와 전조 활동의 committed 오분류부터 고친다.** 범용 기술 관련성 확대, quality 자동 승격, committed 일괄 승인은 하지 않는다.

## 1. 조사 기준과 재현 가능한 자료

- 기준 snapshot: `C:/Users/926264/Downloads/article-review-34180547079-1/2026-08-4346bcef12d55a7eb64189fc/snapshot.json`
- 기사별 판정: 같은 아티팩트의 `reviews/ARTICLE_ID.json`.
- 기준 정책: `article-review-v1:1f62e799d58400a86ee82ba8`.
- 모델: `nvidia / deepseek-ai/deepseek-v4-flash-0731`.
- 기준 raw 490행 → review 254기사 → 후보 1,524개(사업동향 254, 투자 1,270) → relevant 10, investment 3.
- 투자 승인 3개는 모두 지표 4이며, 해당 기사는 사업동향에도 승인됐다.
- 최신 `outputs/latest_relevant_signals.json`의 10개 cache key가 모두 기준 snapshot의 기사 ID와 일치했다. 저장된 254개 review를 현재 `importReview`로 읽어 모두 통과했고, 승인 10/3도 재현했다.
- `outputs/ai_summary_cache.json` 및 예전 classification JSON은 다른 파이프라인의 자료이므로 이 집계에 섞지 않았다.

아티팩트 전체에는 다른 준비본도 남아 있다. raw 498/293기사 준비본은 relevant 9/investment 3이고, 현재 정책 hash의 raw 490/302기사 준비본은 정확히 일치하는 review 파일이 0개다. 마지막 `status.json`은 이 302기사 실행의 429 중단 기록이므로, 254기사 게시 결과의 실패 기록으로 해석하면 안 된다. 세 준비본이나 reviews 폴더 전체를 합산하면 기사·리뷰 버전이 중복된다.

이 조사는 저장된 evidence를 기준으로 모델이 무엇을 판단할 수 있었는지를 검토했다. 기사 속 사건이 외부 현실에서도 사실인지 별도로 재취재한 결과는 아니다. 보완이 필요한 기사에 외부 지식을 넣어 기존 evidence로 승인 가능한 것처럼 취급하지 않았다.

## 2. 현재 승인 조건

구현 근거: `scripts/local_report.mjs`의 `sourceCandidates`, `groupArticles`, `importReview`; `scripts/validate_report_inputs.mjs`의 `investmentStageSupported`, `validateRows`; `docs/local_report_review.md`의 판정 기준; `scripts/review_providers.mjs`의 SYSTEM/RETRY 지침.

| 조건 | relevant | investment |
|---|---|---|
| 기업 귀속 | entity_supported=true | 동일 |
| 기술 연결 | target_technology_supported=true 또는 기존 relevance_exempt | 동일 |
| 구체적 사건 | 구체적 기술·사업 활동을 indicator_supported로 판정 | 해당 지표의 indicator/description에 맞는 사건 |
| 선행성 | true로 정규화; 투자 선행성 심사 없음 | leading_indicator_supported=true |
| 단계 | not_applicable로 정규화 | exploratory/planned 또는 지표 1·3·4·5의 precursor |
| 근거 충분성 | quality=pass | 동일 |
| 승인 증빙 | evidence 내 정확한 인용 1개 이상, 한·영 문안, 사유, 스키마·일관성 검증 | 동일 |

지표 2에는 precursor를 허용하지 않는다. 최종 시설투자·인수의 committed/completed, unclear는 투자 승인 대상이 아니다. 이미 끝난 시설투자도 구체적 사업 활동이므로 relevant에서는 승인할 수 있다.

각 review는 모든 후보를 정확히 한 번씩 다뤄야 한다. 잘못된 ID·자료에 없는 인용·승인 문안 누락 등은 정상적인 부적합 판정과 달리 validation failure다. 승인식에서 제외되더라도 입력한 인용의 원문 일치 검사는 적용된다. `quality=pass`는 적합이라는 뜻이 아니라 근거에 기초한 판정이 가능하다는 뜻이며, 명확한 부적합도 pass다.

원자료 중 review 대상으로 잡힌 모든 기사에 지표 5개와 relevant가 생성된다. 이 경로에서는 종전 keyword score나 technology classifier threshold 때문에 일부 투자 후보가 AI에 전달되지 않는 병목은 없다. 490→254의 모집단 차이를 AI false negative로 계산하지 않았다.

## 3. 탈락 사유 집계

아래 조건별 수치는 중복 집계다. 예를 들어 기술 연결이 없고 사건도 없으면 두 열에 모두 포함된다. `target_technology_supported=false`는 면제 후보에서는 실제 차단 사유로 세지 않았다.

| 실제 차단 조건 | relevant / 254 | investment / 1,270 | 이 조건 하나만 실패: relevant / investment |
|---|---:|---:|---:|
| entity_supported=false | 131 | 655 | 0 / 0 |
| 기술 연결 부족, 면제 아님 | 210 | 1,050 | 0 / 0 |
| indicator_supported=false | 244 | 1,256 | 8 / 0 |
| leading_indicator_supported=false | 0 | 1,258 | 0 / 0 |
| 승인 불가 event_stage | 0 | 1,267 | 0 / 9 |
| quality=needs_review | 104 | 516 | 0 / 0 |
| 최종 승인 | 10 | 3 | — |

relevant의 배타적 조합은 다음과 같다. E=기업 귀속 부족, T=기술 연결 부족(면제 반영), I=활동 부족, Q=needs_review.

| 조합 | 기사 수 |
|---|---:|
| T+I | 99 |
| E+T+I | 30 |
| I | 8 |
| E+T+I+Q | 76 |
| I+Q | 1 |
| T+I+Q | 5 |
| E+I | 3 |
| E+I+Q | 22 |
| 승인 | 10 |
| 합계 | 254 |

투자 단계는 not_applicable 696, unclear 561, committed 9, completed 1, precursor 3이고 exploratory/planned는 0이다. 이 중 단계만 막는 9후보는 6기사에 걸쳐 있다: Applied 실적(S2/S4), Applied–UC Berkeley(S4), Ouster 실적(S3), HyProMag/Remloy(S2), Nexeon 자금조달(S2/S3/S4), Moderna/BioSpace(S4). **9개를 전부 풀어도 되는 것은 아니다.** 최종 시설투자, 용도 부족, 본문 부재 사례가 섞여 있다.

본문 보유 여부는 snapshot의 candidate.row.content_text 비어 있음 여부로 집계했다. 길다고 유효한 본문이라는 뜻은 아니다.

| 저장 본문 | 기사 수 | relevant needs_review | relevant pass |
|---|---:|---:|---:|
| content_text 있음 | 128 | 7 | 121 |
| content_text 없음 | 126 | 97 | 29 |
| 합계 | 254 | 104 | 150 |

quality만 없애서 회복되는 후보는 0개다. relevant needs_review 104개 중 97개가 본문 없는 기사다. 따라서 quality 문턱의 일반적 완화보다 본문 확보와 필드 간 판단 오염을 분리하는 것이 우선이다. 본문이 없는데 pass인 29개는 제목만으로 명백한 무관함을 판단한 사례도 포함하므로 모두 오류는 아니다. 반대로 Moderna/BioSpace의 제목만으로 한 승인은 아래 precision 경계 사례다.

보조 준비본(293기사)의 중복 조건 집계도 방향이 같다: relevant E162/T245/I284/Q130, 승인9; investment E810/T1225/I1453/L1454/Q645/단계1462, 승인3(총1,465후보). 기준 254기사와 합산하지 않았다.

**병목 해석:** indicator가 수치상 최대 병목이지만, 사유를 읽으면 다른 필드의 실패를 그대로 복제한 경우가 있다. 특히 기술 면제 기업 36기사 중 기업 귀속이 true이고 relevant 활동이 false인 것은 9기사다. 이 중 6개는 배당·일정·일반 이사 선임 등으로 탈락이 타당하고, 나머지 3개(Applied 실적, Applied CD-SEM, Amkor 사절단)는 구체적 활동이 있는데 기술 연결 부재를 재요구했다. 면제를 새로 늘릴 필요 없이 기존 면제를 정확히 적용할 문제다.

## 4. 오탈락 의심 실제 기사 10개

확실한 오탈락과 확인이 필요한 의심 사례를 구분한다. 숫자를 10개 맞추기 위해 10개 모두 승인을 권고하지 않는다. 아래 원문 구절은 저장된 evidence에서 읽은 것이며, 실제 승인 시에는 문맥을 보존한 완전한 인용을 선택해야 한다.

1. **Applied Materials — Third Quarter 2026 Results** (`219d8b0d592f616cb1b56a58`)
   - [기사](https://ir.appliedmaterials.com/news-releases/news-release-details/applied-materials-announces-third-quarter-2026-results)
   - relevant는 기업 귀속=true, 기술 면제=true, quality=pass인데 기술 연결이 없다는 이유로 indicator=false. S4는 indicator/leading=true인데 공동연구 확정을 committed로 판정했다.
   - 근거: “Announced three additional EPIC Center partnerships.” Broadcom의 advanced chip packaging, UC Berkeley의 material/process innovations, SCREEN SPE의 co-optimized process solutions가 이어진다. 구체적 신제품·싱가포르 제조시설 확장도 있다.
   - **강한 FN:** relevant와 S4. 기술 면제를 indicator에서 되돌리면 안 되며, 연구협력 체결은 precursor다. 이미 확장한 싱가포르 캠퍼스 자체를 S2 전조로 바꾸지는 않는다. 별도 장기 제조능력 투자 발언은 구체성·확정성 추가 판독이 필요하다.

2. **Applied Materials — Bringing Next-Generation CD-SEM Metrology to the Fab** (`281cf43bd98c17134e49238e`)
   - [기사](https://www.appliedmaterials.com/us/en/newsroom/blogs/bringing-next-generation-cd-sem-metrology-to-the-fab.html)
   - 저장 사유가 “기술 면제 대상이지만 품목 연계가 없어 부적합”이라고 명시한다.
   - 근거: “Applied Materials ® developed the VeritySEM 20” 및 High-NA EUV 계측 제어·정밀도 개선 설명. 실제 제품 개발 활동이다.
   - **강한 FN:** relevant. target_technology=false를 유지하고 기존 면제로 승인 가능하다. 단독 제품 개발을 외부 공동연구 S4로 추가하지 않는다.

3. **Amkor — Arizona-Korea Semiconductor Delegation** (`aa2f449804dba3ee4e9006fb`)
   - [기사](https://amkor.com/blog/arizona-korea-semiconductor-delegation/)
   - 기업 귀속·기술 면제는 true인데 방열소재 연결 부재로 relevant indicator=false, quality=needs_review.
   - 근거: “Construction is underway on Amkor’s Arizona campus”와 회사의 한국 경제사절단 참여, 정부·산업·학계와 투자 기회 탐색을 위한 면담 계획. 저장 본문 4,814자에 실제 사업 활동이 있다.
   - **강한 FN:** relevant. 기술 면제 대상이므로 방열소재 미언급을 근거 부족으로 쓰면 안 된다. 다만 CEO 인용문·서명만으로 CEO 본인의 방한·실사를 확정할 수 없다. S5는 전략적 참가자·역할 연결을 더 확인해야 하며 이번 최소 변경의 확정 회복분으로 세지 않는다. 건설 중 시설은 S2 전조로 승인하지 않는다.

4. **Applied Materials — UC Berkeley to Join EPIC Center** (`d44c9c800f8fb06a55fc9701`)
   - [기사](https://ir.appliedmaterials.com/news-releases/news-release-details/uc-berkeley-join-applied-materials-epic-center-speed-chip)
   - relevant는 승인됐다. S4는 기업 귀속·면제·indicator·leading·quality가 모두 충족하지만 stage=committed만 차단한다.
   - 근거: UC Berkeley가 “will join … as a research collaborator”; 연구 대상은 AI computing의 material/process innovations로 구체화돼 있다.
   - **강한 FN:** S4 precursor. 연구협약의 확정과 최종 생산시설 투자 확정을 혼동한 사례다.

5. **Nexeon — National Wealth Fund backs £100m investment round** (`14c94ba7b4cb44dd0aa5d068`)
   - [기사](https://www.nexeonglobal.com/media/national-wealth-fund-backs-nexeon-in-gbp100m-investment-round)
   - relevant 승인, S2/S3/S4는 indicator/leading/quality가 모두 충족하지만 모두 committed로 차단됐다.
   - 근거: 투자 라운드 £100m 완료, NWF £52.6m, Honda Xcelerator Ventures 및 KDB 참여. 자금은 “development of a UK-based pilot manufacturing facility”, R&D와 advanced manufacturing technology unit 확대에 사용된다.
   - **강한 FN:** 사업 확장 용도가 명시된 S3 자금 확보는 precursor. 실리콘 음극재 기술의 상용화·확장을 위한 전략적 투자 참여 S4도 precursor 재판정 근거가 강하다. S2는 영국의 후속 pilot 계획을 이미 가동한 군산 공장과 분리해서 planned 여부를 판단해야 한다. 이번 권고에서는 S2를 자동 회복으로 세지 않는다.

6. **NXP — Trimension UWB / BMW Digital Key Plus and Presence Detection** (`2c8b096122bf8350a19e4aa5`)
   - [기사](https://media.nxp.com/news-releases/news-release-details/nxp-trimension-ultra-wideband-powers-bmw-groups-digital-key-plus)
   - relevant T/I=false. 그러나 본문에 “first monolithic automotive UWB solution”과 “robust short-range radar capabilities”가 명시돼 있다. 단순 디지털키 기사로만 읽으면 레이다 기능을 놓친다.
   - **범위 확인이 필요한 FN 후보:** 타겟 표기는 “위성통신 및 레이다용 RF 반도체”지만 산업 매핑은 우주항공이다. 자동차 단거리 레이다를 의도한 범위에 포함하는지 명확하지 않다. 활동의 존재는 인정하되, 이번 prompt 수정에서 산업 범위를 넓혀 자동 승인하지 않는다. 범위가 확정되면 이 구절로 relevant T를 재판정한다.

7. **Charles River — Second-Quarter 2026 Results** (`d04371d8505d4221ebe47169`)
   - [기사](https://ir.criver.com/news-releases/news-release-details/charles-river-laboratories-announces-second-quarter-2026-results)
   - relevant와 S4에서 타겟 기술 무관으로 탈락. 본문에는 Arovella와 “in vitro Next Generation Sequencing (NGS) services” 협력이 있고, 저장 사유도 그 협업 존재는 인정한다.
   - **확인 필요:** NGS라는 분석 방식만으로 바이러스 검증·MCB/WCB 특성분석을 확정할 수 없다. 승인된 Medigen 기사와 비교하되 같은 분석 방식이라는 이유만으로 기술 연결을 복사하지 않는다. 바이러스 안전성·세포은행에 대한 해당 과제의 목적이 현재 evidence에 부족하면 계속 보류한다.

8. **Evonik — Strong Second Quarter** (`c980fa0dd5f86c302b0bb343`)
   - [기사](https://www.evonik.com/en/news/press-releases/2026/08/q2-2026.html)
   - relevant T/I=false. 본문에는 “higher demand for precipitated silicas”에 따른 Inorganics 사업 매출 증가가 있다. “관련 사업 활동이 없다”는 사유는 이 대목을 충분히 설명하지 못한다.
   - **부분 연결만 확인:** 침강실리카 제품 활동은 있지만 타이어용·친환경 범위와의 직접 연결은 본문만으로 불충분하다. 그 연결을 기존 타겟 정의 안에서 인용할 수 있을 때만 relevant 승인. 경쟁사 공급 병목의 수혜를 S1 공급망 대응으로 바꾸거나, 고성능 폴리머 증설을 침강실리카 S2로 옮기지 않는다.

9. **Ouster — BlueCity REV8 Utah Traffic Expansion** (`c9b69b447972f66c3812f46e`)
   - [기사](https://investors.ouster.com/news-releases/news-release-details/ouster-bluecity-rev8-lidar-wins-multimillion-dollar-utah-traffic)
   - relevant T/I=false. 본문은 OS1 Max Rev8, 160개 추가 교차로, Econolite와의 구체적 시스템 사업을 설명한다.
   - **관련 제품이나 승인 보류:** 로봇용 라이다가 타겟인데 사건은 교통 인프라 배치다. 회사 소개의 robotics, 같은 Rev8 제품군만으로 타겟 적용을 증명하지 않는다. 기존 evidence에 동일 모델의 타겟 로봇 기능·용도 연결이 없다면 이번 최소 변경에서는 계속 탈락. 상업적 공급 계약을 자동으로 S4 공동연구로 바꾸지 않는다.

10. **Ouster — Earnings Release** (`a148981f689392d25a2ba1bf`)
    - relevant는 승인. S3는 ATM 주식 발행 대금 때문에 indicator/leading/quality=true지만 completed로 탈락했다.
    - 근거: 현금흐름표의 “Proceeds from the issuance of common stock under at-the-market offering”와 97,985(표 단위 thousands).
    - **단계 오류 가능성과 근거 부족이 공존:** 조달 완료는 S3 precursor가 될 수 있지만, 이 기사에서는 그 대금의 투자·사업 확장 용도가 확인되지 않는다. 별도의 자본지출·인수 지출 항목과 임의로 연결하지 않는다. 단계만 고쳐 승인하면 FP가 될 수 있다. 현재 승인 제외를 유지하고 leading의 근거를 재검토한다.

결론적으로 10기사 중 5기사는 현행 계약으로 복구할 근거가 강하고, 나머지 5개는 범위·과제·용도 연결 확인이 필요하다. 강한 사례의 보수적 검증 목표는 relevant 3후보와 investment 4후보(S4 두 Applied 기사, Nexeon S3/S4)다. 이는 API 재실행으로 검증한 증가량이나 목표 출력 건수가 아니다. 같은 사건을 실적 기사와 개별 보도자료가 반복할 수도 있으므로 투자 후보 수와 독립 투자 사건 수를 구분해야 한다.

## 5. 네 핵심 필드에 대한 판단

| 필드 | 판단 | 최소 조치 |
|---|---|---|
| target_technology_supported | 비면제 후보의 문턱 자체가 과도하다고 일반화할 근거는 부족. 다른 사업부 기사 탈락은 대체로 정상. 기존 면제가 indicator/quality에서 되돌려지는 오류는 명확 | 기술값은 사실대로 유지. 면제를 다른 필드에서 재요구하지 않도록 명시. 업종·용도 확장은 별도 결정으로 남김 |
| leading_indicator_supported | 수치상 대부분 false지만 지표 사건 부재와 중복. 단독 병목은 0. 자금 용도 등 precision 보호에 필요 | 지표 사건이 확인되면 그 사건에 맞는 전조 근거만 판단. 기술 부족이나 다른 지표 실패를 복제하지 않음 |
| event_stage | 투자에서 실제 단독 병목 9후보. 연구협력·자금 확보의 체결/완료를 최종 시설투자 확정과 혼동 | 기사 전체 대신 후보별 사건에 단계 부여. 구체적 연구협력·사업 확장용 조달은 precursor, 최종 시설투자·인수는 committed/completed 유지 |
| quality=pass | 전체 문턱을 낮출 이유 없음. 단독 병목 0, 본문 부족이 주류. Amkor에서는 면제 기술 부족 때문에 과도하게 needs_review | 후보 판정의 근거 충분성만 평가. 제목만으로 용도·기술·파트너십을 추정하지 않음. 명확한 부적합 pass와 근거 부족 needs_review 구분 |

투자 5개와 relevant를 한 응답으로 묻는 구조에서 필드 사이의 판단 복제는 의심되지만, “6개를 함께 물어서 성능이 떨어졌다”는 인과관계까지 입증한 것은 아니다. 이번 변경에서 호출을 후보별로 6분할하거나 모델을 바꾸지 않는다.

## 6. 추천하는 단일 최소 변경안

**판정 기준 prompt에 다음 독립 판정 절차와 대비 사례를 넣는다.** 실제 수정은 아직 하지 않았다. 변경 위치는 `docs/local_report_review.md`의 `## 판정 기준` 본문으로 제한하는 것이 가장 작고 정책 digest에도 반영된다.

1. 후보마다 먼저 사건·주체·기술 근거를 구별한다. entity/technology/indicator/leading/quality 중 하나가 실패해도 다른 필드 값을 그 실패에 맞춰 복제하지 않는다.
2. `relevance_exempt=true`이면 target_technology 값은 그대로 평가하되, 그 부족을 indicator 또는 quality의 탈락 사유로 다시 사용하지 않는다. 신제품·실제 제조 활동·구체적 연구협력은 활동으로 평가하고, 배당·일정 안내·일반 인사는 계속 제외한다.
3. 단계의 대상은 후보의 사건이다. “협약을 맺었다”, “자금조달이 완료됐다”는 이유만으로 최종 시설투자가 committed인 것은 아니다. 지표 3은 조달 사건과 사업 확장 용도 인용, 지표 4는 특정 기술 과제/협력·전략적 기술 투자 인용이 확인되면 precursor로 판단한다.
4. 기사에 과거 가동시설과 미래 pilot 개발이 함께 있으면 두 사건을 섞지 않는다. S2는 별도 계획 자체의 구체성·확정성을 읽고, 최종 시설투자 확정·인수 완료나 단순 확장 가능성을 precursor로 돌리지 않는다.
5. quality는 해당 후보의 판단 근거 충분성이다. 다른 후보가 불명확하다는 이유로 모두 needs_review로 만들지 않는다. 반대로 근거 부족을 “명확한 부적합이 아님”이라는 이유로 pass/승인하지 않는다.

대비 사례는 가능하면 다른 월 기사나 별도 예시로 작성하고, 아래 20개 평가 기사·문장을 그대로 prompt에 넣어 평가 정답을 노출하지 않는다.

**절대 유지할 것:** entity_supported 필수, 기존 면제 목록, 비면제 기술 연결 필수, 지표별 구체적 사건과 전조 근거, 사업 확장 용도 없는 현금·유동성의 제외, 지표 2 precursor 금지, 최종 시설투자·인수의 committed/completed 제외, quality=pass 필수, exact evidence quote, ID·후보 완전성·enum·boolean·문안·논리 일관성의 deterministic validation. 표기 정규화를 의미 기반 fuzzy quote matching으로 바꾸지 않는다. 재시도 실패 시 모든 후보를 승인하거나 quality를 자동 변경하는 보정도 하지 않는다.

이 권고는 새 승인 조건을 추가하는 것보다 현행 문서가 이미 의도한 판정을 모델이 일관되게 수행하도록 하는 수정이다. 정책 변경 전후의 actual model 응답을 확인하기 전에는 precision 유지·recall 개선을 달성했다고 선언할 수 없다.

기준 policy hash를 재현한 과거 커밋 `f85fba5`의 판정 기준에도 기술 면제와 “협업 계약·조달의 확정을 최종 투자 확정으로 분류하지 않는다”는 설명이 이미 있었다. 따라서 위 두 오류는 최신 기준을 과거 결과에 소급 적용해서 발견한 차이가 아니라, 당시에도 존재했던 판정 계약의 적용 실패다.

## 7. 비교용 golden set 제안: 20기사 / 120후보

아래는 **사람 검토용 잠정 정답표**다. 저장된 AI 결과를 정답으로 복사한 것이 아니다. R=relevant, S1~S5=투자 지표. 보류는 승인하지 않는다는 뜻이며, quality/각 boolean은 근거 유무에 따라 별도로 확정한다. 표에서 설명하지 않은 다른 후보도 모두 독립 라벨링해야 한다.

| # | 기사 ID | 기사 / 검증 목적 | 기대 판정 또는 경계 |
|---|---|---|---|
| 1 | 219d8b0d592f616cb1b56a58 | Applied Q3 실적 | R 승인, S4 precursor; 완료된 싱가포르 시설 자체로 S2 승인 금지 |
| 2 | 281cf43bd98c17134e49238e | Applied CD-SEM | R 승인, T=false/면제 유지; 단독 제품 개발만으로 S4 금지 |
| 3 | aa2f449804dba3ee4e9006fb | Amkor 한국 사절단 | R 승인, Q=pass; CEO의 직접 방한·실사를 인용 없이 만들지 않음 |
| 4 | d44c9c800f8fb06a55fc9701 | Applied–UC Berkeley | R 유지, S4 precursor |
| 5 | 14c94ba7b4cb44dd0aa5d068 | Nexeon £100m | R 유지, S3/S4 precursor; S2 후속 pilot 계획 별도 판독 |
| 6 | 2c8b096122bf8350a19e4aa5 | NXP UWB/BMW | 레이다 기능을 읽되 우주항공 범위 미확정 상태로 자동 승인 금지 |
| 7 | d04371d8505d4221ebe47169 | Charles River Q2 | NGS 과제의 바이러스/세포은행 목적 없이는 R/S4 보류 |
| 8 | c980fa0dd5f86c302b0bb343 | Evonik Q2 | 침강실리카와 타이어 용도 연결 확인; 경쟁사 병목 수혜를 S1로 승인 금지 |
| 9 | c9b69b447972f66c3812f46e | Ouster BlueCity | 교통 인프라와 로봇 용도를 동일시하지 않음; 영업 계약을 R&D로 변환 금지 |
| 10 | a148981f689392d25a2ba1bf | Ouster Q2 / ATM | R 유지; 사업 확장 자금 용도 없이 S3 승인 금지 |
| 11 | ca32ab44533e46fb169d76ae | Ouster–GUSS | 기존 R/S4 양성 유지; 로봇 적용·구체적 통합 계획 |
| 12 | dcb954c492651c37999f9ebe | Charles River–Medigen | 기존 R/S4 양성 유지; 바이러스 시드 뱅크 특성분석 명시 |
| 13 | f0e21debb717a307f35cee05 | HyProMag / Remloy | R/S4 유지; 완료 인수·확보시설을 S2 전조로 우회 금지 |
| 14 | 75bf7e11137933e19bd45a98 | Nexeon Gunsan ISO 9001 | R 유지; 확장 가능한 설계만으로 S2 계획 승인 금지 |
| 15 | ba535126a61bdbbe816c4ece | Albemarle Q2 | R 유지; 현금·부채 감축·capex 전망을 S3 조달로 승인 금지 |
| 16 | d337176310b62c74a7bc467b | Ouster/Stereolabs–Trossen | 기업 귀속은 인정, 스테레오 카메라를 라이다 기술로 승인 금지 |
| 17 | 39578b8ea9ece8ccd17d3442 | Evonik Vancouver GMP | 실제 투자라도 지질 의약 사업을 타이어 실리카로 승인 금지 |
| 18 | c9337ee3091d380aac2eb0a5 | Cytiva에 매핑된 Danaher CEO | Cytiva 명시적 연결 없는 모회사 인사: entity 게이트 유지 |
| 19 | a8b2ba39d95bf6df054576d2 | Moderna/BioSpace | 현재 R 승인도 재검토: 제목만 있고 전달체/GMP 근거 없음. R/S4 승인 보류, quality 과신 방지 |
| 20 | 4255205cb4d265a95ea97086 | 3M Quarterly Dividend | 기술 면제 기업이라도 배당은 R/S1~S5 탈락 유지; 면제 적용 교정의 오승인 방지 |

평가 계획:

- 20개 snapshot evidence를 고정하고, 사람이 후보별 entity/technology/indicator/leading/stage/quality/허용 인용과 사유를 먼저 확정한다. NXP 산업 범위와 Nexeon S2처럼 미합의된 후보는 disputed로 표시하고 확정 precision/recall 계산에서 분리한다. 부족한 근거로 승인하지 않는 동작은 별도 검증한다.
- 동일 NVIDIA 모델·provider·입력으로 기존 응답과 새 prompt를 비교한다. 프롬프트만의 효과를 보려면 provider 기본값이 바뀌어도 동일 모델을 명시적으로 고정한다.
- 후보별 승인 변화와 필드 변화, validation failure·재시도 수를 기록한다. relevant와 각 투자 지표를 분리해서 precision/recall을 계산한다.
- 알려진 오탈락의 교정 여부와 기존 확인된 양성 유지, 음성·본문 부족 사례의 신규 오승인 0건을 통과 기준으로 삼는다. 오류로 의심되는 기존 Moderna 승인을 유지해야 할 양성으로 세지 않는다.
- 정확한 인용을 validator가 통과했다는 사실과 인용이 승인 주장을 실제로 뒷받침한다는 사실을 사람이 별도로 확인한다.
- 이 표는 의도적으로 어려운 사례를 선택했으므로 월 전체 precision/recall 추정 표본이 아니다. 안정성 검증 이후 별도의 미사용 holdout을 추가하고, 규칙을 튜닝한 20개 점수를 전체 성능처럼 보고하지 않는다.
- 같은 기사·사건의 반복 보도는 독립 사건의 증가로 세지 않는다. 평가 단위는 우선 후보, 보조로 기사와 사건 그룹이다.

## 8. 캐시와 API 범위 계산

`review_report.mjs`는 기사 하나당 후보 6개를 한 번에 요청한다. review 파일은 article ID 단위이며, provider/model/reviewer 버전과 `importReview` 검증이 맞아야 재사용한다. article ID에는 기사 내용·evidence·후보 메타데이터·policy가 반영된다. policy digest에는 provider/model, 판정 기준 문서 추출문, 기술 매핑 전체, 지표 정의 전체가 들어간다.

따라서 **후보 4개만 바꾼다고 4번 요청하는 구조가 아니며**, 이미 relevant가 승인됐어도 같은 기사의 투자 후보가 틀렸으면 기사 단위로 다시 요청해야 한다. 전 기사에 투자 후보 5개가 있으므로 “탈락 후보가 하나라도 있는 기사”를 선택하면 기준 254기사 전부가 선택된다.

반대로 `review_providers.mjs`의 SYSTEM_INSTRUCTION/RETRY_INSTRUCTION만 수정하면 그 문자열 자체는 현행 policy digest 입력에 들어가지 않아, 이전 review가 계속 재사용될 수 있다. 이번 권고를 hash에 포함되는 판정 기준 문서에 두는 이유다. provider prompt를 수정하는 별도 구현을 택한다면 내용 평가 버전 반영이 필요하며, 날짜 버전으로 대신 처리하지 않는다.

| 실행안 | 내용 리뷰 API 요청 수: 최초 시도 기준 | 캐시/자료 재사용 |
|---|---:|---|
| 이번 조사 | 0 | 저장본만 읽음 |
| 기존 254기사·동일 입력/정책/provider/model | 0 | 254개 검증된 review 전부 재사용 가능 |
| golden 20개 새 prompt 1회 비교 | 20 | 기존 응답 20개를 baseline으로 재사용; 나머지 234개는 재판정하지 않음 |
| golden 기존·새 prompt를 모두 새로 실행 | 40 | 모델 변동을 포함한 동일 시점 비교. 기존 저장본 비교와 구분 |
| golden 양쪽 3회 반복 | 120 | 선택 사항. 분산 확인용이며 최소안은 아님 |
| 우선 재검토 12기사만 별도 실행 | 12 | 기준 242기사 보존. 12개 모두 golden 20 안에 있으므로 golden 후 중복 호출 불필요 |
| 수정 정책을 기준 254기사에 현행 방식으로 전면 적용 | 254 | raw/evidence 재사용; 새 정책의 review는 전부 필요 |
| 현재 코드로 현재 490 raw를 그대로 실행 | 302 | 현재 생성 기사 ID 중 기존 파일 일치 0; 내용 리뷰 최소 302회 |

우선 12개는 위 분석 10개 + HyProMag/Remloy + Moderna/BioSpace다. 앞의 10개는 의심 원인 재판독, 뒤의 2개는 단계만 실패하는 후보를 무조건 올리는 오류를 막기 위한 재검토다. 12개 선택은 자동 배치 규칙이 아니라 이번 수동 조사 목록이다.

**중요한 구현 제약:** 20개/12개 선택 실행과 나머지 보존은 향후 격리 평가용 실행 경로·명시적 대상 목록을 마련한다는 계획이다. 현재 production CLI가 이 선택적 정책 갱신을 그대로 지원한다는 뜻이 아니다. 현행 정책 digest를 바꾸면 전체 ID가 바뀌므로, 기존 캐시 파일을 새 ID로 이름만 바꾸거나 policy hash를 유지해 새 평가가 된 것처럼 취급하면 안 된다. 가장 작은 첫 검증은 20개만 별도 namespace에서 평가하고 운영 결과는 그대로 보존하는 방식이다.

현재 생성되는 302기사 중 기준 254기사 모두는 policy를 제외한 모델 입력 내용·후보 메타데이터가 동일함을 비교했다. 내용자료는 재활용할 수 있지만 새 정책 평가 결과까지 같다고 볼 수는 없다. 현재와 저장본의 정책 ID 차이는 식별자로만 기록하며, 날짜 규칙 차이의 원인 분석이나 수정은 이번 범위에서 하지 않는다. 현행 full run은 최소 302회지만, 이번 prompt 효과 비교 모집단은 기준 254/선택 20으로 고정한다.

최초 응답이 모두 정상이라고 가정한 수치다. 모델 응답 validation 재시도가 각 기사에서 한 번씩 필요하면 20→40회, 254→508회, 302→604회가 된다. 일시적 네트워크·5xx 재시도는 추가될 수 있고 429로 중단될 수 있다. 실행당 현재 최대 요청 예산은 400이므로 254/302건 전면평가는 재시도 상황에 따라 여러 회차가 필요하다. 이 수치는 내용 리뷰 요청만이며 범위 밖 보조 요청은 합산하지 않았다.

저장 usage로 계산한 규모(향후 요금·정확한 토큰 예측 아님):

| 모집단 | 저장 prompt tokens | 저장 completion tokens | 합계 |
|---|---:|---:|---:|
| golden 20기사 | 98,462 | 22,114 | 120,576 |
| 우선 12기사 | 60,911 | 13,761 | 74,672 |
| 기준 254기사 | 853,012 | 220,117 | 1,073,129 |

새 prompt의 토큰 증가, 출력 변동과 재시도 때문에 실제 사용량은 달라진다. 모델/provider 변경 시 이 비용 표본도 새로 측정해야 한다. 요금 API나 실제 모델 API는 호출하지 않았다.

## 9. 실행 순서와 최종 권고

1. 기준 snapshot과 20개 잠정 정답을 고정하고 disputed 후보의 범위를 명시한다.
2. 승인식·기술 매핑·validator는 유지한 채 판정 기준 prompt의 독립 필드·면제·사건 단계 설명만 수정한다.
3. 별도 namespace에서 동일 모델로 20회 비교한다. 인용·기업 귀속·기술 범위·음성 사례 회귀를 먼저 통과시킨다.
4. 통과한 뒤 필요한 전체 범위를 재평가할지 결정한다. 현행 운영 경로에 새 policy를 적용하려면 기준 254기사 또는 현재 준비본 302기사의 새 리뷰가 필요함을 예산에 반영한다. 20개 결과로 나머지 캐시를 새 정책 결과라고 자동 승격하지 않는다.

추천은 **문턱 완화가 아니라 판정 계약을 정확히 적용하는 prompt 수정 1건**이다. 기술 면제를 실제로 적용하고, 연구협력·사업 확장용 자금 확보를 최종 시설투자와 구분한다. entity_supported, 정확한 evidence quote, deterministic validation과 quality=pass 게이트는 유지한다. 외부 근거가 부족한 의심 기사를 억지로 올리지 않으며, 실제 검증 전 승인 건수의 증가를 성과 목표로 두지 않는다.
