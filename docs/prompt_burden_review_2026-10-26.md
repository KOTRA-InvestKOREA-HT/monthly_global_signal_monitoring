# 모델 지시문 부담 점검 (2026-10-26)

4호(2026-09) 보고서의 사업동향을 검토하다가 문안 결함(한국 지명의 로마자 표기, 용어 정의 문장, 지난 사건의 재게재)이
보였고, 사용자가 "지금 프롬프트 보고 과한가" 조사를 요청했다. 조사만 했고 코드와 지시문은 바꾸지 않았다.
2026-09-23 점검(`docs/archive/prompt_burden_audit_2026-09-23.md`)은 판정과 문안 작성이 한 호출이던 때의 기록이다.
그 뒤 판정·문안 작성·문안 검토·상자 문안 작성이 따로 나뉘었으므로 단계별로 다시 잰다.

## 결론

분량 자체는 과하지 않다. 문제는 규칙 밀도와 엇갈림이다. 모든 단계가 경량 모델(`gemini-3.5-flash-lite`)을 쓰는데,
판정 지시에만 금지·필수 지시가 55개 있고 같은 규칙이 여러 곳에 되풀이된다. 확인된 결함 가운데 둘은 지시문이
원인이고(한국 지명 로마자, 이미 있는 실적 발표 규칙의 누락), 하나는 지시문이 아니라 코드 검사의 버그다(월 약어).

## 측정

`buildSystemInstruction(policySection(doc))`, `buildWriterInstruction(writerPolicySection(doc))`, `REVIEWER_INSTRUCTION`,
`buildBoxInstruction(...)`, `VERIFY_INSTRUCTION` 을 직접 조립해 셌다. 줄바꿈은 LF 로 통일했고, 기사 본문과 응답 스키마는
뺐다. 글자 수이며 토큰 수가 아니다. "금지·필수 지시"는 must/never/do not/always/only/required 와 국문 금지 표현을 센 값이다.

| 단계 | 파일 | 글자 수 | 금지·필수 지시 |
| --- | --- | ---: | ---: |
| 판정 | `scripts/review_prompts.mjs` + `docs/local_report_review.md` 판정 기준 | 16,692 | 55 |
| 문안 작성 | `scripts/summary_writer.mjs` (예시 4개 3,597자 포함) | 10,649 | 26 |
| 상자 문안 작성 | `scripts/box_writer.mjs` | 4,013 | 11 |
| 문안 검토 | `scripts/summary_reviewer.mjs` | 2,623 | 7 |
| 2차 검증 | `scripts/review_prompts.mjs` `VERIFY_INSTRUCTION` | 989 | 3 |

판정 요청에는 기사 본문이 최대 36,000자 더 붙는다. 지시문 길이만으로는 감당할 수준이다.

## 실제 결함으로 이어진 것

1. **한국 지명이 국문 문안에 로마자로 남는다.** 4호 Amkor 상자 "Buk-gu Cheomdan district의 Gwangju 공장",
   "South Jeolla-Gwangju와 Jangseong-gun", Nexeon 상자 "대한민국 Gunsan 공장". 세 지시가 같은 쪽으로 민다.
   - `scripts/review_prompts.mjs:62`: 회사·기관·제품·프로그램 이름은 원래 라틴 문자로 두고 한글로 옮기지 말 것.
   - `scripts/summary_writer.mjs:88-91`: 좋은 예시가 지명도 라틴 문자로 둔다("핀란드 Porvoo", "멕시코 Guadalajara").
   - `scripts/summary_reviewer.mjs:75`: 라틴 문자로 남긴 지명은 결함이 아니다.
   외국 이름을 음차하지 말라는 원래 목적은 맞다. 한국 지명·기관은 한글 표기가 정해져 있다는 예외가 없다.
2. **이미 있는 규칙을 경량 모델이 놓친다.** `docs/local_report_review.md:37` 은 실적 발표·분기 보고서가 지난 사건을
   되짚으므로 이번 달 새 발표라는 증거가 없으면 `leading_indicator_supported=false` 로 하라고 한다. 그런데 3M 의
   10월 20일자 3분기 실적 발표 PDF(IR 목록의 분기말 날짜 9월 30일로 수집됨)에서 GSEO 지분 취득이 S4 로 승인돼 9월호
   사업현황 상자에 실렸다. 이 날짜 판정 자체도 수집 쪽 결함이다(본문 첫머리 "Oct. 20, 2026 – … today reported"가
   `context` 날짜로만 분류됐다). 문서 종류로 가를 수 있는 규칙은 지시문보다 코드가 확실하다.
3. **(코드 검사) 국·영 월 대조가 영문 월 약어를 읽지 못한다.** `scripts/summary_writer.mjs:325-336`
   `bilingualFactProblems` 는 영문 월을 전체 철자로만 찾는다. 영문 "Sept. 23"과 국문 "9월 23일"을
   `bilingual_month_mismatch` 로 판정한다(직접 실행해 확인). 4호에서 이 사유로 세 번 다 탈락해 보고서에서 빠진 투자 시그널
   문안이 Umicore `investment:1`(Eco&Dream 전구체 공급), EMM(Umicore) `investment:2` 두 건이다
   (`outputs/latest_ai_summary_summary.json` `summary_writer.failed`). 두 기사의 인용문에 "Sept. 23", "Sept. 14"가 있어
   이 버그일 가능성이 크다. 실패한 문안 원본은 Actions 캐시에만 있어 로컬에서 단정하지는 못했다.

## 정리 대상 (결함 확인 없음)

- **판정 지시의 중복**: 판정 항목끼리 서로 영향을 주지 말라는 규칙이 세 번(`docs/local_report_review.md:21`, 2번 항목 끝,
  Approval 절), 날짜 제안 규칙이 두 번(시스템 지시 5절과 Date handling 마지막 항목), "S2 는 precursor 불가"가 두 번
  (`:33`, `:34`) 나온다. `event_stage` 설명은 `:31-38` 다섯 문단에 흩어져 있다.
- **판정에 쓰지 않는 내용**: 날짜 표의 "Monthly PDF" 열(`:63`)은 PDF 포함 규칙이고 판정과 무관하다. `:45` 의
  "Do not duplicate judgement exceptions in the system instructions"는 개발자에게 하는 말이다.
- **문안 작성 지시의 글자 수가 서로 다르다**: 영문 투자 문안 상한이 `docs/local_report_review.md:94` 에서는 400자,
  `scripts/summary_writer.mjs:176` 에서는 440자다. "length is a target, not a cap"(`scripts/review_prompts.mjs:62`)과
  "국문 230자 이하"가 함께 간다. 상자 문안 작성도 "길이는 목표"와 "360자 이하"를 함께 받고, 상자와 무관한 투자 카드
  배치 규칙(" - " 구분자)까지 받는다(정책 문안 절을 통째로 넣기 때문).

## 빠진 규칙

사업동향 문안이 사건 대신 배경·정의 문장만 쓰는 것을 막는 규칙이 없다. 4호 품목별 카드 EMM(Umicore)은
"HS Hyosung Energy Solution Korea는 … 80%와 20%의 지분율로 설립한 합작법인임." 한 문장이고, EVG 는 둘째 문장이
"하이브리드 본딩은 … 첨단 패키징 기술임."이다. 지시문은 "Omit repetition and filler"만 둔다. 과해서가 아니라 모자라서 생긴
결함이다. "사업동향 첫 문장은 회사가 한 일을 말하고, 용어 정의·회사 소개 문장은 쓰지 않는다" 같은 규칙이 필요하다.

## 고칠 때의 비용

- 판정 지시(`review_prompts.mjs` 판정 부분, `docs/local_report_review.md` 판정 기준)를 바꾸면 프롬프트 다이제스트가 기사
  ID 에 들어가므로(`reviewPromptDigest`) 그 달 기사 전부를 다시 판정한다. 4호 기준 733건이다. 다음 달 수집 전에 한 번에
  모아 바꾼다.
- 문안 작성·검토 지시와 코드 검사는 해당 문안만 다시 쓴다.

## 권고 순서

1. `bilingualFactProblems` 가 영문 월 약어(Jan., Feb., Sept., Sep. 등)를 읽게 고친다. 코드만, 모델 비용 없음.
2. 문안 작성·검토 지시에 한국 지명·기관은 한글로 쓴다는 예외와, 사업동향의 정의·소개 문장 금지를 넣는다.
3. 실적 발표·분기 보고서 같은 문서 종류는 수집·코드 단계에서 가려 판정 부담을 줄이고, 본문 첫머리 발표일이 IR 목록의
   분기 날짜보다 우선하게 한다.
4. 판정 지시의 중복과 무관한 내용을 정리한다(다음 달 수집 전).

## 재현

지시문 조립·측정 스크립트는 저장소에 넣지 않았다. 위 다섯 함수를 같은 인자로 부르면 같은 글자 수가 나온다.
월 약어 오탐은 다음으로 확인한다.

```js
import { bilingualFactProblems } from './scripts/summary_writer.mjs';
bilingualFactProblems({ summary_en: 'Eco&Dream said on Sept. 23 that it signed a supply contract.',
  summary_ko: 'Eco&Dream은 9월 23일 공급 계약을 체결했다고 밝혔음.' });
// → ['bilingual_month_mismatch']
```
