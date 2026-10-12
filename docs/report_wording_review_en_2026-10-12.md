# 영문 보고서 문구 변경 제안 검토 (2026-10-12)

## 검토 대상과 결론

- 대상: [영문 보고서 고정문구 변경 제안](report_wording_proposal_en_2026-10-12.md)
- 기준: [영문 보고서 고정문구 기준](report_wording_guide_en.md)
- 확인한 구현: `scripts/report_content.py`, `scripts/report_view_model.py`, `scripts/build_pdf_report.py`, `config/investment_signal_indicators.json`

제안의 수정 방향은 대체로 타당하다. 다만 일부 반려 근거는 문법·의미 문제보다 엄격하게 적용되었으며, “바로 반영 가능”과 “다른 대안이 없음”이라는 결론은 조정할 필요가 있다.

권장 방향은 **머리글에 KEY DEVELOPMENTS 사용, C2·C3 수용, 지표 ③ 설명 개선, 지표 ⑤ 명사구 개선**이다. 지표 ③ 이름 변경과 설명 전체의 동명사구 통일은 보류를 권한다.

이 문서는 검토 의견이며 사용자 승인 기록이 아니다. 보고서 코드와 기존 기준·제안 문서는 수정하지 않았다. 제안서에 기재된 “9쪽 유지·잘림 없음”은 이번 검토에서 직접 재검증하지 않았다. 아래 새 권장 문구의 레이아웃도 반영 전에 확인해야 한다.

## 1. 머리글: KEY DEVELOPMENTS 권장

사용자가 고려 중인 `KEY DEVELOPMENTS`는 해당 면의 머리글로 자연스럽다. 다음 조합을 권장한다.

> KEY DEVELOPMENTS  
> Global Business Developments by Company

머리글은 섹션을 짧게 안내하고, 제목은 구체적인 내용을 설명하므로 역할이 다르다. 두 곳의 단어가 완전히 같아야 한다는 제안서의 R3 해석은 지나치게 엄격하다. 핵심 표현인 `Developments`도 유지된다.

`Key`는 주요 내용을 선별했다는 의미를 더한다. 현재 해당 면이 기업별로 선정된 사업동향을 보여주는 구조이므로 내용과도 맞는다.

기준 문서에는 `KEY DEVELOPMENTS`를 **이 섹션의 머리글에 사용하는 축약 표현**으로 허용한다고 기록하면 된다. 일반 사업 소식을 가리키는 용어집의 `business developments`까지 모두 바꿀 필요는 없다.

코드상 머리글은 국·영문 공통이므로 반영 시 양쪽 보고서에 적용된다는 제안서 설명은 맞다.

## 2. 개별 변경안 판단

| 항목 | 판단 | 이유 |
|---|---|---|
| C2: `selected by MOTIR`를 프로젝트 뒤로 이동 | 수용 | 국문의 “산업부 선정 30대 프로젝트”와 수식 관계가 맞아진다. |
| C3: `IMU, RF, and …` | 수용 | 기존 문구의 문법 오류 수정이라기보다 정해 둔 연속 쉼표 규칙을 적용하는 변경이다. |
| ③ 설명: `executing capital increases` → `raising equity` | 수용 | 더 간결하고 자연스럽다. |
| ④ 설명 앞에 `Pursuing` 추가 | 선택 사항 | 동명사구 통일에는 유효하지만 기존 명사구도 문법적으로 문제없다. |
| ⑤ 설명: `unannounced site visits` 변경 | 수용 | 원문의 비공개성·방한을 제대로 전달하지 못하고, 불시 현장 방문으로 읽힐 가능성이 있다. |
| ③ 이름: `Debt & Equity Financing`으로 변경 | 보류 권장 | 자연스럽지만 “유동성 확보”라는 별도 의미가 약해진다. |

### C2·C3 권장 문구

표지 둘째 줄:

> 30 major investment promotion projects selected by MOTIR · 77 target companies

품목명:

> IMU, RF, and baseband chips for autonomous vehicles

### 지표 ③ 설명 권장 문구

> Issuing corporate bonds on a large scale, raising equity, and securing credit facilities

제안서의 `raising equity`는 수용하되, 앞부분도 다듬는다. `large-scale corporate bonds`보다 **발행 행위의 규모**를 명확하게 표현한다.

### 지표 ④ 설명 권장 방향

명사구를 유지하고 연속 쉼표를 적용해도 충분하다.

> Joint R&D, technology licensing, PoCs, and equity-stake talks

전체 설명을 동명사구로 통일하기로 별도 결정한다면 제안서의 `Pursuing` 추가안도 가능하다. 다만 형식 통일만으로 필수 변경이라고 판단하지 않는다.

### 지표 ⑤ 설명 권장 문구

> C-suite changes, low-profile visits to Korea, and due diligence coordination

`Undergoing leadership changes`보다 명사구가 간결하고, 원문의 C-level 범위도 직접 드러낸다. 동명사구 안의 `leadership`은 C-level보다 범위가 넓고 표현도 길어진다.

`Korea`는 원문의 “방한”을 옮기므로 넣는 것이 맞다. 설명의 예시 하나에 Korea가 들어간다고 지표 전체가 방한으로 제한되는 것은 아니다.

`low-profile`은 “극비”보다 약한 표현이다. 다만 공개자료를 다루는 보고서에서 방문의 비공개성을 과도하게 단정하지 않는 표현으로 합리적이다. 완전히 같은 강도의 번역은 아니라는 점은 남는다.

## 3. R5: 설명 전체의 동명사구 통일은 필수가 아님

설명 다섯 개를 같은 형식으로 맞추면 시각적 일관성은 좋아진다. 그러나 그 때문에 자연스러움과 의미 보존이 떨어진다면 통일을 강제할 필요는 없다.

특히 ⑤를 `Undergoing leadership changes`로 바꾸는 것은 표현이 길어지고 범위가 넓어지는 데 비해 이득이 크지 않다. 각 설명 내부의 병렬 구조와 설명 간 형식 통일은 구분해야 한다.

R5의 해당 조항은 다음과 같이 명확히 하는 것을 권장한다.

> 각 설명 내부의 나열은 병렬 구조를 맞춘다. 설명 간 형식 통일은 자연스러움과 의미 보존을 해치지 않는 범위에서 적용한다. 마지막 항목 앞의 접속사와 연속 쉼표 사용은 일관되게 적용한다.

## 4. 제안서의 판단 근거 중 보완할 부분

### unannounced site visits

반드시 규제기관의 불시 점검만을 뜻하는 표현은 아니다. 다른 상황에서도 사용할 수 있으므로 “규제기관의 불시 점검을 뜻하는 굳은 표현”이라고 단정하는 것은 과하다.

이 보고서에서는 **원문의 비공개성·방한을 전달하지 못하며 불시 방문으로 읽힐 수 있다**는 근거가 더 확실하다. 변경 결론은 유지하되 근거를 수정하는 것이 좋다.

### confidential / unpublicized visits

비공개 방문이 보도되었다고 논리적 모순이 생기는 것은 아니다. 방문 당시에는 비공개였지만 나중에 알려질 수 있다.

따라서 이 표현들은 모순이라는 이유로 일괄 반려하기보다, 자료가 비공개성을 뒷받침하는지와 보고서의 어조에 맞는지로 판단해야 한다.

### Changing C-level executives

주된 문제는 “변하는 임원들”이라는 해석보다 **“임원들을 교체한다”는 뜻으로 좁아지는 것**이다. 선임·퇴임·이동을 폭넓게 다루려는 원문에는 맞지 않으므로 변경 결론은 타당하다.

### 지표 ③ 이름의 양자택일

`Debt & Equity Financing` 또는 기존의 `Capital Raising & Liquidity Securing`만 가능한 것은 아니다.

예를 들어 `Capital Raising & Liquidity Support`도 검토 후보로 생각할 수 있다. 다만 `Support` 역시 “확보”와 완전히 같은 뜻은 아니므로 최종 권장안으로 확정할 단계는 아니다. 기존 문구가 자연스럽다는 뜻에서 보류하는 것도 아니다.

이름이 포괄해야 할 범위를 먼저 정하고 대안을 비교하는 것이 좋다. 제안서의 “모든 조건을 만족하는 안을 찾지 못했다”는 검토 결과를 “다른 대안이 없다”는 결론으로 확대하지 않아야 한다.

### 국문의 “등” 누락

“등”을 매번 영어로 옮기지 않았다는 사실만으로 의미 누락이라고 보기는 어렵다. 짧은 지표 설명에서는 예시 나열로 충분히 읽힐 수 있다.

독자가 실제로 나열을 배타적인 정의로 오해할 여지가 있는지 문맥으로 판단하면 된다. 일괄적으로 `etc.` 등을 추가할 필요는 없다.

## 5. 반영 권장 범위

| 구분 | 권장 사항 |
|---|---|
| 머리글 | `KEY DEVELOPMENTS` 사용 |
| C2 | `selected by MOTIR`를 프로젝트 뒤로 이동 |
| C3 | `IMU, RF, and …`로 연속 쉼표 적용 |
| ③ 설명 | `Issuing corporate bonds on a large scale, raising equity, and securing credit facilities` |
| ④ 설명 | 명사구 유지, 연속 쉼표 적용 |
| ⑤ 설명 | `C-suite changes, low-profile visits to Korea, and due diligence coordination` |
| ③ 이름 | 변경 보류, 의미 범위와 대안 추가 검토 |
| R5 | 각 설명 내부의 병렬 구조를 우선하고, 설명 간 형식 통일은 조건부 적용 |
| 제안서 근거 | 불시 방문·비공개 방문·“등” 누락 등에 대한 단정 완화 |

실제 반영 시에는 국·영문 공통 머리글 적용 범위를 결정 기록에 명시하고, 새 문구의 PDF·화면 레이아웃을 확인해야 한다.
