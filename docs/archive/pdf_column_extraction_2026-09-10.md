# PDF 다단 본문 추출 오류 (2026-09-10)

실행 `34425835724`의 artifact `article-review-34425835724-1`을 확인했다. 최종
`status.json`은 `paused` / `invalid_responses`, 완료 320/324, API 요청 97건,
캐시 235건이다. 요청이 97건뿐이라 쿼터나 429와는 무관하다. 두 번씩 재시도한 뒤에도
실패한 기사 4건은 모두 `evidence_mismatch`였고, 4건 전부 PDF다. Nabtesco FY2026 Q2
실적설명회 Q&A, Vestas 2026 Q2 Company Announcement, Umicore 연차보고서 2022·2023이다.
완료 상태가 아니면 `review_report.mjs`가 exit code 75를 내보내므로 잡 전체가 실패했다.

원인은 인용 자체가 아니라 본문 추출이다. `pdfplumber`의 `extract_text`는 페이지를
전체 폭에 걸쳐 한 줄씩 읽는다. 다단 레이아웃에서는 두 단이 한 줄씩 번갈아 나오므로
한 문장이 옆 단 텍스트로 끊긴다. Vestas 6쪽에서 추출된 원형은 다음과 같았다.

```
...decreased due to Eurobond maturing in 2033, Vestas successfully issued
less investments related to the manufacturing ramp-up a EUR 500m Eurobond
maturing in 2033; the proceeds of the V236-15.0 MW platform. were used to
repay the existing EUR 500m Eurobond which matured in second quarter 2026.
```

모델은 이 문장을 옳게 이해해 읽을 수 있는 한 문장으로 복원해 인용했다. 그러나 복원된
문장은 원문의 연속 부분열이 아니므로 `local_report.mjs`의 정확 일치 검사에서 탈락한다.
Nabtesco는 Q&A 표라 질문 열과 답변 열이 교차했고, 모델이 답변 열을 이어 붙이면서
`completed based on the assumption`의 `based`를 빠뜨렸다. 이미 있는
`separateVerifiedQuotes`의 복구는 문장 단위로 붙은 인용만 분리하므로 문장 내부에서
일어난 이 뒤섞임에는 닿지 않는다.

수정: `scripts/extract_pdf_text.py`를 추가하고 수집기가 이 스크립트로 PDF를 읽게 했다.
페이지를 읽기 전에 재귀 XY cut으로 영역을 나눠, 한 단을 끝까지 읽은 뒤 다음 단으로
넘어간다. 단 경계는 폭만으로 판정하지 않는다. 양쪽 정렬된 본문의 어절 간격이 조밀한
보고서의 표 열 간격보다 넓은 경우가 있어서다. 대신 열이 가지는 성질, 즉 그 오른쪽
줄들이 같은 x에서 시작한다는 정렬을 요구한다. 단을 가로지르는 머리글이 세로 여백을
가려 열이 보이지 않는 경우에는, 가로지르는 줄만 따로 떼어낸 뒤 남은 띠에서 다시
단을 찾는다. 단이 없는 페이지는 기존과 같은 읽기 순서로 남는다.

`CONTENT_COLLECTION_VERSION`을 `article-body-v3`으로 올렸다. 올리지 않으면 예전
방식으로 추출된 캐시 본문이 그대로 쓰여 수정이 적용되지 않는다. 기사 ID는 본문을
포함해 해시하므로 PDF 기사 47건은 ID가 바뀌어 다시 판정되고, 나머지는 캐시를 유지한다.

검증: `npm test` 122개 통과, `python -m unittest discover -s tests` 10개 통과.
새 `tests/test_pdf_extraction.py`의 5개 중 3개는 예전 줄 단위 읽기에서 실패하고
2개는 단이 없는 본문이 쪼개지지 않음을 지킨다. 실패했던 4건의 실제 PDF를 내려받아
확인한 결과 Vestas·Umicore 2022·Umicore 2023의 문제 인용은 새 추출 본문에서 정확히
일치하고, Nabtesco는 `based`를 포함한 원문 문장이 연속으로 복원된다. 4개 PDF의 30쪽
전체에서 단어가 유실되거나 중복되지 않음도 확인했다. Umicore 2022의
`substantial government grants` 인용은 290쪽 문서의 앞 60쪽 어디에도 없어 이번 수정
대상이 아니다. 모델이 지어낸 인용을 검증이 옳게 막은 경우다.

남은 사항: 2026년 8월 보고서인데 Umicore 2022·2023 연차보고서 PDF가 수집됐다.
제목이 `English version`인 문서로, 판정 이전 수집 단계에서 볼 문제다.
실제 워크플로 재실행은 아직 하지 않았다.
