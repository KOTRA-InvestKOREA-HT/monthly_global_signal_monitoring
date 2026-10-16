# 사업동향 탐색 검색어·비용 측정 (2026-09-18)

## 결론

- 기업당 사업동향 후보 상한은 `1`건으로 둔다.
- 최종 검색어 로직으로 2026-08-01~2026-08-31, 77개사를 조회했을 때 `trend_discovery_kept=31`이었다.
- 따라서 중복 제거 전 보수적 상한으로도 이번 표본의 추가 LLM 호출은 31회다. 실제 월간 실행에서는 기존 공식·Google 수집 기사와의 중복이 빠져 이보다 줄 수 있다.
- 직전 2건 상한 probe는 47건을 남겼고, 30개사에서 후보가 생겼으며 17개사가 2건 상한에 닿았다. 보조 탐색의 비용을 고려해 1건을 선택했다.

## 측정 방법

- 실제 Google News RSS를 기업당 한 번 조회했다.
- 보고 기간 자체를 `after:2026-08-01 before:2026-09-01`로 지정했다.
- 공식 자료와 일반 fallback은 끄고 사업동향 질의만 격리했다.
- 기사 본문과 LLM API는 호출하지 않았다. 제목·RSS description 사전 필터 뒤 남는 후보 수만 셌다.
- 최종 1건 probe는 요청 77회, 검색 결과 287건, 사전 필터·상한 적용 후 31건, 오류 0건이었다.

## Hydro 회귀 확인

기존 정식 회사명과 카탈로그 검색어만 쓴 질의는 목표 기사를 남기지 못했다. 기업별 검색어와 짧은 별칭을 제한적으로 적용하고 다음 표현을 추가했다.

- `Hydro CIRCAL`
- `recycled aluminium`
- `recycled aluminum`
- `recycled alu`
- `recycled alloy`
- `recycled content aluminum`

최종 probe에서는 `Hydro to supply high recycled content aluminum to GM`이 `recycled content aluminum`으로 매칭되어 후보에 들어왔다. `scrap`이 `scrapped`에 부분 일치해 들어오던 무관한 Mercedes 기사는 단일어 경계 매칭으로 제외했다.

이 측정은 검색·사전 필터 비용을 비교하기 위한 격리 probe다. 월간 전체 실행의 `trend_discovery_kept`가 실제 추가 검토 건수를 기록하므로, 이후 월에도 이 값을 보고 상한을 다시 판단한다.
