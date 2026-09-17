// 2026-08 보고서(실행 35167466191) 재판정·문안 수정 기록.
// 저장 본문과 docs/local_report_review.md 기준으로 사람이(Claude 로컬 세션) 직접 읽고 판정했다.
// apply.mjs 가 원본 review 를 복사한 새 폴더에 적용하고 importReview(strictNumbers) 로 검증한다.
// 원본 아티팩트와 snapshot 은 수정하지 않는다.

export const REVIEWER = 'claude-opus-5 local adjudication 2026-09-17';

const decision = (candidate_id, fields) => ({
  candidate_id, entity_supported: true, target_technology_supported: false, indicator_supported: false,
  leading_indicator_supported: false, event_stage: 'unclear', quality: 'pass', evidence_quotes: [],
  summary_ko: '', summary_en: '', ...fields,
});
const business = (fields) => decision('relevant', { leading_indicator_supported: true, event_stage: 'not_applicable', ...fields });

// ---- Nexeon 1억 파운드 투자 라운드 (판정 실패 기사) ----
const NEXEON_ROUND = 'The National Wealth Fund’s commitment of £52.6 million ($70 million) marks the completion of Nexeon’s latest investment round totalling £100 million ($133 million).';
const NEXEON_INVESTORS = 'Other new investors include the Korea Development Bank and Honda Xcelerator Ventures.';
const NEXEON_USE = 'The National Wealth Fund’s financing will support Nexeon’s development of a UK-based pilot manufacturing facility, directly supporting their research and development activities and allowing the expansion of its advanced manufacturing technology unit, creating a number of new highly skilled jobs.';
const NEXEON_SCALE = 'The investment round supports the company’s continued scale-up and commercialisation activities and marks another key milestone in the pathway to high-volume manufacturing and global customer adoption.';
const NEXEON_HONDA = 'Honda Xcelerator Ventures is the global open innovation program of the Honda Motor Co. Ltd., and invests in technologies shaping the future of mobility and electrification.';
const NEXEON_TECH = 'Nexeon’s cutting-edge silicon anode materials enable production of higher energy density lithium-ion batteries, helping to reduce charging times and extend the range of electric vehicles.';

// ---- Siemens-Gamesa Q3 FY26 실적 발표 (판정 실패 기사) ----
const SGRE_PROFIT = 'Siemens Gamesa reported a positive result for the first time since fiscal year 2022 and is on track to reach break-even for 2026.';
const SGRE_OFFSHORE = 'Year-over-year, revenue rose significantly due to an increase in the offshore business.';

// ---- Skyworks/Qorvo 기사 (판정 실패 기사) ----
const SKY_CLOSE = 'Semiconductor company Skyworks Solutions said it expects to complete its approximately $22 billion acquisition of rival Qorvo by the end of the year, earlier than previously anticipated, creating a larger player in the increasingly competitive chip market.';
const SKY_LEADERS = 'Last week, the company also announced its leadership team once the merger is completed.';

export const ADJUDICATIONS = {
  f339eb0a85d7d0d8dbd194e7: {
    kind: 'rereview_failed_article',
    note: 'Nexeon 1억 파운드 투자 라운드. 두 번의 모델 응답이 인용 불일치로 저장되지 않아 보고서에서 빠졌다. 두 번째 응답은 S3를 completed 로 봤다.',
    decisions: [
      decision('investment:1', { target_technology_supported: true,
        reason_ko: '영국 배터리 공급망 강화는 투자 기관과 정부 측의 정책 목적 설명이며, Nexeon이 직접 취한 공급선 다변화·현지 조달 전환 조치는 본문에 없음.' }),
      decision('investment:2', { target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true,
        event_stage: 'planned', evidence_quotes: [NEXEON_USE, NEXEON_TECH],
        reason_ko: '조달 자금으로 영국 내 파일럿 제조시설을 개발하고 첨단 제조기술 조직을 확대한다고 명시해 실리콘 음극재 생산 거점 신설 계획이 확인됨. 시설은 아직 개발 단계이므로 planned.',
        summary_ko: '영국 파일럿 제조시설 개발 계획 - National Wealth Fund 자금으로 영국 내 실리콘 음극재 파일럿 제조시설을 개발하고 첨단 제조기술 조직을 확대할 계획임.',
        summary_en: 'UK pilot manufacturing facility planned - National Wealth Fund financing will support Nexeon’s development of a UK-based pilot manufacturing facility and the expansion of its advanced manufacturing technology unit.' }),
      decision('investment:3', { target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true,
        event_stage: 'precursor', evidence_quotes: [NEXEON_ROUND, NEXEON_USE],
        reason_ko: '총 1억 파운드 투자 라운드 완료는 조달 활동의 완료이지 최종 시설투자의 완료가 아님. 자금 용도로 영국 파일럿 제조시설 개발과 제조기술 조직 확대가 명시돼 투자 목적 조달의 전조(precursor)임.',
        summary_ko: '1억 파운드 투자 라운드 완료로 설비 재원 확보 - National Wealth Fund의 5,260만 파운드 투입으로 총 1억 파운드 라운드가 완료됐으며, 자금은 영국 파일럿 제조시설 개발에 쓰일 예정임.',
        summary_en: 'Completion of £100 million investment round - The National Wealth Fund’s £52.6 million commitment completed Nexeon’s £100 million round, and the financing will support development of a UK-based pilot manufacturing facility.' }),
      decision('investment:4', { target_technology_supported: true, indicator_supported: true, leading_indicator_supported: true,
        event_stage: 'precursor', evidence_quotes: [NEXEON_INVESTORS, NEXEON_HONDA],
        reason_ko: 'Honda의 오픈 이노베이션 투자 조직인 Honda Xcelerator Ventures가 실리콘 음극재 기술 기업인 Nexeon에 신규 투자자로 참여함(기술 기업 지분투자). 공동개발 과제는 명시되지 않아 협력으로 확대 해석하지 않음.',
        summary_ko: 'Honda Xcelerator Ventures 등 신규 전략 투자자 참여 - Honda의 오픈 이노베이션 투자 조직인 Honda Xcelerator Ventures와 Korea Development Bank가 이번 라운드에 신규 투자자로 참여했음.',
        summary_en: 'New strategic investors join the round - Honda Xcelerator Ventures, the open innovation program of Honda Motor Co. Ltd., and the Korea Development Bank joined as new investors in the round.' }),
      decision('investment:5', { target_technology_supported: true,
        reason_ko: '경영진 선임·교체·영입이나 한국 방문 사건이 없음. CEO·CFO 발언 인용만 있음.' }),
      business({ target_technology_supported: true, indicator_supported: true, evidence_quotes: [NEXEON_ROUND, NEXEON_INVESTORS, NEXEON_SCALE],
        reason_ko: '실리콘 음극재 기업 Nexeon의 투자 라운드 완료와 규모 확대·상업화 자금 확보라는 구체적 사업 활동이 확인됨.',
        summary_ko: 'Nexeon은 National Wealth Fund의 5,260만 파운드 투자로 총 1억 파운드 규모 투자 라운드를 완료했음. Korea Development Bank와 Honda Xcelerator Ventures가 신규 투자자로 참여했음. 자금은 실리콘 음극재 사업의 규모 확대·상업화와 영국 파일럿 제조시설 개발에 쓰일 예정임.',
        summary_en: 'Nexeon completed an investment round totalling £100 million with a £52.6 million commitment from the National Wealth Fund. The Korea Development Bank and Honda Xcelerator Ventures joined as new investors. The funds will support the scale-up and commercialisation of its silicon anode business and the development of a UK pilot manufacturing facility.' }),
    ],
  },

  a02a239ca2b6bb4a409a4103: {
    kind: 'rereview_failed_article',
    note: 'Siemens Energy Q3 FY26 실적 발표. 두 응답 모두 relevant 인용 불일치로 실패. 같은 실적의 주주서한(4d8f3b6d…)은 이미 사업동향으로 승인됨.',
    decisions: [
      ...[1, 2, 3, 4, 5].map((no) => decision(`investment:${no}`, { target_technology_supported: no === 2,
        reason_ko: {
          1: '공급망·지정학 리스크에 대한 Siemens Gamesa의 구체적 대응 조치가 없음.',
          2: '해상풍력 매출 증가 설명만 있고 생산능력 증설·신규 공장 계획은 없음. 그룹 차원의 capacity expansion 언급은 Siemens Gamesa에 귀속되지 않음.',
          3: '신규 자금 조달 사건이 없음. 자사주 매입 현금흐름은 자금 지출임.',
          4: '공동연구·라이선스 등 기술 협력 사건이 없음.',
          5: '핵심 경영진 선임·이동 사건이 없음.',
        }[no] })),
      business({ target_technology_supported: true, indicator_supported: true, evidence_quotes: [SGRE_PROFIT, SGRE_OFFSHORE],
        reason_ko: '실적 발표 안에 해상풍력 사업 증가에 따른 Siemens Gamesa 매출 증가와 흑자 전환이 명시돼 해상풍력터빈 사업 동향으로 인정함. 같은 분기 주주서한 기사와 내용이 겹침.',
        summary_ko: 'Siemens Gamesa는 2026 회계연도 3분기에 2022 회계연도 이후 처음으로 흑자를 기록했으며 2026년 손익분기점 달성을 향해 나아가고 있음. 매출은 해상풍력 사업 증가에 힘입어 전년 동기 대비 크게 늘었음.',
        summary_en: 'Siemens Gamesa reported a positive result for the first time since fiscal year 2022 and is on track to reach break-even for 2026. Its revenue rose significantly year over year due to an increase in the offshore business.' }),
    ],
  },

  c2f5c757eab28908e6515374: {
    kind: 'rereview_failed_article',
    note: 'Skyworks 2025 연차보고서·2026 주총 안내. 게시일 미상(date_pending). 두 응답 모두 S5 인용 불일치로 실패.',
    decisions: [
      ...[1, 2, 3, 4, 5].map((no) => decision(`investment:${no}`, {
        reason_ko: {
          1: '연차보고서의 회사 소개로, 보고 기간 내 공급망 대응 조치가 없음.',
          2: '생산시설 증설·신규 거점 계획이 없음.',
          3: '신규 자금 조달 사건이 없음.',
          4: '2025년 10월 발표된 Qorvo 합병을 회고할 뿐 보고 기간 내 새 기술 협력 과제가 없음. 합병 자체는 S4 사건이 아님.',
          5: '경영진 명단과 직함만 나열돼 있고 보고 기간 내 선임·교체 사건이 명시되지 않음.',
        }[no] })),
      business({ reason_ko: '연차보고서·주총 안내의 일반 회사 소개와 과거 합병 발표 회고로, 자율주행차 IMU/RF/베이스밴드 칩과 직접 연결된 구체적 사업 활동이 없음.' }),
    ],
  },

  '5b07cc9eb5ec3b9f552ccfa5': {
    kind: 'rereview_failed_article',
    note: 'OCBJ 8/3 Skyworks/Qorvo 기사. 1차는 요약 숫자 오류(22억 달러), 2차는 relevant 인용 불일치로 실패.',
    decisions: [
      decision('investment:1', { reason_ko: '공급망·지정학 리스크 대응 조치가 없음. 합병 규제 승인 절차는 S1 사건이 아님.' }),
      decision('investment:2', { reason_ko: '생산시설 증설 계획이 없음. 매출 전망은 S2 근거가 아님.' }),
      decision('investment:3', { reason_ko: '배당 중단과 자사주 매입 승인은 자금 조달이 아님. 합병 자금 조달 계획은 구체적 조달 사건으로 서술되지 않음.' }),
      decision('investment:4', { reason_ko: 'Qorvo 인수 자체는 S4 기술 협력 사건이 아님. 인수 발표도 2025년 10월임.' }),
      decision('investment:5', { indicator_supported: true, evidence_quotes: [SKY_LEADERS],
        reason_ko: '합병 후 경영진(CFO, COO/CTO) 구성 발표가 있으나 기사 게시일(8월 3일) 기준 "지난주"인 7월 말 발표를 되짚은 것으로 보고 기간 내 신규 발표가 아님. RF 통신칩 합병 경영진으로 자율주행차 칩 연결도 확인되지 않음.' }),
      business({ indicator_supported: true, evidence_quotes: [SKY_CLOSE],
        reason_ko: 'Qorvo 인수 종결 시점을 앞당긴다는 구체적 사업 동향이 있으나, 스마트폰·통신용 RF 칩 기업 간 합병으로 자율주행차 IMU/RF/베이스밴드 칩과의 직접 연결이 본문에 없음.' }),
    ],
  },

  fde5ad838758c10519286600: {
    kind: 'correction',
    note: '3M 8-K 신용계약. S3 승인 → 탈락. 기술 관련성 면제(3M)는 유지.',
    patch: {
      'investment:3': { indicator_supported: false, leading_indicator_supported: false, event_stage: 'unclear',
        evidence_quotes: [
          'On August 17, 2026 (the “Effective Date”), 3M Company (the “Company”) entered into a new credit agreement (the “Credit Agreement”) with JPMorgan Chase Bank, N.A., as administrative agent; certain subsidiaries of the Company from time to time party thereto, as subsidiary borrowers (together with the Company, the “Borrowers”); and certain financial institutions as lenders.',
          'The Credit Agreement replaced the $4.25 billion five-year revolving credit agreement dated as of May 11, 2023 (as amended by Amendment No. 1, dated as of July 7, 2023 and Amendment No. 2, dated as of September 18, 2023, the “Former Revolving Credit Agreement”), among the Company, the lenders named therein and JPMorgan Chase Bank, N.A. as administrative agent.',
        ],
        reason_ko: '새 신용계약은 같은 규모(42억 5000만 달러)의 기존 5년 만기 리볼빙 신용계약을 대체하고 기존 약정을 종료한 갱신·차환임. 순증 신규 자금이나 투자·사업 확장 용도가 명시되지 않아 S3 투자 재원 확보 사건으로 보지 않음. 기술 관련성 면제는 조달 사건 요건을 면제하지 않음.',
        summary_ko: '', summary_en: '' },
    },
  },

  b6009dba54b6af864abf5adb: {
    kind: 'correction',
    note: 'Air Liquide 2026 상반기 재무보고서. S2 planned 승인 → committed·당월 신규성 없음으로 탈락. 사업동향 문안을 투자 결정 내용으로 교체.',
    patch: {
      'investment:2': { target_technology_supported: false, indicator_supported: true, leading_indicator_supported: false,
        event_stage: 'committed',
        reason_ko: '애리조나 1억 6,000만 달러 생산유닛은 신규 장기계약에 따라 투자가 결정된 시설로, 2028년 가동 예정은 확정 투자의 일정이지 미확정 계획이 아님(committed). 반기보고서가 상반기 투자 결정 목록을 정리한 것이며 8월에 새로 발표된 사건이라는 근거가 없음. 별도의 미확정 후속 증설 계획도 없음.',
        summary_ko: '', summary_en: '' },
      relevant: { target_technology_supported: false,
        evidence_quotes: [
          'In the 1st half of 2026, industrial and financial investment decisions were particularly dynamic. They reached a record level of 2.9 billion euros, up +27% compared to the 1st half of 2025.',
          '160 million US dollars investment in Arizona, United States: Air Liquide plans the start-up by 2028 of a new large-scale production unit to supply high purity gases to the expansion of a plant operated by a world leader in the semiconductor industry.',
        ],
        reason_ko: '상반기 산업·금융 투자 결정과 반도체 고객용 가스 생산유닛 투자 등 구체적 사업 활동이 보고됨. 기술 관련성 면제 기업이며 타겟 기술(이온교환막)과의 직접 연결은 확인되지 않음.',
        summary_ko: 'Air Liquide의 2026년 상반기 산업·금융 투자 결정액은 29억 유로로 전년 동기 대비 27% 늘어 최대치를 기록했음. 여기에는 미국 애리조나주 반도체 공장 확장에 고순도 가스를 공급할 대규모 생산유닛 투자(1억 6,000만 달러)가 포함되며, 해당 유닛은 2028년까지 가동 예정임.',
        summary_en: 'Air Liquide’s industrial and financial investment decisions reached a record 2.9 billion euros in the first half of 2026, up 27% year on year. They include a 160 million US dollar investment in Arizona, United States, in a new large-scale production unit to supply high purity gases to a semiconductor plant expansion, with start-up planned by 2028.' },
    },
  },

  fc8638acf32baa3386674317: {
    kind: 'correction',
    note: 'Infineon 사업동향 승인 → 기술 연결 미확인으로 탈락.',
    patch: { relevant: { target_technology_supported: false, summary_ko: '', summary_en: '',
      reason_ko: '우주망원경에 탑재된 방사선 경화 HiRel 전력 반도체 사건임. 지정 품목은 위성통신·레이다용 RF 반도체로, 우주용이라는 적용 분야 공통점만으로 전력 반도체와 RF 반도체의 직접 기술 연결을 인정하지 않음.' } },
  },

  e62873f81fe53ca3b1e9b01b: {
    kind: 'correction',
    note: 'Plansee 사업동향 승인 → 기술 연결 미확인으로 탈락.',
    patch: { relevant: { target_technology_supported: false, summary_ko: '', summary_en: '',
      reason_ko: '텅스텐 공구·스크랩 재활용과 텅스텐 원료 조달에 관한 인터뷰로, 지정 품목인 티타늄·탄탈륨 금속타겟과 소재·용도가 다름. 같은 금속 소재 기업이라는 이유로 직접 연결을 인정하지 않음.' } },
  },

  '544145cbe1b47486a06adf03': {
    kind: 'correction',
    note: 'NXP 사업동향 승인 → 매핑 적용 분야(우주항공) 밖으로 판단해 탈락. 매핑 범위를 넓히기로 결정하면 재검토 필요.',
    patch: { relevant: { target_technology_supported: false, summary_ko: '', summary_en: '',
      reason_ko: '차량 실내 디지털 키·탑승자 감지용 UWB 단거리 레이다가 BMW 차량에 적용되는 사건임. 기술 매핑은 우주항공 산업의 위성통신·레이다용 RF 반도체이며, 레이다 기능이 있다는 공통점만으로 자동차 UWB 칩을 해당 품목과 직접 연결하지 않음. 매핑 적용 범위 확인이 필요함.' } },
  },

  ae55f545a376db882a62ca66: {
    kind: 'correction',
    note: 'HyproMag 사업동향 유지. 사건 주체가 모회사 Mkango임을 문안에 밝히고 HyProMag와의 명시적 연결과 인수금액(800만 유로)을 한·영 양쪽에 반영.',
    patch: { relevant: {
      evidence_quotes: [
        'Mkango Resources Ltd. ( AIM/TSX-V: MKA) (“Mkango” or the “Company”) is pleased to announce that following the announcement on 20 May 2026, the Company has completed the acquisition of the Remloy rare earth magnet recycling business (“Remloy”) from Heraeus Amloy Technologies GmbH for €8 million (US$9.3 million [1] ) in cash of which €5 million (US$5.8 million 1 ) was settled by Mkango on closing (the “Transaction”).',
        'Supply of end-of-life magnets from the Remloy stockpile for processing by the HyProMag group',
        'Maginito holds a 100 per cent interest in HyProMag Limited',
      ],
      reason_ko: '인수 주체는 HyProMag Limited를 100% 보유한 Maginito의 지배회사 Mkango임. 본문이 Remloy 폐자석 재고의 HyProMag 그룹 공급과 인력·시너지 연계를 명시해 타겟과의 연결이 확인되며, 폐영구자석 재활용 사업으로 타겟 기술과 연결됨.',
      summary_ko: 'HyProMag의 지배회사 Mkango Resources Ltd.가 Heraeus Amloy Technologies GmbH로부터 Remloy 희토류 자석 재활용 사업을 800만 유로에 인수 완료했음. Remloy의 독일 Bitterfeld 공장은 폐영구자석을 용융 공정으로 재활용해 NdFeB 합금 분말을 생산함. Mkango는 Remloy 폐자석 재고를 HyProMag 그룹 처리 원료로 공급하는 방안을 시너지로 제시했음.',
      summary_en: 'Mkango Resources Ltd., the controlling parent of HyProMag, completed the acquisition of the Remloy rare earth magnet recycling business from Heraeus Amloy Technologies GmbH for €8 million. Remloy’s plant in Bitterfeld, Germany, recycles end-of-life rare earth magnets via a melting process to produce NdFeB alloy powders. Mkango cited the supply of end-of-life magnets from the Remloy stockpile for processing by the HyProMag group as a synergy.' } },
  },

  // ---- 문안만 수정: 판정 필드는 그대로 두고 문체·고유명사·번역을 고친다 ----
  '58da11f5299fc5e2a2bd3a1d': { kind: 'wording', note: 'Evonik 음차 제거', patch: {
    'investment:3': { summary_ko: '캐나다 정부 기금 지원을 통한 신규 시설 투자 재원 확보 - Evonik의 밴쿠버 신규 GMP 제조 시설 프로젝트는 캐나다 연방 정부 Strategic Response Fund로부터 최대 6800만 캐나다달러의 외부 자금 지원을 받음.' },
    'investment:2': { summary_ko: '캐나다 밴쿠버 LNP 제조 시설 투자를 통한 생산 능력 확충 - Evonik은 캐나다 밴쿠버에 지질 기반 약물 전달체(LNP) 생산을 위한 1억 5000만 캐나다달러 규모의 신규 GMP 제조 시설 투자를 발표했으며, 2029년 말 생산 개시를 목표로 함.' } } },
  '029c1f295b1cb977e1b98b68': { kind: 'wording', note: 'Jenoptik 음차·문체', patch: {
    'investment:2': { summary_ko: 'OEM 사업 부문의 생산 능력 확대 계획 추진 - Jenoptik은 2026년 상반기 실적 발표에서 OEM 사업 부문의 생산 능력 확대를 단기 중점 과제로 제시했음.' } } },
  '7bbcfbfcc8fca19098658a1a': { kind: 'wording', note: 'Boeing·Archer 음차 제거', patch: {
    'investment:4': { summary_ko: 'Archer와 전략적 파트너십 및 기술 공유 협약 체결 - Boeing이 Archer와 전략적 파트너십을 맺고 지분을 취득하며, Wisk의 자율비행 핵심 기술 접근권을 유지하는 기술 공유 협약을 체결했음.' },
    relevant: { summary_ko: 'Boeing이 자회사 Wisk Aero, SkyGrid, Insitu를 Archer에 매각하는 최종 계약을 체결했음. 이와 함께 Boeing은 Archer의 지분을 취득하고 전략적 파트너로서 기술 공유 및 협력 관계를 구축했음.' } } },
  '8d6959be1cc4b2b3d6ce9c50': { kind: 'wording', note: 'Renishaw 개조식 통일, 전시 일정을 앞 문장으로 올려 양 언어 카드에 모두 남게 함', patch: {
    relevant: {
      summary_ko: 'Renishaw는 반도체 제조의 첨단 모션 제어용 차세대 RLE 간섭계 레이저 엔코더 제품군(RLE100, RLE200, RLE300)을 출시했음. 신규 제품군은 SEMICON Taiwan 2026(타이베이)과 SEMICON West 2026(샌프란시스코)에서 선보일 예정임. 모듈형 구조와 실시간 진단 기능으로 유지보수성을 높였음.',
      summary_en: 'Renishaw has launched its next-generation RLE interferometric laser encoder range, the RLE100, RLE200 and RLE300, for advanced motion control in semiconductor manufacturing. The company will present the new systems at SEMICON Taiwan 2026 in Taipei and SEMICON West 2026 in San Francisco. A modular architecture and real-time diagnostics improve serviceability.' } } },
  '38d97eca35b7abd2bb30b4ec': { kind: 'wording', note: 'Ouster 금액 표기(55백만 달러)', patch: {
    relevant: { summary_ko: 'Ouster는 2026년 2분기 총 매출 5500만 달러(전년 동기 대비 56% 증가)를 기록하고 라이다 및 카메라 센서를 17,000대 이상 출하했음. 수요는 물류 자동화, 야드 물류, 지능형 교통 분야의 산업·스마트 인프라 고객이 이끌었음.' } } },
  '02734e904b0832801764cc19': { kind: 'wording', note: 'Ouster–GUSS "함대" 오역', patch: {
    relevant: { summary_ko: 'John Deere의 자회사 GUSS Automation이 과수원용 차세대 자율주행 작업차량군(Autonomous Orchard Machine Fleet)에 Ouster의 Rev8 OS0 네이티브 컬러 디지털 라이다 센서를 통합할 계획임. 복잡한 과수원 환경에서 자율주행 차량의 주행 정밀도와 장애물 감지 능력을 높이는 것이 목적임.' } } },
  '27186feff58111c990b345e8': { kind: 'wording', note: 'Nabtesco 개조식 통일', patch: {
    relevant: { summary_ko: 'Nabtesco는 CMP 부문에서 RV mini와 일반 산업용 애플리케이션 판매 확대, Hamamatsu Plant 가동률 상승으로 사업 규모를 키울 계획임. RV mini는 6축 수직다관절 산업용 로봇의 손목 축 용도에 먼저 진입하고 협동로봇·공작기계 채택도 검토 중이며, 하반기부터 기존 고객 출하가 시작됐음.' } } },
  '3a82fd3abf18c5c0614150c5': { kind: 'wording', note: 'Qualcomm 개조식 통일', patch: {
    relevant: { summary_ko: 'Qualcomm의 오토모티브 부문 매출은 전년 동기 대비 61% 증가한 15억 9,000만 달러로 최대치를 기록했고, IoT 부문 매출은 9% 증가한 18억 3,000만 달러였음. BMW와의 확대 계약으로 차세대 ADAS·디지털 콕핏의 주력 컴퓨팅 실리콘 공급사가 됐으며, 2026 회계연도 말 오토모티브 연환산 매출 목표를 60억 달러에서 약 70억 달러로 올렸음.' } } },
  '6f0ea5fbaa9000684dc932a2': { kind: 'wording', note: 'Qualcomm 음차·개조식', patch: {
    relevant: { summary_ko: 'Qualcomm의 2026 회계연도 3분기 자동차 부문 매출은 전년 동기 대비 61% 증가한 15억 9000만 달러로, 23개 분기 연속 두 자릿수 성장을 기록했음. 디지털 콕핏, 첨단 운전자 보조, 자율주행 출하 확대가 성장을 이끌었으며 2026 회계연도 말 연환산 자동차 매출 전망을 약 70억 달러로 올렸음. 글로벌 하이퍼스케일러 대상 맞춤형 실리콘 수주 2건은 2026년 12월 분기부터 매출이 발생할 예정임.' } } },
  '1ca13a566d0581926822f9dd': { kind: 'wording', note: 'Air Products 음차 제거', patch: {
    relevant: { summary_ko: 'Air Products는 전통 산업용 가스 프로젝트에 연간 약 15억 달러를 투자할 계획이며, 사우디아라비아 NEOM 그린수소 프로젝트를 계속 추진하고 있음. 비용 구조 개선을 위한 생산성 향상 프로그램과 인력 감축도 시행하고 있음.' } } },
  '9493adc2af3df4f858b29a4f': { kind: 'wording', note: 'Cognex 음차 제거', patch: {
    relevant: { summary_ko: 'Cognex가 OneVision 플랫폼을 데이터센터 공급망으로 확장했음. 서버 랙 검사 애플리케이션으로 복잡한 품질 관리 요구에 대응하고, AI 기반 비전 애플리케이션의 구성·배포를 가속하고 있음.' } } },
  '978af39518d19cbf2868939a': { kind: 'wording', note: "ASM members' scheme of arrangement 원문 방치", patch: {
    relevant: { summary_ko: 'Energy Fuels Inc.가 주주 대상 인수 절차(members\' scheme of arrangement)를 통해 Australian Strategic Materials 지분 100% 인수를 완료했음. 이에 따라 Australian Strategic Materials는 ASX 공식 상장 목록에서 제외됐고 주주들에게 주식 및 현금 대가가 지급됐음.' } } },
};
