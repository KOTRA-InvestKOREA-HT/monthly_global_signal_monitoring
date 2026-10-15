# 전체 코드 감사 — 수정할 사항 (2026-10-15)

기준 커밋: `67e369d`. 서브에이전트 4개(수집 / 판정·문안 / 렌더링 / 웹·CI·저장소)로 읽기 전용 감사를 했고, 아직 아무것도 고치지 않았다.
줄 번호는 이 커밋 기준이다. 고칠 때 다시 확인한다.

- 확인 = 코드를 읽거나 직접 실행해서 확인함
- 추정 = 코드상 그렇게 보이지만 실제 영향은 데이터나 설정에 달림
- 🔴 높음 · 🟠 중간 · 🟡 낮음

---

## 0. 우선순위 요약

1. 🔴 호수 기본값 "2" 제거 (§4-1)
2. 🔴 검증기 정지 규칙이 계속 같은 곳에서 멈추는 문제 (§2-1)
3. 🔴 설정을 덮어쓰는 생성 스크립트 제거 또는 수정 (§1-2)
4. 🔴 공식 출처의 확장자 없는 PDF 경로 (§1-1)
5. 🔴 HTML 상세 페이지 넘침 검사 (§3-1)
6. 🟠 CI 테스트 워크플로 추가 (§4-9)
7. 🟠 시간대와 없는 날짜 처리 (§1-3, §1-4)
8. 🟡 죽은 코드 정리: reportlab 그리기 코드, 레거시 스크립트, `outputs/review_*`
9. 🟡 중복 정리, docs 아카이브

### 직접 결정이 필요해서 보류한 것
- API 라우트에 앱 차원 인증(middleware)을 둘지. 지금은 Vercel 배포 보호 하나에만 기대고 있다 (§4-3).
- 무시 목록 키를 달별·기사(url)별로 바꿀지 (§4-6).
- git 히스토리 용량(95.9MiB). 매달 4.8MB JSON과 PDF를 다시 커밋한다. Release 자산 등으로 옮길지.
- `docs/`의 한글 이름 참고 PDF·로고를 옮길지.

### 다음에 서브에이전트로 나눌 때
파일 소유를 겹치지 않게 나눈다 (worktree 4개 → 마지막에 한 브랜치로 합침).

| 담당 | 파일 |
|---|---|
| 수집 | `collect_company_signals.mjs`, `date_state`, `collection_resilience`, `link_policy`, `audit_link_rules`, `publisher_recovery`, Python 데이터 구축 스크립트. 그리고 수집 인자 호출부(`review_report` ~1252, `local_report` ~746, package.json `collect`, link-policy-trial 수집 단계) |
| 판정·문안 | `review_report.mjs`(수집 호출부 제외), `summary_writer`, `summary_reviewer`, `review_providers`, `review_prompts`, `golden_review`, 레거시 분류·요약 스크립트, 관련 config. 판정 캐시 키나 버전을 바꾸는 변경은 금지(LLM 호출을 다시 사게 됨) |
| 렌더링 | `report_content.py`(문안 길이 한도 줄 제외), `build_pdf_report.py`, `report_view_model.py`, `report_html.mjs`, `build_html_report.mjs`, `local_report.mjs`, `publish_report.mjs`, `app/lib/report_pdf.mjs`, 스냅샷 테스트, `.claude/agents/en-*` |
| 웹·CI | `app/`(report_pdf 제외), `api/`, workflows, package.json, requirements, `.gitignore`, README, docs, `outputs/review_*` |

로컬에는 reportlab·pdfplumber가 없다. Python 테스트는 저장소 밖 venv에서 돌린다.

---

## 1. 수집 파이프라인

### 🔴 1-1. 공식 출처의 확장자 없는 PDF가 바이트 판별을 타지 않음 — 확인
- 위치: `scripts/collect_company_signals.mjs:1775`
- 문제
  - 공식 행인데 URL이 `.pdf`로 끝나지 않으면 `fetchText()` → `response.text()` 경로로 간다.
  - 그래서 `downloadArticleDocument`(~1645-1667)의 `sniffDocumentType`와 PDF 추출을 거치지 않는다.
  - 10/13 실행분에서도 Nabtesco `/en/news/20260930-…/` 5건, Renishaw `resourcecentre/…/download` 3건, Bayer·Merck 각 1건이 여전히 `unextractable_binary_document`다.
  - `tests/document_types.test.mjs:50`은 `downloadArticleDocument`를 직접 부르므로 이 경로를 검증하지 못한다. 같은 테스트 56-60행은 추출기의 **모든** 오류를 skip으로 삼킨다.
  - 반대 방향의 문제도 있다. 공식 `.pdf` 링크와 대체 출처 다운로드는 재시도·`domainGuard`를 거치지 않는다.
- 수정
  - 공식 상세 페이지도 바이트 판별 다운로드 경로로 받고, 재시도와 domainGuard를 공통으로 씌운다.
  - 테스트는 실제 공식 행 경로를 타게 하고, skip은 ENOENT(python·pdfplumber 없음)일 때만 한다.

### 🔴 1-2. 생성 스크립트가 손으로 관리하는 데이터를 덮어씀 — 확인
- `scripts/import_official_sources_from_excel.py:124-155`
  - `config/company_sources.json`을 `official_feeds: {}`와 `official_pages`만 남긴 내용으로 덮어쓴다.
  - 손으로 넣은 피드 29건, `sec_filers` 23건, `official_sitemaps` 4건이 사라진다.
  - pandas가 requirements에 없고, 이 스크립트를 부르는 곳도 없다.
  - 출력인 `data/official_source_catalog.{json,csv}`도 읽는 곳이 없다.
  - → 스크립트와 카탈로그를 삭제한다.
- `scripts/build_company_technology_map.py:211-227`
  - `target_identity`를 만들지 않아, 손으로 넣은 Prodrive 값이 재생성 때 사라진다. 이 값은 `local_report.mjs:345,484`에서 쓴다.
  - → 기존 파일의 비생성 키를 보존하며 병합한다.

### 🟠 1-3. 시간대 오프셋 때문에 게시일이 전월로 넘어감 — 확인
- 위치: `parseDate`(~366-377), `date_state.mjs` `dayOf`(~23-30)
- 문제
  - `2026-09-01T00:30:00+09:00`이 `2026-08-31`로 저장되어 8월 보고서에 들어간다.
  - 한국·일본 기업의 1일 오전 발표, 유럽의 자정 직후 발표가 해당한다.
- 수정: 오프셋이 있으면 게시처 현지 날짜(문자열의 `YYYY-MM-DD`)를 쓴다.
- Python 쪽도 같은 기준으로 맞춘다. `report_content.py`의 `format_date`(~483)는 현지 날짜, 필터(~521)는 UTC 날짜를 쓴다.

### 🟠 1-4. 없는 날짜가 다음 달로 넘어감 — 확인
- 사례
  - `new Date("2026-02-31")` → 3월 3일
  - `"February 30, 2026"` → 3월 2일
  - `sitemapUrlDate(".../2026/02/30/")` → 3월 2일
- 수정: `isoDate`/`parseStrictDate`에서 연·월·일이 그대로 돌아오는지 검사한다.

### 🟠 1-5. 대체 수집(Google News) 두 가지
- `~2645` `rows.map(row => byUrl.get(row.url) || row)`: 본문 단계에서 제외한 행(`no_article_title`, `verified_index_page` 등)이 원래 행으로 다시 들어온다. 공식(~2611)·사업동향(~2674) 경로처럼 보강 결과를 그대로 쓴다.
- `buildQuery`(~864-869, ~2145)가 아직 `when:Nd`를 쓴다. 늦게 돌리면 기간 밖 기사가 6건 한도를 채운다. 사업동향 질의처럼 `trendSearchWindow(dateRange)`(after/before)를 쓴다.

### 🟠 1-6. Google 일시정지 장치가 실제 차단을 세지 않음 — 확인
- 위치: `createPublisherProbe` ~1457
- 문제: `publisher_url_unresolved`일 때만 카운터를 올리고, 429·5xx·타임아웃이면 0으로 되돌린다. 그래서 일시정지가 걸리지 않는다.
- 수정: 429·5xx·타임아웃도 연속 실패로 센다.

### 🟠 1-7. 이어받기 조건이 너무 좁음 — 확인
- 문제
  - 이어받기는 `onlyProbePaused`(`collection_resilience.mjs:78`)일 때만 된다.
  - 상세 페이지 하나만 타임아웃 나도 그 기업은 매번 처음부터 다시 수집한다.
  - `retryable_company_count`가 24라서 `collectionNeedsRefresh`가 매번 수집기를 다시 돌린다.
- 수정: "출처 단계는 실패 없음, 일시 오류는 상세 단계에만 있음"으로 조건을 넓힌다. `reusableStep`이 실패 단계를 이미 빼는지 확인한 뒤 진행한다.

### 🟠 1-8. 중복 제거가 쿼리스트링을 통째로 지움 — 코드상 확인
- 위치: `dedupeRows` ~2202, `isDuplicateTrendRow` ~2088
- 문제: 쿼리를 지우고 경로를 소문자로 바꿔서 `?releaseid=1`과 `?releaseid=2`가 한 건으로 합쳐진다.
- 수정: `stripTracking`(추적 파라미터만 제거)을 쓰는 URL 키 함수 하나로 통일한다.

### 🟠 1-9. 수집 진입점마다 인자가 다름
- 운영(`review_report.mjs:1252-1257`): `official_feeds,official_pages,official_sitemaps,sec_filings,google_news`, `--max-http-header-size=131072`
- 다른 곳들
  - `package.json` `collect`, `link-policy-trial.yml:107-124`, `local_report.mjs:746`: sitemaps·SEC가 없고 헤더 한도도 없다.
  - `parseArgs` 기본값(131-159)은 또 다르다.
- 수정: `scripts/collection_args.mjs` 같은 공용 상수를 두고 모든 호출부가 쓴다.

### 🟠 1-10. 요약 집계가 캐시·이어받기 기업을 빼고 셈
- 문제
  - `link_verdict_counts`, `excluded_non_article_*`, `retry_count`(~87-120, 1756, 2821-2830)는 모듈 전역 카운터다.
  - link-policy-trial이 캐시를 복원한 뒤 이 숫자를 비교 지표로 쓴다.
  - `maxVerifyPerCompany=0`이면 `selectDetailRows`(~2271)가 `fetch_to_verify`를 기록 없이 버린다.
- 수정: 기업별 stats에 넣어 체크포인트와 함께 저장하고 합산한다.

### 🟡 1-11. 인자 파서 — 코드상 확인
- 위치: `parseArgs` 189-220
- 문제
  - 모르는 플래그를 무시하고, 값은 무조건 다음 토큰으로 읽는다.
  - trial 워크플로에서 `company_limit`을 비우면 `--company-limit --link-policy current`가 되어 `current`가 버려진다.
  - 숫자 인자의 NaN을 검사하지 않는다.
- 수정: 값이 `--`로 시작하면 오류를 내고, 숫자 인자를 검증한다.

### 🟡 1-12. 기타 엣지 케이스
- `audit_link_rules.mjs:230`: `recovered_current_false_proposed_true: pick("XXO","XOO")`인데, `"XXO","OXO"`가 맞다.
- `parseJsonFeed` ~1281: url이 비면 피드 URL이 기사 URL이 된다.
- `parseRssOrAtom` ~888: 링크 없는 항목의 url이 검색어 문자열이 된다.
- `discoverFeedLinks` ~1118: "feedback" 같은 링크도 피드로 받는다. 발견된 피드 행은 링크 정책을 거치지 않는다.
- `createDomainGuard` `finally { state.probing = false }`: 탐침이 아닌 요청이 끝날 때도 플래그가 풀린다.
- `extractPdfText` ~1513: `python`이 하드코딩되어 있다.
- `request_count`: 실패·재시도를 세지 않는다.
- `extract_pdf_companies.py:22`: 정규식 `7[0-7]`가 중복이고 78~99도 받는다.
- `maxDetailPerCompany`·`maxVerifyPerCompany`: 실제로는 호출당 한도라 기업당 최대 3배까지 받는다. 이름에 맞게 고칠지, 이름·주석을 고칠지 정한다.

### 🟡 1-13. 죽은 코드
- `scripts/collect_company_signals.py`: 진입점 없음. 같은 `latest_*`를 덮어쓸 위험이 있다. → 삭제
- GDELT 경로 전체: `collectGdelt` 2168-2195, `buildGdeltQuery` 871, `collectSource` 분기 2548, `parseDate` 분기 346, `date_evidence_sources.json`의 `gdelt_seen`
- `capCompanyRows` ~2258의 기간 밖 분기: 도달하지 않는다. `tests/collection_titles_dates.test.mjs:129`가 이 경로를 테스트한다.
- `proposedRule`(`link_policy.mjs:373`): 참조 0
- `data/target_companies.csv`: 읽는 곳 없음. JSON과도 어긋나 있다.
- `relevantAliases`의 하드코딩 `["hydro","maxon","evonik"]`(~857): `search_names`와 겹친다.
- `companySearchTerms`의 `searchTerms?.[company]`(~1956): 옛 형식 호환용

### 🟡 1-14. 중복과 주석
- 제목 정규화가 5곳에 있다: `dedupeRows`, `isDuplicateTrendRow`, `isCompanyNameOnlyTitle`, `extractArticleText.normalize`, `publisher_recovery.cleanTitle`.
- 확장자 목록이 3곳에 있다.
- `isGoogle` 정규식이 1651에 한 번 더 있다.
- 482·489행이 `MONTH_NAME_PATTERN`을 쓰지 않는다.
- 동시 실행 도우미가 둘이다(`mapWithConcurrency`, `request_pool`).
- 낡은 주석
  - `link_policy.mjs:291`, `audit_link_rules.mjs:4`, link-policy-trial 머리말: "current = 지금 쓰는 규칙"이라고 되어 있지만 기본값은 이미 `proposed`다.
  - `collect_company_signals.mjs:755`: 동작과 다르다.
  - `company_sources.json`의 description

---

## 2. 판정·문안·검토 (`review_report.mjs` 외)

### 🔴 2-1. 검증기 정지 규칙 때문에 매번 같은 곳에서 멈춤 — 코드 경로 확인
- 위치: `review_report.mjs:931-938`(직접 확인), `:986-993`, `:1173`
- 문제
  - 한 실행 안에서 검증 성공이 0건이고 pending이 3건이면 `verifier_unavailable`로 멈춘다(exit 75).
  - 이미 검증된 기사는 캐시로 빠지므로, 재실행 때 검증하는 건 늘 통과 못 하는 기사뿐이다.
  - 그런 기사가 3건 이상이면 매 실행이 똑같이 멈추고 보고서가 나오지 않는다. 지금 빠져나오는 방법은 `REVIEW_VERIFIER=off`뿐이다.
- 수정: 검증기의 정상적인 거부 응답은 "검증기 장애"로 세지 않는다. 전송·HTTP 실패만 센다.

### 🟠 2-2. 1차 판정과 검증기가 같은 요청 간격을 씀
- 위치: ~793-808, 913, 346-357
- 문제
  - gate의 `nextStart`/`delayMs`가 하나다. 1차가 NVIDIA(1.6초)면 Gemini 검증기(최소 4초)도 1.6초 간격으로 불려 429가 난다.
  - 동시 모드에서는 gate가 이미 간격을 지키는데도 ~913에서 기사마다 한 번 더 sleep한다.
- 수정: 종류별로 gate를 나눈다.

### 🟠 2-3. writer와 reviewer가 판정 파일을 원자적으로 쓰지 않음
- 위치: `summary_writer.mjs:460,567`, `summary_reviewer.mjs:251`은 `fs.writeFile`. 판정 단계(`review_report.mjs:331-335`)는 tmp+rename이다.
- 문제: 45분 타임아웃으로 끊기면 JSON이 잘릴 수 있다.
- 수정: 공용 원자적 쓰기 도우미를 만든다.

### 🟠 2-4. 통과 못 한 카드를 매 publish마다 다시 재작성
- 위치: `summary_reviewer.mjs:204`, `summary_writer.mjs:471`
- 문제: `rewrite_failed`로 원래 문안을 둔 카드도 지적이 캐시에 남아, 매 실행마다 writer 요청이 카드당 최대 3건씩 나간다. 상한이 없다.
- 수정: 같은 문안과 같은 지적이면 한 번만 시도하도록 시도 키를 기록한다.

### 🟡 2-5. 기타 버그
- `review_report.mjs:798-801, 946-948, 849`: 요청 예산이 바닥나도 `verifier_unavailable`로 기록된다. `budget_exhausted`로 구분한다.
- `summary_writer.mjs:536`: 실행 전체의 `stopped` 때문에 다른 기사의 `importReview` 안전장치까지 건너뛴다. 기사별 플래그로 바꾼다. `kept` 사유도 같다.
- `mergeVerification`(`review_report.mjs:223-227`): 1차 판정의 `unverified_quotes_removed`를 덮어쓴다. 합치도록 바꾼다.
- writer는 게시일을 받지 않는데(`summary_writer.mjs:244-249`), reviewer는 게시일로 시제를 판단한다(`summary_reviewer.mjs:60-63,104-111`). 고치면 writer 캐시 키가 바뀌므로 비용을 확인한 뒤 진행한다.
- `audit_signal_coverage.mjs:68-71`: 근접 후보까지 승인으로 센다(35건 vs 실제 18건). `publishedSignalCounts`를 재사용한다.
- 캐시 재검토(~1019)가 `verificationSuspects` 전체를 다시 검증한다. 주석(~257)은 지난번 후보만이라고 되어 있다.

### 🟡 2-6. 설정
- 제공자 기본값: 코드(`review_providers.mjs:227`)는 `nvidia`, 워크플로는 `gemini`다. 로컬 `collect:all`은 다른 모델과 다른 캐시를 쓴다.
- `summary_reviewer.mjs:45`: reviewer 간격을 환경변수로 바꿀 수 없다.
- `writerPolicySection`(`summary_writer.mjs:67`): 문서 제목이 바뀌면 빈 절로 그냥 진행한다(fail-open). 판정 쪽처럼 예외를 낸다.
- 문안 길이 한도가 JS(`summary_writer.mjs:336-337` en 440/ko 230)와 Python(`report_content.py:830-833`)에 따로 있다. 국문 표제 58자 한도는 Python에만 있다. 공용 JSON 하나로 옮긴다.
- `golden_review.mjs:190-191`: 예상 요청 수에 검증과 재검토가 빠져 있다.
- 골든 설정의 `month`, `baseline_article_id` 키는 쓰이지 않는다.

### 🟡 2-7. 죽은 코드 (약 2,000줄)
- `scripts/summarize_signal_evidence.mjs`
  - 스스로 DEPRECATED라고 적혀 있다.
  - `summarizer_fail_closed`, `summary_quality_downgrade` 테스트만 이 파일을 쓴다. `validateRows`의 면제 단언(~105-126)은 `report_input_validation` 테스트로 옮긴다.
- `filter_relevant_signals.mjs`, `classify_investment_signals.mjs`
  - 운영에서 쓰지 않는다.
  - 모듈 최상위에서 `main()`을 실행해 import도 할 수 없다.
  - npm 스크립트(`filter:relevant`, `filter:investment`, `summarize:ai`)로 돌리면 운영 `outputs/latest_*`를 **덮어쓴다**.
- `scripts/summary_sheet.mjs`와 `tests/golden_sheet.test.mjs`
  - golden이 더는 만들지 않는 `after.summary_ko`, `facts`, `variant`를 읽는다. 사실상 망가져 있다.
- `config/golden_followup_32d17e0.json`: docs에서만 언급한다.
- 레거시만 읽는 설정 키
  - `investment_signal_indicators.json`의 지표별 `keywords`와 `default_threshold`
  - `technology_keywords.json`의 `default_threshold`
  - 지우기 전에 git grep으로 다시 확인한다. `build_company_technology_map.py`가 쓸 수 있다.
- 테스트만 쓰는 호환 re-export: `review_report.mjs:16-17`, `review_providers.mjs:5-11`, `MODEL_CRITERIA_IDS`

### 🟡 2-8. 중복과 리팩터
- 같은 7개 판정 규칙(S3 재조달, Form 3, 중간 단계, 완료된 인수 등)이 5곳에 반복된다: 문서, `VERIFY_QUESTIONS`, `freshRecheckFeedback`, 정규식, 버전 상수.
  - `{id, version, suspects, question, feedback}` 표 하나로 묶는다.
  - 캐시 키가 바뀌지 않게 주의한다.
- `:646-649`가 `RECHECK_VERSIONS()`와 같은 목록을 손으로 다시 적는다.
- 같은 코드가 3곳씩 있다.
  - "기술 연결로 발행될 비면제 판정" 고르기: `:88-93`, `:197-201`, `:254-256`
  - 인용 원문 일치 검사: `:713`, `:741`, `:485`
- HTTP 오류 분류가 writer와 reviewer에 거의 같게 중복된다.
- `REPORT_CONCURRENCY` 검증이 3곳, 4500ms 기본 간격이 3곳에 있다.
- `reviewArticlesSerial`(~875-1175, 약 300줄)을 분리한다.
- 낡은 주석
  - `:457`: 캐시 키 설명이 실제 구현과 다르다.
  - `:396-410`: 주석이 엉뚱한 함수 위에 붙어 있다.
  - `review_providers.mjs:127`: 없는 `check_openai_access.mjs`를 언급한다.
  - `summary_writer.mjs:520`: 없어진 대체 모델을 언급한다.

### 🟡 2-9. `scripts/golden_review.mjs`에 실제 NUL 바이트 4개 — 확인
- 위치: 61, 64, 174, 178행 템플릿 리터럴
- 문제: git이 바이너리로 취급해 diff가 보이지 않는다.
- 수정: `'\u0000'` 이스케이프로 바꾼다.

---

## 3. 보고서 렌더링

운영 경로는 HTML→Chrome 하나다.
- Actions: `publish_report` → `local_report build` → `build_html_report`(국·영 병렬) → `report_view_model.py` → `report_html.mjs` → Chrome
- 웹 다운로드: `api/report-view-model.py` → `app/lib/report_pdf.mjs`(puppeteer) → 같은 `report_html.mjs`

### 🔴 3-1. 상세 페이지가 세로로 넘쳐도 빌드가 통과 — 합성 데이터로 재현
- 위치: `report_html.mjs:590-740`, `build_html_report.mjs:85-91`
- 문제
  - `.page{overflow:hidden}`인데, 측정 스크립트는 줄 수 제한 잘림만 본다.
  - 약 400자 영문 시그널 3개와 약 420자 사업현황이면 내용이 752pt까지 내려가 푸터(742pt)를 넘는다. 시그널 4개면 837pt로 쪽 밖이다. 그래도 cut_text가 0건이라 통과한다.
  - 지금 데이터는 기업당 지표가 최대 2개라 아직 터지지 않았다.
- 수정
  - 각 `.page`의 내용 아래끝이 742pt 이하인지 검사한다.
  - 가로 말줄임 칸(`.target-text`, 산업 알약, `td.company`, `.empty`)도 scrollWidth로 검사한다.

### 🔴 3-2. 회귀 방지 장치가 쓰지 않는 reportlab 렌더러를 보고 있음
- 문제
  - `build_pdf_report.py` 1,245줄 중 약 1,000줄(`SlideReport`, `draw_*`, `item_breaks`, `build_report`, `main`)은 운영에서 쓰지 않는다. 글자 폭 측정, `register_fonts`, `SIGNAL_BODY_SIZE`만 쓰인다.
  - 그런데 다음은 모두 reportlab 출력을 기준으로 한다.
    - `test_report_snapshot.py:129`(`pdf.build_report`)와 `expected_pages_{ko,en}.txt`
    - `test_pdf_layout.py`
    - `.claude/agents/en-layout-reviewer.md:17-20`(reportlab "clipped" 경고)
    - 문구 가이드 R6
  - 실제 PDF의 회귀는 아무것도 막지 못한다. 표지 제목 크기도 HTML은 44/50pt, reportlab은 30/36pt로 다르다.
- 수정
  - 측정 코드만 작은 모듈로 남기고 그리기 코드는 삭제한다.
  - 스냅샷은 뷰모델 JSON과 HTML 렌더 텍스트로 바꾼다.
  - layout 에이전트는 `build_html_report.mjs` 기준으로 고친다.
  - `en-consistency-reviewer.md`의 면 머리글 위치 목록에 `report_html.mjs`도 넣는다.
  - `scripts/verify_report_layout.mjs`는 참조가 없고 과거 데이터에 고정되어 있으니 삭제한다.

### 🟠 3-3. 날짜·기간 계산이 다섯 곳 이상에 있음
- 위치
  - `report_month.mjs`
  - `local_report.mjs:304` `monthPeriod`
  - `date_state.mjs:150` `lastDayOfMonth`
  - `report_content.py:559` `month_bounds`, `:601-612`(KST 전월 대체값)
  - `report_period.mjs:12-19`(`date_range.isCalendarDate`의 사본)
- 문제: JS↔Python 동등성 테스트가 없다.
- 수정: 한 곳으로 모으고 approval_parity 같은 테스트를 추가한다.
- 덧붙여: 국문 `matrix_period_label`과 `report_month_label`(640-648)은 시작 달만 쓴다. 달을 넘는 기간에서 틀린다.

### 🟠 3-4. 빌드 진단 파일이 아무에게도 닿지 않음
- 문제
  - `local_report.mjs:1077-1089`가 coverage, date-pending 등 8개 파일을 buildDir에 쓴다.
  - `publish_report.mjs:169`가 아티팩트 업로드 전에 그 폴더를 지운다.
  - investment-summary는 1094행 주석이 스스로 미사용이라고 적고 있다.
- 수정: 필요한 것은 보존 경로로 옮기고, 나머지는 쓰지 않는다.

### 🟡 3-5. 기타
- `build_html_report.mjs:34-45` `run()`: 출력을 안 읽으면서 stdout을 pipe로 연다. 64KB를 넘으면 멈출 수 있다.
- 쓰이지 않는 CLI 옵션: `--view-model`, `--ignored-signals`, `--from-date`, `--to-date`, 그리고 reportlab의 `--relevance-summary`
- 실패한 빌드의 `report-*` 폴더가 runDir에 쌓인다(publish가 성공할 때만 지움).
- `report_content.py`의 죽은 코드
  - `normalize_company_key`(47, 미사용)
  - `expand_business_summary`(1284, 그대로 돌려주는 함수)
  - `split_sentences`(901, 별칭)
  - `best_business_row` 3단계(1361-1369, 도달 불가)
  - `covered`
- `report_view_model.py`의 미사용 필드: `cover.stacked`, `cover.description_offset`, `business.near_miss`(148, 224-229)
- `register_fonts`(211-235): 어떤 예외든 Regular로 조용히 대체한다.
- 면 머리글 "S I G N A L…" 등이 TEXTS 밖에서 두 렌더러에 따로 있다. COLORS도 이중이고, `matrix_indicators`(354, 394)는 지표 이름을 복사해 들고 있다.
- 문구
  - 국문 `business_empty`가 "공식 출처"라고 하지만 제3자 뉴스도 포함된다.
  - 국문 "이번 달 해당 신호 없음" vs 영문 "No signal in {month}": 영문 가이드 R7의 근거가 국문에도 해당한다.
- `assets/images/emoji_target_1f3af.png`: 쓰이지 않는데 배포에 실린다. `assets/images/README.md:12`의 `draw_logo` 설명은 낡았다.
- 테스트
  - 스냅샷이 실제 `data/target_companies.json`과 기술맵을 읽는다(`test_report_snapshot.py:39-40`). 픽스처로 복사한다.
  - 뷰모델 → `renderReport`를 끝까지 도는 테스트가 없다. 키 이름이 바뀌면 빈칸이 조용히 인쇄된다.
  - `test_pdf_layout.py:70`의 `unittest.main()`이 파일 중간에 있다.
- 낡은 주석
  - `local_report.mjs` 2행, 1090-1093행
  - `report_view_model.py` 3-8행
  - `test_pdf_layout.py` 177-180행
  - `report_pdf.mjs` 13행(없는 `cardHeights`)

---

## 4. 웹 앱 · CI · 저장소

### 🔴 4-1. 호수 기본값 "2" — 확인
- 위치
  - `.github/workflows/collect-company-signals.yml:31`(`default: "2"`)
  - `scripts/publish_report.mjs:52`(`return pick || '2'`)
  - `scripts/report_content.py:43` `DEFAULT_ISSUE_NUMBER`
  - `app/api/report/route.js:15-17`
  - `api/report-view-model.py:24-25`
  - `local_report.mjs:1102`
- 문제
  - collect를 수동 실행하면 "2"가 status.json에 기록된다.
  - 이어서 publish를 호수 없이 실행하면 "Issue 2" PDF가 main에 커밋된다. 현재 호수는 4다.
- 수정: 기본값을 없애고, 호수가 없으면 실패(400)한다.

### 🔴 4-2. API 라우트에 앱 차원 인증이 없음 — 보류(결정 필요)
- 대상
  - POST `/api/trigger-crawl`: 워크플로를 실행하고 main에 커밋한다.
  - `/api/report`: Chromium과 Python을 띄운다(최대 60초).
- 문제
  - 막는 장치가 Vercel Deployment Protection 하나뿐이다. `middleware.js`가 없고, Origin 검사도 없다.
  - GET 진단(`trigger-crawl/route.js:129-141`)이 인증 없이 토큰 길이·앞 4글자·GitHub login을 보여준다. → 이건 바로 고친다.

### 🟠 4-3. 동시 실행 그룹 때문에 자동 발행이 조용히 취소됨
- 위치: `collect-company-signals.yml:64-66`, `publish-report.yml:30-32`, `trigger-crawl/route.js:64`, `page.jsx:703`
- 문제
  - 두 워크플로가 `monthly-report-${ref}` 그룹을 같이 쓴다. GitHub는 그룹당 대기 실행을 하나만 둔다.
  - 발행이 대기 중일 때 "크롤링 수행"을 다시 누르면 대기 중인 발행이 취소된다.
- 수정: collect 요청에도 `pipeline.active` 검사를 넣고, 실행 중에는 버튼을 비활성화한다.

### 🟠 4-4. 웹 다운로드와 화면이 서로 다른 데이터를 읽음
- 문제
  - 화면은 GitHub 최신 JSON(`signals/route.js:23-81`)을 읽고, PDF는 배포 묶음의 `outputs/latest_*`를 읽는다.
  - latest에는 마지막 한 달만 있어서, 다른 달을 고르면 "0개사" 보고서가 오류 없이 나온다.
  - 웹 PDF는 잘림 검사(`cutTexts`)도 하지 않는다(`app/lib/report_pdf.mjs`).
- 수정: 데이터 기간 밖의 요청은 400으로 거절하고, 월 선택기를 가능한 달로 제한하고, 잘림 검사를 적용한다.

### 🟠 4-5. 입력 검증
- `/api/report`(172-173): `rangeProblem`을 쓰지 않아 한쪽 날짜만 주거나 순서가 뒤집혀도 통과한다.
- `api/report-view-model.py:28-33`: 정규식으로만 검사해서 2026-02-31이 통과하고, 파싱에 실패하면 조용히 전월로 대체한다.
- `ignored`·`issue`에 길이 제한이 없다.
- 500 응답이 `str(error)`와 stderr 경로를 노출한다.

### 🟠 4-6. 무시 목록이 다른 달·다른 기사까지 번짐 — 보류(결정 필요)
- 위치: `page.jsx:16, 378-396, 618-638`, `report_content.py:904-937`
- 문제
  - 키가 `target_no|company|signal_no`뿐이다. 다른 달의 같은 회사·지표, 같은 달의 다른 기사까지 빠진다.
  - "N건 무시" 표시도 모든 달을 합친 수다.

### 🟠 4-7. 깨진 npm 스크립트
- `validate:pdf`: 필수 인자 `--pdf`(`extract_pdf_companies.py:82`)를 넘기지 않아 항상 실패한다.
- `build:technology-map`: `C:/Users/buy4u/Downloads/...`가 하드코딩되어 있다. README 157·171행도 같다.
- `report:pdf`: 국문만 Issue 2로 만들어 `public/reports/latest_report.pdf`를 덮어쓴다. → 삭제
- `filter:relevant`, `filter:investment`, `summarize:ai`: 운영 파일을 덮어쓴다(§2-7). → 삭제
- `collect:all`과 `report:review`가 같은 명령이다. → 하나로 합친다.

### 🟠 4-8. 워크플로 env 누락
- README:285가 `GEMINI_REVIEWER_MODEL=off`를 안내하지만, `publish-report.yml:78-91`이 `GEMINI_REVIEWER_MODEL`, `GEMINI_REVIEWER_THINKING_LEVEL`, `GEMINI_WRITER_TIMEOUT_MS`를 넘기지 않는다.
- collect도 `GEMINI_MODEL`, `NVIDIA_MODEL`, `GEMINI_VERIFIER_THINKING_LEVEL`을 넘기지 않는다.
- 수정: `${{ vars.X }}`로 매핑한다.

### 🟠 4-9. CI에서 테스트가 돌지 않음
- 문제
  - 워크플로 3개 모두 `node --test`와 Python unittest가 없다.
  - `approval_parity`는 reportlab이 없으면 조용히 skip한다.
- 수정: `.github/workflows/test.yml`을 추가한다. Node 22 + `node --test`, Python 3.12 + `requirements-python.txt` + `python -m unittest discover tests`.

### 🟡 4-10. 웹 기타
- `page.jsx:492-499`: `json()`이 실패한 뒤 `text()`를 다시 불러 "body already read" 오류가 난다.
- `page.jsx:934`: "기술 관련 후보"만 기간 필터와 무관한 값을 쓴다. → `displayedRelevantSignals.length`
- 죽은 코드
  - `investmentSummary` 상태(438, 545)와 그 GitHub 호출(`signals/route.js:80`)
  - `month` 쿼리(480)
  - `X-Report-Fallback` 분기(512-515)
  - `days` 입력(`trigger-crawl:34`, `report_pipeline.mjs:79`, 워크플로 16-19)
- 현재 데이터에 0건인 필드 분기(`page.jsx` 1022-1049, 1040, 1119, `dashboard_signals.mjs:3-13`)
  - `ai_summary_tier`, `ai_summary_headline_ko/detail_ko`, `evidence_snippets`
  - `matched_terms`, `technology_matched_terms`
  - `investment_signal_reason`, `relevance_reason`
  - `direct_source_url`, `detail_url`, `article_url`, `canonical_url`, `document_url`
  - "Terra/Luna 요약" 표시
- `app/api/report/route.js:38-41`: 개인 Python 경로(`.cache/codex-runtimes/...`)가 하드코딩되어 있다.
- `viewModelFromPython`: 진짜 Python 오류가 나도 인터프리터 8개를 다시 돌리고, ENOENT 판정도 틀린다.
- `crawl-status/route.js:12`: 토큰 없이 API를 호출한다. 비공개 저장소면 "대기"로 오표시된다.
- `route.js:127`: 내부 호출 주소를 Host 헤더로 만든다. 자체 호스팅이면 위험하다(추정).
- `page.jsx` 중복
  - `dateStatus`가 `date_state.mjs`를 다시 구현한다.
  - 요약 정규화가 `report_content.py:687-816`과 중복된다.
  - 출처 배지·날짜·링크 셀 복사본이 3곳이다(1052-1063, 1131-1142, 1184-1195).
- `maxDuration 60`: Python 45초에 콜드 스타트가 더해지면 시간 초과가 날 수 있다(추정).

### 🟡 4-11. CI·버전
- `link-policy-trial.yml:118-121`
  - 자유 입력을 `run:`에 직접 넣는다(스크립트 주입). → env로 넘기고 숫자만 검증한다.
  - `stefanzweifel/git-auto-commit-action@v7`가 SHA로 고정되지 않았다(contents:write 권한).
  - 기간 계산을 bash로 따로 구현한다(66-94). 다른 워크플로처럼 `report_period.mjs --github-output`을 쓴다.
- 버전 차이
  - CI는 Node 22 / Python 3.12, 로컬은 Node 24 / Python 3.14다.
  - `engines`, `.nvmrc`, `.python-version`이 없다.
  - requirements는 `>=`라 고정되지 않았고, 두 파일이 중복이다.
  - `puppeteer-core ^25.11.0`(캐럿)이 고정된 chromium-min 153과 어긋날 수 있다.

### 🟡 4-12. 저장소 위생
- `.gitignore`에 빠진 것: `.env`, `.vercel/`, `outputs/review_work/`, `__pycache__/`, `outputs/latest_report.html`, `public/reports/*.html`, `outputs/html_report/`, `outputs/review_*/`
- 커밋된 일회성 산출물(약 1.1MB, 참조 0, Vercel 배포에도 실림)
  - `outputs/review_2026-09-15/`, `outputs/review_2026-09-15_latest/`, `outputs/review_2026-09-17/`
  - `outputs/pdf_companies_extracted.*`
- 테스트가 전혀 없는 모듈
  - `audit_signal_coverage`, `extract_pdf_companies`, `build_company_technology_map`
  - `trigger-crawl` POST, `page.jsx`의 `signalKey`·`isWithinPeriod`

### 🟡 4-13. 문서
- 낡은 내용
  - `github_vercel_button_workflow.md`: 151행 "deployment paused", 83-101행 PDF를 만드는 주체가 틀림
  - `automation_notes.md`: publish 단계가 빠져 있음
  - `review_parallel_execution.md`: 동시 실행 기본값을 8로 적음. 실제는 4
  - `README.md`: 31행(build_pdf_report가 PDF를 그린다는 설명), 32행(.py 수집기), 125행("August 2026"), 157·171행(buy4u 경로), 285행
- 없는 파일을 참조하는 문서
  - `html_report_prototype`, `report_cost_options`, `structural_efficiency`
  - `summary_rule_deduplication`, `post_ai_filter`, `summary_comparison_experiment`, `refactor_2026-09-21`
- `docs/archive/`로 옮길 일회성 노트 약 40개
  - `claude_*` 지시와 인계 문서, 날짜가 붙은 조사·측정·리뷰 노트 전부
  - **옮기기 전에** 파일명을 git grep해서 코드·테스트·에이전트가 경로로 참조하면 남긴다.
  - 유지할 것
    - `local_report_review.md`: 프롬프트가 읽음
    - `report_wording_guide_en.md`
    - `github_vercel_button_workflow.md`
    - `automation_notes.md`
    - `date_criteria_2026-09-07.md`
    - `collection_resume.md`
    - `review_parallel_execution.md`
    - `company_level_signal_scope_2026-09-21.md`
