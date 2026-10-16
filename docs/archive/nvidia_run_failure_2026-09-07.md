# NVIDIA DeepSeek 판정 검증 오류 (2026-09-07)

실행 `34088768931`의 다운로드 artifact `article-review-34088768931-1`을 확인했다.
진단 파일 9개(기사 5개)는 모두 `investment:1: invalid event_stage`였다.
기업은 Eli Lilly and Company, GE Healthcare, Infineon이다. 실행 자체의 최종 상태는
`cancelled`이며 최종 `status.json`은 없었다. 캐시 저장과 artifact 업로드는 성공했다.

DeepSeek는 투자와 무관한 기사에 `event_stage=not_applicable`,
`indicator_supported=false`, `leading_indicator_supported=false`를 반환했다.
API 출력 스키마에는 `not_applicable`이 포함돼 있지만 내부 `importReview`는
투자 후보에서 이 값을 무조건 거부했다. 재시도 지침도 인용 복사에 집중돼 있어
같은 올바른 제외 판정이 다시 실패했다. 이번 진단의 원인은 인용이나 API 인증이 아니다.

수정: 투자 후보에서 지표 해당 여부와 선행 지표 여부가 모두 명시적으로 `false`인
경우에만 `not_applicable`을 허용한다. 값 자체를 다른 단계로 바꾸지 않는다.
해당 판정은 `supported=false`, `row=null`이므로 보고서 시그널로 발행되지 않는다.
불리언 누락·잘못된 타입, 인용 불일치, 사유 누락, 승인과 모순되는 단계는 계속 거부한다.
`needs_review`의 보류 의미도 유지한다.

모델·프롬프트·정책 해시를 변경하지 않아 현재 NVIDIA의 유효한 캐시는 재사용한다.
Gemini 캐시를 NVIDIA 판정으로 재사용하는 변경은 하지 않았다.

검증: `npm test` 56개 통과. 6개 후보의 DeepSeek 제외 응답을 재현한 모의 API 테스트에서
첫 요청에 완료·저장되고 다음 실행은 API 요청 없이 캐시를 재사용했다.
실제 NVIDIA API 재호출 및 월 전체 PDF 생성은 아직 검증하지 않았다.
