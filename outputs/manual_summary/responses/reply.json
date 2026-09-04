# 월간 글로벌 투자시그널 판정 요청

아래 자료는 타겟기업 공식 보도자료·IR·뉴스에서 수집한 것이다. 각 **판정 대상**에 대해 근거가
실제로 있는지 판정하고, 통과한 것만 보고서용 요약문을 작성한다. 결과는 마지막의 출력 형식대로
JSON 배열 하나로만 답한다.

## 판정 규칙

각 판정 대상은 (기업 × 시그널 × 기사) 조합이다. 기사 본문에 실제로 적힌 사실만 쓴다. 본문에
없는 내용을 추론하거나 지어내지 않는다.

- `e` (기업 귀속): 사건이 그 기업 자체에 귀속되면 1. 모회사·관계사 자료는 본문에 해당
  기업명, 사업부, 제품 또는 임원이 명시될 때만 1.
- `t` (타겟 기술 연결): 사건이 그 기업의 '유치필요 기술'과 직접 연결되면 1. 같은 기업의 다른
  사업부·제품이나 일반 경영활동이면 0.
- `i` (지표 부합): 본문이 그 시그널 정의에 맞는 **구체적 사건**을 보여주면 1. 키워드만 등장하거나
  위험고지·전망 상용문구, 일반 재무항목뿐이면 0. 사업동향(REL) 대상은 항상 1.
- `l` (선행성): 앞으로의 투자결정을 시사하는 선행 징후면 1. 이미 확정·완료된 투자·인수·자금조달
  사실 자체만 근거인 후행 사건이면 0. 사업동향(REL) 대상은 항상 1.
- `stage` (사건 단계): INV 대상은 exploratory / planned / committed / completed / unclear 중 하나.
  이미 확정·계약·자금조달·인수·가동이 끝났으면 committed 또는 completed. REL 대상은 항상
  not_applicable.
- `q` (근거 품질): 근거가 충분하면 pass, 부족하면 needs_review.
- `c` (확신도): 0~1 사이 숫자.
- `why`: 그렇게 판정한 이유. 한국어 한 문장.
- `ok` (종합): 위 판정의 논리곱. 하나라도 0이거나 불명확하면 0.
  단, 판정 대상에 `면제` 표시가 있으면 그 대상은 `t`를 `ok` 계산에서 제외한다.

**판정은 대상마다 독립적으로 한다.** 앞에서 몇 개를 통과시켰는지, 통과 비율이 얼마인지는 다음
대상의 판정에 영향을 주지 않는다. 통과가 적어도 억지로 늘리지 않고, 많아도 억지로 줄이지 않는다.

## 요약문 규칙

- `ok`가 0인 대상: `ko`와 `en`에 기사 사실을 각 한 문장(40~90자)으로만 적는다. 나머지 요약
  필드는 넣지 않는다.
- `ok`가 1인 대상만 아래 보고서용 요약을 추가로 작성한다.
  - INV 대상: `hko` 18~42자 명사구(종결어미 없이), `dko` 35~85자(종결어미 없이),
    `hen` 40~90자 영문 표제, `den` 70~180자 영문 캡션. 영문은 마침표로 끝내지 않는다.
  - REL 대상: `ko` 3~4문장 260~360자 보고서체(존대말·구어체 금지, '습니다' 금지),
    `en` 같은 내용의 영문 3~4문장 300~460자. `hko`/`dko`/`hen`/`den`은 넣지 않는다.
- 영문은 한국어 직역이 아니라 같은 사실을 영어 보고서 문체로 쓴 것이어야 하며, 두 언어의
  사실관계는 일치해야 한다.
- 성장률: mid-single-digit=한 자릿수 중반대, low-single-digit=한 자릿수 초반대,
  high-single-digit=한 자릿수 후반대.

## 출력 형식

설명·머리말 없이 JSON 배열 하나만 출력한다. `ref`는 입력에 나온 것을 그대로 쓰고, **모든 판정
대상이 정확히 한 번씩** 나와야 한다.

```json
[
 {"ref":"INV-001","e":1,"t":0,"i":0,"l":0,"stage":"unclear","q":"needs_review","c":0.3,
  "why":"공급망 언급은 위험고지 상용문구이며 구체적 대응 조치가 없음",
  "ko":"분기 실적과 일반적 공급망 위험요인을 언급","en":"Quarterly results note supply-chain risk in general terms"},
 {"ref":"INV-014","e":1,"t":1,"i":1,"l":1,"stage":"planned","q":"pass","c":0.84,
  "why":"수요 증가 시 반응기를 추가하도록 설계했다는 구체적 확장 계획이 확인됨",
  "hko":"군산 실리콘 음극재 생산기지 확장 기반 확보","dko":"수요 증가 시 반응기 증설로 생산능력 확대 가능",
  "hen":"Gunsan silicon anode site built for staged expansion",
  "den":"Reactors can be added as demand grows, giving headroom without a new site",
  "ko":"","en":""}
]
```

답변이 길어 한 번에 끝나지 않으면 배열을 도중에 끊고, 이어서 요청하면 나머지를 같은 형식으로
계속 출력한다.

## 보고 기간

2026-08-01 ~ 2026-08-31

## 5대 투자동향 시그널 정의

- **S1 공급망·지정학 리스크 대응**: 특정지역 의존도 축소·공급망 다변화·규제 리스크 대응 등
- **S2 생산 확대 및 다변화 의지**: APAC 신규 시설 확장 검토·생산기지 타당성 조사 등
- **S3 투자 재원 확보**: 대규모 회사채 발행·유상증자·신용공여 조달 등
- **S4 기술 생태계 밀착(R&D)**: 공동연구·기술 라이선싱·PoC 매칭·지분투자 등
- **S5 핵심 전략 인력의 이동**: C-Level 이동·극비 방한 및 실사 조율 등

## 자료 (기사 83건 · 판정 대상 170건)

### 1. Welcome to Mkango Resources Ltd.
출처: HyproMag - Mkango 2026 News / News Archive RSS · 게시일: 2026-08-31

판정 대상:
- `INV-001` HyproMag | 유치필요 기술: 사용후 영구자석 고순도 희토류 추출 | S1 공급망·지정학 리스크 대응
- `INV-050` HyproMag | 유치필요 기술: 사용후 영구자석 고순도 희토류 추출 | S2 생산 확대 및 다변화 의지
- `REL-033` HyproMag | 유치필요 기술: 사용후 영구자석 고순도 희토류 추출 | 글로벌 사업현황

team and all stakeholders to grow the Remloy business within Mkango. Through this Transaction, we will further develop and strengthen the rare earth supply chain and ecosystem for recycling and magnet manufacturing in Germany and its neighbours. Mkango is now uniquely positioned across the whole rare earth supply chain in Europe and North America, including projects for recyclin deferred consideration; and that demand and prices for rare earth materials and magnetic products, and general economic, market, currency, tariff and geopolitical conditions, do not change materially and adversely.

### 2. Applied Materials Announces Third Quarter 2026 Results
출처: Applied Materials - Investor News Releases / Press Releases · 게시일: 2026-08-13

판정 대상:
- `INV-002` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-032` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S2 생산 확대 및 다변화 의지 | **면제**
- `INV-057` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S3 투자 재원 확보 | **면제**
- `INV-071` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S4 기술 생태계 밀착(R&D) | **면제**

imely basis, if at all; changes in tariffs, any retaliatory measures, and our ability to mitigate the impact of tariffs; the effects of geopolitical turmoil or conflicts; demand for semiconductor chips and electronic devices; customers’ technology and capacity requirements; the introduction of new and innovative technologies, and the timing of technology transitions; our ability arge of $253 million for settlement with the U.S. Commerce Department Bureau of Industry and Security to resolve a previously disclosed export controls compliance matter. 13, 2026 (GLOBE NEWSWIRE) -- Applied Materials, Inc. (NASDAQ: AMAT) today reported results for its third quar... (NASDAQ: AMAT) today reported results for its third quarter ended July 26, 2026 . Third Quarter Results Applied generated record revenue of $9.12 billion .

### 3. Earnings Release
출처: Ouster - Investor Relations / Investor Relations · 게시일: 2026-08-06

판정 대상:
- `INV-003` Ouster | 유치필요 기술: 로봇용 라이다 | S1 공급망·지정학 리스크 대응
- `INV-041` Ouster | 유치필요 기술: 로봇용 라이다 | S2 생산 확대 및 다변화 의지
- `INV-082` Ouster | 유치필요 기술: 로봇용 라이다 | S4 기술 생태계 밀착(R&D)
- `REL-014` Ouster | 유치필요 기술: 로봇용 라이다 | 글로벌 사업현황

ty to use tax attributes; Ouster’s dependence on key third party suppliers, in particular Benchmark Electronics, Inc., Fabrinet, and other suppliers; supply chain constraints and challenges; conditions in the industries the Company targets or the global economy; Ouster’s ability to recruit and retain key personnel; its ability to complete, successfully integrate or achieve the an ully integrate or achieve the anticipated benefits of new acquisitions or investments, including the Stereolabs acquisition; changes to trade policy, tariffs, and import/export regulations may have a material adverse effect on Ouster’s business, financial condition and results of operations; risks related to the use of AI tools by us and others, including risks related to c ta regulations, product performance, and data privacy; Ouster’s ability to adequately protect and enforce its intellectual property rights; 

### 4. Amkor Technology Reports Financial Results for the Second Quarter 2026
출처: Amkor Technology - Investor Press Releases / Press Releases · 게시일: 2026-07-27

판정 대상:
- `INV-004` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-054` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S2 생산 확대 및 다변화 의지 | **면제**
- `INV-055` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S3 투자 재원 확보 | **면제**
- `INV-073` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S4 기술 생태계 밀착(R&D) | **면제**

ence on international factories and operations, and risks relating to trade restrictions and regional conflict, including restrictive trade barriers, export controls, tariffs, customs and duties; our ability to develop new proprietary technology, protect our proprietary technology, operate without infringing the proprietary rights of others and implement new technologies; our conti ence on international factories and operations, and risks relating to trade restrictions and regional conflict, including restrictive trade barriers, export controls, tariffs, customs and duties; our ability to develop new proprietary technology, protect our proprietary technology, operate without infringing the proprietary rights of others and implement new technologies; our contin onal factories and operations, and risks relating to trade restrictions and regional conflict, including restrictive trade barrie

### 5. 3M Reports Second-Quarter 2026 Results; Increases Full-Year Guidance
출처: 3M - Investor Relations / Investor Relations · 게시일: 2026-07-21

판정 대상:
- `INV-005` 3M | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-064` 3M | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S3 투자 재원 확보 | **면제**
- `INV-085` 3M | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S4 기술 생태계 밀착(R&D) | **면제**

, July 21, 2026 /PRNewswire/ -- 3M (NYSE: MMM) today reported second-quarter results. "We delivered a strong second quarter, exceeding... 3M Reports Second-Quarter 2026 Results; Increases Full-Year Guidance Jul 21, 2026 • 6:30 AM EDT Download as PDF Related Documents Webcast Stream Transcript Presentation PDF Financial Statement Information PDF 10-Q Filing HTML PDF Q2 GAAP sales of $6.5 billion, up 2.4%; operating margin of 15.1%, down 290 bps; EPS of $1.78, up 33%, all YoY Adjusted sales of $6.5 billion with organic growth of 5.4%&nbsp;YoY Adjusted operating margin of 24.9%, up 40 bps YoY Adjusted EPS of $2.40, up 11% YoY Q2 operating cash flow of $1.0 billion with adjusted free cash flow of $1.3 billion 2026 adjusted EPS guidance increased from $8.50 - $8.70 to $8.80 - $8.95 ST.

### 6. When tech makes an impact
출처: Air Liquide - Press Releases & News / Press Releases / News · 게시일: 미상

판정 대상:
- `INV-006` Air Liquide | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-034` Air Liquide | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S2 생산 확대 및 다변화 의지 | **면제**
- `INV-100` Air Liquide | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S4 기술 생태계 밀착(R&D) | **면제**

and amid the most dynamic industrial reconfigurations. South Korea, Singapore and China are competing for leadership in advanced manufacturing, while reshoring and de-risking strategies are reshaping where and how critical materials are produced. The Group is strengthening its positions through new plants and long-term contracts, while also deepening execution capabilities thr e time, its presence in the USA and in Asia is a decisive advantage: it enables Air Liquide to maintain its growth trajectory despite the dynamics of regionalization and the new realities of a global industry that is reorganizing itself." Christina Law , Independant Director, Member of the Remuneration Committee and the Environment and Society Committee Read Christina Law’s full int ost dynamic industrial reconfigurations.

### 7. Charles River Laboratories Announces Second-Quarter 2026 Results
출처: Charles River - News Releases / Press Releases · 게시일: 2026-08-05

판정 대상:
- `INV-007` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | S1 공급망·지정학 리스크 대응
- `INV-063` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | S3 투자 재원 확보
- `INV-069` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | S4 기술 생태계 밀착(R&D)
- `REL-003` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | 글로벌 사업현황

gal costs and adjustments related to an NHP inventory charge in our DSA segment related to now concluded U.S . government investigations into the NHP supply chain; legal and advisory costs related to entering into a Cooperation Agreement with a shareholder; tax effect of all of the aforementioned matters; and adjustments related to the derecognition of certain deferred tax assets NHP supply constraints; changes and uncertainties in the global economy and financial markets, including disruptions in the global economy caused by geopolitical conflicts; the ability to successfully integrate businesses we acquire, and risks and uncertainties associated with businesses that we acquire; the timing and magnitude of our share repurchases; negative trends in resea ond quarter ended June 27, 2026 .

### 8. August 04, 2026 Company Evonik reports strong second quarter Essen, Germany. As announced on June 26, Evonik delivered strong earnings in the second quarter. The ongoing conflict in the Middle East caused supply chain bottlenecks, mainly outside Europe, resulting in an economic windfall.
출처: Evonik Industries - Media / Newsroom / Media · 게시일: 2026-08-04

판정 대상:
- `INV-008` Evonik Industries | 유치필요 기술: 타이어용 친환경 침강실리카 제조기술 | S1 공급망·지정학 리스크 대응
- `INV-052` Evonik Industries | 유치필요 기술: 타이어용 친환경 침강실리카 제조기술 | S2 생산 확대 및 다변화 의지
- `REL-015` Evonik Industries | 유치필요 기술: 타이어용 친환경 침강실리카 제조기술 | 글로벌 사업현황

st 04, 2026 Evonik reports strong second quarter Adjusted EBITDA rises to €630 million in the second quarter Higher volumes and selling prices due to supply chain bottlenecks outside of Europe Outlook 2026: €2.0 billion to €2.2 billion adjusted EBITDA Essen, Germany . As announced on June 26, Evonik delivered strong earnings in the second quarter. The ongoing conflict in the Midd usiness registered a considerable rise in sales. Slightly higher sales were posted by the Inorganics business, which benefited from higher demand for precipitated silicas. Adjusted EBITDA improved by 25 percent to €333 million, driven mainly by higher volumes and selling prices and improved utilization of production capacity.

### 9. Danaher Appoints Julie Sawyer Montgomery as President and Chief Executive Officer
출처: Cytiva - Danaher Investor Relations / Investor Relations RSS · 게시일: 2026-08-03

판정 대상:
- `INV-009` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S1 공급망·지정학 리스크 대응
- `INV-053` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S2 생산 확대 및 다변화 의지
- `INV-058` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S3 투자 재원 확보
- `INV-099` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S4 기술 생태계 밀착(R&D)
- `REL-032` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | 글로벌 사업현황

r our products and services, labor matters and our ability to recruit, retain and motivate talented employees, U.S. economic, political, geopolitical, legal, compliance, social and business factors (including the impact of elections, regulatory and policy changes or uncertainty, government shutdowns and military conflicts such as the conflict in the Middle East), dis factors include, among other things: our ability to retain key personnel, our ability to execute on growth and other opportunities, the impact of the tariffs and related actions implemented by the U.S. and other countries, the impact of our debt obligations (including debt we incurred to finance the acquisition of Masimo) on our operations and liquidity, deterioration of or Explore more at www.danaher.com . The // classes are added to so styling immediately reflects the current // toolbar state.

### 10. Amkor Technology Announces Strategic Partnership with NVIDIA to Expand Advanced Packaging and Test for Next-Generation AI Infrastructure
출처: Amkor Technology - Investor Press Releases / Press Releases · 게시일: 2026-07-23

판정 대상:
- `INV-010` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-033` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S2 생산 확대 및 다변화 의지 | **면제**
- `INV-083` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S4 기술 생태계 밀착(R&D) | **면제**

ty in Arizona , complementing the company’s established manufacturing footprint across Asia , to create a geographically diverse and resilient global supply chain. “AI is driving a generational shift in technology, transforming every industry and creating a unique opportunity to reinvigorate American manufacturing and supply chains,” said Debora Shoquist , Executive Vice Presiden ment to expanding full turnkey advanced packaging and test capabilities in the United States , strengthening domestic semiconductor manufacturing and supply-chain resilience for AI infrastructure. NVIDIA’s capacity agreement supports Amkor’s expansion of U.S .

### 11. 3M and Microsoft announce strategic partnership to advance AI data center infrastructure and enterprise transformation
출처: 3M - Investor Relations / Investor Relations · 게시일: 2026-07-15

판정 대상:
- `INV-011` 3M | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-086` 3M | 유치필요 기술: 이온교환막 및 바이폴라 이온교환막 | S4 기술 생태계 밀착(R&D) | **면제**

3M to build datacenters that are faster to deploy, more resilient and ready for the scale of AI," said Cliff Henson, corporate vice president, Cloud Supply Chain, Microsoft. "3M's EBO solution will help unlock new levels of performance, reliability and efficiency to ensure customers can run their cloud and AI workloads on a trusted, sustainable and advanced environment." &nbsp; 3M and Microsoft announce strategic partnership to advance AI data center infrastructure and enterprise transformation Jul 15, 2026 • 9:01 AM EDT Download as PDF Microsoft becomes first announced&nbsp;hyperscale cloud provider to deploy 3M Expanded Beam Optical (EBO) technology 3M to use Microsoft AI and digital capabilities to advance enterprise transformation across key functions ST.

### 12. TSMC and Amkor Technology Announce Long Term Partnership to Accelerate Advanced Packaging in the United States
출처: Amkor Technology - Investor Press Releases / Press Releases · 게시일: 2026-06-16

판정 대상:
- `INV-012` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-043` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S2 생산 확대 및 다변화 의지 | **면제**

hip that will enhance advanced semiconductor packaging capabilities in Arizona , strengthening and accelerating investment in the U.S . The agreement establishes a collaboration framework for TSMC to procure from Amkor advanced packaging and testing services. By working together as partners to expand capacity, the companies aim to enable a mo Skip to content Press Releases Printer-friendly version Back TSMC and Amkor Technology Announce Long Term Partnership to Accelerate Advanced Packaging in the United States HSINCHU, Taiwan & TEMPE, Ariz. 16, 2026-- Taiwan Semiconductor Manufacturing Company (NYSE: TSM) and Amkor Technology, Inc. (Nasdaq: AMKR) today announced a 10-year agreement to foster a strong partnership that will enhance advanced semiconductor packaging capabilities in Arizona , strengthening and accelerating investment in the U.S .

### 13. West Announces Second-Quarter 2025 Results and Fourth-Quarter 2025 Dividend, Updates Full-Year 2025 Guidance - Thu, 07/24/2025 - 06:00
출처: West Pharmaceutical - Financial Information / Financial Reports / Filings · 게시일: 2025-07-24

판정 대상:
- `INV-013` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S1 공급망·지정학 리스크 대응
- `INV-046` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S2 생산 확대 및 다변화 의지
- `INV-061` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S3 투자 재원 확보
- `INV-091` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S4 기술 생태계 밀착(R&D)
- `REL-024` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

ergy and labor costs; fluctuations in currency exchange; the ability to meet development milestones with key customers; and the consequences of other geopolitical events, including tariffs, natural disasters, acts of war, and global health crises. This list of important factors is not all inclusive. For a description of certain additional factors that could cause the Company's fu ed compensation. Our updated adjusted-diluted EPS guidance incorporates our estimate of $15 to $20 million for the net impact of recently implemented tariffs. For the remaining quarters of the year, our adjusted-diluted EPS guidance range assumes a tax rate of approximately 21% and does not include potential tax benefits from stock-based compensation. Any tax benefits assoc r approximately 90 days after the event. &nbsp; About West&nbsp; West Pharmaceutical Services, Inc.

### 14. 20-05-2026 | Press release Prodrive Technologies and Fortaegis Technologies sign strategic partnership agreement
출처: Prodrive - Press-release Filter / Press Releases · 게시일: 미상

판정 대상:
- `INV-014` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-075` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S4 기술 생태계 밀착(R&D) | **면제**

The collaboration will commence with Prodrive Technologies supporting areas such as engineering, system integration, supply chain management and advanced manufacturing. The companies will also explore joint customer engagement, market development and participation in relevant Dutch and European innovation programs. “ This partnership is an importa Skip to content 20-05-2026 | Press release Prodrive Technologies and Fortaegis Technologies sign strategic partnership agreement Son, the Netherlands, May 2026 – Prodrive Technologies Group B.V. (“Prodrive Technologies”) and Fortaegis Technologies B.V. have signed a strategic partnership agreement to support the development, industrialization and commercialization of advanced secure hardware and software platforms. The agreement provides a framework for long-term collaboration between both companies.

### 15. Press releases from 2020
출처: Vestas - Media / Newsroom / Media · 게시일: 미상

판정 대상:
- `INV-015` Vestas | 유치필요 기술: 해상풍력터빈 | S1 공급망·지정학 리스크 대응
- `REL-005` Vestas | 유치필요 기술: 해상풍력터빈 | 글로벌 사업현황

Triton Knoll pre-assembly hub ramps up activity \r\n \r\n MHI Vestas and EolMed partner for floating offshore wind farm in France \r\n \r\n Taiwan’s supply chain gains another link with transformer purchase agreement \r\n \r\n MHI Vestas to source additional key turbine components locally in Taiwan \r\n \r\n Tower supply purchase agreement finalised in Taiwan \r\n \r\n First pow MWOW Press Releases 2020 \r\n"}}" id="styledheading-d99bbaa3dd" class="cmp-text"> 2020 Please find all MHI Vestas Offshore Wind press releases from 2020 here.

### 16. Press Releases August 05, 2026 Albemarle Reports Second Quarter 2026 Results CHARLOTTE, N.C., Aug. 5, 2026 /PRNewswire/ -- Albemarle Corporation (NYSE: ALB), a global leader in providing essential elements for mobility, energy, connectivity and health, today announced its results for the second quarter ended June 30, 2026. Second Quarter 2026 and Recent Highlights (Unless
출처: Albemarle - Newsroom / Newsroom / News · 게시일: 2026-08-05

판정 대상:
- `INV-016` Albemarle | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S1 공급망·지정학 리스크 대응
- `INV-062` Albemarle | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S3 투자 재원 확보
- `INV-094` Albemarle | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S4 기술 생태계 밀착(R&D)
- `REL-036` Albemarle | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | 글로벌 사업현황

Operations at the Jordan Bromine Company (JBC) joint venture are in line with expectations as it continues to navigate geopolitical tensions in the region.

### 17. Full Year Results 2025
출처: Umicore - Investor Relations / Investor Relations · 게시일: 2026-02-20

판정 대상:
- `INV-017` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S1 공급망·지정학 리스크 대응
- `INV-068` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S3 투자 재원 확보
- `REL-035` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | 글로벌 사업현황

core’s circular, multi-metal model is as a powerful differentiator and an anchor in a fragmented market, ensuring independent, secure and sustainable supply chains for critical metals. ---------- 1 All references to revenues in this document refer to revenues excluding metals (i.e. all revenue elements less the value of the following purchased metals: Au, Ag, Pt, Pd, Rh, Co, Ni, eve increased output for antimony and tin. At the same time, the project will strengthen its best-in-class environmental performance.

### 18. GUSS Automation, a wholly owned John Deere Subsidiary, Plans to Advance Precision Autonomy in High-Value Crops with Ouster's Next-Generation REV8 Digital Lidar
출처: Ouster - News Releases / Press Releases · 게시일: 2026-08-26

판정 대상:
- `INV-018` Ouster | 유치필요 기술: 로봇용 라이다 | S1 공급망·지정학 리스크 대응
- `INV-038` Ouster | 유치필요 기술: 로봇용 라이다 | S2 생산 확대 및 다변화 의지
- `REL-010` Ouster | 유치필요 기술: 로봇용 라이다 | 글로벌 사업현황

product performance, cybersecurity, and data privacy; Ouster’s ability to adequately protect and enforce its intellectual property rights; legal and regulatory risks; and other important factors discussed in the Company’s Annual Report on Form 10-K for the year ended December 31, 2025, and as may be further updated from time to time in the Company’s Quarterly Reports on Form 10-Q a Automation, a wholly owned John Deere Subsidiary, Plans to Advance Precision Autonomy in High-Value Crops with Ouster's Next-Generation REV8 Digital Lidar August 26, 2026 PDF Version Unlocking Precision and Safety in Autonomous Agriculture: GUSS Plans Deployment of Rev8 to Revolutionize Orchard Operations SAN FRANCISCO --(BUSINESS WIRE)--Aug.

### 19. Guidance for 2025 Delivered, Growth Foundation in Place
출처: Merck - News / Press Releases / News · 게시일: 미상

판정 대상:
- `INV-019` Merck | 유치필요 기술: 의약품용 부형제 | S1 공급망·지정학 리스크 대응
- `INV-079` Merck | 유치필요 기술: 의약품용 부형제 | S4 기술 생태계 밀착(R&D)
- `REL-025` Merck | 유치필요 기술: 의약품용 부형제 | 글로벌 사업현황

.0 0.7 4.0 Healthcare sales 8.6 1.8 3.7 Electronics sales 3.5 –7.1 –0.6 “We once again demonstrated our resilience in 2025 in the face of significant geopolitical challenges and strong currency headwinds.” Results & Beyond: Our CEO Speaks Our CEO Belén Garijo comments on the full-year 2025 results. Watch the video Annual Report 2025 Detailed information about the development of o Tumors Oncology Neurology & Immunology Fertility Cardiovascular, Metabolism and Endocrinology Vibrant Thoughts Blog Electronics Thin Films Optronics Formulations Metrology and Inspection Delivery Systems & Services (DS&S) Specialty Gases Intermolecular® The Future Transformation Blog Events & Highlights Research Research Research Our R&D Approach Healthcare Pipeline Clinical Tr You are using an outdated browser. Please upgrade your browser to improve your experience.

### 20. Bringing Next-Generation CD-SEM Metrology to the Fab
출처: Applied Materials - Applied Materials Newsroom / Newsroom / News · 게시일: 2026-08-31

판정 대상:
- `INV-020` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S1 공급망·지정학 리스크 대응 | **면제**

jcr:content_root_globalheader_copy_tabs_item-0_item_0_copy_columncontainer_copy_column1_copy_text-59132" class="cmp-text"> Services Service Solutions Supply Chain Solutions Resources \r\n"}}" id="_content_experience-fragments_applied-materials_us_en_site_header_master_jcr:content_root_globalheader_copy_tabs_item-0_item_0_copy_columncontainer_copy_column1_copy_copy_text-36991" cla Dropdown language United States China - 简体中文 Europe - English India - English Israel - English Japan - 日本語 Korea - 한국어 Singapore - English Taiwan - 繁體中文 United States - English Trending Topics Dropdown language United States China - 简体中文 Europe - English India - English Israel - English Japan - 日本語 Korea - 한국어 Singapore - English Taiwan - 繁體中文 United States - English Products & Services Products &amp; Technologies \r\n"}}" id="_content_experience-fragments_applied-materials_us_en_site_header_master_jcr:content_r

### 21. National Wealth Fund backs Nexeon in £100m investment round August 31, 2026
출처: Nexeon - Media / Newsroom / Media · 게시일: 2026-08-31

판정 대상:
- `INV-021` Nexeon | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | S1 공급망·지정학 리스크 대응
- `INV-035` Nexeon | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | S2 생산 확대 및 다변화 의지
- `INV-093` Nexeon | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | S4 기술 생태계 밀착(R&D)
- `REL-034` Nexeon | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | 글로벌 사업현황

31, 2026 Nexeon has secured backing from the National Wealth Fund to support the expansion of its domestic operations, strengthening the UK’s battery supply chain, creating jobs and boosting growth. The National Wealth Fund’s commitment of £52.6 million ($70 million) marks the completion of Nexeon’s latest investment round totalling £100 million ($133 million). Other new investor nd totalling £100 million ($133 million). Other new investors include the Korea Development Bank and Honda Xcelerator Ventures. Nexeon’s cutting-edge silicon anode materials enable production of higher energy density lithium-ion batteries, helping to reduce charging times and extend the range of electric vehicles. The investment round supports the company’s continued scale-up and akthrough technologies that will shape the future of energy storage.

### 22. Nexeon Achieves ISO 9001 Certification for Gunsan Plant August 28, 2026
출처: Nexeon - Media / Newsroom / Media · 게시일: 2026-08-28

판정 대상:
- `INV-022` Nexeon | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | S1 공급망·지정학 리스크 대응
- `INV-047` Nexeon | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | S2 생산 확대 및 다변화 의지
- `REL-039` Nexeon | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | 글로벌 사업현황

rtification demonstrates the strength of the systems we have put in place to achieve that.” The Gunsan facility benefits from a strategically located supply chain, including direct access to monosilane, a critical precursor for Nexeon’s silicon-carbon materials. Its location also provides proximity to major Asian battery manufacturers and supports efficient integration into estab important milestone in the development of Nexeon’s Gunsan operation, and reinforces the company’s commitment to delivering consistently high quality silicon-carbon materials to leading battery cell manufacturers and automotive customers. Nexeon’s Gunsan facility is the company’s first commercial-scale production plant, and was announced as production ready in December 2025. It is oduction plant, and was announced as production ready in December 2025.

### 23. Tackling Key HBM and Advanced Packaging Bottlenecks for the AI Era
출처: Applied Materials - Applied Materials Newsroom / Newsroom / News · 게시일: 2026-08-18

판정 대상:
- `INV-023` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S1 공급망·지정학 리스크 대응 | **면제**

jcr:content_root_container_globalfooter_text-6639" class="cmp-text"> ©2026 Applied Materials, Inc. \r\n"}}" id="_content_experience-fragments_applied-materials_us_en_site_blog-subscription-block_master_jcr:content_root_container_columncontainer_container_copy_text_copy-73724" class="cmp-text"> Stay updated on our content. Subscribe Share via Facebook Share via Twitter Share via Linkedin Share via Email Tackling Key HBM and Advanced Packaging Bottlenecks for the AI Era August 18, 2026 \r\nBy Jinho An, Ph.D. and Kyla Zhao \r\n"}}" id="root_container_container_container_1955866749_columncontainer_column1_container_1630550081_2100365834_text-36802" class="cmp-text"> August 18, 2026 By Jinho An, Ph.D. and Kyla Zhao Today's advanced AI processors deliver extraordinary performance but are increasingly limited by how quickly data can move between compute and memory....

### 24. Arizona-Korea Semiconductor Delegation
출처: Amkor Technology - Corporate News / Newsroom / News · 게시일: 2026-08-13

판정 대상:
- `INV-024` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S1 공급망·지정학 리스크 대응 | **면제**
- `INV-048` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S2 생산 확대 및 다변화 의지 | **면제**
- `INV-101` Amkor Technology | 유치필요 기술: 반도체 후공정용 고성능 방열소재 | S4 기술 생태계 밀착(R&D) | **면제**

oins Arizona Economic Delegation to the Republic of Korea August 13, 2026 in by Allison Grigg Share: Advancing Semiconductor Innovation, Investment & Supply Chain Resilience Through International Collaboration As Arizona’s semiconductor industry continues to grow, collaboration across industry, government, and the broader semiconductor ecosystem remains essential to building a st Blog Amkor’s latest news and blogs Amkor Joins Arizona Economic Delegation to the Republic of Korea August 13, 2026 in by Allison Grigg Share: Advancing Semiconductor Innovation, Investment & Supply Chain Resilience Through International Collaboration As Arizona’s semiconductor industry continues to grow, collaboration across industry, government, and the broader semiconductor ecosystem remains essential to building a strong and resilient future.

### 25. Q3 2026 Applied Materials Earnings Conference Call
출처: Applied Materials - Investor Relations / Investor Relations · 게시일: 2026-08-13

판정 대상:
- `INV-025` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S1 공급망·지정학 리스크 대응 | **면제**

These statements and their underlying assumptions are subject to risks and uncertainties and are not guarantees of future performance.

### 26. Merck KGaA, Darmstadt, Germany, Delivers Robust Q2 2026 Performance, Upgrades ...
출처: Merck - News & Stories / Newsroom / Stories · 게시일: 2026-08-06

판정 대상:
- `INV-026` Merck | 유치필요 기술: 의약품용 부형제 | S1 공급망·지정학 리스크 대응
- `INV-036` Merck | 유치필요 기술: 의약품용 부형제 | S2 생산 확대 및 다변화 의지
- `INV-080` Merck | 유치필요 기술: 의약품용 부형제 | S4 기술 생태계 밀착(R&D)
- `REL-052` Merck | 유치필요 기술: 의약품용 부형제 | 글로벌 사업현황

imary driver, while several key Asian currencies continued to have a slightly negative effect on reported performance. In an environment of continued geopolitical volatility and ongoing global conflicts, Merck KGaA, Darmstadt, Germany, benefits from its longstanding region-for-region approach built on close customer relationships and deep local market expertise. The company deliv € 5.9 billion and € 6.3 billion. This adjustment primarily reflects assumptions of stronger momentum in Life Science – including minor headwinds from tariff refunds to customers – and Electronics, while Healthcare demonstrated resilience in a challenging environment.

### 27. Open Report of unscheduled material events or corporate event in HTML.
출처: Cytiva - Danaher SEC Filings / Regulatory Filings · 게시일: 2026-08-03

판정 대상:
- `INV-027` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S1 공급망·지정학 리스크 대응
- `INV-056` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S3 투자 재원 확보
- `INV-106` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S5 핵심 전략 인력의 이동
- `REL-058` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | 글로벌 사업현황

r our products and services, labor matters and our ability to recruit, retain and motivate talented employees, U.S. economic, political, geopolitical, legal, compliance, social and business factors (including the impact of elections, regulatory and policy changes or uncertainty, government shutdowns and military conflicts such as the conflict in the Middle East), dis factors include, among other things: our ability to retain key personnel, our ability to execute on growth and other opportunities, the impact of the tariffs and related actions implemented by the U.S.

### 28. Media Kits & Digital Assets "> Media Kits & Digital Assets
출처: Applied Materials - Applied Materials Newsroom / Newsroom / News · 게시일: 2026-06-25

판정 대상:
- `INV-028` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S1 공급망·지정학 리스크 대응 | **면제**

nouncement \r\n \r\n Applied Materials, Inc.&nbsp;is working with Apple and Texas Instruments (TI) to bolster the semiconductor manufacturing supply chain in&nbsp;the United States. Applied is supporting Apple’s partnership with TI, announced today, by supplying American-made chipmaking equipment from&nbsp;Austin, Texas&nbsp;to TI’s&nbsp;U.S.&nbsp;factories.&nbsp; \r\n"}}" id="ro Newsroom Newsroom Newsroom Home Press Releases "> Press Releases Blogs "> Blogs Events "> Events Media Kits & Digital Assets "> Media Kits & Digital Assets Media Kits & Digital Assets Media Kits June 25, 2026 | Master Class – Powering DRAM and Advanced Packaging Inflections with Materials Innovation and Process Control \r\n \r\n Applied Materials today introduced a suite of new chipmaking systems for building the advanced 3D chip architectures that power next-generation AI.

### 29. News Article Top six takeaways from the 2026 Danaher Summit 06.15.26
출처: Cytiva - Danaher Newsroom / Newsroom / News · 게시일: 2026-06-15

판정 대상:
- `INV-029` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | S1 공급망·지정학 리스크 대응
- `REL-042` Cytiva | 유치필요 기술: 바이오의약품 생산용 배양 및 정제 시스템 | 글로벌 사업현황

ier commitments and shared performance targets as part of doing business. Far from being separate from operational strategy, this is part of building supply chains resilient enough to support long-term innovation at scale.

### 30. Q2 2026 Applied Materials Earnings Conference Call
출처: Applied Materials - Investor Relations / Investor Relations · 게시일: 2026-05-14

판정 대상:
- `INV-030` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S1 공급망·지정학 리스크 대응 | **면제**

These statements and their underlying assumptions are subject to risks and uncertainties and are not guarantees of future performance.

### 31. maxon achieves a respectable result with CHF 594.7 million revenue despite challenging conditions
출처: Maxon - News / Newsroom / News · 게시일: 2025-01-01

판정 대상:
- `INV-031` Maxon | 유치필요 기술: 로봇용 감속기 | S1 공급망·지정학 리스크 대응
- `INV-051` Maxon | 유치필요 기술: 로봇용 감속기 | S2 생산 확대 및 다변화 의지
- `INV-104` Maxon | 유치필요 기술: 로봇용 감속기 | S4 기술 생태계 밀착(R&D)
- `REL-059` Maxon | 유치필요 기술: 로봇용 감속기 | 글로벌 사업현황

solid liquidity reserve in 2024 – a reassuring position in economically and politically uncertain times. 2025 will also be challenging; economic and geopolitical imponderables are currently difficult to assess." Eugen Elmiger, CEO of the maxon Group, says of the annual result: "We began 2024 with optimism but had to quickly adjust our expectations. After several years of revenue omer applications. Since 2012, maxon has offered an online product configurator for this purpose, which makes it possible to flexibly combine motors, gearboxes, sensors and electronics for complex customer projects. In 2024, maxon reached series production readiness in several important system projects, such as logistics shuttles and autonomous logistics vehicles.

### 32. Infineon and Tack One win SICC Award for Best Technological Collaboration
출처: Infineon - Press / Press Releases / Media · 게시일: 2026-08-31

판정 대상:
- `INV-037` Infineon | 유치필요 기술: 위성통신 및 레이다용 RF 반도체 | S2 생산 확대 및 다변화 의지
- `REL-029` Infineon | 유치필요 기술: 위성통신 및 레이다용 RF 반도체 | 글로벌 사업현황

oyment in urban and rural communities, helping improve flood preparedness and climate resilience.

### 33. Ouster BlueCity with REV8 Lidar Wins Multimillion-Dollar Utah Traffic Modernization Expansion
출처: Ouster - News Releases / Press Releases · 게시일: 2026-08-11

판정 대상:
- `INV-039` Ouster | 유치필요 기술: 로봇용 라이다 | S2 생산 확대 및 다변화 의지
- `INV-081` Ouster | 유치필요 기술: 로봇용 라이다 | S4 기술 생태계 밀착(R&D)
- `REL-012` Ouster | 유치필요 기술: 로봇용 라이다 | 글로벌 사업현황

Learn More Ouster BlueCity with REV8 Lidar Wins Multimillion-Dollar Utah Traffic Modernization Expansion August 11, 2026 PDF Version Econolite partnership leverages world's first native color digital lidar to expand Ouster BlueCity across 160 intersections with up to 500-foot advance detection for optimized mobility and enhanced safety. (Nasdaq: OUST) (“Ouster” or the “Company”), a global leader in high-performance lidar sensors and intelligent software solutions, powering Physical AI across the automotive, industrial, robotics and smart infrastructure sectors, announced today that Econolite , a leader in mobility operating systems, was awarded an expansion contract from Utah D...

### 34. Ouster Announces Upcoming Investor Events
출처: Ouster - News Releases / Press Releases · 게시일: 2026-08-07

판정 대상:
- `INV-040` Ouster | 유치필요 기술: 로봇용 라이다 | S2 생산 확대 및 다변화 의지
- `REL-013` Ouster | 유치필요 기술: 로봇용 라이다 | 글로벌 사업현황

and perception for Physical AI across industrial, robotics, automotive, and smart infrastructure. With a unified platform of high-performance digital lidar, cameras, AI compute, sensor fusion and perception software, and AI models, Ouster delivers solutions that improve quality of life in the physical world. Learn More Ouster Announces Upcoming Investor Events August 7, 2026 PDF Version SAN FRANCISCO --(BUSINESS WIRE)--Aug. (Nasdaq: OUST) (“Ouster” or the “Company”), a leader in sensing and perception for Physical AI, today announced that Ouster management will participate in the following investor events: Event: Oppenheimer 29th Annual Technology, Internet & Communications Conference (Virtual) Date: August 11, 2026 Presentation: 2:55 p.m.

### 35. West Reports Second-Quarter 2026 Results
출처: West Pharmaceutical - Press Releases / Press Releases · 게시일: 2026-07-23

판정 대상:
- `INV-042` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S2 생산 확대 및 다변화 의지
- `INV-059` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S3 투자 재원 확보
- `INV-084` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S4 기술 생태계 밀착(R&D)
- `REL-016` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

GAAP) (6) 2026 2025 Americas $388.7 $349.7 11.2 % 0.6 % 10.6 % Europe , Middle East , Africa 399.8 349.7 14.3 % 2.2 % 12.1 % Asia Pacific 83.8 67.1 24.9 % (2.1) % 27.0 % Total $872.3 $766.5 13.8 % 1.1 % 12.7 % Six Months Ended June 30 , Reported Net Sales ( U.S . GAAP) Percent Change Impact of Currency Organic Net Sales Growth Rate (Decline) (Non- U.S . , July 23, 2026 /PRNewswire/ -- West Pharmaceutical Services, Inc. (NYSE: WST), a leading provider of innovative, high-quality injectable solutions and services, today announced its financial results for the second quarter of 2026. Second-Quarter Summary (comparisons to prior-year period) Net sales of $872.3 million increased 13.8%; organic growth was 12. Source: LSEG Release Details West Reports Second-Quarter 2026 Results July 23, 2026 PDF Version Raising Full-Year Net Sales and EPS guidance EXTON, Pa.

### 36. West Reports First-Quarter 2026 Results - Thu, 04/23/2026 - 06:00
출처: West Pharmaceutical - Financial Information / Financial Reports / Filings · 게시일: 2026-04-23

판정 대상:
- `INV-044` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S2 생산 확대 및 다변화 의지
- `INV-060` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S3 투자 재원 확보
- `INV-089` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | S4 기술 생태계 밀착(R&D)
- `REL-022` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

GAAP) (4) 2026 2025 Americas $377.3 $338.9 11.3 % 0.5 % 10.8 % Europe , Middle East , Africa 399.4 306.9 30.1 % 12.2 % 17.9 % Asia Pacific 68.2 52.2 30.7 % 1.4 % 29.3 % Total $844.9 $698.0 21.0 % 5.7 % 15.3 % (4) Organic net sales exclude the impact from acquisitions and/or divestitures and translate the current-period reported sales of subsidiaries whose f S guidance EXTON, Pa. , April 23, 2026 /PRNewswire/ -- West Pharmaceutical Services, Inc. (NYSE: WST), a leading provider of innovative, high-quality injectable solutions and services, today announced its financial results for the first quarter of 2026. Source: LSEG Release Details West Reports First-Quarter 2026 Results April 23, 2026 PDF Version Strong Start to the Year and Raising Full-Year Revenue and EPS guidance EXTON, Pa.

### 37. Ouster Acquires StereoLabs, Creating a World-Leading Physical AI Sensing and Perception Company
출처: Ouster - News Releases / Press Releases · 게시일: 2026-02-09

판정 대상:
- `INV-045` Ouster | 유치필요 기술: 로봇용 라이다 | S2 생산 확대 및 다변화 의지
- `INV-090` Ouster | 유치필요 기술: 로봇용 라이다 | S4 기술 생태계 밀착(R&D)
- `REL-023` Ouster | 유치필요 기술: 로봇용 라이다 | 글로벌 사업현황

Learn More Ouster Acquires StereoLabs, Creating a World-Leading Physical AI Sensing and Perception Company February 9, 2026 PDF Version Ouster acquires StereoLabs Sensing & Perception for Physical AI Physical AI's first unified sensing & perception platform A unified sensing & perception platform for industrial, robotics, and smart infrastructure Ouster Logo Ouster now offers a unified platform of high-performance digital lidar, cameras, AI compute, sensor fusion and perception software, and cutting-edge AI models StereoLabs brings AI vision solutions, expanded software capabilities, and over 10,000 customers Builds on Ouster's momentum, compounding the success of its lidar business and expanding its total addressable market StereoLabs is...

### 38. 5-11-2025 | Press release Prodrive Technologies inaugurates 4MW green hydrogen rectifier test facility
출처: Prodrive - Press-release Filter / Press Releases · 게시일: 미상

판정 대상:
- `INV-049` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S2 생산 확대 및 다변화 의지 | **면제**
- `INV-077` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S4 기술 생태계 밀착(R&D) | **면제**

ia production without compromising efficiency or grid compatibility.” The first factory acceptance testing has already concluded successfully at this new facility, after which Hydra systems have been delivered to one of the largest multinational oil and gas companies for further field testing. Prodrive technologies is a privately owned Dutch high-tech electronics developer and ma Skip to content 5-11-2025 | Press release Prodrive Technologies inaugurates 4MW green hydrogen rectifier test facility SCIENCE PARK EINDHOVEN, THE NETHERLANDS. (5 November, 2025) - Testing has started at Prodrive Technologies’ new 4MW test facility at its HQ in Son, the Netherlands. It will be used in the coming months and years to explore and perfect the performance of their new SiC-based ‘Hydra’ rectifier system by covering all possible operational conditions and loads.

### 39. Half Year Results 2026
출처: Umicore - Investor Relations / Investor Relations · 게시일: 2026-07-31

판정 대상:
- `INV-065` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S3 투자 재원 확보
- `REL-041` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | 글로벌 사업현황

sus 4.4 for H1 2025 Turning earnings into cash while maintaining rigorous capital discipline and efficiency focus Efficiency measures of € 60 million Capital expenditures of € 130 million Cash flow from operations of € 433 million and Free Operating Cash Flow of € 295 million Net Debt at € 1.5 billion, corresponding to a Net Debt/LTM adj. EBITDA ratio of 1.52x Upgrading guidance to slig nd-markets. Battery Materials Solutions’ revenues and adj. This was mostly driven by higher revenues and adj. EBITDA in Battery Cathode Materials versus H1 2025, mainly related to accruals for take-or-pay compensation [4] linked to contractual volumes. The negative contribution in Battery Recycling Solutions remained in line with H1 2025.

### 40. Q1 and outlook 2026
출처: EMM(Umicore) - Umicore Investor Relations / Investor Relations · 게시일: 2026-04-30

판정 대상:
- `INV-066` EMM(Umicore) | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | S3 투자 재원 확보
- `INV-067` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S3 투자 재원 확보
- `INV-102` EMM(Umicore) | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | S4 기술 생태계 밀착(R&D)
- `INV-103` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | S4 기술 생태계 밀착(R&D)
- `REL-037` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | 글로벌 사업현황
- `REL-043` EMM(Umicore) | 유치필요 기술: 실리콘 음극재 기술(증착형 Si-C) | 글로벌 사업현황

y reflect take-or-pay compensations 4 for volume shortfall. Umicore is executing its standalone mid-term plan, reducing its cost base and keeping its capital expenditures closely managed. Capital expenditures are anticipated to slightly increase versus 2025 driven by selective high-quality growth investments in the foundation businesses while maintaining a focus on strict capital alloca ship agreement with Korea’s HS Hyosung Advanced Materials to advance and fund the industrialization, commercialization and further development of its silicon-carbon composite anode materials for electric vehicle (EV) lithium-ion batteries. The transaction establishing the joint venture has been completed 1 .

### 41. 1-12-2025 | Press release Prodrive Technologies takes €40 million EIB loan to boost R&D in new technologies
출처: Prodrive - Press-release Filter / Press Releases · 게시일: 미상

판정 대상:
- `INV-070` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S4 기술 생태계 밀착(R&D) | **면제**

Skip to content 1-12-2025 | Press release Prodrive Technologies takes €40 million EIB loan to boost R&D in new technologies LUXEMBOURG/SON (1 December, 2025)&nbsp; Dutch-based Prodrive Technologies has signed a €40 million lending agreement with the European Investment Bank (EIB). The financing will advance Prodrive Techn gnal that we want to support homegrown technology in support of Europe’s strategic autonomy.” stated EIB vice president Robert de Groot . “Prodrive’s research and development are complementary to the EU Chips Act, while also providing perspective for technologies that enable green growth.

### 42. UC Berkeley to Join Applied Materials’ EPIC Center to Speed Chip Innovation
출처: Applied Materials - Investor News Releases / Press Releases · 게시일: 2026-08-11

판정 대상:
- `INV-072` Applied Materials | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | S4 기술 생태계 밀착(R&D) | **면제**

with Applied’s state-of-the-art equipment and process integration expertise Located in Silicon Valley , Applied’s EPIC Center provides industry-scale R&D environment with access to cutting-edge chipmaking equipment to enable rapid co-innovation and faster commercialization SANTA CLARA, Calif. 11, 2026 (GLOBE NEWSWIRE) -- Applied Materials, Inc. today announced tha f the Semiconductor Products Group at Applied Materials. “Few institutions have shaped modern chipmaking as profoundly as UC Berkeley . today announced that the University of Califor... today announced that the University of California, Berkeley will join the company’s EPIC Center in Silicon Valley as a research collaborator.

### 43. 1-05-2026 | Press release Prodrive Technologies appoints Mark Roeloffzen as new Chief Executive Officer
출처: Prodrive - Press-release Filter / Press Releases · 게시일: 2026-06-01

판정 대상:
- `INV-074` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S4 기술 생태계 밀착(R&D) | **면제**
- `INV-105` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S5 핵심 전략 인력의 이동 | **면제**

At Nexperia, Mark served as an Executive and General Manager of a global Business Group, combining strategic, commercial, R&D, and operational responsibility with full P&L ownership. Across these roles, he built a strong track record in scaling technology‑driven organizations, navigating complex global markets, and aligning innovation with lon g subsidiaries in Malaysia and South-Korea in 2026.

### 44. 1-04-2026 | Press release Prodrive Technologies announces 2025 financial results
출처: Prodrive - Press-release Filter / Press Releases · 게시일: 미상

판정 대상:
- `INV-076` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S4 기술 생태계 밀착(R&D) | **면제**

hnologies appoints Mark Roeloffzen as new Chief Executive Officer 1-12-2025 | Press release Prodrive Technologies takes €40 million EIB loan to boost R&D in new technologies 5-11-2025 | Press release Prodrive Technologies inaugurates 4MW green hydrogen rectifier test facility 23-09-2025 | Press release Change in executive management at Prodrive Technologies 13-05-2025 | subsidiaries in Europe, the U.S., China, and Japan. Related articles 20-05-2026 | Press release Prodrive Technologies and Fortaegis Technologies sign strategic partnership agreement 1-05-2026 | Press release Prodrive Technologies appoints Mark Roeloffzen as new Chief Executive Officer 1-12-2025 | Press release Prodrive Technologies takes €40 million EIB loan to boost R&D in new technologi Skip to content 1-04-2026 | Press release Prodrive Technologies announces 2025 financial results Prodrive Technologies Group B.V.

### 45. 23-09-2025 | Press release Change in executive management at Prodrive Technologies
출처: Prodrive - Press-release Filter / Press Releases · 게시일: 미상

판정 대상:
- `INV-078` Prodrive | 유치필요 기술: 자율주행차 카메라/이미지 신호처리 | S4 기술 생태계 밀착(R&D) | **면제**

ss release Prodrive Technologies announces 2025 financial results 1-12-2025 | Press release Prodrive Technologies takes €40 million EIB loan to boost R&D in new technologies 5-11-2025 | Press release Prodrive Technologies inaugurates 4MW green hydrogen rectifier test facility 13-05-2025 | Press release Prodrive Technologies begins shipping ultra-fast 10MPx and 21MPx mach half of the Supervisory Board, Eric Saris, Chairman Related articles 20-05-2026 | Press release Prodrive Technologies and Fortaegis Technologies sign strategic partnership agreement 1-05-2026 | Press release Prodrive Technologies appoints Mark Roeloffzen as new Chief Executive Officer 1-04-2026 | Press release Prodrive Technologies announces 2025 financial results 1-12-2025 | Press releas Skip to content 23-09-2025 | Press release Change in executive management at Prodrive Technologies After a change process of approxima

### 46. Siemens Energy begins preparations for the launch of an independent brand
출처: Siemens-Gamesa - Siemens Energy Investor Relations / Investor Relations · 게시일: 2026-07-14

판정 대상:
- `INV-087` Siemens-Gamesa | 유치필요 기술: 해상풍력터빈 | S4 기술 생태계 밀착(R&D)
- `REL-018` Siemens-Gamesa | 유치필요 기술: 해상풍력터빈 | 글로벌 사업현황

ccessful development, Siemens Energy is now beginning preparations for the transition to an independent brand. This move is based on the time-limited license agreement governing the use of the brand. In the future, the current entities Siemens Energy and Siemens Gamesa Renewable Energy will be united under a single name and brand umbrella: Omterra. The rebranding process is scheduled d renewable energy technology, such as gas and steam turbines, hybrid power plants operated with hydrogen, and power generators and transformers. Its wind power subsidiary Siemens Gamesa makes Siemens Energy a global market leader in renewable energies. An estimated one-sixth of the electricity generated worldwide is based on technologies from Siemens Energy.

### 47. Charles River Provides NGS Services to Arovella Therapeutics, Accelerating Progress Toward Alternative Cancer Treatment Approaches
출처: Charles River - News Releases / Press Releases · 게시일: 2026-07-13

판정 대상:
- `INV-088` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | S4 기술 생태계 밀착(R&D)
- `REL-001` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | 글로벌 사업현황

ant ISO, 6 cleanroom suites, 8-10 weeks cell bank completion to release, and over 2,000 cell and viral banks produced supporting client programs from research and development through commercial manufacturing. About Arovella Therapeutics Arovella Therapeutics Ltd (ASX: ALA) is a biotechnology company focused on developing its invariant natural killer T (iNKT) cell therapy platform from Imperi ue Invariant Natural Killer T (iNKT) cell therapy platform for cancer treatment. In a successful IND application, the FDA approved the use of NGS for viral safety testing of two cell banks that produce reagents used in the ALA-101 manufacturing process. “Providing Arovella with NGS services as they advance a transformative iNKT cell therapy platform for patients with lymphoma and ue Invariant Natural Killer T (iNKT) cell therapy platform for cancer treatment.

### 48. Press releases from 2018
출처: Vestas - Media / Newsroom / Media · 게시일: 미상

판정 대상:
- `INV-092` Vestas | 유치필요 기술: 해상풍력터빈 | S4 기술 생태계 밀착(R&D)
- `REL-004` Vestas | 유치필요 기술: 해상풍력터빈 | 글로벌 사업현황

s for Northwester 2 in Belgium \r\n \r\n MHI Vestas Advances Readiness for First Round of Taiwan Offshore Wind Projects \r\n \r\n Blyth Offshore Wind Demonstration Project Fully Commissioned \r\n \r\n MHI Vestas Receives Final Certification for V164-9.5 MW Offshore Wind Turbine \r\n \r\n Blauwwind Consortium Reaches Financial Close on Borssele III/IV \r\n \r\n Financial Close for Industry MWOW Press Releases 2018 \r\n"}}" id="styledheading-beb68df33f" class="cmp-text"> 2018 Please find all MHI Vestas Offshore Wind press releases from 2018 here.

### 49. MilliporeSigma Announces BioReliance ® Testing Facility Opening in ...
출처: Merck - News & Stories / Newsroom / Stories · 게시일: 2026-07-16

판정 대상:
- `INV-095` Merck | 유치필요 기술: 의약품용 부형제 | S4 기술 생태계 밀착(R&D)
- `REL-054` Merck | 유치필요 기술: 의약품용 부형제 | 글로벌 사업현황

Delivery Systems & Services (DS&S) Specialty Gases Intermolecular® The Future Transformation Blog Events & Highlights Research Research Research Our R&D Approach Healthcare Pipeline Clinical Trials Global R&D Hubs Artificial Intelligence - AI Research Open Innovation Innovation Cup Research Grants Future Insight Prize Research Challenges Science Space Envisioning Tomorr ts & Highlights Research Research Research Our R&D Approach Healthcare Pipeline Clinical Trials Global R&D Hubs Artificial Intelligence - AI Research Open Innovation Innovation Cup Research Grants Future Insight Prize Research Challenges Science Space Envisioning Tomorrow News & Media News & Media Press Releases Subscribe to News Releases Events Press Kits Download Gallery Media Con Tumors Oncology Neurology & Immunology Fertility Cardiovascular, Metabolism and Endocrinology Vibrant Thoughts Blog Electronics Thin Films Op

### 50. maxon acquires strategic minority stake in Synapticon
출처: Maxon - News / Newsroom / News · 게시일: 2025-01-01

판정 대상:
- `INV-096` Maxon | 유치필요 기술: 로봇용 감속기 | S4 기술 생태계 밀착(R&D)
- `REL-057` Maxon | 유치필요 기술: 로봇용 감속기 | 글로벌 사업현황

its expertise in the field of motion control through a strategic partnership with the German company Synapticon. The goal of the collaboration is the joint development of high-performance drive solutions with integrated functional safety, based on optimally combined components from both companies. As part of this partnership, the maxon Group has acquired a minority stake in Synapticon r Stuttgart, Germany Download Contact us Share current page The Swiss maxon Group is expanding its expertise in the field of motion control through a strategic partnership with the German company Synapticon.

### 51. Infineon acquires C2i Semiconductors to expand its innovation capabilities in AI data center power management solutions
출처: Infineon - Press / Press Releases / Media · 게시일: 2026-08-31

판정 대상:
- `INV-097` Infineon | 유치필요 기술: 위성통신 및 레이다용 RF 반도체 | S4 기술 생태계 밀착(R&D)
- `REL-027` Infineon | 유치필요 기술: 위성통신 및 레이다용 RF 반도체 | 글로벌 사업현황

uding Substrate Integrated Voltages Regulators (SIVR) Transaction expands Infineon’s innovation footprint in India and further strengthens its global R&D capabilities Munich, Germany / Bangalore, India – 24 August 2026 – Infineon Technologies AG (FSE: IFX / OTCQX: IFNNY) today announced the acquisition of C2i Semiconductors, a Bangalore-based technology company specializ ineon’s global scale, application know-how and broad portfolio of power semiconductors, including silicon, silicon carbide (SiC) and gallium nitride (GaN) technologies, as well as vertical power delivery solutions, paving the way to future Substrate Integrated Voltage Regulators (SIVR).

### 52. Charles River Laboratories and Medigen Vaccine Biologics Corp Collaborate to Advance New Vaccine Development Programs Through Next Generation Sequencing
출처: Charles River - News Releases / Press Releases · 게시일: 2026-08-20

판정 대상:
- `INV-098` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | S4 기술 생태계 밀착(R&D)
- `REL-002` Charles River | 유치필요 기술: 바이러스 검증 및 MCB/WCB 특성분석 | 글로벌 사업현황

erved as the only domestic manufacturer to receive Emergency Use Authorization (EUA) in Taiwan during the COVID-19 pandemic, demonstrating its robust R&D capabilities. MVC's commercialized ENVACGEN®, an Enterovirus 71 Vaccine, has obtained regulatory approvals in Taiwan and Vietnam , with active market expansion in Southeast Asia . Building on this foundation, MVC contin ced therapeutics are characterized and tested, ensuring high-quality products are delivered to patients. NGS has transformed the genetic analysis and pathogen detection landscape with its high throughput, scalability, and speed. Charles River’s CGMP NGS testing services accelerate development timelines without compromising safety and meets regulatory requirements for accuracy, reliabil WIRE)--Aug. 20, 2026-- Charles River Laboratories International, Inc. (NYSE: CRL) and Medigen Vaccine Biologics Corp.

### 53. Press releases from 2019
출처: Vestas - Media / Newsroom / Media · 게시일: 미상

판정 대상:
- `REL-006` Vestas | 유치필요 기술: 해상풍력터빈 | 글로벌 사업현황

MWOW Press Releases 2019 \r\n"}}" id="styledheading-369601c0c5" class="cmp-text"> 2019 Please find all MHI Vestas Offshore Wind press releases from 2019 here.

### 54. Empower Productivity: encoders from the HEIDENHAIN CORPORATE GROUP provide optimal motor feedback for greater productivity, safety and quality at every level of automation.
출처: Heidenhain - Press Releases / Press Releases · 게시일: 2026-05-22

판정 대상:
- `REL-007` Heidenhain | 유치필요 기술: 리니어스케일 | 글로벌 사업현황

INE LINDE, LTN, NUMERIK JENA, RENCO, and RSF. New products at the HEIDENHAIN exhibit, located at Booth D040 in Hall 3, include the ILC 3019 inductive linear encoder from HEIDENHAIN and the 600 series incremental rotary encoder from LEINE LINDE.&nbsp; Many other solutions from the HEIDENHAIN CORPORATE GROUP for robotics and automation will be showcased, including the ECI and EQI rot bustness through inductive scanning technology. Meanwhile, the MCR&nbsp;16 from RSF offers optical scanning with improved signal quality for absolute position measurement on large axes.&nbsp; HEIDENHAIN at SPS Italia: May 26 to 28, 2026, Booth D040 in Hall 3 Empower Productivity: HEIDENHAIN and its brands AMO, LEINE LINDE, RSF, and RENCO offer the optimal rotary encoder solution for ever ay to detect and analyze vibrations arising in machine components.

### 55. Encoders from the HEIDENHAIN GROUP provide optimum motor feedback and increase productivity, reliability, and quality at every level of automation
출처: Heidenhain - Press Releases / Press Releases · 게시일: 2025-11-19

판정 대상:
- `REL-008` Heidenhain | 유치필요 기술: 리니어스케일 | 글로벌 사업현황

ature high robustness and a versatile mechanical design. The MCR&nbsp;16 from RSF delivers optical scanning with improved signal quality for absolute position measurement on axes with large diameters. Empower Productivity: HEIDENHAIN and its brands AMO, RSF, and RENCO offer the optimum solution in the form of rotary encoders for every task in automation and robotics. New at SPS 2025 in N olution for detecting and analyzing vibrations arising from machine elements. These encoders unite position feedback and vibration analysis, and thus motion control and collision monitoring, within a single device. The link they establish between vibration and position signals also makes it easier to identify the type and location of the vibration’s source.

### 56. West to Participate in Upcoming Investor Conferences
출처: West Pharmaceutical - Press Releases / Press Releases · 게시일: 2026-08-26

판정 대상:
- `REL-009` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

26, 2026 /PRNewswire/ -- West Pharmaceutical Services, Inc. (NYSE: WST), a global leader in innovative solutions for injectable drug administration, today announced that it will present at the following upcoming investor conferences: Wells Fargo Annual Healthcare Conference on Thursday, September 10, 2026 at 8:45 a.m. Source: LSEG Release Details West to Participate in Upcoming Investor Conferences August 26, 2026 PDF Version EXTON, Pa. EDT in Everett, MA Morgan Stanley Annual Global Healthcare Conference on Monday, September 14, 2026 at 8:30 a.m. EDT in New York, NY The live webcasts for these events can be accessed in the Investors section of the Company's website . A replay of each webcast will also be available on the Company's website for approximately 90 days after each respective event. About West West Pharmaceutical Services, Inc.

### 57. Siemens Energy is starting preparations for business area Transformation of Industry to become a standalone company
출처: Siemens-Gamesa - Siemens Energy Investor Relations / Investor Relations · 게시일: 2026-08-25

판정 대상:
- `REL-011` Siemens-Gamesa | 유치필요 기술: 해상풍력터빈 | 글로벌 사업현황

d renewable energy technology, such as gas and steam turbines, hybrid power plants operated with hydrogen, and power generators and transformers. Its wind power subsidiary Siemens Gamesa makes Siemens Energy a global market leader in renewable energies. An estimated one-sixth of the electricity generated worldwide is based on technologies from Siemens Energy.

### 58. West Declares Quarterly Dividend
출처: West Pharmaceutical - Press Releases / Press Releases · 게시일: 2026-07-21

판정 대상:
- `REL-017` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

RNewswire/ -- On July 21, 2026, the Board of Directors of West Pharmaceutical Services, Inc. (NYSE: WST), a global leader in innovative solutions for injectable drug administration, declared its regular quarterly dividend of $0.22 per share on the Company's common stock. The dividend is payable on August 5, 2026 to shareholders of record on July 29, 2026. Source: LSEG Release Details West Declares Quarterly Dividend July 21, 2026 PDF Version EXTON, Pa. , July 21, 2026 /PRNewswire/ -- On July 21, 2026, the Board of Directors of West Pharmaceutical Services, Inc. About West West Pharmaceutical Services, Inc. is a leading provider of innovative, high-quality injectable solutions and services. As a trusted partner to established and emerging drug developers, West helps ensure the safe, effective containment and delivery of life saving and life enhancing medicines for patients.

### 59. West to Host Second-Quarter 2026 Conference Call
출처: West Pharmaceutical - Press Releases / Press Releases · 게시일: 2026-07-07

판정 대상:
- `REL-019` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

, July 7, 2026 /PRNewswire/ -- West Pharmaceutical Services, Inc. Source: LSEG Release Details West to Host Second-Quarter 2026 Conference Call July 7, 2026 PDF Version EXTON, Pa. (NYSE: WST), a global leader in innovative solutions for injectable drug administration, today ann... The live webcast can be accessed by clicking here . To ask questions on the conference call, participants need to register in advance by clicking here . Registered telephone participants will receive the dial-in number along with a unique PIN number that will enable them to ask questions on the call. A slide presentation will be made available on the day of the call in the Investors section of the Company's website. A replay of the webcast will be available on the Company's website for approximately 90 days after the event. About West West Pharmaceutical Services, Inc.

### 60. West Completes Sale and Transfer of the Manufacturing and Supply Rights for SmartDose® 3.5mL On-Body Delivery System
출처: West Pharmaceutical - Press Releases / Press Releases · 게시일: 2026-07-01

판정 대상:
- `REL-020` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

, July 1, 2026 /PRNewswire/ -- West Pharmaceutical Services, Inc. (NYSE: WST), a global leader in innovative solutions for injectable drug administration, today announced the company completed the sale and transfer of the manufacturing and supply rights for SmartDose® 3.5mL On-Body Delivery System and associated facilities. Source: LSEG Release Details West Completes Sale and Transfer of the Manufacturing and Supply Rights for SmartDose® 3.5mL On-Body Delivery System July 1, 2026 PDF Version EXTON, Pa. The transaction closed as planned on July 1, 2026 . &nbsp; &nbsp; West will continue to develop and manufacture all other versions of SmartDose, including SmartDose® 10mL On-Body Delivery System, adaptive technology for larger volumes. About West West Pharmaceutical Services, Inc. is a leading provider of innovative, high-quality injectable solutions and services.

### 61. West Appoints Michel Lagarde to be President and Chief Executive Officer
출처: West Pharmaceutical - Press Releases / Press Releases · 게시일: 2026-06-01

판정 대상:
- `REL-021` West Pharmaceutical | 유치필요 기술: Autoinjector/PFS 의약품 완충전 및 제조기술 | 글로벌 사업현황

, June 1, 2026 /PRNewswire/ -- West Pharmaceutical Services, Inc. (NYSE: WST), a global leader in innovative solutions for injectable drug administration, today announced that its Board of Directors has appointed Michel Lagarde to be President and Chief Executive Officer (CEO) and a member of the Company's Board of Directors starting August 31, 2026 . Source: LSEG Release Details West Appoints Michel Lagarde to be President and Chief Executive Officer June 1, 2026 PDF Version Experienced healthcare and life sciences executive to lead the Company's next phase of growth and innovation EXTON, Pa. Green , who will retire from his roles as President, CEO and Board Chair on that date. The Company also announced as part of the CEO transition that the Board has elected Lead Independent Director Robert F. Friel to become Board Chair effective August 31, 2026 .

### 62. Tomorrow's electric aircraft See more
출처: Safran - Pressroom / Newsroom / Press · 게시일: 미상

판정 대상:
- `REL-026` Safran | 유치필요 기술: 항공용 전기모터/고출력 배터리 추진 모듈 | 글로벌 사업현황

(본문 없음)

### 63. Infineon HiRel power semiconductors support successful launch of NASA Nancy Grace Roman Space Telescope Technology news Aug 31, 2026
출처: Infineon - Press / Press Releases / Media · 게시일: 2026-08-31

판정 대상:
- `REL-028` Infineon | 유치필요 기술: 위성통신 및 레이다용 RF 반도체 | 글로벌 사업현황

onal cadence across the full duration of the mission. Infineon's HiRel product range spans radiation-hardened silicon power MOSFETs, gallium nitride (GaN) transistors, gate drivers, solid-state relays and diodes, backed by in-house fabrication, robust radiation testing capabilities and guaranteed long-term product availability. Infineon's JANS-qualified rad-hard 100 V Ga English 日本語 Deutsch Login Register Close { "default" : { "title" : "Login or register", "description" : "Please log in with an existing account or create a new one." }, "bookmark" : { "title" : "Save your favorite pages in one place!", "description" : "Log in or create a myInfineon account to bookmark this page and access it anytime from your dashboard.

### 64. Archer to Shape Physical AI Future of Aerospace and Defense with Acquisition of Boeing's Wisk Aero, Insitu and SkyGrid Subsidiaries; Boeing to Invest in Archer and Collaborate
출처: Boeing - News Releases and Statements / Press Releases / Statements · 게시일: 2026-08-10

판정 대상:
- `REL-030` Boeing | 유치필요 기술: 항공용 전기모터/고출력 배터리 추진 모듈 | 글로벌 사업현황

The deal will combine complementary capabilities developed over decades in autonomy, electric vertical takeoff and landing (eVTOL) aircraft, and unmanned aircraft systems (UAS) – creating a groundbreaking end-to-end physical AI platform for aerospace and defense. Wisk, SkyGrid and Insitu have pioneered and incubated core autonomous flight technolo --> News Releases --> Archer to Shape Physical AI Future of Aerospace and Defense with Acquisition of Boeing's Wisk Aero, Insitu and SkyGrid Subsidiaries; Boeing to Invest in Archer and Collaborate Transaction creates an end-to-end physical AI platform for aerospace and defense. Adds a profitable defense business generating over $200M in annual revenue 1 , with operations across 35 countries, to Archer's portfolio.

### 65. NXP Trimension Ultra-Wideband Powers BMW Group’s Digital Key Plus and Presence Detection
출처: NXP - Media Center Press Releases / Newsroom / Media · 게시일: 2026-08-04

판정 대상:
- `REL-031` NXP | 유치필요 기술: 위성통신 및 레이다용 RF 반도체 | 글로벌 사업현황

t 4, 2026 9:00 AM CET (UTC+1) by NXP Semiconductors Press Release Share Twitter LinkedIn Facebook NXP’s Trimension™ Ultra-Wideband (UWB) ranging and radar solutions will be deployed by the BMW Group across its fleet, starting with selected 2026 vehicle programs NXP’s Trimension NCJ29D6 family allows OEMs to use one UWB system for multiple use cases, from presence detection About NXP Careers Contact Us Inclusion at NXP Innovation Stories Events History Investor Relations Newsroom NXP Leadership Our Brand Our Team Members Quality Smarter World Blog Smarter World Podcast Smarter World Videos Startups x NXP Step Forward Sustainability Trade Compliance We Are NXP Worldwide Locations Newsroom Media Contacts News Briefs Partner and Industry News Press Kits Press Releases NXP Trimension Ultra-Wideband Powers BMW Group’s Digital Key Plus and Presence Detection NXP Trimension Ultra-Wideband Powers

### 66. wind turbines orders
출처: Vestas - Company News / Company News · 게시일: 미상

판정 대상:
- `REL-038` Vestas | 유치필요 기술: 해상풍력터빈 | 글로벌 사업현황

&nbsp; \r\n 495 \r\n 31.03.25 \r\n Vestas wins 50 MW order in Italy \r\n 50 \r\n &nbsp; \r\n 31.03.25 \r\n Vestas wins firm order for the Nordlicht 1 offshore wind project in Germany \r\n &nbsp; \r\n 1,020 \r\n 31.03.25 \r\n Vestas secures orders with wpd for a total of 154 MW in Germany \r\n 154 \r\n &nbsp; \r\n 31.03.25 \r\n Vestas wins 172 MW order in the USA \r\n 172 \r\n &nbs Wind turbine orders Announced wind turbine orders \r\n"}}" id="styledheading-a04bb2028c" class="cmp-text"> Announced wind turbine orders Below you will find an overview of announced wind turbine orders from the current year and more Date \r\n \r\n Title \r\n \r\n Onshore \r\n \r\n Offshore \r\n \r\n 14-04-26 \r\n Vestas receives 70 MW order from Tessa Green Energy to deliver more wind energy in Bulgaria \r\n 70 \r\n &nbsp; \r\n 27-04-26 \r\n Vestas strengthens Québec presence with 186 MW order from EDF power so

### 67. TR-1: Standard form for notification of major holdings
출처: HyproMag - Mkango 2026 News / News Archive RSS · 게시일: 2026-08-03

판정 대상:
- `REL-040` HyproMag | 유치필요 기술: 사용후 영구자석 고순도 희토류 추출 | 글로벌 사업현황

Disclaimer Receive Email Updates Subscribe &copy; 2026 Mkango Resources Ltd. Issuer Details ISIN CA60686A4090 Issuer Name MKANGO RESOURCES LTD. Reason for Notification An acquisition or disposal of voting rights; An acquisition or disposal of financial instruments; An event changing the breakdown of voting rights 3. Details of person subject to the notification obligation Name Spreadex LTD City of registered office (if applicable) St. Albans Country of registered office (if applicable) United Kingdom 4. Details of the shareholder Full name of shareholder(s) if different from the person(s) subject to the notification obligation, above City of registered office (if applicable) Country of registered office (if applicable) 5. Date on which the threshold was crossed or reached 31-Jul-2026 6. Date on which Issuer notified 03-Aug-2026 7.

### 68. maxon at Hannover Messe 2026: Robotics drives, latest portfolio additions, and functional safety
출처: Maxon - News / Newsroom / News · 게시일: 2026-01-01

판정 대상:
- `REL-044` Maxon | 유치필요 기술: 로봇용 감속기 | 글로벌 사업현황

we will show how maxon and Parvalux products can be ideally combined, for example, the maxon IDX industrial drive with the Parvalux GB 28 right-angle gearbox. At our booth, we will also present various live demos showcasing our drive solutions in action. The maxon Germany team will be available for any questions. You can find us at Hannover Messe in Hall 13, Booth C51. For f Back Contact Media Release 04/09/2026 maxon at Hannover Messe 2026: Robotics drives, latest portfolio additions, and functional safety Download Contact us Share current page At Hannover Messe 2026, maxon will present itself with an updated trade fair appearance.

### 69. Hydro at a glance
출처: Norsk Hydro - News Subscription / Investor News Subscription · 게시일: 2025-12-11

판정 대상:
- `REL-045` Norsk Hydro | 유치필요 기술: 비철금속 소재 스크랩 활용률 극대화 | 글로벌 사업현황

ments with a base in sustainable industries. Hydro is through its businesses present in a broad range of market segments for aluminium, energy, metal recycling, renewables and batteries, offering a unique wealth of knowledge and competence. Hydro is committed to leading the way towards a more sustainable future, creating more viable societies by developing natural resources in investments with a base in sustainable industries. Our purpose is to create more viable societies by developing natural resources into products and solutions in innovative and efficient ways. Since 1905, Hydro has turned natural resources into valuable products for people and businesses, creating a safe and secure workplace for our 32,000 employees in more than 140 locations and 40 countries. Today, we own and operate various businesses and have investments with a base in sustainable industries.

### 70. Press Center
출처: EVG - Press Center / News / Newsroom / News · 게시일: 2025-10-14

판정 대상:
- `REL-046` EVG | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | 글로벌 사업현황

cas Catalyst Award Read more 02.10.2025 Innovation Engine: EV Group Wins 2025 Upper Austria Innovation Award Read more 23.09.2025 EV Group Highlights Hybrid Bonding, Lithography, and Support for U.S. Semiconductor Onshoring at SEMICON West 2025 Read more 08.09.2025 EV Group Achieves Breakthrough in Hybrid Bonding Overlay Control for Chiplet Integration Read more 02.09.2025 EV Group pport for U.S. EN English (EN) Choose your language EN English (EN) Deutsch (DE) 日本語 (JA) 中文 (ZH) Services Contact EV Group Company News Press Center 14.10.2025 EVG receives “Grand Achievement Award” for nanoimprint technology Read more 08.10.2025 SEMI Honors EV Group’s Erich Thallner with Inaugural SEMI Americas Catalyst Award Read more 02.10.2025 Innovation Engine: EV Group Wins 2025 Upper Austria Innovation Award Read more 23.09.2025 EV Group Highlights Hybrid Bonding, Lithography, and Support for U.S.

### 71. Press Center
출처: EVG - Press Center / News / Newsroom / News · 게시일: 2025-06-26

판정 대상:
- `REL-047` EVG | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | 글로벌 사업현황

ns with LITHOSCALE® XT Read more 19.05.2025 EV Group Forms Subsidiary in Singapore to Strengthen Local Customer Support Read more 14.05.2025 EV Group Hybrid Bonding, Maskless Lithography and Layer Transfer Solutions for Heterogeneous Integration to be Highlighted at ECTC 2025 Read more 30.04.2025 EV Group Appoints Dr. Thomas Uhrmann Vice President of Sales Read more 26.03.2025 EV G etnam's Semiconductor Capabilities Read more 18.03.2025 EV Group Advances 300-mm MEMS Manufacturing with Next-Generation GEMINI® Automated Production Wafer Bonding System Read more 18.02.2025 EV Group Highlights Revolutionary Temporary Wafer Bonding and Debonding Solution for HBM and 3D DRAM at SEMICON Korea Read more Previous 1 2 3 4 ...

### 72. Topics on the agenda
출처: Norsk Hydro - News Subscription / Investor News Subscription · 게시일: 2019-03-19

판정 대상:
- `REL-048` Norsk Hydro | 유치필요 기술: 비철금속 소재 스크랩 활용률 극대화 | 글로벌 사업현황

In order to reach net-zero by 2050, Hydro needs to phase out fossil fuel consumption, remove process emissions and step up recycling of post-consumer scrap. Karmøy technology pilot The technology pilot is ground breaking for Hydro, Norway and the world. Cyber-attack on Hydro Hydro became victim of an extensive cyber-attack in the early hours of Tuesday, March mazon. Roadmap to net-zero In order to reach net-zero by 2050, Hydro needs to phase out fossil fuel consumption, remove process emissions and step up recycling of post-consumer scrap. The Corridor program Growing alliance of international and local organizations working to accelerate development in the Brazilian Amazon. Topics Explore the topics and issues that shape Hydro and influence the future of aluminium – from sustainability and innovation to the challenges and opportunities in the industry.

### 73. Press Center
출처: EVG - Press Center / News / Newsroom / News · 게시일: 2017-07-05

판정 대상:
- `REL-049` EVG | 유치필요 기술: nm급 W2W 하이브리드 본딩 장비 | 글로벌 사업현황

nt Lithography for Semiconductor Advanced Packaging Read more 19.01.2017 Imec and EVG demonstrate for the first time 1.8µm pitch overlay accuracy for wafer bonding Read more 26.09.2016 EV Group Extends Volume Manufacturing Expertise to Biotechnology and Medical Device Applications Read more 11.07.2016 EV Group Rolls Out Automated Metrology System for Advanced Packaging, MEMS and P As Most Innovative Company in Austria Read more 08.03.2017 EV Group Breaks Speed and Accuracy Barrier in Mask Alignment Lithography for Semiconductor Advanced Packaging Read more 19.01.2017 Imec and EVG demonstrate for the first time 1.8µm pitch overlay accuracy for wafer bonding Read more 26.09.2016 EV Group Extends Volume Manufacturing Expertise to Biotechnology and Medical Device Ap EN English (EN) Choose your language EN English (EN) Deutsch (DE) 日本語 (JA) 中文 (ZH) Services Contact EV Group Company News Press

### 74. Stories by Hydro
출처: Norsk Hydro - News Subscription / Investor News Subscription · 게시일: 미상

판정 대상:
- `REL-050` Norsk Hydro | 유치필요 기술: 비철금속 소재 스크랩 활용률 극대화 | 글로벌 사업현황

ommunity life Brazil stories Sustainability Topic Locations Topic Sustainability CBAM: Europe’s low-carbon aluminium is threatened by a big aluminium scrap loophole Recycling Sustainability A future built together: Inside the apprentice experience that powers Hydro’s next generation Careers People and careers Working with designers to shape the market for greener aluminium Stories by Hydro All Aluminium in use Innovation and technology Sustainability People and careers Recycling Brazil stories Energy Belonging in action: Supporting a school community in Texas People and careers Sustainability Careers Portmann and Hydro: Aluminium innovation with sustainability at the core Aluminium in use Innov Stories by Hydro All Aluminium in use Innovation and technology Sustainability People and careers Recycling Brazil stories Energy Belonging in action: Supporting a school community in Texas People

### 75. Capital Markets Day 2025
출처: Umicore - Newsroom / Newsroom / News · 게시일: 미상

판정 대상:
- `REL-051` Umicore | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | 글로벌 사업현황

ted on reinforcing our leadership in the foundation businesses and further unlocking their strong cash generation potential, while setting up Battery Cathode Materials for value recovery. Discover our 2028 Roadmap All presentations = 1, }" > = 1) { this.active = [] } this.active.push(this.identifier) } else { this.active = this.active.filter( (expanded) => expanded !== this.identifie Umicore unveils roadmap to 2028 On March 27th 2025, Umicore CEO Bart Sap and the Executive Leadership Team shared the key outcomes of the Battery Materials strategy review and Umicore’s roadmap to 2028.

### 76. Latest quarterly results
출처: Norsk Hydro - Investors / Investor Relations · 게시일: 2026-07-22

판정 대상:
- `REL-053` Norsk Hydro | 유치필요 기술: 비철금속 소재 스크랩 활용률 극대화 | 글로벌 사업현황

90 million in the same quarter last year. Higher aluminium prices and product premiums contributed positively, together with improved earnings in the recycling business. Lower energy production due to hydrology and adverse effects from a stronger NOK contributed negatively. Hydro delivered strong profitability in the quarter, with adjusted earnings per share increasing from NO Hydro's second quarter 2026: Operational strength delivering solid results Hydro’s adjusted EBITDA for the second quarter of 2026 was NOK 8,923 million, up from NOK 7,790 million in the same quarter last year. Free cash flow was NOK 4 billion, with strong adjusted EBITDA partially offset by investments and tax payments. The twelve month adjusted RoaCE ended at 10.9 percent.

### 77. Albemarle Publishes 2025 Sustainability Report
출처: Albemarle - Newsroom / Newsroom / News · 게시일: 2026-06-10

판정 대상:
- `REL-055` Albemarle | 유치필요 기술: 양극재 소재(수산화리튬, 탄산리튬) | 글로벌 사업현황

ntal sustainability and community resilience initiatives worldwide.&nbsp; Supporting our customers' sustainability goals &nbsp; Commissioned a direct lithium extraction (DLE) pilot facility at our La Negra site in Chile, achieving a lithium recovery rate exceeding 94% over 3,000 hours of operation. The technology has the potential to increase process efficiency and contribut ate exceeding 94% over 3,000 hours of operation. Share LinkedIn WhatsApp X Email Copy Link June 9, 2026 &nbsp; Albemarle published its 2025 Sustainability Report: Resourceful, Responsible, Resilient , highlighting the company’s sustainability achievements and progress toward its 2030 goals.&nbsp; &nbsp; "At Albemarle, our values shape how we lead, how we operate and how we create value over the long term," said Albemarle Chairman and CEO Kent Masters.

### 78. maxon at the SPS 2025: New drive solutions for robotics, automation and mobility
출처: Maxon - News / Newsroom / News · 게시일: 2025-01-01

판정 대상:
- `REL-056` Maxon | 유치필요 기술: 로봇용 감속기 | 글로벌 사업현황

hare current page At the SPS trade fair from November 25 to 27, 2025, maxon will present a wide range of new products. From highly integrated robotic actuators to powerful servo drives and controllers: a diverse technology portfolio awaits visitors at the maxon booth in Hall 3, Stand 468. One focus at the maxon booth will be the further developed robotics solutions, in partic Back Contact 11/12/2025 maxon at the SPS 2025: New drive solutions for robotics, automation and mobility Strain wave gearhead Download Contact us Share current page At the SPS trade fair from November 25 to 27, 2025, maxon will present a wide range of new products. These compact, highly integrated quasi-direct drive (QDD) actuators combine motor, gearhead, sensors, and electronics in a single, robust housing. Following the successful launch of the HEJ 90 (140 Nm), the HEJ 70 with 62 Nm torque now...

### 79. Pioneering mRNA technology - Moderna Australia
출처: Moderna - News and Media / Newsroom / News · 게시일: 미상

판정 대상:
- `REL-060` Moderna | 유치필요 기술: 유전자/세포치료제 전달체 및 GMP 원료기술 | 글로벌 사업현황

oderna Australia 13+ Years of progress 45 Products in pipeline 36 Ongoing clinical trials Meet Moderna Moderna’s goal is to deliver on the promise of mRNA science to create a new generation of transformative medicines for patients. See about us Join us and change the world of medicine Get matched to your next opportunity Homepage > So, what is mRNA" id="so-what-is-mrna" c Skip to main content This is Moderna's Australia website It may contain content that is not applicable to your location CHANGE COUNTRY Welcome to Moderna Australia 13+ Years of progress 45 Products in pipeline 36 Ongoing clinical trials Meet Moderna Moderna’s goal is to deliver on the promise of mRNA science to create a new generation of transformative medicines for patients. Messenger RNA (mRNA) already exists in your body. It carries a “message” - instructions that direct your cells what to do.

### 80. mRNA（メッセンジャーRNA）技術のパイオニア - モデルナ・ジャパン
출처: Moderna - News and Media / Newsroom / News · 게시일: 미상

판정 대상:
- `REL-061` Moderna | 유치필요 기술: 유전자/세포치료제 전달체 및 GMP 원료기술 | 글로벌 사업현황

;min-height:100%;max-height:100%;object-fit:cover;object-position:32.84023668639053% 26.304106548279687%"/> 1 / 2 13+ 年にわたる成長 45 のパイプライン 36 の臨床試験が進行中 mRNA(メッセンジャーRNA）医薬で人々に最大の可能性を 創薬と初期開発の加速から、急速に拡大するパイプライン、そして世界クラスのチームまで、私たちはmRNA（メッセンジャーRNA）の約束を実現していきます。 モデルナのミッションについて モデルナで医薬品の世界に変革をもたらしませんか。 モデルナでの仕事を探す Homepage > So, what is mRNA" id="mrna" class="Wrapper-sc-s3066g-0 Skip to main content これはモデルナの日本のウェブサイトです あなたの地域には適用されない内容が含まれている可能性があります 国を変更する 新型コロナワクチン情報サイト 本サイトでは、モデルナの新型コロナウイ ルスワクチンを適正にご使用いただくための情報提供を行っています。 新型コロナワクチン情報サイト Homepage > Hero-slide 1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" decoding="async" style="position:absolute;top:0;left:0;bottom:0;right:0;box-sizing:border-box;padding:0;border:none;margin:auto;display:block;width:0;height:0;min-width:100%;max-width:100%;min-height:100%;max-height:100%;object-fit:cover;object-position

### 81. Pioneering mRNA technology - Moderna
출처: Moderna - News and Media / Newsroom / News · 게시일: 미상

판정 대상:
- `REL-062` Moderna | 유치필요 기술: 유전자/세포치료제 전달체 및 GMP 원료기술 | 글로벌 사업현황

Skip to main content 這是Moderna在香港的網站 其中可能包含不適用於您所在區域的內容 更改國家 歡迎來到莫德納香港 13+ 年科研成果 45 項研發中的產品 36 項持續臨床研究 認識莫德納 莫德納的目標是以 mRNA 技術，履行為患者研發新一代革命性藥物的承諾。 了解我們的使命 歡迎加入我們，一起改造醫藥世界 莫德納的工作環境 Homepage > So, what is mRNA" id="mrna" class="Wrapper-sc-s3066g-0 indexstyles__CarouselWrapper-sc-15tnf59-0 fXtPHr hEyxpP"> 甚麼是mRNA？ 信使核糖核酸 (mRNA) 早已存在於你的體內，它帶著一個「 Skip to main content 這是Moderna在香港的網站 其中可能包含不適用於您所在區域的內容 更改國家 歡迎來到莫德納香港 13+ 年科研成果 45 項研發中的產品 36 項持續臨床研究 認識莫德納 莫德納的目標是以 mRNA 技術，履行為患者研發新一代革命性藥物的承諾。 了解我們的使命 歡迎加入我們，一起改造醫藥世界 莫德納的工作環境 Homepage > So, what is mRNA" id="mrna" class="Wrapper-sc-s3066g-0 indexstyles__CarouselWrapper-sc-15tnf59-0 fXtPHr hEyxpP"> 甚麼是mRNA？ 信使核糖核酸 (mRNA) 早已存在於你的體內，它帶著一個「訊息」—也就是指示細胞該作什麼的指令。 以不一樣的方式對抗疾病 療法應用不受限制 讓更多人受惠 以更短時間研發更多藥物 以不一樣的方式對抗疾病 有別於傳統的醫療方式，mRNA（信使核糖核酸）藥物能刺激身體的免疫系統，以製造有效的工具來治療或預防疾病。 進一步了解mRNA 療法應用不受限制 我們相信，若mRNA對治療某種疾病有效，將能治療其他疾病。我們計劃將mRNA應用於目前尚未有治療方法的疾病。 進一步了解mRNA 讓更多人受

### 82. Energy Fuels Completes Australian Strategic Materials Acquisition, Adding Rare Earth Metal & Alloy Capacity - Crux Investor
출처: Google News: Crux Investor · 게시일: 2026-08-29

판정 대상:
- `REL-063` Australian Strategic Metals | 유치필요 기술: 사용후 영구자석 고순도 희토류 추출 | 글로벌 사업현황

Energy Fuels Completes Australian Strategic Materials Acquisition, Adding Rare Earth Metal & Alloy Capacity - Crux Investor

### 83. Energy Fuels Completes Australian Strategic Materials Acquisition As NdFeB Alloy Capacity Targets 3,600 Tonnes Annually - Pulse 2.0
출처: Google News: Pulse 2.0 · 게시일: 2026-08-30

판정 대상:
- `REL-064` Australian Strategic Metals | 유치필요 기술: 사용후 영구자석 고순도 희토류 추출 | 글로벌 사업현황

Energy Fuels Completes Australian Strategic Materials Acquisition As NdFeB Alloy Capacity Targets 3,600 Tonnes Annually - Pulse 2.0

