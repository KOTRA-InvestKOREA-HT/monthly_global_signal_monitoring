# API 키 없이 AI 근거 평가하기 (수동 반입)

## 1. 왜 가능한가

파이프라인 여섯 단계 중 API가 필요한 것은 하나뿐이다.

| 단계 | API |
|---|---|
| 수집(크롤링) | 불필요 |
| 기술 관련성 필터 | 불필요 |
| 투자 시그널 분류 | 불필요 |
| **AI 근거 평가** | **필요** |
| 게시 입력 검증 | 불필요 |
| PDF 생성 | 불필요 |

AI 단계가 이미 격리돼 있어 그 자리에 사람이 들어갈 수 있다. 앞뒤 단계는 수정하지 않는다.

접합부는 JSON 행에 붙는 필드 10개다. 이것만 채워지면 검증기와 PDF는 그 값이 API에서 왔는지
사람이 넣었는지 구분하지 않는다.

```text
ai_signal_supported          ai_entity_supported
ai_target_technology_supported  ai_indicator_supported
ai_leading_indicator_supported  ai_event_stage
ai_summary_quality           ai_summary_ko
ai_summary_en                ai_summary_reason
```

## 2. 절차

```bash
# 1) 수집·필터·분류는 평소대로 (API 불필요)
npm run collect && npm run filter:relevant && npm run filter:investment

# 2) 채팅에 붙여넣을 배치 파일 생성
npm run export:batches

# 3) outputs/manual_summary/batches/*.md 를 하나씩 채팅에 붙여넣고
#    받은 JSON 배열을 outputs/manual_summary/responses/ 에 같은 이름의 .json 으로 저장

# 4) 되돌려 넣기
npm run merge:batches

# 5) 이후는 평소와 동일
npm run validate:report-inputs && npm run report:pdf
```

배치 파일은 그 자체로 완성된 프롬프트다. 규칙과 출력 형식이 파일 안에 들어 있으므로 파일 전체를
그대로 붙여넣으면 된다. 응답은 코드펜스나 짧은 머리말이 붙어 있어도 병합기가 배열만 도려낸다.

## 3. 실측 부피

2026년 8월분 174행(투자 109 + 사업동향 65) 기준이다.

| 항목 | 값 |
|---|---|
| 배치 수 | 16개 |
| 배치당 행 수 | 최대 12행 |
| 입력 총량 | 653,257자 |

행당 입력은 3,600자 상한을 쓰며 174행 중 161행이 이미 상한까지 잘려 있다. 원문은 더 길다.

출력을 줄이기 위해 **승인되지 않은 행은 한 문장 요약만 요청한다.** 보고서용 한·영 요약문은
`signal_supported=true`인 행에만 작성하게 되어 있다. 8월분 기준 그런 행은 24개였다.

배치 크기는 조절할 수 있다.

```bash
node scripts/export_summary_batches.mjs --max-rows 8 --max-batch-chars 30000
```

## 4. 판정 기준은 API 경로와 동일하다

승인값은 답변의 `signal_supported`를 그대로 믿지 않고 `computeSignalSupport()`로 다시 계산한다.
이 함수는 API 경로가 쓰는 것과 같은 함수이며 `summarize_signal_evidence.mjs`에 한 벌만 있다.
규칙을 두 벌로 두면 어느 경로로 만든 보고서냐에 따라 승인 기준이 달라진다.

관련성 면제 기업 처리도 동일하다. 배치 파일에서 해당 항목에는 `relevance_exempt: true`가 붙고,
그 행은 타겟 기술 근거를 승인 조건으로 요구하지 않는다.

투자 시그널 요약문은 API 경로와 같은 문구 정리(`summaryHeadlineDetail`, `englishHeadlineDetail`)를
거치므로 PDF에서 같은 문체로 보인다.

## 5. 병합은 fail-closed다

손으로 옮기는 경로에서는 깨진 JSON, 누락 행, 없는 행 추가가 반드시 생긴다. 다음 중 하나라도
발견되면 **원본 파일을 건드리지 않고** 종료 코드 1을 반환한다.

- JSON 배열을 찾지 못함
- manifest에 없는 `ref`
- 같은 `ref` 중복
- 응답이 없는 행
- 판정 boolean 자리에 boolean이 아닌 값
- 정의에 없는 `event_stage` 또는 `quality`
- 요약문 또는 판정 사유가 빔
- 내보낸 뒤 원본 행이 바뀜(수집을 다시 돌린 경우)

마지막 항목 때문에, 내보낸 뒤에 수집을 다시 돌렸다면 배치도 다시 내보내야 한다.

적용 전에 확인만 하려면 `--dry-run true`를 쓴다.

## 6. 검증 결과

8월분 174행으로 왕복 시험을 했다.

```text
내보내기          174행 -> 배치 16개
병합(dry-run)     174행 검증 통과
병합(적용)        174행 반영
게시 입력 검증    passed, 오류 0건
PDF               5페이지 생성
```

같은 판정을 넣었을 때 승인 수가 API 실행 결과와 정확히 일치했다(투자 1건, 사업동향 23건).
수동 경로가 API 경로의 판정을 그대로 재현한다는 뜻이다.

실패 모드도 확인했다. 응답 파일 하나를 지우면 누락 12건을 보고하고, 없는 `ref`를 넣으면 그
`ref`와 응답 없는 행을 함께 보고하며, 두 경우 모두 원본 파일이 변경되지 않았다.

## 7. 한계

수동 경로에는 API 경로에 없는 약점이 있다. 상시 운영 방식으로 삼기 전에 감안해야 한다.

**배치 간 판정 일관성이 떨어진다.** 16개 배치를 나눠 물으면 첫 배치와 마지막 배치의 엄격도가
달라질 수 있다. API는 행마다 동일한 프롬프트로 독립 호출하므로 이 문제가 없다. 이 프로젝트가
판정 일관성을 잡는 작업이었다는 점에서 가장 큰 약점이다.

**감사 추적이 약해진다.** API 경로는 행마다 모델명, 티어, 프롬프트 버전, 캐시 키를 남긴다.
수동 경로는 `ai_summary_model`에 `--model`로 넘긴 값만 남는다. 어떤 모델이 어떤 기준으로
판정했는지 사후에 확인하기 어렵다. 병합된 행은 `ai_summary_source=manual_chat_handoff`,
`ai_summary_tier=manual`로 표시되므로 최소한 경로 구분은 된다.

**캐시가 없다.** 다음 달에 같은 기사가 다시 걸리면 처음부터 다시 판정해야 한다.

**작업량이 있다.** 16개 배치를 붙여넣고 응답을 저장하는 수작업이 월 1회 발생한다.

따라서 키 문제가 풀리지 않거나 급히 결과가 필요할 때의 우회로로 쓰고, 키가 확보되면 API 경로로
돌아가는 것이 적절하다.
