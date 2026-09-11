# 본문 추출 범위 축소가 실적 발표를 지웠다 (2026-09-10)

> 2026-09-11 후속: `fix/article-body-scope`에서 수정과 고정 입력 검증을 완료했다.
> 아래는 발견 당시 기록이며, 변경 내용과 실시간 검증 한계는 문서 끝에 덧붙였다.

`da02c5c`가 바꾼 `extractArticleText()`를 실제 수집으로 검증했다. 의도(네비게이션·관련
제품 문구를 판정 근거에서 빼기)는 옳지만, **일부 사이트에서 기사 본문 자체가 사라진다.**

`docs/accuracy_review_2026-09-10.md`가 "여러 article이 있는 사이트는 정확한 본문 선택이
보장되지 않는다"고 적어둔 위험이 가정이 아니라 실제로 일어나고 있다는 것이 이 문서의
내용이다. 코드는 아직 고치지 않았다.

## 무엇을 쟀나

같은 14개사(`--sources official_pages`, 2026-08)를 `da02c5c` 전후로 수집해 **같은 URL의
`content_text` 길이를 대조**했다. 양쪽 모두 본문이 있는 70행이 대상이다.

```
본문이 절반 이하로 줄어든 행    4 / 70
그중 90% 이상 사라진 행         1 / 70
나머지 33행                     600자 안팎 감소 (의도된 <header> 제거)
```

감소분 대부분은 정상이다. 문제는 상위 4건이고, 하필 전부 실적 관련 문서다.

| 기사 | 이전 | 이후 |
|---|---|---|
| Charles River 2026 2분기 실적 | 24,000자 | **123자** |
| Air Products 2026 3분기 실적 | 13,707자 | 5,782자 |
| Air Products 실적 발표 | 14,375자 | 5,885자 |
| West Pharmaceutical 컨퍼런스콜 | 715자 | 127자 |

Charles River 기사에 남은 본문은 전문이 이것뿐이다.

```
View printer-friendly version
Charles River Laboratories Announces Second-Quarter 2026 Results
Download PDF 477.6 KB
```

`revenue` · `GAAP` · `per share` · `guidance` · `outlook` 이 모두 사라졌다.

Air Products 기사는 헤드라인과 데이트라인(`07/30/2026 | Lehigh Valley, PA`)이 빠지고
회사 소개 문단만 남았다. 남은 5,782자는 전부 `About Air Products` 보일러플레이트다.

## 원인

실제 페이지를 받아 세어보면 Air Products 보도자료의 `<article>` 요소는 셋인데
**그중 기사 본문인 것은 하나도 없다.**

```
<article> #0     73자   "View entire earnings release with all financial tables"
<article> #1     54자   "Access all earnings materials"
<article> #2  5,781자   "About Air Products ... world-leading industrial gases company"
```

진짜 본문은 `<main>` 안에 있다. 새 코드는 `article → main → body` 순으로 훑다가
**처음 걸리는 계층에서 곧바로 반환**하므로, `<article>`이 사이드바 카드로 쓰인 사이트에서는
`<main>`을 아예 보지 않는다. Charles River도 같은 구조이고, 거기서는 `<article>`이
인쇄 링크 카드라 123자가 남았다.

이전 코드는 네 계층(article/main/div.content/body)의 후보를 모두 모아 **가장 긴 것**을
골랐다. 그래서 이 사이트들에서는 사실상 `<body>` 전체가 선택됐고, 네비게이션이 섞이는
대신 본문은 확실히 포함됐다.

## 왜 그냥 되돌리면 안 되나

두 규칙 모두 단독으로는 틀린다. 실제로 돌려서 확인했다.

| 방식 | Air Products | Charles River |
|---|---|---|
| 계층 우선, 최초 계층에서 반환 (현재) | 5,782자, **본문 없음** | 123자, **본문 없음** |
| 모든 계층 중 최장 (nav 제거 후) | 13,888자, 본문 있음 | 41,908자, `Skip to main navigation`으로 시작 |

`<nav>`/`<aside>`/`<footer>` 제거는 좋은 변경이지만 Charles River의 메뉴는 그 태그들
안에 있지 않아서 걸러지지 않는다. 즉 "계층 우선"을 버리면 Charles River가 원래대로
지저분해지고, 유지하면 두 기사 다 본문을 잃는다.

## 검증한 수정 방향

**후보가 기사 제목을 담고 있는지로 계층을 고른다.** 제목이 없는 계층은 건너뛴다.
프로토타입으로 돌린 결과는 이렇다.

```
Air Products  ->  main(제목 포함)  13,671자
                  "07/30/2026 | Lehigh Valley, PA  Air Products Reports Fiscal 2026 Third Quarter Re..."
```

헤드라인·데이트라인·재무 내용이 모두 복구된다.

다만 이것만으로는 부족하다. Charles River는 제목을 담은 116자짜리 `<article>` 카드를
고른다. **길이 하한이 함께 필요하다.** 제목을 담은 후보 중에서도 지나치게 짧으면
다음 계층으로 넘어가야 한다.

정리하면 선택 규칙은 세 조건을 함께 만족해야 한다.

1. `<nav>`/`<aside>`/`<footer>` 를 먼저 제거한다 (현재 코드 유지)
2. 후보가 기사 제목을 담고 있어야 한다
3. 후보가 최소 길이를 넘어야 한다. 못 넘으면 다음 계층으로 간다

## 회귀 테스트로 박을 것

고칠 때 아래 두 사이트를 고정 입력으로 넣어야 한다. 둘이 서로 반대 방향으로
규칙을 당기므로, 한쪽만 보고 고치면 다른 쪽이 깨진다.

- `<article>`이 사이드바 카드뿐이고 본문은 `<main>`에 있는 페이지 (Air Products 형)
- `<article>`이 인쇄 링크 카드이고 본문은 그 밖에 있는 페이지 (Charles River 형)

길이가 아니라 **본문에 헤드라인과 핵심 낱말(`revenue`, `GAAP` 등)이 남아 있는지**로
단언해야 한다. 길이만 재면 보일러플레이트 5,782자도 통과한다.

## 이 회귀가 왜 위험한가

본문에 없는 문장을 모델이 인용하면 `importReview`의 원문 대조에서 막힌다.
`docs/pdf_column_extraction_2026-09-10.md`가 다룬 다단 PDF 문제와 같은 실패 모드다.
막히지 않는 경우가 더 나쁘다. 신호가 실린 실적 발표를 모델이 "근거 없음"으로
정직하게 판정하게 되고, 그 판정은 검증을 통과한다.

`docs/signal_accuracy_measurement_2026-09-10.md`에서 본문 없는 후보 1,512건의 승인이
0건이었다. 본문을 보일러플레이트로 바꾸는 것은 본문을 지우는 것과 같은 값이다.

## 같이 확인할 것

- **다음 실행은 전체 재수집이다.** `CONTENT_COLLECTION_VERSION`이 `article-body-v3`에서
  `v4-accept-only`를 거쳐 `v5-content-scope`로 두 번 올랐다. 캐시가 전부 무효화되므로
  시간과 요청이 평소보다 많이 든다. 위 수정을 넣으면 버전을 한 번 더 올려야 한다.
  같은 재수집에 묶는 편이 낫다.
- **`coverageStatus`의 보류 처리.** `deferredCount > 0` 이면 무조건 `incomplete_evidence`를
  반환한다. 날짜 보류가 전체의 22.8%였으므로 상당수 기업이 미완료로 찍힐 수 있다.
  의도한 엄격함인지, 보류 건수에 기준을 둘 것인지 정해야 한다.

## 기록해 둘 것

처음 이 변경을 볼 때 Charles River 본문의 **앞 150자만** 보고 "네비게이션이 빠지고
헤드라인부터 시작한다"며 개선으로 판단했다. 전체 길이를 재고 나서야 24,000자가
123자로 줄었다는 것을 알았다. 본문 추출 변경은 시작 부분이 아니라 **길이 분포와
핵심 낱말 잔존 여부**로 판정해야 한다.

## 2026-09-11 수정과 검증

`html-report-prototype`의 마지막 커밋 `a2ac398`을 기준으로
`fix/article-body-scope` 브랜치에서 `extractArticleText()`를 수정했다.

- nav/aside/footer 제거와 article → main → body 순서는 유지한다. 각 계층에서
  페이지 제목을 포함하고 300자 이상인 후보를 찾으며, 없으면 다음 계층을 확인한다.
  제목은 유니코드·대소문자·구두점 차이를 정규화해 비교한다. 제목이 없는 페이지는
  길이 조건으로 계층을 선택한다.
- article/main의 header 안에 있는 헤드라인은 보존한다. body까지 내려간 경우에는
  페이지 제목과 일치하는 h1/h2 앞의 텍스트를 잘라, 일반 div로 만든 앞쪽 메뉴가
  본문에 섞이는 것을 줄인다. 임의의 링크 텍스트를 절단 기준으로 삼지는 않는다.
- 큰 후보가 없으면 제목이 있는 짧은 후보를 보존한다. 제목 근거도 없으면 기존처럼
  첫 비어 있지 않은 계층으로 돌아가므로 짧은 공지를 무조건 폐기하지 않는다.
- `CONTENT_COLLECTION_VERSION`을 `article-body-v6-headline-scope`로 올렸다.
  이전의 잘린 본문 수집 캐시를 재사용하지 않으며, 바뀐 기사 본문은 기존 캐시 키
  규칙에 따라 다시 검토된다.

`tests/article_evidence_accuracy.test.mjs`에 위 두 사이트의 **축약 구조 재현 입력**을
추가했다. 실제 HTML을 내려받아 저장한 스냅샷은 아니다. Air Products형은 긴 회사
소개 article을 넘어 main의 재무 본문을 읽고, Charles River형은 제목이 있는 짧은
인쇄 카드에서 멈추지 않는다. 두 경우 모두 제목·Revenue·GAAP·per share·guidance·outlook
보존을 검사한다. 별도로 정상 article의 범위 유지, 짧은 공지 보존, 제목 구두점 차이도
검사한다. 전체 Node 테스트 **170개**, Python 테스트 **10개**가 통과했다.
Python 의존성은 작업 폴더의 `.cache/body-scope-venv`에 설치해 검사했다.

실시간 확인은 완료하지 못했다. 현재 저장된 Charles River 2026년 2분기 실적 URL은
25초 시간 초과, Air Products `0430-air-products-fiscal-2026-second-quarter-earnings`
URL은 HTTP 403이었다. 따라서 위 결과는 고정 입력 검증이며, 원래 비교한 14개사
70행에서의 실제 본문 길이 분포나 AI 판정 개선을 재측정한 결과가 아니다.
원격 워크플로 실행·보고서 게시도 수행하지 않았다.

300자 기준과 제목 일치는 휴리스틱이다. 긴 카드, 메타 제목과 실제 제목이 다른 문서,
본문 뒤의 일반 div 메뉴는 추가 표본 검증이 필요하다. `coverageStatus`의 날짜 보류
처리 정책은 별도 판단 사항으로 남긴다.
