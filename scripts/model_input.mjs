// 모델에 보내는 표현만 담당하는 변환 계층.
//
// 한국어 원본은 여기서 바뀌지 않는다. 후보의 `row`, 기사 표시 필드, 설정 파일, 수집·분류 키워드,
// 한국어 PDF·화면 표기는 그대로다. 이 파일이 정하는 것은 "같은 사실을 모델에게 어떤 표현으로
// 보내는가" 하나뿐이다.
//
// 2026-09-22 조사에서 한 요청 안에 같은 정의가 두 벌 들어가는 것이 확인됐다. 판정 기준은 S1~S5 를
// 영어로 정의하는데, 후보마다 같은 지표를 한국어 `indicator`·`description` 으로 다시 실어 보냈다.
// 두 벌은 번역 관계도 아니었다(한국어 S2 에만 "APAC", S3 에만 "대규모"가 있다). 후보는 자기 id 로
// 기준을 가리키게 하고, 정의는 판정 기준 한 곳에만 둔다.
export const MODEL_INPUT_VERSION = 'model-input-v1';

// 지표 정의를 후보에서 뺀 자리를 무엇이 대신하는지. 판정 기준의 3번 절이 이 id 로 기준을 고르라고
// 말하고, 기준 목록 자체가 `investment:1` ~ `investment:5` 와 `relevant` 를 표제로 쓴다.
// description_en 을 만들어 후보마다 다시 보내는 것은 언어만 맞추고 중복은 남기는 선택이라 하지 않는다.
export const MODEL_CRITERIA_IDS = ['investment:1', 'investment:2', 'investment:3', 'investment:4',
  'investment:5', 'relevant'];

const text = (value) => String(value ?? '').trim();

// 기술 번역 누락은 조용히 넘어가면 안 된다. 빈 문자열로 보내면 모델은 타겟 기술이 없는 후보로 읽고,
// 한국어로 되돌리면 이 변환 자체가 무의미해진다. 둘 다 하지 않고 준비 단계에서 멈춘다.
//
// 기술 면제(relevance_exempt)와 번역 누락은 다른 상태다. 면제 기업도 타겟 기술 자체는 가지고 있고,
// 승인 조건에서만 빠진다. 그래서 면제를 번역 누락의 면제로 쓰지 않는다.
export function technologyTranslationError(tech) {
  if (!text(tech?.target_technology)) return '';
  if (text(tech?.target_technology_en)) return '';
  const group = text(tech?.technology_group) || 'unknown-group';
  return `Missing target_technology_en for ${text(tech?.company) || 'unknown company'} ` +
    `(technology_group=${group}, target_technology=${JSON.stringify(text(tech.target_technology))})`;
}

// 판정 기준은 `target_technology_scope.includes` 와 `.excludes` 를 보라고 말한다. 그런데 설정 파일의
// 키는 includes_ko·excludes_ko·includes_en·excludes_en 이라, 지시문이 가리키는 키가 전달된 객체에
// 없었다. 2026-09 실행에서 범위가 실린 기사 16건이 그 상태로 판정됐다.
// 여기서 영어 쪽만 골라 지시문이 부르는 이름으로 바꾼다. 한국어 범위는 설정 파일에 그대로 남는다.
export function modelTechnologyScope(scope) {
  if (!scope) return null;
  const includes = text(scope.includes_en), excludes = text(scope.excludes_en);
  if (!includes && !excludes) return null;
  return { includes, excludes };
}

// 모델이 보는 후보. row 는 호출자가 따로 보관한다.
//
// 번역 검사를 여기서도 한다. sourceCandidates 만 검사하면 groupArticles 를 직접 부르는 경로가
// 검사를 지나치고, 그 후보는 타겟 기술이 빈 문자열인 채로 모델에 간다. 기술이 없는 후보와
// 번역이 없는 후보는 모델에게 같은 모양이라 구분되지 않는다.
export function modelCandidate({ kind, row }) {
  const translationError = technologyTranslationError(row);
  if (translationError) throw new Error(translationError);
  const scope = modelTechnologyScope(row.target_technology_scope);
  return {
    id: kind === 'investment' ? `investment:${row.investment_signal_no}` : 'relevant',
    kind,
    // 회사별로 다른 정보라 id 로 대신할 수 없다. 일반 증설인지 그 회사가 추적하는 품목의 증설인지는
    // 기술을 알아야 갈린다. 그래서 지표와 달리 후보에 남기되 표현만 영어로 보낸다.
    target_technology: text(row.target_technology_en),
    // 범위가 없는 기사는 필드 자체를 넣지 않는다. 빈 필드를 넣으면 모든 기사 ID 가 바뀐다.
    ...(scope ? { target_technology_scope: scope } : {}),
    relevance_exempt: row.excluded_from_relevance === true || row.technology_gate_decision === 'relevance_exempt',
  };
}

// 기사에서 사람이 읽는 한국어 설명을 뺀다. date_label("2026.09.08 (게시일 근거 충돌)")과
// date_note("게시일 근거가 서로 어긋남")이 말하는 것은 date_status·date_placement·published_at 에
// 구조화되어 이미 들어 있다. 같은 정보를 한국어 문장으로 한 번 더 보낼 이유가 없다.
//
// 기사 객체에서는 지우지 않는다. date_note 는 날짜 보강 대상 목록을 만들 때 쓰이고 date_label 은
// 사람이 읽는 표시다. 그래서 저장이 아니라 전송에서만 뺀다. 두 필드는 원래부터 기사 ID 의 재료가
// 아니므로(groupArticles 의 material) 이 제외만으로는 저장된 판정이 무효화되지 않는다.
// MODEL_INPUT_VERSION 이 프롬프트 계약에 들어가 그 역할을 한다.
export function modelArticle(article) {
  const { date_note, date_label, ...sent } = article;
  return sent;
}
