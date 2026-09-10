# HTML → PDF 보고서 시험 이전 (2026-09-10)

표지와 시그널 매트릭스 두 페이지를 HTML/CSS로 다시 만들고 헤드리스 Chrome으로
인쇄해 기존 reportlab 출력과 비교했다. 나머지 페이지(기업별 상세, 품목별 사업동향)는
그대로 `scripts/build_pdf_report.py`가 그린다. 이번 단계의 목적은 디자인 재현이
가능한지, 그리고 그 판단을 눈대중이 아니라 숫자로 할 수 있는지 확인하는 것이다.

## 결과

두 페이지의 모든 텍스트 기준선이 원본 좌표와 **최대 0.8pt** 차이다. 표의 좌측
시작점(25pt)과 폭(242pt)은 정확히 일치한다. 한국어·영어 모두 확인했다.

`scripts/verify_report_layout.mjs`가 이 비교를 자동으로 한다. Chrome에
렌더된 페이지의 실제 좌표를 물어 `build_pdf_report.py`의 좌표와 point 단위로
대조하고, 1pt를 넘으면 종료 코드 1을 낸다. 남은 페이지를 옮길 때 이 도구가
합격 기준이 된다.

## 무엇이 실제로 좋아지는가

매트릭스 페이지는 지금 두 개의 39행 표로 **하드코딩**돼 있다.

```python
draw_matrix_table(report, profiles[:39], ...)   # build_pdf_report.py:1354
draw_matrix_table(report, profiles[39:], ...)   # build_pdf_report.py:1355
```

타겟기업을 120개로 늘려 실제로 돌려봤다. reportlab 출력은 오른쪽 표가 범례를
덮어썼고, **85~120번 36개사가 어느 페이지에도 나오지 않았다.** 그러면서
`clipped_text_count: 0`, `pages: 7`로 성공을 보고했다. 폭 기준 잘림만 세고
세로 넘침은 세지 않기 때문이다. 현재 타겟은 77개사이고 계산상 81개사 근처에서
이 일이 시작된다.

같은 120개사를 HTML로 인쇄하면 매트릭스가 3페이지로 나뉘고, 마지막 페이지의
짧은 열도 정상으로 보이며, 범례는 제자리에 남는다. 누락은 없다.

영문 표지에서도 차이가 드러났다. 지표 라벨이 길어지면 원본은
`short_text_to_width`로 라벨을 자르거나 설명을 지운다. HTML에서는 라벨과 설명이
flex 축소 우선순위로 자리를 협상해, 라벨은 온전히 남고 설명이 먼저 줄어든다.
결과적으로 영문 표지에서 잘리는 문구가 없어졌다.

## 구조

```
scripts/report_view_model.py    데이터 판단 → JSON  (build_pdf_report.py를 import)
scripts/report_html.mjs         JSON → HTML 문자열  (순수 함수, 파일·브라우저 접근 없음)
scripts/build_html_report.mjs   위 둘을 엮어 Chrome으로 PDF 인쇄
scripts/verify_report_layout.mjs  렌더 결과를 원본 좌표와 대조
```

데이터 판단(국가명, 산업 분류, 어느 칸이 켜지는지, 각주의 세 가지 집계)은
`build_pdf_report.py`에서 그대로 import한다. 두 벌로 갈라지면 반드시 어긋나기
때문이다. 옮긴 것은 배치뿐이다. `report_html.mjs`가 순수 함수라서, 나중에
같은 렌더러를 Next.js 라우트에서 그대로 써서 Vercel에 미리보기를 띄울 수 있다.

## 왜 Playwright가 아니라 Chrome CLI인가

`scripts/`의 어떤 스크립트도 node_modules를 필요로 하지 않고, Actions 워크플로에는
npm 설치 단계 자체가 없다. GitHub Ubuntu 러너에는 Chrome이 이미 있고 이 PC에도
Chrome·Edge가 있다. 페이지는 정적이고 폰트는 로컬 파일이라 드라이버가 줄
제어권이 필요 없다. `--print-to-pdf`가 `@page { size: 540pt 780pt }`를 그대로
지켜 정확히 540×780pt를 낸다. 더 정교한 제어가 필요해지면 Playwright로 올리면 된다.

## 남은 것

- 기업별 상세 페이지와 품목별 사업동향 페이지. `draw_detail_page`의
  max_lines 축소 재시도 루프와 `paginate_item_cards`가 사라질 자리다.
- 표지 제목 크기는 아직 Python이 계산해 view model에 실어 보낸다. 폭을 재서
  줄이는 일은 CSS가 스스로 못 한다. 여기서는 HTML이 얻는 게 없다.
- Actions 워크플로 연결, Vercel 즉석 생성 경로 정리, reportlab 경로 제거.
  이번 브랜치는 아무 워크플로도 건드리지 않았고 기존 PDF 생성 경로도 그대로다.

## 검증

`npm test` 129개 통과(신규 `tests/report_html.test.mjs` 7개 포함),
`python -m unittest discover -s tests` 10개 통과. 신규 테스트는 120개사 입력에서
모든 기업이 정확히 한 번씩 나타나는지, 범례·각주가 마지막 매트릭스 페이지에만
한 번 찍히는지, 쪽번호가 매트릭스 페이지 수만큼 이어지는지를 본다.
`node scripts/verify_report_layout.mjs --html <파일>`은 worst 0.8pt로 통과한다.
실제 워크플로 실행과 Vercel 배포는 하지 않았다.
