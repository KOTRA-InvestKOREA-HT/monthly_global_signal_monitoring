# 링크 판정 규칙 회수 감사 (2026-09-10)

수집기가 기사 후보를 **fetch 하기 전에** 잘라내면서 생기는 false negative를 재고 줄였다.
PDF 본문 추출, 다단 PDF 읽기, Google News → 발행사 URL 추적, 대체 본문 확보, 날짜 근거
관리는 손대지 않았다. AI 검토 프롬프트·승인식·validator도 건드리지 않았고 AI API도
호출하지 않았다. 기본 동작은 그대로 두고, 새 규칙은 `--link-policy proposed` 뒤에 두었다.

## 1. 판정을 세 갈래로 나눈 이유

지금까지 `isRelevantOfficialLink()`는 참/거짓 하나를 돌려줬다. 그러면 **"기사가 아님"과
"기사인지 알 수 없음"이 한 칸에 뭉개진다.** 뭉개진 쪽은 늘 버리는 쪽으로 정리됐다.

```
hard_reject      구조적으로 기사가 될 수 없다.  카테고리·페이지네이션·에셋·자리표시자 URL
fetch_to_verify  기사일 수 있다.                받아본 문서를 보고 판정한다
accept           링크 단계에서 이미 근거가 충분하다
```

의미 판단(타겟 기술과 관련이 있는가, 투자 신호인가)은 여기서 하지 않는다. 그건 AI 검토의
일이다. 이 규칙이 답하는 질문은 **"문서인가 목록인가"** 하나뿐이다.

## 2. 확인된 false negative

감사는 77개사의 공식 목록 페이지 134장에서 앵커 **10,928개**를 읽어 규칙 세 벌을 모두 걸었다.

### 2-1. NXP 보도자료가 "깨진 URL"로 버려지고 있었다

`looksLikeBrokenUrl()`의 `[/:][A-Z][A-Z0-9_-]{3,}$` 조항이 슬래시 뒤 대문자 토큰까지 묶었다.

```
버려도 되는 것   /company/about-nxp/accessibility:ACCESSIBILITY   (콜론, 자리표시자)
같이 버려진 것   /company/about-nxp/newsroom/NW-NXP-BREAKS-GROUND-SITE-MAL
                /company/about-nxp/newsroom/NW-DIVIDEN-ANNOUNCE-Q3-2026
```

**착공 발표와 분기 배당 발표다.** 착공은 지표 사건 그 자체다. NXP는 자리표시자를 콜론으로
붙이고 보도자료 슬러그는 슬래시 뒤 대문자 문서번호를 쓴다. 자리표시자를 가르는 것은
대문자가 아니라 콜론이었다. 2026-08 프로덕션 실행의 `broken_url` 194건이 이 조항이다.

### 2-2. 날짜가 슬러그에 박힌 보도자료를 통째로 놓치고 있었다

```
https://boeing.mediaroom.com/2026-09-04-Boeing-Africas-Airplane-Fleet-Will-More-th...
https://investors.danaher.com/2026-08-03-Danaher-Appoints-Julie-Sawyer-Montgomery-...
```

경로에 `news`·`press` 낱말이 없어 `sameHostNewsPath`에 걸리지 않고, 제목에도 키워드가
없어 `ARTICLE_KEYWORDS`에 걸리지 않는다. **Boeing과 Danaher(Cytiva)의 보도자료 피드가
한 건도 들어오지 않았다.** 발행일과 제목이 둘 다 있으면 확인할 것이 없으므로 `accept`로
올렸다.

### 2-3. 짧은 슬러그가 카테고리 탭으로 오판됐다

`looksLikeSourceIndexUrl()`의 마지막 조항은 "상위 경로가 전부 목록 낱말이고 마지막 조각이
두 낱말 이하"면 카테고리로 봤다. `/press/strategic-deal`, `/newsroom/korea-plant`이 정확히
그 모양이다. **URL 모양만으로는 카테고리 탭과 짧은 기사 슬러그를 가를 수 없다.** 그래서
이 조항을 거부가 아니라 확인 대상으로 돌렸다. 뉴스 구역 안에 있으면 대개 `accept`까지 간다.

### 2-4. stories·insights·blog 상세 페이지

`INDEX_SEGMENTS`에 `stories`·`blog`·`insights`가 들어 있어 그 아래 짧은 슬러그가 전부
탈락했다. 구역 자체(`/stories`)는 계속 목록으로 보고, 그 아래 문서는 살린다.

## 3. fetch 예산을 지키는 조항

처음 만든 규칙은 애매한 링크를 전부 확인 대상으로 보냈다. 12장만 걸어봤는데 확인 대상이
**accept 69건 대비 315건**이었다. 회사 사이트의 제품·시장·소개 페이지가 전부 들어왔다.

```
/products/vial-transfer-devices      /markets/Optical-Communications-Market.html
/mines/the-dubbo-project/            /us/en/who-we-are
```

"낱말 3개 이상이면 기사 슬러그"라는 판정이 원인이었다. 제품 페이지도 세 낱말이다.
**낱말 수는 기사를 가르지 못한다.** `hasArticleAffordance()`로 바꿔 뉴스 구역에서 나왔거나
발행일·발행번호가 박힌 경로만 확인 대상이 되게 했다. 확인 대상이 571건으로 줄었다.

## 4. shadow audit 결과

`node scripts/audit_link_rules.mjs --per-company 2` (앵커 10,928개, 목록 페이지 134장)

| | 통과 |
|---|---|
| 전임자 8월 규칙 | 1,738 |
| 현재 규칙 | 1,740 |
| **제안 규칙** | **2,393** (accept 1,937 + 확인 대상 456) |

사용자가 요청한 다섯 칸:

| 셀 | 건수 |
|---|---|
| old=true / current=false | 89 |
| old=true / proposed=false | 45 |
| **current=false / proposed=true** | **653** |
| all=true | 1,649 |
| all=false | 8,490 |
| **current=true / proposed=false (프로덕션 기준)** | **0** |

마지막 칸이 이번 작업의 약속이다. **지금 걷던 링크는 한 건도 잃지 않는다.**

회수 653건의 사유별 분해:

| 사유 | 건수 |
|---|---|
| no_listing_date | 280 |
| article_link (링크 단계에서 바로 accept) | 197 |
| short_slug_under_index | 102 |
| unfamiliar_path | 44 |
| generic_link_text | 30 |

`old=true / proposed=false` 45건은 전부 직접 확인했고 **진짜 목록 페이지였다.**
Vestas 블로그 색인, Bayer 이벤트 목록, Arkema 보도자료 목록, Amkor `/category/company-news/`,
Prodrive `?label=Whitepaper` 같은 필터 뷰다. 회수할 것이 없다.

## 5. 실제 수집으로 확인한 증감

14개사 · 2026-08 · `official_pages`만 · 같은 인자로 두 정책을 연달아 실행했다.

| | current | proposed |
|---|---|---|
| 수집 행 | 75 | **89** (+18.7%) |
| 요청 수 | 139 | 157 (+12.9%) |
| PDF 행 | 13 | **15** |
| 본문 확보 | 70/75 (93%) | 84/89 (94%) |
| **사라진 행** | — | **0** |

확인 대상 판정은 401건 나왔지만 실제로 출력까지 간 것은 11건이다. 나머지는 `maxPerSource`
정렬에서 확실한 기사에 밀렸거나, 받아본 뒤 목록으로 판명돼 걸러졌다.

### 되찾은 기사 표본

```
Australian Strategic  2026-08-28  ASM and Energy Fuels merger
Australian Strategic  2026-08-31  ceased quotation on ASX from close of trading (PDF)
BorgWarner            undated     View our Q2/2026 Financial Results (PDF)
```

### 새로 늘어난 소음 표본

```
Air Products   Download Podcast / Reconciliation Tables / Earnings Release PDF   (static-files)
Chemours       Segment Information / Fact Sheet                                  (static-files)
Albemarle      '+ ' ' + '                                                        (JS 템플릿 잔재)
ASM            ASX Announcements        ← 목록 페이지. 날짜를 2026-12-08 로 잘못 물어옴
ASM            Shareholder Information  ← IR 안내 페이지
```

**소음은 거의 전부 IR 구역의 기계 생성 문서 링크다.** 되찾은 기사는 뉴스 구역에서 나온다.

### 사후 판정이 잡아낸 것

받아본 문서로 판정하는 `verifyFetchedArticle()`이 이번 실행에서 7건을 되돌렸다.

```
verified_index_page  2   본문이 800자 미만인데 링크가 20개 이상인 문서
no_article_title     5   제목 자리가 문서번호뿐  (0001627223-26-000027, e9aaa4d1 c1c1 42a4 ...)
```

PDF는 `html`이 비어 있어 링크 밀도 조항을 아예 타지 않는다. 본문만으로 판정한다.

## 6. PDF · Google 경로 보존 확인

- `.pdf`는 `ASSET_EXTENSION`에서 제외돼 있다. 이미지·영상·zip만 거부한다.
- `scripts/extract_pdf_text.py` 호출부와 다단 분리 로직은 한 글자도 바뀌지 않았다.
- 실제 실행에서 PDF 행이 13 → 15로 늘었다. 줄지 않았다.
- `detailSourceUrl()` / `createPublisherProbe()` / `fetchArticleDocument()`는 그대로다.
  Google 래퍼를 발행사 증거로 쓰지 않는 기존 동작도 그대로다.
- 회귀 테스트를 새로 붙였다(아래).

## 7. exclusion 표본을 사유별로 나눴다

예전에는 표본 120건을 한 통에 담았다. 2026-08 실행에서 제외 9,998건 중 9,782건이
`index_or_category_page`라 **표본이 전부 그 사유로 채워졌고, `no_article_title` 22건은
한 건도 눈에 띄지 않았다.** 확인이 필요한 쪽은 늘 소수 사유다.

사유별로 최대 24건, 그 안에서 회사당 2건씩 담게 바꿨다. 요약에
`excluded_non_article_sample_reasons`로 사유별 표본 수도 함께 낸다.

## 8. 테스트

`npm test` 152개 통과(신규 `tests/link_policy.test.mjs` 12개 포함),
`python -m unittest discover -s tests` 10개 통과.

신규 테스트가 보는 것:

- 짧은 기사 슬러그가 fetch 전에 버려지지 않는다
- 카테고리·태그·페이지네이션·피드·사이트 루트는 계속 hard reject 된다
- 링크 텍스트가 `Read more`여도 목적지가 기사면 살아남고, 제품 페이지면 버린다
- stories·insights·blog **상세**는 살고 **구역**은 버린다
- 발행일이 슬러그에 박힌 보도자료는 확인 없이 통과한다
- 대문자 문서번호 슬러그를 자리표시자로 보지 않는다
- PDF 링크가 에셋으로 버려지지 않고, 링크 밀도 조항에 걸리지 않는다
- 받아본 문서가 목록이면 확인 대상은 통과하지 못한다
- Google 발행사 추적이 그대로다
- **proposed 정책이 현재 걷던 링크를 하나도 떨어뜨리지 않는다**
- 감사 도구는 프로덕션 판정을 읽기만 하고 바꾸지 않는다

기본 정책으로 같은 14개사를 다시 수집해 **행 집합과 순서가 완전히 동일함**을 확인했다.

## 9. 프로덕션 적용 추천

**적용하되, 한 달은 `--max-verify-per-company 2`로 좁혀서 돌린다.**

근거는 이렇게 갈린다.

- **accept 쪽 197건은 바로 켜도 된다.** NXP 착공 발표, Boeing·Danaher 보도자료 피드는
  규칙의 구조적 결함이었고 회수에 판단이 끼지 않는다. 소음이 붙지 않는다.
- **확인 대상 456건은 수확이 낮다.** 14개사 실행에서 출력까지 간 11건 중 사람이 봐서
  값이 있는 것은 2~3건이었다. 나머지는 IR static-files다. 다만 요청은 13%만 늘고
  사후 판정이 걸러내므로 손해도 크지 않다.

지금 두 갈래를 따로 끄고 켤 스위치는 없다. `--max-verify-per-company`를 줄이는 것이
확인 대상 쪽만 좁히는 가장 가까운 손잡이다.

한 달 돌린 뒤 볼 숫자는 요약의 `link_verdict_counts`와 제외 사유의
`verified_index_page`·`no_article_title` 비율이다. 확인 대상에서 승인이 한 건도 안 나오면
`docs/signal_accuracy_measurement_2026-09-10.md`가 Google News 본문 미확보 기사에 대해
내린 것과 같은 판단을 이 갈래에도 내리면 된다.

한 가지는 분명히 해둔다. **이 감사는 "현재 규칙이 버린 링크 중 무엇이 기사였나"를 잰 것이지,
"기사를 하나도 안 놓친다"를 잰 것이 아니다.** 목록 페이지에 아예 링크가 걸리지 않은 기사는
어떤 규칙으로도 여기서 보이지 않는다.
