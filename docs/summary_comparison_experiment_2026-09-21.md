# 문안 비교 실험 (2026-09-21)

이번 회차 문안 오류를 프롬프트 금지사항으로 바꾸지 않고, **평가용 사례**로 남겼다. 대신 비교
실험 장치를 만들었다. 재는 것은 두 가지다.

1. **공통 사실 기반 한·영 작성**(`shared_facts` 변형) 대 현재 방식
2. **같은 입력에 모델만 교체**

두 비교 모두 "실행 디렉터리 두 개"로 귀결되므로 도구는 하나다.

## 무엇을 고쳤고 무엇을 고치지 않았나

기본 경로는 한 글자도 바뀌지 않았다. `buildSystemInstruction('P')` 과 `reviewPromptDigest('P')`
가 HEAD 와 같은 값을 낸다는 것을 확인했고, 테스트로도 고정했다. 즉 이 변경만으로는 재판정이
발생하지 않는다.

- 새 프롬프트 지시문은 `shared_facts` 변형 안에만 있다. 기본값은 `baseline` 이다.
- 특정 기업·표현에 대한 예외는 넣지 않았다. `GUSS`, `pending`, `Applied Materials` 는 프롬프트
  어디에도 없다. 그 사례들은 `config/golden_articles.json` 의 `defects` 에만 있다.

## shared_facts 가 바꾸는 것

기사 판정은 그대로 두고, 문안 작성 앞에 한 단계를 넣는다. 모델이 그 후보의 근거에서 사실 목록을
먼저 적고(`actor`, `action`, `counterparty`, `date`, `status`, `amount`), 두 문안을 그 목록에서만
쓴다. 구조화 출력의 키 순서가 곧 모델이 답을 쓰는 순서이므로, `facts` 는 `quality` 뒤 `summary_ko`
앞에 둔다. 문안을 먼저 쓰고 사실을 맞춰 적는 순서가 되면 실험이 성립하지 않는다.

지시문 제목도 함께 바뀐다(`… then one shared fact list for both languages`). 본문만 갈아 끼우면
"각 언어를 따로 쓴다"는 제목이 본문과 어긋난 채 함께 전달된다.

**나아진다는 보장은 없다.** 사실 목록을 뽑는 단계부터 틀릴 수 있다. 그래서 재는 것이다.

## 개발용과 검증용

`config/golden_articles.json` 의 모든 항목에 `set` 이 붙었다. 표시를 잊은 항목은 `holdout` 으로
읽는다. 개발용으로 새지 않는 쪽이 안전한 기본값이다.

| set | 건수 | 무엇인가 |
|---|---|---|
| `dev` | 6 | 이번 회차에 문안 오류를 발견한 기사. 수정 방향을 정하는 데 썼다 |
| `holdout` | 32 | 그 수정에 쓰지 않은 기사 |

`dev` 6건은 Applied Materials 3건(Q3 실적, CD-SEM, UC Berkeley), Ouster–GUSS, Skyworks
선순위채권, Applied 어드밴스드 패키징 해설이다. 각 항목의 `defects` 에 무엇이 틀렸는지 적었다.
앞의 넷은 이미 골든 목록에 있던 기사라 `set` 만 붙였고, 뒤의 둘은 새로 넣었다.

`holdout` 32건 중 16건은 2026-08 리콜 조사에서 온 기존 목록이고, 16건은 현재 수집본에서 한·영
문안이 모두 있으면서 목록에 없던 기사 **전부**를 회사·url 순으로 넣은 것이다. 골라 넣지 않았다.
좋아 보이는 기사를 고르면 홀드아웃이 홀드아웃이 아니게 된다.

`dev` 에서만 좋아지면 과적합이다. `holdout` 에서도 같이 좋아져야 일반화된 개선이다.

## 실행

변형은 `REPORT_PROMPT_VARIANT` 로 정한다. `--variant` 는 그 값을 확인만 한다. 모듈이 적재될 때
이미 프롬프트 다이제스트에 들어가므로, 인자로 늦게 바꾸면 요청은 변형으로 나가고 기사 id 는
기본값으로 남는다.

```bash
# 1. 현재 방식
node scripts/golden_review.mjs --month 2026-08 --set dev \
  --out-dir outputs/golden_eval/baseline-dev --run

# 2. 공통 사실 기반
REPORT_PROMPT_VARIANT=shared_facts node scripts/golden_review.mjs --month 2026-08 --set dev \
  --variant shared_facts --out-dir outputs/golden_eval/shared-dev --run

# 3. 채점지
node scripts/summary_sheet.mjs --a outputs/golden_eval/baseline-dev \
  --b outputs/golden_eval/shared-dev --out docs/sheets/dev.md
```

`--set holdout` 로 같은 셋을 한 번 더 돌린다. 모델 교체는 `<PROVIDER>_MODEL` 만 바꾸고 같은
`--set`, 같은 `--variant` 로 돌린 뒤 두 디렉터리를 `summary_sheet` 에 넣는다.

요청 수는 기사 수와 같다(`expected_requests`). dev 6건, holdout 29건이므로 한 조합에 35건,
변형 비교에 70건, 모델 교체까지 하면 140건이다.

## 채점지

`scripts/summary_sheet.mjs` 는 같은 기사·같은 후보를 한 표에 놓는다. 근거 인용을 문안 위에 두고,
`shared_facts` 실행이면 사실 목록을 그 아래 한 줄로 적는다. 문안이 틀렸을 때 **목록부터 틀렸는지,
목록은 맞는데 문장이 틀렸는지**를 갈라 봐야 변형이 무엇을 바꿨는지 읽을 수 있다.

칸은 세 개다. 셋은 서로 다른 문제이고, 고치는 자리도 다르다.

- **사실**: 근거에 없는 말이거나 근거와 다른 말(주체·상대방·날짜·금액·진행 단계)
- **누락**: 근거에 있는데 요약이 떨어뜨린 사실
- **어색**: 사실은 맞지만 직역·음차·비문으로 읽히지 않는 문장

## 아직 하지 못한 것

- **실제 호출을 하지 못했다.** `GEMINI_API_KEY` 가 로컬에 없다. 위 명령은 `--run` 없이 계획까지
  확인했다(dev 6건 36후보, holdout 29건 174후보).
- 홀드아웃 32건 중 3건(Amkor, Evonik, Moderna)이 현재 수집본에 없다. 목록의 기사가 빠지면 비교
  대상이 말없이 달라지므로 기본은 중단이고, `--allow-missing` 으로 한 번 인정하면 나머지로
  진행하면서 빠진 목록을 `plan.json` 과 `comparison.json` 에 남긴다.
- 기대 사실값은 비워 두었다. `defects` 에는 관찰한 문제만 적었다. 각 기사의 올바른 사실이
  무엇인지는 원문을 본 사람이 채워야 한다.
