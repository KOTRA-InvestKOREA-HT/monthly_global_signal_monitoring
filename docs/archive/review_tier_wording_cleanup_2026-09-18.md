# 사람 검토 계층 문구 정리 (2026-09-18)

## 무엇이 어긋나 있었나

`09e3059`가 사람 검토 계층을 데이터에서 없앴고 `0477a49`가 승인 기준을 되돌리면서, 승인 조건을
하나 못 채운 후보는 `ai_signal_supported=false`로 남아 대시보드에만 보이고 보고서 본문과
매트릭스에는 실리지 않게 됐다. 두 커밋 모두 판정 기준 문서와 프롬프트를 일부러 건드리지 않았다.
판정 캐시 식별자가 바뀌면 저장된 302건의 기사 판정을 다시 사야 했기 때문이다.

그 결과 정책 문서와 구현이 어긋난 채로 남았다. 문서는 사람 검토 후보를 PDF에 함께 싣는다고
설명했고, 그 후보에도 한영 요약을 쓰라고 지시했다. 이 문구는 `policySection()`을 거쳐 실제
판정 요청의 시스템 프롬프트로 들어가므로, 모델은 어느 지면에도 실리지 않는 행의 요약을 계속
썼다. `review_prompts.mjs`의 요약 자격 지시도 같은 계층을 가리켰다.

## 바꾼 것

- `docs/local_report_review.md`: 요약 대상을 승인 후보로 한정했다. 근접 후보 설명은 모델에
  보내지 않는 `## 실행` 구간으로 옮기고, 그 행이 발행되지 않는다는 사실을 명시했다.
- `scripts/review_prompts.mjs`: 요약 자격 지시에서 human-review를 뺐다. 판정 기준과 1차 지시가
  함께 바뀌어 캐시가 어차피 무효가 되므로, 그때 빼라고 주석에 적혀 있던
  `PRIMARY_CACHE_VERIFY_COMPAT` 호환 문자열도 함께 제거했다. `PROMPT_VERSION`은 v3이다.
- `scripts/review_report.mjs`: 보조 요청의 검증 메시지와 로그, 실행 요약의 재검토 미완료 문구를
  실제 동작(승인 후보 / 대시보드 보관)에 맞췄다.
- `app/page.jsx`, `app/lib/dashboard_signals.mjs`: 사라진 `ai_review_tier`·`ai_review_gaps`를
  읽던 코드를 지우고 근접 후보 배지 하나로 합쳤다. 통계 항목은 `근접 후보(미발행)`이다.

근접 후보를 무엇으로 볼지는 `nearMissCandidate()`가 코드로 정한다. 모델은 그 계층을 알 필요가
없으므로 판정 기준에서 설명하지 않는다.

## 운영상 결과: 판정 캐시 무효화

`reviewPolicy()`는 판정 기준 본문과 프롬프트 digest를 기사 ID에 넣는다. 이번 변경으로 식별자가
바뀌었다.

```
이전: article-review-v1:5a6519e4fe2fc0360fcbe68a
이후: article-review-v1:f5fa8c84ea674c9143f4452e
```

저장된 판정은 재사용되지 않으므로 다음 실행은 전체 재판정이다. 무료 할당량과
`GEMINI_MAX_REQUESTS` 때문에 한 번에 끝나지 않으면 워크플로가 진행분을 저장하고 멈추며, 같은
기간으로 다시 돌리면 이어서 진행한다. 어차피 전체 재판정이 필요한 실행에서 이 정리를 함께
가져가는 것이 비용상 유리하다.

## 이어서 볼 것

1. **사업동향 누락 실측.** `collect-company-signals` 워크플로를 해당 기간으로 수동 실행한 뒤
   실행 요약의 `trend_discovery_found`와 `trend_discovery_kept`, 그리고 발행된 사업동향 건수를
   본다. 로컬에서는 API 키가 없어 돌릴 수 없다.
2. **후보 상한 1 → 2.** `collect_company_signals.mjs`의 `TREND_DISCOVERY_PER_COMPANY` 한 줄이고
   `--max-trend-discovery`로도 넘긴다. 상한을 바꾸면 수집 식별자가 바뀌어 다시 수집한다.
   2026-08 격리 probe에서 상한 1은 31건, 상한 2는 47건을 남겼다
   (`docs/trend_discovery_measurement_2026-09-18.md`). 실측에서 누락이 확인된 뒤에 올린다.
3. **기술 그룹 범위 확충.** 30개 그룹 중 `satellite_radar_rf_semiconductor` 하나만
   `config/technology_scope.json`에 정의돼 있다. 예전 오판으로 지목된 NXP 차량용 UWB와 Infineon
   전력반도체는 둘 다 이 그룹이라, 범위를 적는 방식 자체는 이미 효과가 확인된 셈이다. 나머지 29개
   그룹의 우선순위는 저장된 `outputs/latest_*`로는 정할 수 없다. 그 파일은 계층 제거 이전 실행의
   38행짜리 산출물이라 현재 승인 기준의 기술 연결 판정을 담고 있지 않다. 1번 실측이 끝난 뒤
   기술 연결로 승인된 행과 기술 연결만 모자란 근접 후보가 많은 그룹부터 적는다.
