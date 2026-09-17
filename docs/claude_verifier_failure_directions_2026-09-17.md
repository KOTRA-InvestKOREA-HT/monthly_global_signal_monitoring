# Claude 수정 지시: Flash-Lite 2차 검증 이후 실패 원인과 최소 수정 방향

## 0. 범위와 결론

검토 기준 HEAD: `efea0d6`. 최신 아티팩트 `article-review-35200022672-1` 및 동일 실행의 Actions 로그를 대조했다. 이전 `article-review-35197626547-1/status.json`도 비교했다.

**최신 실행의 직접 실패 원인은 모델 API 장애가 아니라 Charles River 영문 S4 문안의 PDF 잘림이다.** 다만 그 앞 단계에도 첫 검증을 재시도로 오인하는 버그, 미완료를 검증 성공으로 집계하는 문제, 검증 프롬프트 캐시 식별 누락이 확인됐다. 모델을 다시 바꾸거나 재시도 횟수만 늘리지 말고 이 경로를 먼저 고친다.

사용자는 API 비용 때문에 Judge/Writer/Verifier 3단계 분리를 취소했다. 이를 재추진하지 않는다. 현 모델과 2단계 구조를 유지하고, 새 유료 서비스·모델 전환·전체 rereview·검증 비활성화를 해결책으로 삼지 않는다. 이번 문서는 조사 및 수정 지시이며 구현을 완료했다는 의미가 아니다.

## 1. 실행별 증거를 섞지 말 것

### 최신 실행 35200022672

- 실행 커밋: `efea0d60f3cf3e069b5e2be4042db63bd1a45ecb`.
- 1차 provider/model: `gemini` / `gemini-3.5-flash-lite`. 2차 모델도 `gemini-3.5-flash-lite`.
- 판정 단계 로그: 전체 요청 40회, 캐시 328건, 완료 363/364, 1차 실패 Skyworks 1건.
- 2차 집계: 요청 35회, 변경 12개 기사, 실패 1개 기사, `evidence_mismatch` 오류 응답 3회. 요청 횟수와 기사 수를 혼용하지 말 것.
- `recheck_pending`은 4개 기사다. Applied Materials S4, Boeing S4, Nexeon S3, Nabtesco 사업동향.
- 한국어 PDF 생성 단계는 통과했고 매트릭스는 6/8/23/40. 이 숫자 자체가 판정 정확성을 증명하지 않는다.
- 최종 실패 로그: `Report text would be cut (en): [{"company":"Charles River","part":"signal 4"}]`.
- 따라서 한영 PDF 업로드·자동 발행 단계는 건너뛰었다. 한국어 생성 로그만으로 새 보고서 발행 성공이라 말하지 말 것.
- 최종 `status.json`은 `failed / validation_or_execution`만 남아 앞선 상세 판정 상태가 사라졌다.

이전 35197626547의 `status.json`에는 `paused / verifier_unavailable`, HTTP 429, `credits_exhausted`가 있다. 이는 최신 실행의 PDF 실패와 다른 문제다. 이를 전부 “Flash-Lite 장애”로 묶지 말 것. 35198796190의 전건 검증 거부 경위는 현재 코드 주석에도 있으나, 이 문서의 재현·판단은 최신 실행을 중심으로 한다.

로그: https://github.com/KOTRA-InvestKOREA-HT/monthly_global_signal_monitoring/actions/runs/35200022672

아티팩트 내 현재 snapshot: `2026-08-8858ea1067532acf4036abfb/snapshot.json`. 이전 실행 snapshot과 diagnostics도 함께 보관돼 있으므로 파일 개수를 이번 실행 건수로 계산하지 말 것. `run.id`, SHA, diagnostic `created_at`을 맞춘다.

## 2. P0: 검증 첫 시도가 재시도로 취급됨

관련: `scripts/review_report.mjs`의 `requestReview()`, `verify()`, `salvageCandidateEvidence()`.

`verify()`는 첫 호출부터 `retry={mode:'verify', ...}`를 넘긴다. `requestReview()`는 `if (problem && retry && ...)`로 재시도 여부를 판단한다. 따라서 첫 검증 응답도 이미 재시도한 것으로 보고 다음 우회 처리를 실행한다.

- 날짜 오류 힌트를 폐기하고 결과를 반환.
- 숫자 오류를 경고로 낮추고 결과를 반환.
- 인용·문안 근거 오류 후보를 salvage하여 요약을 비우고 pending을 붙인 뒤 결과를 반환.

그 결과 `verify()`의 catch에 들어가지 않아 `efea0d6`에서 추가한 “검증 응답을 한 번 더 묻기”가 작동하지 않는 경우가 생긴다.

실제 최신 로그:

| 기사 ID | 기업·후보 | 실제 결과 |
|---|---|---|
| c59af946e87a4ec744d8ba08 | Applied Materials S4 | salvaged → pending인데 verified 로그 |
| 8c985f991f9df7f22a6cd0b7 | Boeing S4 | salvaged → pending인데 verified 로그 |
| ba671c03e4aa601d013965ee | Nexeon S3 | precursor로 수정됐지만 문안은 빈 문자열, pending |
| 80cb5d530ea4cd0f09cce27e | Nabtesco relevant | 실제 throw 경로로 두 번 시도 후 실패 |

오프라인 재현도 확인했다. Charles River 실제 snapshot/review를 입력으로 삼고 S4 인용만 의도적으로 틀린 문자열로 바꾼 mock 응답을 첫 verify 호출에 반환하니, 네트워크 mock 1회 후 예외 없이 `candidate_evidence_unverified`가 반환됐다. 실제 API는 호출하지 않았다.

### 수정 요구

1. 작업 모드(`review`/`verify`)와 보정 시도 횟수(`validationAttempt` 등)를 명시적으로 분리한다. 객체의 truthiness로 재시도 여부를 판단하지 않는다.
2. 첫 검증 응답의 검증 오류는 구조화된 오류로 전달하고, 해당 검증에 한해 최대 한 번 보정한다. 전송 오류 횟수와 형식 보정 횟수를 별도로 관리하되 모든 요청은 공통 예산에 포함한다.
3. 보정 후에도 실패하면 해당 후보만 pending. 다른 후보를 잃지 않되, 검증 실패를 통과로 바꾸지 않는다.
4. 숫자 검증을 경고로 낮추는 기존 정책은 이번에 무심코 확대하지 않는다. 최소한 첫 verify 응답에는 “재시도 후 완화”를 적용하지 않는다. 판정 규칙 변경 없이 호출 단계 해석부터 바로잡는다.

## 3. P0: pending을 성공으로 집계하지 말 것

현재 `verify()`는 `mergeVerification()` 결과에 pending이 남아도 `verifierStop.succeeded++`와 `verified` 로그를 실행한다. 실제로 성공하지 않은 결과가 “검증기 정상 동작”으로 집계돼 중단 조건에도 영향을 준다.

### 수정 요구

- 요청 대상 후보의 결과를 기준으로 `verified / partially_verified / pending / rejected_response`를 구분한다. 모델이 근거로 탈락 판정을 내린 것은 유효한 검증 완료이며, 응답 형식 오류·근거 미검증과 다르다.
- `succeeded`는 검증 대상 후보가 실제 검증 계약을 통과했을 때만 증가시킨다. 부분 완료는 따로 집계한다.
- “형식 검증 통과”와 “내용 판단의 정확성”도 구별한다. 검증 완료를 정확도 향상으로 보고하지 않는다.
- pending 후보가 AI 승인으로 발행되지 않는 기존 안전장치는 유지한다. 빈 문안의 투자 후보는 실질적으로 카드에 못 실릴 수 있으므로 “모두 사람 검토로 발행됐다”고 쓰지 말고 실제 발행·제외를 각각 센다.
- 성공률 집계와 pending 건수가 저장된 후보 상태에서 일관되게 산출되는 회귀 테스트를 추가한다.

## 4. P0: PDF 잘림은 문안/렌더링 문제로 국소 수정

Charles River 기사 `4b8856267676b6ea91d733f1`의 S4 영문은 519자다. NGS, virus seed bank, CMC, IND, global clinical development까지 한 카드에 넣은 검증 결과가 저장돼 있다. 한국어는 통과하지만 영문 `signal 4`가 넘쳐 실행이 실패했다.

### 수정 요구

- 이 저장 판정으로 한영 PDF를 먼저 로컬 재현한다. 판정과 인용은 고정하고, Charles River 문안을 양 언어에서 같은 핵심 사실을 유지하도록 줄인 뒤 둘 다 렌더링 검증한다.
- `REPORT_ALLOW_CUT_TEXT=true`, 무조건적인 글자 자르기·문장 버리기, 전역 글꼴 축소로 통과시키지 않는다.
- 장기적으로 잘림 탐지 결과를 문안 보정 대상으로 전달할 수는 있으나 전체 판정 재요청을 만들지 않는다. 자동 문안 보정 API를 새로 추가하려면 요청 예산과 범위를 별도 제시한다. 이번 최소 수정은 저장 문안 국소 수정 + 실제 PDF 회귀 검증으로 충분하다.
- 다음 무수정 재실행이 같은 긴 문안을 계속 재사용하면 동일하게 실패할 수 있다. 모델 재시도만 고쳤다고 해결 완료로 보고하지 않는다.

## 5. P1: 실제 검증 프롬프트가 캐시 식별에서 빠짐

관련: `scripts/review_prompts.mjs`의 `LEGACY_VERIFY_CONTRACT`, `promptContract()` 및 `scripts/review_report.mjs`의 `cachedRecheck()`.

현재 primary digest에는 실제 검증 프롬프트 대신 고정된 과거 검증 문자열을 넣는다. 검증 기록에는 `VERIFICATION_VERSION='verifier-v2'`와 모델명을 저장하지만, `cachedRecheck()`는 저장된 `verification.version`이나 모델명을 현재 값과 비교하지 않는다. 버전/모델/검증 지시를 바꿔도 완료된 캐시 검증이 자동 갱신되지 않는 경로다.

### 수정 요구

- 1차 캐시를 전부 무효화하지 않고, 실제 검증 지시·스키마/계약 버전·검증 모델·추론 설정을 반영한 `verification_digest`를 별도로 만든다.
- 검증 성공 결과에 digest를 저장하고 캐시 재사용 시 비교한다. 빠졌거나 달라졌으면 필요한 후보만 2차 검증하며 1차 판정은 재구매하지 않는다.
- 검증기의 오류로 탈락·보류됐던 후보도 재검증에서 빠지지 않게 이전 `verification.candidate_ids`와 필요한 1차 근거를 보존한다. 이미 수정된 결과만 보고 후보를 다시 선택하면 이전 승인이 잘못 탈락한 상태로 고착될 수 있다.
- fixed legacy 문자열은 숨겨진 현재 계약처럼 유지하지 말고, 과거 primary 캐시를 보존하기 위한 명시적 1회 마이그레이션/호환 처리로 분리한다.
- 동일 입력은 재호출하지 않으며 검증 지시 변경 시 검증만 갱신된다는 테스트를 요구한다. 취소된 3단계 파이프라인을 만들 필요는 없다.

## 6. P1: 실패 진단 보존

- 최종 catch가 상세 `status.json`을 최소 오류 상태로 덮어쓰지 않게 한다. 이번 실행의 상태만 읽어 `review_state`와 `build_state`를 함께 기록하고 `failed_stage`, 언어, 회사, 위치, 오류 코드를 남긴다. 이전 실행 상태를 현재 상태로 가져오지 않는다.
- verifier의 각 실패 시도도 1차 diagnostics처럼 기록한다. run ID·article ID·후보·모델·시도 횟수·검증 메시지·실패한 인용/문안 및 대응 원문을 남기고 비밀 값은 제거한다.
- 현재는 Nabtesco 검증 오류의 구체 메시지가 영속 diagnostics에 남지 않아 원문 어느 구간이 틀렸는지 재구성할 수 없다. API를 다시 호출해 로그를 얻는 방식부터 피한다.

## 7. 구현 순서 및 완료 조건

1. 최신 저장 자료로 첫 verify salvage 문제와 Charles River 영문 잘림을 실패 테스트로 고정한다.
2. 모드/시도 분리와 pending 집계를 수정한다. 아직 원인 자료가 없는 기업별 프롬프트 예외를 추가하지 않는다.
3. 검증 digest 및 실패 진단을 수정한다. 1차 판정 캐시는 보존한다.
4. 저장 문안 국소 수정으로 한영 PDF를 다시 만들고 잘림·누락·근거 일치를 확인한다.
5. `npm test`, 관련 Python/PDF 테스트를 실행한다. mock 통과를 “실제 모델로 33건 검증 성공”처럼 표현하지 않는다.

필수 회귀 항목:

- 첫 verify의 인용/요약 오류 → 보정 1회 → 성공 또는 해당 후보 pending. 후보 일부가 유효하다는 이유로 첫 응답 오류 보정을 생략하지 않음.
- 검증 대상 밖 dummy 응답은 기존 판정을 덮지 않으며, 대상 후보의 누락/중복/잘못된 인용은 여전히 거부함.
- 숫자 오류의 첫 검증이 재시도 후 경고 경로로 우회하지 않음.
- pending을 succeeded로 집계하지 않음. 모델의 유효한 탈락 판단과 검증 응답 오류를 구분함.
- 검증 digest 변경 → 검증만 갱신. 동일 digest → 완료 검증 재사용.
- Charles River 한영 실제 렌더링 통과. 영문 실패 시에도 상세 판정 상태 보존.
- 인증/할당량 오류에 무제한 재시도하지 않음. 기존 출처·날짜·기술 연결·한영 검증을 약화하지 않음.

실제 API 실행은 비용·무료 할당량 확인 후 별도 승인 범위다. 최소 표본에서 검증하기 전에 전체 rereview를 켜지 않는다. 모델이 바뀐 뒤 판정 내용까지 더 나빠졌는지는 이번 로그만으로 단정할 수 없다. 원문 대조 평가 없이 승인·사업동향 숫자를 과거와 같게 맞추지 않는다.

구현 결과에는 코드 수정, 오프라인 테스트, 실제 모델 평가, PDF 재생성을 각각 구분해 보고한다. 이 지시서만으로 운영 실행·모델 교체·추가 과금·전체 재판정 권한을 추정하지 않는다.
