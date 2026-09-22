# 지표 ID 참조와 모델 입력 영어화 — 적용 결과

`docs/model_input_cleanup_handoff_2026-09-22.md`의 구현이다. 모델 API는 호출하지 않았다.

## 적용 내용

새 변환 계층 `scripts/model_input.mjs`가 모델이 보는 표현만 정한다. 한국어 원본, 저장된 `row`,
설정 파일, 수집·분류 키워드, 한국어 PDF·화면 표기는 바뀌지 않는다.

- **지표는 ID로 참조한다.** 후보에서 `indicator`, `description`을 제거했다. 판정 기준 3번을
  "각 후보의 `id`가 아래 목록에서 지표를 고른다"로 고쳐 제거한 필드를 더 이상 가리키지 않는다.
  `description_en`은 만들지 않았다. 언어만 맞추고 중복은 남는 선택이기 때문이다.
- **타겟 기술은 원본과 입력 표현을 분리했다.** 후보에 `target_technology_en`을 보낸다. 이 값은
  `data/company_technology_map.json`에 이미 있었고(77개 전부, 한글 잔존 0), 연결은 배열 순서가
  아니라 `company`+`target_no`로 한다. `row.target_technology`의 한국어 원본은 그대로다.
- **기술 범위의 키 이름을 고쳤다.** 판정 기준은 `target_technology_scope.includes`와 `.excludes`를
  보라고 말하는데, 전달된 객체의 키는 `includes_ko`·`excludes_ko`·`includes_en`·`excludes_en`이었다.
  지시문이 부르는 키가 객체에 없었다. 중단된 실행에서 범위가 실린 기사 16건이 그 상태로 판정됐다.
  이제 영어 쪽만 골라 `includes`·`excludes`로 보낸다.
- **번역 누락은 준비 단계에서 멈춘다.** 빈 문자열이나 한국어로 조용히 대체하지 않고
  `technology_group`과 함께 예외를 낸다. `sourceCandidates`와 `modelCandidate` 양쪽에서 검사하므로
  `groupArticles`를 직접 부르는 경로도 지나치지 못한다. 기술 면제는 번역 면제가 아니다.
- **표시용 날짜 문구는 전송에서만 뺀다.** `date_label`("2026.09.08 (게시일 근거 충돌)")과
  `date_note`("게시일 근거가 서로 어긋남")이 말하는 것은 `date_status`·`date_placement`·
  `published_at`에 구조화되어 있다. 기사 객체에는 남긴다. `date_note`는 날짜 보강 목록이 쓰고
  `date_label`은 사람이 읽는 표시다.
- **기사 원문은 손대지 않았다.** `evidence`·제목·본문의 한국어·일본어·독일어를 지우거나 번역하지
  않는다. 인용 검증이 원문 문장에 기댄다.

## 캐시 식별자

두 가지가 서로 다른 범위로 움직인다.

- **기술 번역**은 `groupArticles`의 `material`에 들어간다. 한 기업의 번역을 고치면 그 기업의 기사
  ID만 달라지고 나머지는 그대로다. 테스트로 고정했다.
- **전송에서만 빼는 필드**는 기사 자료가 그대로여서 ID에 나타나지 않는다. 그 몫은 프롬프트 계약에
  넣은 `MODEL_INPUT_VERSION`(`model-input-v1`)이 맡는다.

이번 변경은 지표 제거·기술 영어화가 `material`에 들어가므로 392건 전부의 기사 ID가 달라진다.
같은 자료로 재구성해 확인했다: **기사 ID 유지 0 / 392**. 한국어 원본이 같다는 이유로 다른 영어
입력의 판정이 재사용되지 않는다. 기존 376건과 운영 캐시는 삭제하지 않았다.

## 측정

중단된 실행의 같은 392건으로 이전·이후 요청을 만들어 비교했다.

| | 이전 | 이후 |
| --- | --- | --- |
| 사용자 메시지 평균 | 7,702자 | 7,303자 |
| 평균 한글 | 250.6자 | 0.2자 |
| 최대 한글 | 865자 | 30자 |

남은 30자는 BorgWarner 기사 2건의 원문 한국어다. 이것은 근거이므로 보존한다.

시스템 지시문의 한글 213자도 그대로다. 전부 `## Summary wording` 절의 한국어 문안 규칙과
`§5`의 시제 대응(`예정·계획·가능성`)이라 남아야 한다.

토큰 절감량은 측정하지 않았다. 문자 수 감소를 토큰 절감으로 읽지 않는다.

## 확인해야 할 것: 제거한 한국어 설명과 영어 기준의 의미 차이

인계 문서가 요구한 대조다. 영어 기준이 곧 유일한 정의가 되므로 차이가 남으면 승인 범위가 바뀐다.
**아래 세 건은 영어 기준이 더 넓다. 이번 작업에서 임의로 좁히거나 넓히지 않고 그대로 두었다.**

| | 제거된 한국어 | 영어 기준 | 차이 |
| --- | --- | --- | --- |
| S1 | 특정지역 의존도 축소·공급망 다변화·규제 리스크 대응 등 | supplier diversification, localized sourcing or production, raw-material procurement agreements, responses to tariffs, export controls or regulation | "특정지역 의존도 축소"에 해당하는 구절이 없다. 수집 키워드에는 `탈중국`·`중국 의존도`가 있다 |
| S2 | **APAC** 신규 시설 확장 검토·생산기지 타당성 조사 등 | Plans or studies to add capacity, equipment or production sites… | 영어에 지역 한정이 없다. 모든 지역의 증설이 들어온다 |
| S3 | **대규모** 회사채 발행·유상증자·신용공여 조달 등 | New funds raised… bonds or notes, equity issuance, new credit or loan commitments, **investment rounds and grants** | 규모 조건이 없고, 투자 라운드·보조금이 영어에만 있다 |

S4와 S5, 사업동향은 의미가 대응한다. S5의 `극비`는 문체 수식이라 누락으로 보지 않는다.

이 차이는 이번 작업이 만든 것이 아니라 판정 기준을 영어로 옮긴 단계에서 생겨 한국어 설명이
가리고 있던 것이다. 한국어 설명을 함께 보내던 동안에는 모델이 둘 다 읽었고, 어느 쪽을 따랐는지는
알 수 없다. 세 건을 영어 기준에 반영할지는 승인 범위의 결정이므로 사용자 확인이 필요하다.

## 테스트

`node --test`: 398개 통과, 실패 0개. 새 파일 `tests/model_input.test.mjs` 9개.

- 모든 후보가 `id`로 기준을 가리키고, 기준 문서에 그 `id`의 정의가 실제로 있다.
- 기준이 제거한 필드를 더 이상 참조하지 않는다.
- 모델은 영어 기술을, `row`는 한국어 원본을 가진다.
- 번역 누락이 `technology_group`과 함께 드러나고, 면제로 우회되지 않는다.
- 범위가 지시문이 부르는 키 이름으로 전달된다.
- Gemini·NVIDIA의 1차·수리·2차 검증 요청 모두에 `indicator`·`description`·`date_label`·
  `date_note`가 없다. 검증 요청이 후보를 좁히는 동작은 유지된다.
- 기사 원문의 한국어가 보존된다.
- 입력 계약 버전이 바뀌면 다이제스트가 달라진다.
- 한 기업의 번역을 고치면 그 기업의 기사 ID만 달라진다.

기존 픽스처에 `target_technology_en`을 채웠다. 채우지 않으면 새 검사가 준비 단계에서 멈춘다.

## 한계

입력 끝의 한국어가 문안 품질에 준 영향은 측정되지 않았다. 이 작업이 확실히 한 것은 중복 정의
제거와 언어 혼용 축소, 그리고 지시문이 가리키는 범위 키가 실제로 전달되게 한 것이다. 문안 품질과
토큰 절감은 별도 실험으로 측정해야 한다.

## 관련 문서

- `docs/model_input_cleanup_handoff_2026-09-22.md`: 이 작업의 인계 문서.
- `docs/english_review_contract_2026-09-22.md`: 판정 기준 영어화 및 영어 `reason` 계약.
- `docs/summary_rule_deduplication_2026-09-22.md`: 공통 문안 규칙 중복 정리.
