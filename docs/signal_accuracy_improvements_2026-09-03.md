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
