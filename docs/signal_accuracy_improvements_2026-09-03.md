# 시그널 정확성 개선 구현 기록 (2026-09-03)

## 1. 목적과 범위

이 문서는 `docs/signal_accuracy_review_2026-09.md`의 감사 내용을 코드와 2026년 8월 산출물에
대조한 뒤 실제로 반영한 개선 사항을 기록한다. 최우선 기준은 **근거가 불완전한 행을 월간
보고서의 사실로 단정하지 않는 것**이다.

이번 변경은 다음 경로를 대상으로 한다.

1. AI 근거 판정과 캐시
2. 게시 전 입력 검증
3. PDF 반영 조건과 수집 커버리지 표현
4. GitHub Actions의 보고 기간
5. 정확성 감사 문서의 사실관계

수집기 자체의 소스 품질 개선, 스케줄 트리거, 실패 알림, 공식 RSS 목록 구축은 이번 변경 범위에
포함하지 않았다.

## 2. 재검증에서 확인한 문제

2026년 8월 기존 산출물은 수집 434건, 투자 시그널 후보 109행이었다. 기존 AI 판정을 적용하면
16개사·27칸이 살아 있었지만, 이 수치를 검증 정확도로 볼 수 없었다.

- 통과 행 5건은 판정 사유에서 타겟 기술과 직접 연결되지 않는다고 스스로 설명했다.
- 통과 행 3건은 `ai_summary_quality=needs_review`였다.
- 기업 상세 9개 중 4개는 `ai_signal_supported=false`인 행을 글로벌 사업현황으로 선택했다.
- 완료된 인수·투자·자금조달이 선행 시그널처럼 표시될 수 있었다.
- Cytiva 대상 행에 Cytiva가 등장하지 않는 Danaher 본사 자료가 연결되는 등 모회사 출처와
  타겟 기업의 사건 귀속을 구분하지 못했다.
- API 키가 없거나 AI 요청이 일부 실패해도 보고서 입력 파일을 훼손하거나 불완전한 결과를
  발행할 가능성이 있었다.
- 매트릭스의 `무신호`는 실제 미포착과 수집 근거 부족을 구분하지 않았다.
- 수동 워크플로 기본 기간이 2026년 7월로 고정돼 있었다.

## 3. 구현 내용

### 3.1 AI 판정을 다섯 개 근거 축으로 분리

파일: `scripts/summarize_signal_evidence.mjs`

프롬프트 버전을 투자 `signal-summary-koen-v6`, 사업동향 `business-summary-koen-v8`로 올렸다.
각 행은 다음 필드를 반드시 반환한다.

| 필드 | 의미 |
|---|---|
| `ai_entity_supported` | 사건이 타겟 기업·사업부·제품·임원에 명시적으로 귀속되는가 |
| `ai_target_technology_supported` | 사건이 유치필요 품목·기술과 직접 연결되는가 |
| `ai_indicator_supported` | 키워드가 아니라 지표 정의에 맞는 구체적 사건이 있는가 |
| `ai_leading_indicator_supported` | 완료된 후행 사건이 아니라 투자결정의 선행 징후인가 |
| `ai_event_stage` | `exploratory`, `planned`, `committed`, `completed`, `not_applicable`, `unclear` 중 사건 단계 |

투자 시그널은 모든 근거 축, `quality=pass`, 모델의 명시적 승인, 모순 없는 판정 사유를 모두
만족하고 사건 단계가 `exploratory` 또는 `planned`일 때만 `ai_signal_supported=true`가 된다.
사업동향은 기업 귀속과 타겟 기술 연결이 확인되고 `quality=pass`, `event_stage=not_applicable`일
때만 승인된다.

`needs_review`, 불명확한 단계, 완료·확정 사건, 판정 사유가 직접 관련성을 부정하는 행은
대시보드 검토용으로 남길 수 있지만 보고서 승인값은 false가 된다.

### 3.2 AI 실패 시 보고서 입력 보존

파일: `scripts/summarize_signal_evidence.mjs`

- 기본값을 `--optional false`로 바꿨다.
- API 키가 없으면 모든 요청 행에 현재 프롬프트 버전의 완전한 캐시가 있을 때만 결과를 재사용한다.
- 기존 입력 행에 붙은 동일 버전 판정도 완전한 캐시 적중으로 계산한다.
- 한국어·영어 요약, 판정 사유, 품질, 사건 단계, 다섯 boolean이 모두 있어야 완전한 판정이다.
- 투자 또는 사업동향 평가가 한 건이라도 실패하면 `latest_*` 보고서 입력을 덮어쓰지 않는다.
- 성공한 결과만 캐시에 저장하고 실행을 실패 상태로 종료한다.

### 3.3 게시 전 독립 검증기 추가

파일: `scripts/validate_report_inputs.mjs`

PDF 생성 전에 투자 시그널과 사업동향 JSON 전체를 검사한다. 다음 중 하나라도 발견되면 종료 코드
1을 반환해 게시를 중단한다.

- 필수 판정 boolean, 사건 단계, 양국어 요약 또는 판정 사유 누락
- 승인 행의 `quality`가 `pass`가 아님
- 승인 행의 기업 귀속·타겟 기술·지표·선행성 근거 누락
- 승인 사유가 직접 연관성 부재를 인정함
- 승인된 투자 행이 `committed`, `completed`, `unclear` 단계임

`package.json`의 `collect:all`과 GitHub Actions 모두 PDF보다 먼저 이 검증기를 실행한다.

### 3.4 PDF도 독립적으로 fail-closed 처리

파일: `scripts/build_pdf_report.py`

워크플로 검증기를 우회해 PDF 스크립트를 직접 실행하더라도 다음 조건을 모두 만족해야 행이
표시된다.

- `ai_signal_supported === true`
- `ai_summary_quality === "pass"`
- 네 가지 세부 근거 boolean이 모두 true
- 사건 단계가 `committed`, `completed`, `unclear`가 아님
- 판정 사유가 직접 관련성을 부정하지 않음

글로벌 사업현황 후보에도 같은 조건을 적용해 AI가 거부한 행이 상세 박스에 들어가는 문제를 막았다.

매트릭스 문구는 다음 세 상태로 변경했다.

- `시그널 포착`
- `공식자료 확인 후 미포착`
- `수집근거 부족`

여기서 공식자료 확인은 보고 기간 안에 게시일이 확인된 공식 수집 행이 있는지를 기준으로 한다.
따라서 수집하지 못한 회사를 `무신호`라고 단정하지 않는다.

### 3.5 워크플로 기간과 게시 순서 수정

파일: `.github/workflows/collect-company-signals.yml`

- 고정된 2026-07-01~2026-07-31 기본값을 제거했다.
- 두 날짜가 비어 있으면 `Asia/Seoul` 기준 직전 완료 월을 계산한다.
- 날짜는 반드시 두 개를 함께 입력해야 한다.
- 잘못된 날짜 또는 시작일이 종료일보다 늦은 범위는 중단한다.
- AI 요약을 명시적인 필수 단계로 실행한다(`--optional false`).
- PDF 생성 전에 게시 입력 검증 단계를 실행한다.

스케줄 트리거와 실패 알림은 아직 추가하지 않았다.

### 3.6 감사 문서 정정

파일: `docs/signal_accuracy_review_2026-09.md`

- 67%를 정확도라고 표현한 결론을 철회하고 AI false 판정 비율로 정정했다.
- 중복 33→9는 정확도가 아니라 중복 분류행 그룹 수임을 명시했다.
- 모회사 출처 표기만으로 기업 귀속 문제가 해결된다는 결론을 철회했다.
- 공식 페이지 수를 설정 파일 기준 314개로 정정했다.
- 분류 JSON 크기를 3,231,950 bytes, 3.08 MiB로 정정했다.
- 완료된 작업과 여전히 미검증인 작업을 구분했다.

## 4. 추가·변경 파일

| 파일 | 변경 내용 |
|---|---|
| `scripts/summarize_signal_evidence.mjs` | 다차원 판정, 선행성·단계 판정, 캐시 완전성 검사, 실패 시 입력 보존 |
| `scripts/validate_report_inputs.mjs` | 게시 전 fail-closed 검증기 신규 추가 |
| `scripts/build_pdf_report.py` | 엄격한 승인 조건, 사업현황 필터, 커버리지 구분 |
| `.github/workflows/collect-company-signals.yml` | 한국시간 기준 직전 월 계산, 입력 검증, 필수 AI 단계 |
| `package.json` | 테스트와 보고서 입력 검증 명령 추가 |
| `tests/report_input_validation.test.mjs` | 승인 경계 테스트 5개 |
| `tests/summarizer_fail_closed.test.mjs` | API 키 누락 시 입력 보존 회귀 테스트 1개 |
| `README.md` | 현재 파이프라인과 fail-closed 동작 설명 |
| `docs/signal_accuracy_review_2026-09.md` | 기존 감사의 부정확한 수치·결론 정정 |

## 5. 검증 결과

수행한 검증:

```text
node --check scripts/summarize_signal_evidence.mjs       통과
node --check scripts/validate_report_inputs.mjs          통과
node --test                                              6/6 통과
python -m py_compile scripts/build_pdf_report.py          통과
GitHub Actions YAML 파싱                                 통과
git diff --check                                         통과
```

추가 회귀 확인:

- API 키가 없고 현재 캐시가 불완전한 경우 종료 코드 1을 반환한다.
- 이 경우 투자·사업동향 입력 JSON의 내용이 바뀌지 않는다.
- 현재 저장된 v5/v7 산출물은 새 필드가 없어 검증기에서 차단된다. 오류 1,207건은 이 차단이
  동작한 결과이며 새 코드의 정상 산출물이 실패했다는 뜻이 아니다.
- 구형 산출물을 PDF 스크립트에 직접 넣어도 승인 행 0건으로 처리된다. 한글·영문 PDF는 각각
  매트릭스까지 2페이지로 생성됐고 상세 페이지는 생성되지 않았다.
- Next.js 빌드는 저장소에 `node_modules`가 없어 `next` 실행 파일을 찾지 못해 검증하지 못했다.

## 6. 현재 산출물 상태와 다음 실행 조건

현재 `outputs/latest_investment_signals.json`, `outputs/latest_relevant_signals.json` 및 공개 PDF는
새 v6/v8 판정으로 재생성한 자료가 아니다. 로컬에 `OPENAI_API_KEY`가 없어 실제 API 응답 품질도
검증하지 못했다.

따라서 다음 정상 GitHub Actions 실행에서 다음 조건을 확인해야 한다.

1. 저장소 secret `OPENAI_API_KEY`가 설정돼 있어야 한다.
2. 프롬프트 버전 변경으로 모든 대상 행을 다시 평가해야 한다.
3. `Validate report inputs (fail closed)` 단계가 통과해야 한다.
4. 통과 후 생성된 한글·영문 PDF의 기업 수, 매트릭스 칸, 근거 문장을 표본 검토해야 한다.

이 실행과 사람의 표본 검토 전에는 새 보고서의 실제 정확도가 확인됐다고 표현하지 않는다.

## 7. Codex hook 실패 진단

프로젝트의 `.git/hooks`에는 활성 Git hook이 없고 샘플 파일만 있다. 반복 표시된 hook은
`C:\Users\926264\.codex\hooks.json`에 등록된 전역 `code-review-graph` hook이다.

| 시점 | 실행 내용 | 제한 시간 |
|---|---|---:|
| 세션 시작·재개 | `code-review-graph status` | 10초 |
| Write/Edit/Bash 이후 | `code-review-graph update --skip-flows` | 30초 |

수동 `code-review-graph update --skip-flows`와 상태 조회는 이 저장소에서 정상 동작했다. 따라서
그래프 프로그램 자체보다는 다음 전역 hook 래퍼 문제가 유력하다.

- Windows 환경에서 `cat >/dev/null`, `|| true` 같은 POSIX 셸 문법 사용
- 세션 시작 hook이 Git 저장소가 아닌 상위 작업 디렉터리에서 실행될 가능성
- 설치된 플러그인 버전과 전역 `hooks.json`에 남은 명령의 불일치

이 hook은 코드 리뷰용 그래프를 자동 갱신하는 보조 기능이며 수집·분류·PDF 생성에는 필요하지
않다. 전역 사용자 설정은 이번 프로젝트 변경에서 수정하지 않았다. 계속 사용할 경우 Windows용
명령과 명시적인 저장소 경로로 갱신하고, 필요하지 않으면 두 hook을 비활성화하는 것이 적절하다.

## 8. 남은 정확성 작업

- 새 v6/v8 AI 판정 전량 재생성 및 사람 표본 검토
- 결과 0건 6개사 중 미점검 4개사의 소스 URL 확인
- 등록 공식 페이지 314개의 제외 링크 표본 확대 검토
- 날짜 미상 131건의 추가 복원 가능성 점검
- 타겟 기술 relevance 예외 9개사의 예외 정책 재검토
- 공식 RSS 목록 구축과 HTML 앵커 스크래핑 의존도 축소
- 수집 상세 본문 상한 전에 후보를 자르는 순서가 월간 기사를 누락시키는지 검증
- 스케줄 실행과 실패 알림 추가
- Next.js 의존성 설치 후 프로덕션 빌드 검증

## 9. 2026-09-03 GitHub Actions 실패 분석

### 9.1 확인한 실행

- Workflow run: `33732882509`
- URL: `https://github.com/KOTRA-InvestKOREA-HT/monthly_global_signal_monitoring/actions/runs/33732882509`
- 대상 커밋: `0dfe79589923ba0e2ffdb01c857969170c37343f`
- 실행 시각: 2026-09-03 17:21~17:41 KST
- 결론: `failure`

이 실행은 **크롤러에서 실패한 것이 아니다**. 단계별 결과와 시간은 다음과 같다.

| 단계 | 결과 | 소요시간 |
|---|---:|---:|
| 보고 기간 계산 | 성공 | 0초 |
| 회사 자료 수집 | 성공 | 299초(4분 59초) |
| 기술 관련성 필터 | 성공 | 1초 |
| 투자 시그널 분류 | 성공 | 10초 |
| AI 근거 평가 | 성공 | 885초(14분 45초) |
| 게시 입력 검증 | **실패** | 1초 미만 |
| 한글·영문 PDF 및 결과 커밋 | 실행 안 됨 | - |

체감상 오래 걸린 주된 원인은 크롤링보다 AI 근거 평가였다. 프롬프트 버전을 v6/v8로 올려
기존 캐시가 모두 무효화됐고, 투자 109행과 사업동향 65행 등 총 174행이 cache miss로 전량
재평가됐다. 이 중 일부는 Terra 재시도까지 수행했다. 다음 실행에서 동일 입력과 정상 캐시가
유지되면 이 비용은 반복되지 않아야 한다. 그러나 이번 실행은 검증 실패로 자동 커밋 단계가
건너뛰어졌으므로 새 캐시도 저장소에 보존되지 않았다. 현재 상태에서 다시 실행하면 174행 전량
평가가 반복된다. 한 번 정상 완료되어 새 캐시가 커밋된 이후부터 동일 입력의 캐시 재사용이 가능하다.

### 9.2 실제 오류

실패 단계는 `Validate report inputs (fail closed)`이며 다음 5개 사업동향 행에서 동일한 계약 위반이
발견됐다.

```text
West Pharmaceutical
  west-completes-sale-and-transfer-manufacturing-and-supply-rights

Umicore
  strong-start-of-the-year-sets-umicore-up-for-solid-2026-performance

EMM(Umicore)
  strong-start-of-the-year-sets-umicore-up-for-solid-2026-performance

Norsk Hydro
  hydro-at-a-glance

Norsk Hydro
  on-the-agenda
```

각 행의 오류는 다음과 같다.

```text
supported row is not quality=pass
```

즉 각 행에서 `ai_signal_supported=true`였지만 `ai_summary_quality=needs_review`여서, 승인된 행은
반드시 `quality=pass`여야 한다는 게시 규칙을 위반했다. 검증기는 오류 5건을 출력한 뒤 의도대로
종료 코드 1을 반환했다. GitHub의 `Process completed with exit code 1`은 이 결과를 표시한 마지막
문구이며 근본 오류 메시지가 아니다.

### 9.3 코드상 원인

`scripts/summarize_signal_evidence.mjs`의 모델 응답 처리 시점에는 `quality=pass`를 포함해
`ai_signal_supported`가 계산된다. 이후 사업동향 요약이 목표 분량에 미달하거나 Terra 재요약이
실패하면 `summarizeRow()`가 다음 값만 사후 변경한다.

```text
ai_summary_quality = needs_review
ai_summary_reason  = ...목표 분량 미달 또는 Terra 재요약 실패
```

이 사후 변경 시 `ai_signal_supported`를 false로 다시 계산하지 않아 `supported=true`와
`quality=needs_review`가 동시에 남을 수 있다. 이번 5건이 그 상태다. 따라서 오류 종류는
**크롤링·네트워크 실패가 아니라 AI 재시도 후 판정 상태 불일치**다.

게시 전 검증기가 이 불일치를 발견했기 때문에 잘못된 PDF와 JSON은 커밋·배포되지 않았다.
사용자 지시에 따라 이 분석에서는 원인만 기록했으며 코드는 수정하지 않았다.

## 10. 2026-09-04 판정 상태 불일치 수정

### 10.1 수정 내용

파일: `scripts/summarize_signal_evidence.mjs`

9.3에서 기록한 원인을 수정했다. quality를 사후에 낮추는 두 경로가 `ai_summary_quality`만
바꾸고 `ai_signal_supported`는 그대로 두던 문제다.

`downgradeSummaryQuality(summary, reason)`를 추가하고 두 경로가 모두 이 함수를 거치도록 했다.
이 함수는 `ai_summary_quality=needs_review`, 새 판정 사유, `ai_signal_supported=false`를 항상 함께
설정한다. 따라서 `supported=true`와 `quality=needs_review`가 동시에 남을 수 없다.

적용한 두 경로는 다음과 같다.

| 경로 | 상황 |
|---|---|
| Terra 재요약 성공 후 재검사 | 사업동향 요약이 재요약 후에도 기준 미달 |
| Terra 재요약 예외 | Terra 호출 자체가 실패해 Luna 결과로 회귀 |

투자 시그널 경로는 원래 `quality=pass`를 승인 조건에 포함해 계산하므로 이미 일관됐고, 이번
변경으로 달라지지 않는다.

### 10.2 판정 사유 정확성 수정

같은 파일에서 `needsTerra()`를 `terraReason()`으로 분리했다. 기존에는 재요약이 필요한 이유가
분량·한국어 비중·품질·확신도 등 여러 가지인데도 다운그레이드 사유를 항상
`Terra 결과도 목표 분량 미달`로 기록했다.

현재 저장된 산출물의 `needs_review` 28건은 전부 이 문구를 달고 있으나, 그중 한국어 요약이
220자 기준을 넘는 행이 14건이다. 즉 실제 트리거는 분량이 아니라 모델 확신도 또는 품질 판정인데
사유가 분량 미달로 잘못 기록돼 있었다. 이제 사유에 실제 트리거가 그대로 남는다.

### 10.3 테스트 실행 가능하게 변경

`scripts/summarize_signal_evidence.mjs` 하단의 `main()` 호출에 `validate_report_inputs.mjs`와 같은
`import.meta.url === pathToFileURL(process.argv[1]).href` 가드를 씌웠다. 이전에는 import만 해도
`main()`이 실행돼 단위 테스트를 붙일 수 없었다. CLI 동작은 바뀌지 않는다.

### 10.4 실패한 실행의 AI 판정 캐시 보존

파일: `.github/workflows/collect-company-signals.yml`

기존에는 자동 커밋 단계가 게시 검증과 한글·영문 PDF 생성까지 모두 성공해야 실행됐다. 그런데
커밋 대상에 `outputs/ai_summary_cache.json`이 포함돼 있어서, 검증에서 멈추면 이미 계산을 마친
AI 판정 캐시가 함께 버려졌다. 9.1에서 기록한 14분 45초짜리 174행 평가 결과가 이렇게 사라졌고,
같은 상태로 재실행하면 동일 비용이 그대로 반복된다.

`if: failure()` 조건의 캐시 보존 단계 두 개를 잡 마지막에 추가했다. 실패한 실행에서도
`outputs/ai_summary_cache.json`만 따로 커밋한다. 성공한 실행은 기존 단계가 캐시까지 함께
커밋하므로 이 단계가 돌지 않고, 커밋이 중복되지 않는다.

보고서 입력 JSON과 PDF는 보존 대상이 아니다. 검증을 통과하지 못한 산출물을 게시하지 않는다는
기존 fail-closed 원칙은 그대로 유지된다.

### 10.5 검증 결과

로컬에 Node가 없어 이전 기록에서 실행하지 못한 검증을 이번에는 수행했다. Node v24.20.0을
`C:\Users\926264\AppData\Local\Programs\nodejs`에 설치하고 사용자 PATH에 등록했다.

```text
node --check scripts/summarize_signal_evidence.mjs   통과
node --check scripts/validate_report_inputs.mjs      통과
node --test                                          9/9 통과
python -m py_compile scripts/build_pdf_report.py     통과
```

`tests/summary_quality_downgrade.test.mjs`를 추가했다(3개). 다운그레이드가 승인값을 함께
내리는지, 다운그레이드된 사업동향 행이 게시 검증을 통과하는지 확인한다.

실제 실패 데이터로도 재현·확인했다. `outputs/latest_relevant_signals.json`에서
`ai_signal_supported=true`이면서 `quality!=pass`인 행은 7건이며, 이 행들에
`downgradeSummaryQuality()`를 적용하면 `supported row is not quality=pass` 오류가 7건에서 0건이 된다.

### 10.6 아직 확인되지 않은 것

- 저장된 산출물은 여전히 구형 v5/v7 판정이라 검증기 전체 실행은 계속 실패한다(오류 1,207건).
  이는 6절의 조건대로 `OPENAI_API_KEY`가 있는 정상 실행에서 전량 재평가해야 해소된다.
- 이번 변경은 판정 상태 일관성만 보장한다. 실제 AI 응답 품질은 여전히 미검증이다.
- Next.js 프로덕션 빌드는 의존성을 설치하지 않아 이번에도 검증하지 않았다.

### 10.7 후속 판단이 필요한 사항

현재 계약상 `quality=needs_review`인 행은 승인될 수 없다. 그런데 저장된 산출물의
`needs_review` 28건은 모두 근거 부족이 아니라 요약 분량·확신도 같은 서술 품질 사유다. 이
정책을 그대로 두면 근거가 확인된 행도 요약이 짧다는 이유로 글로벌 사업현황 박스에서 빠진다.

분량 미달과 근거 부족을 별도 필드로 분리할지, 아니면 현행 fail-closed를 유지할지는 정책 결정이
필요하므로 이번 변경에서는 손대지 않았다.
