# 월간 자동 수집 예약 + 대시보드 버튼을 보고서 생성으로 (작업 계획, 2026-09-29)

2026-09-29에 합의한 방향을 정리한 문서다. 아직 구현하지 않았다. 다음 작업일에 이 순서대로 진행한다.

> **2026-10-08: 버튼 부분은 다른 방향으로 구현했다.** "크롤링 수행" 버튼은 판정을 `auto_publish=true`로 실행하고,
> 판정이 끝나면 워크플로가 `publish-report`를 이어서 실행한다. 발행만 다시 돌리는 "발행만 실행" 버튼을 따로 두었다.
> 수동 실행은 판정만 한다. 자세한 흐름은 `docs/github_vercel_button_workflow.md`. 아래 1번(월간 예약 실행)은 여전히 구현하지 않았다.

## 목표

- 수집·판정(1단계, `collect-company-signals`)은 매월 자동으로 돈다.
- 대시보드의 "크롤링 수행" 버튼은 보고서 생성(2단계, `publish-report`)을 실행한다.

사람은 보고서를 낼 시점에 버튼 하나만 누르면 된다. 오래 걸리는 수집·판정은 그 전에 끝나 있다.

## 현재 상태 (확인한 사실)

- 세 워크플로(`collect-company-signals`, `publish-report`, `link-policy-trial`)는 모두 `workflow_dispatch`만 받는다.
  `schedule`/cron은 커밋 이력 전체에서 한 번도 없었다.
- 대시보드 버튼(`app/page.jsx:668` "크롤링 수행")은 `app/api/trigger-crawl/route.js`를 부른다. 이 라우트는
  `GITHUB_WORKFLOW_FILE`(기본값 `collect-company-signals.yml`, `app/lib/github_env.mjs:32`)을
  `days`, `from_date`, `to_date`, `issue_number` 입력으로 실행한다.
- 진행 상태 표시(`app/api/crawl-status/route.js`)도 같은 `workflowFile`의 최신 실행을 읽는다.
- `publish-report`는 `workflow_run`으로 이어 받지 않는다. 1단계가 끝나도 2단계는 자동으로 돌지 않는다.
- 입력 없이(예약으로) 돌아도 수집 워크플로는 기본값으로 동작한다.
  - `.github/workflows/collect-company-signals.yml` 94–112행이 `inputs.x || vars.X || 기본값`으로 받는다.
  - 기간이 비면 한국 시간 기준 직전 달이다.
- 판정이 하루 한도 등으로 끝나지 않으면 `review_report.mjs`가 종료 코드 75로 끝난다(1233행). Actions에서는 실패로 보인다.
  같은 기간으로 다시 돌리면 저장된 수집·판정을 이어받는다(`refresh`·`rereview` 기본값 false).

## 할 일

### 1. 예약 실행 추가 — `.github/workflows/collect-company-signals.yml`

```yaml
on:
  schedule:
    # 매월 1일·2일 한국 시간 09:00 (UTC 00:00). 1일 실행이 하루 한도로 멈추면 2일 실행이 이어서 마친다.
    # 1일에 끝났다면 2일 실행은 저장된 수집·판정을 재사용해 요청이 거의 나가지 않는다.
    - cron: "0 0 1,2 * *"
  workflow_dispatch:
    ...
```

- 시각을 08:00이 아니라 09:00으로 정한 이유가 있다. 한국 시간 1일 08:00은 UTC로 전달 말일 23:00이고, cron은 "말일"을 지정할 수 없다.
  08:00을 꼭 지켜야 하면 매일 23:00 UTC에 돌리면서 "내일이 1일인가"를 확인하는 단계를 넣어야 한다.
- GitHub 예약 실행은 부하에 따라 수십 분 늦게 시작할 수 있다.
- 확인할 것: 2일 실행이 1일에 끝난 판정을 실제로 재사용해 요청이 거의 나가지 않는지. 첫 예약 달의 실행 요약으로 본다.
- 예약 실행에는 호수 입력이 없다. 호수는 2단계 버튼에서 넘긴다(아래 2번).

### 2. 버튼이 `publish-report`를 실행하게 — `app/api/trigger-crawl/route.js`, `app/lib/github_env.mjs`, `app/page.jsx`

- 환경변수 `GITHUB_WORKFLOW_FILE`만 `publish-report.yml`로 바꾸면 안 된다. 버튼이 보내는 `days`를 `publish-report`는
  입력으로 정의하지 않아 GitHub가 422로 거절한다. `publish-report`로 보낼 때는 `from_date`, `to_date`, `issue_number`만 보낸다.
- 방법은 둘 중 하나로 정한다.
  - (가) 기본값 `workflowFile`을 `publish-report.yml`로 바꾸고 입력에서 `days`를 뺀다.
  - (나) `GITHUB_PUBLISH_WORKFLOW_FILE`을 새로 두고, 버튼은 그것을, 상태 표시는 두 워크플로를 모두 본다.
  - 상태 표시가 수집 진행도 보여 주는 편이 쓸모 있으므로 (나)를 추천한다.
- 판정이 안 끝났을 때 버튼을 누르는 경우를 처리한다. 디스패치 자체는 204로 성공하고, 실패는 실행 안에서
  `judgement_incomplete`로 난다(`scripts/publish_report.mjs` `judgementFor`).
  - 디스패치 전에 `collect-company-signals`의 최신 실행을 조회한다.
  - 진행 중이거나 실패(판정 미완료 포함)면 "수집·판정이 아직 끝나지 않았습니다" 같은 안내를 띄우고 실행하지 않는다.
- 버튼 이름 "크롤링 수행"을 "보고서 생성"으로 바꾸고, 관련 문구도 함께 바꾼다.
  - `app/page.jsx` 544·569·571·668·852행 부근
  - `route.js` 171행 진단 문구
- 버튼의 기간은 판정 기간과 같아야 한다(`judgementFor`가 다른 기간을 거절한다). 비워 두면 지난달이라 예약 실행과 맞는다.
- 호수: 라우트의 기본값이 `"2"`다(`route.js` 43행). 화면의 호수 입력이 비면 엉뚱한 호수로 나가므로,
  비어 있으면 막거나 판정에 기록된 호수를 쓰게 한다.
- 잃는 것: 대시보드에서 수집을 수동으로 다시 돌릴 수 없게 된다. 특정 기간을 다시 수집할 때는 GitHub Actions 화면에서 실행한다.
- 테스트: `tests/web_api_contracts.test.mjs`(기본 `workflowFile` 기대값 96행)와 라우트 입력 계약을 새 동작에 맞게 고친다.

### 3. 문서

- `README.md`의 "stage 1/2" 설명(16–17행, 276–286행)과 `docs/github_vercel_button_workflow.md`를 새 흐름으로 고친다.
  새 흐름은 "매월 1·2일 자동 수집 → 버튼으로 보고서 생성"이다.

## 다음 작업일에 같이 볼 것 (2026-09-29 기준 남은 일)

- 새 PDF 확인: `publish-report`를 한 번 돌려 아래를 본다.
  - 영문 표지의 금색 머리말 "GLOBAL INVESTMENT SIGNAL MONITOR"
  - 지표 설명을 이름 옆에 둔 배치
  - 매트릭스 범례의 "⑤" 줄바꿈
- 영문 표지 문구(GPT 검토): "Investment Promotion Projects", "leading indicators of Investment",
  "5 LEADING INDICATORS OF INVESTMENT"를 고칠지 결정한다.
  - 표지 문구와 제목은 Issue 3 수정 로그로 정한 것이다(`3b1e127`, `2a21c9f`). 수정 로그를 낸 쪽과 먼저 맞춘다.
  - 오늘 바꾼 S1–S5 영문 이름(`6a6b571`)도 원래는 9월 23일에 "합의된 이름"이었다. 같은 쪽과 공유한다.
- 문안 검토(`summary_reviewer.mjs`)의 흔들림: 3M "50.1% 지분 확보를 위해" 문구를 세 번 중 한 번만 잡았다.
  지켜보고 필요하면 투자 시그널만 두 번 검토하는 방안을 검토한다.
- 같은 사건 카드 중복: Veolia 채권 발행이 카드 3장(영문 보도자료 2 + 프랑스어 목록 1)이다.
- 목록 페이지가 기사로 수집되는 문제: Veolia 프랑스어 보도자료 목록, Bayer 뉴스룸, Jenoptik 뉴스 목록.
- 재판정 대기 `629ea10f…`(investment:5): 진단 파일이 Actions 아티팩트에만 있어 원인을 못 봤다.
