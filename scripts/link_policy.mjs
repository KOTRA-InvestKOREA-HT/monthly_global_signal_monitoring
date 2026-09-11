// 목록 페이지에서 긁은 링크 하나가 기사인지 판정하는 규칙.
//
// 판정을 참/거짓 하나로 내리면 "기사가 아님"과 "기사인지 알 수 없음"이 한 칸에 뭉개진다.
// 뭉개진 쪽은 늘 버리는 쪽으로 정리돼서, 날짜가 링크에 안 박혔거나 슬러그가 짧다는
// 이유만으로 진짜 기사가 fetch 전에 사라졌다. 그래서 세 갈래로 나눈다.
//
//   hard_reject      구조적으로 기사가 될 수 없다. 카테고리·페이지네이션·에셋·깨진 URL.
//   fetch_to_verify  기사일 수 있다. 받아본 문서를 보고 판정한다.
//   accept           링크 단계에서 이미 기사로 볼 근거가 충분하다.
//
// 의미 판단(이 기사가 타겟 기술과 관련이 있는가, 투자 신호인가)은 여기서 하지 않는다.
// 그건 AI 검토의 일이다. 여기서 하는 일은 "문서인가 목록인가"뿐이다.
//
// augustRule/currentRule 은 비교용으로 얼려둔 과거 규칙이다. scripts/audit_link_rules.mjs
// 가 같은 앵커에 세 규칙을 모두 걸어 회수량과 소음 증가량을 재는 데 쓴다.

// 목록 페이지 URL에 흔히 붙는 로케일 세그먼트. en-us, ko_KR, zh-hans 형태를 모두 받는다.
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z0-9]{2,5})?$/;

// 코드 대신 언어 이름을 쓰는 사이트도 많다. sumitomo-chem.co.jp/english/news/ 같은 경우.
const LOCALE_WORDS = new Set([
  "english", "japanese", "korean", "chinese", "deutsch", "german",
  "french", "francais", "spanish", "espanol", "italiano", "portugues",
]);

export function isLocaleSegment(segment) {
  return LOCALE_SEGMENT.test(segment) || LOCALE_WORDS.has(segment);
}

// 기사 한 건이 아니라 기사 묶음을 가리키는 경로 조각.
export const INDEX_SEGMENTS = new Set([
  "en", "global", "corporate", "company", "about", "about-us",
  "news", "news-events", "news-and-events", "news-and-insights", "news-insights",
  "newsroom", "news-room", "newsreleases", "news-release", "news-releases",
  "media", "media-center", "media-centre", "mediacenter", "media-gallery",
  "media-library", "medialibrary", "social-media", "video-center", "video-centre",
  "press", "pressroom", "press-room", "press-kit", "press-kits",
  "press-release", "press-releases", "pressreleases", "releases",
  "stories", "featured-stories", "blog", "blogs", "events", "insights",
  "publications", "library", "resources",
  "investor", "investors", "investor-relations", "ir",
  "announcements", "announcement", "annual-general-meeting",
  "financial-results", "results", "reports",
  "sustainability", "esg", "responsibility",
  "overview", "archive", "archives", "all", "latest", "index", "home", "default",
]);

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

// 목록 페이지임을 확정적으로 드러내는 경로. 카테고리·태그·페이지네이션은 기사 URL이 될 수 없다.
export function hasIndexOnlyPathMarker(parsed) {
  const pathname = parsed.pathname.toLowerCase();
  if (/\/(category|categories|kategorie|tag|tags|topic|topics|subject|filter|search|page)\//.test(pathname)) return true;
  if (/\/page[/-]\d+\/?$/.test(pathname)) return true;
  for (const key of parsed.searchParams.keys()) {
    // ?p=123 은 워드프레스에서 개별 글을 가리키므로 페이지네이션으로 보지 않는다.
    if (/^(page|paged|offset|start|category|cat|tag|topic|filter|label)$/i.test(key)) return true;
  }
  return false;
}

// 치환되지 않은 템플릿 자리표시자나 앵커 문법이 남은 URL. 유효한 문서가 아니다.
// 현재 규칙이 쓰는 판정이라 비교를 위해 그대로 둔다. 제안 규칙은 아래 looksLikeTemplateUrl 을 쓴다.
export function looksLikeBrokenUrl(value) {
  const text = String(value || "");
  if (/\.(cta|href|link)\.url(\?|#|$)/i.test(text)) return true;
  if (/[/:][A-Z][A-Z0-9_-]{3,}$/.test(text.replace(/^https?:\/\//i, ""))) return true;
  if (/\$\{|\{\{|%7b/i.test(text)) return true;
  return false;
}

// 위 판정에서 슬래시 뒤 대문자 토큰을 뺀 것.
//
// nxp.com 은 자리표시자를 콜론으로 붙이지만(/about-nxp/accessibility:ACCESSIBILITY),
// 보도자료 슬러그도 대문자 문서 번호다(/newsroom/NW-NXP-BREAKS-GROUND-SITE-MAL).
// 슬래시까지 한데 묶는 바람에 NXP의 착공·배당 발표 같은 실제 기사가 fetch 전에 사라졌다.
// 자리표시자를 가르는 것은 대문자가 아니라 콜론이다.
export function looksLikeTemplateUrl(value) {
  const text = String(value || "");
  if (/\.(cta|href|link)\.url(\?|#|$)/i.test(text)) return true;
  if (/:[A-Z][A-Z0-9_-]{3,}$/.test(text.replace(/^https?:\/\//i, ""))) return true;
  if (/\$\{|\{\{|%7b/i.test(text)) return true;
  return false;
}

function stripPageExtension(segment) {
  return segment.replace(/\.(html?|aspx?|php|jsp|cfm)$/i, "");
}

// URL 경로를 로케일·확장자를 걷어낸 조각 목록으로 만든다. 구조 판정은 전부 이 조각들 위에서 한다.
function pathSegments(parsed) {
  return parsed.pathname
    .replace(/\/+$/, "")
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map(stripPageExtension)
    .filter((segment) => segment && !isLocaleSegment(segment));
}

export function looksLikeSourceIndexUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    if (!pathname || pathname === "") return true;
    if (/(\/|^)(rss|feed|atom)(\/|$)/i.test(pathname)) return true;
    if (hasIndexOnlyPathMarker(parsed)) return true;
    const segments = pathSegments(parsed);
    if (segments.length === 0) return true;
    if (segments.length <= 4 && segments.every((segment) => INDEX_SEGMENTS.has(segment))) return true;
    // /company/newsroom/featured-stories/automotive 처럼 상위 경로가 전부 목록이고
    // 마지막 조각이 짧은 낱말이면 기사가 아니라 카테고리 탭이다.
    return isShortSlugUnderIndex(segments);
  } catch {
    return false;
  }
}

// looksLikeSourceIndexUrl 의 마지막 조항. 카테고리 탭과 짧은 기사 슬러그가 여기서 갈라진다.
// /press/strategic-deal 같은 실제 기사도 이 모양이라, 제안 규칙은 이 조항을 거부가 아니라
// 확인 대상으로 돌린다. URL 모양만으로는 둘을 가를 수 없다는 것이 이 조항의 사실이다.
export function isShortSlugUnderIndex(segments) {
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1];
  const parents = segments.slice(0, -1);
  const lastLooksLikeCategory = !/\d/.test(last) && last.split("-").length <= 2 && last.length <= 24;
  return parents.every((segment) => INDEX_SEGMENTS.has(segment)) && lastLooksLikeCategory;
}

// 기사가 실제로 놓이는 구역. INDEX_SEGMENTS 중에서 "기사 묶음"인 것만 추린 것으로,
// about-us·resources·overview 처럼 기사가 아닌 묶음은 뺐다.
const NEWS_SECTIONS = new Set([
  "news", "news-events", "news-and-events", "news-and-insights", "news-insights",
  "newsroom", "news-room", "newsreleases", "news-release", "news-releases",
  "media", "media-center", "media-centre", "mediacenter",
  "press", "pressroom", "press-room", "press-release", "press-releases", "pressreleases",
  "releases", "stories", "featured-stories", "blog", "blogs", "insights",
  "announcements", "announcement", "publications", "events",
  "investor", "investors", "investor-relations", "ir",
  "financial-results", "results", "reports", "article", "articles", "detail", "details",
]);

// 발행일이나 발행 번호가 박힌 경로. 뉴스 구역 밖에 놓인 기사를 여기서 건진다.
// 낱말 수는 쓰지 않는다. /products/vial-transfer-devices 도 세 낱말이라 갈라지지 않는다.
function publicationShapedPath(segments) {
  if (segments.some((segment) => /^(19|20)\d{2}$/.test(segment))) return true;
  const last = segments[segments.length - 1];
  return /(^|[-_])(19|20)\d{2}([-_]|$)/.test(last) || /\d{5,}/.test(last);
}

// fetch 해볼 값이 있는 링크인지. 뉴스 구역에서 나왔거나 발행물 경로 모양이어야 한다.
// 이 조항이 없으면 회사 사이트의 제품·시장·소개 페이지가 전부 확인 대상이 되어,
// 정작 기사에 써야 할 fetch 예산을 메뉴가 먹는다.
export function hasArticleAffordance(segments, url) {
  if (segments.length === 0) return false;
  if (segments.slice(0, -1).some((segment) => NEWS_SECTIONS.has(segment))) return true;
  if (publicationShapedPath(segments)) return true;
  // 경로가 난수 ID이고 실제 제목이 쿼리에 담긴 문서 링크. Nasdaq·Q4 IR 사이트가 이 모양이다.
  return /[?&](fileName|filename|releaseid|itemid|newsid)=/i.test(String(url || ""));
}

// 본문을 열 수 없는 파일. PDF는 여기에 넣지 않는다. extract_pdf_text.py 가 읽는다.
const ASSET_EXTENSION =
  /\.(jpg|jpeg|png|gif|svg|webp|bmp|ico|mp4|mov|avi|wmv|mp3|wav|zip|rar|7z|gz|tar|exe|dmg)(?:[?#]|$)/i;

const BOILERPLATE = /privacy|cookie|terms|subscribe|contact|career|linkedin|facebook|twitter|youtube|instagram/i;

const NAV_TITLE =
  /^(investor relations home|corporate governance|corporate directory|corporate citizenship|management|contact us|about us|products?|solutions?|careers?)$/i;

const ARTICLE_KEYWORDS =
  /press|release|news|financial|results|earnings|quarter|annual|report|presentation|announcement|acquisition|expansion|partnership|investment|korea|plant|facility|manufactur/i;

const DETAILED_PATH = /\/(news-release-details|press-releases?|newsroom|news|media|article|announcements?)\//i;

const NEWS_PATH = /\/(news|press|release|media|investor|ir|financial|results|announcements?)\b/i;

function looksDetailed(url) {
  return DETAILED_PATH.test(url) || /\b20\d{2}\b/.test(url);
}

// 같은 회사가 운영하는 호스트인지. investor.cognex.com 과 cognex.com 은 같은 회사이고
// 뉴스룸을 별도 호스트에 두는 회사가 많아서, 호스트 문자열 일치만으로는 전부 놓친다.
function registrableDomain(hostname) {
  const labels = String(hostname || "").replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const secondLast = labels[labels.length - 2];
  const depth = /^(co|com|or|ne|go|ac|gov|edu|org|net)$/i.test(secondLast) ? 3 : 2;
  return labels.slice(-depth).join(".");
}

export function sameOwner(pageUrl, linkUrl) {
  try {
    return registrableDomain(new URL(pageUrl).hostname) === registrableDomain(new URL(linkUrl).hostname);
  } catch {
    return false;
  }
}

function sameHostNewsPath(anchor, pageUrl) {
  try {
    const sourceHost = new URL(pageUrl).hostname.replace(/^www\./, "");
    const targetHost = new URL(anchor.url).hostname.replace(/^www\./, "");
    return sourceHost === targetHost && NEWS_PATH.test(new URL(anchor.url).pathname);
  } catch {
    return false;
  }
}

// 2026-08 시점의 규칙. 목록 판정이 훨씬 느슨했고, 짧은 링크 텍스트는 무조건 버렸다.
export function augustRule(anchor, pageUrl, deps) {
  const title = deps.officialTitle(anchor);
  const direct = `${title} ${anchor.url}`.toLowerCase();
  const detectedDate = deps.detectDate(`${anchor.title} ${anchor.context} ${anchor.url}`);
  if (augustIndexUrl(anchor.url)) return false;
  const pathLooksDetailed = looksDetailed(anchor.url);
  if (title.length < 8) return false;
  if (!detectedDate && !pathLooksDetailed) return false;
  if (ASSET_EXTENSION.test(anchor.url)) return false;
  if (BOILERPLATE.test(direct)) return false;
  if (NAV_TITLE.test(title)) return false;
  if (ARTICLE_KEYWORDS.test(direct)) return true;
  return sameHostNewsPath(anchor, pageUrl);
}

function augustIndexUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, "").toLowerCase();
    if (!pathname) return true;
    if (/(\/|^)(rss|feed|atom)(\/|$)/i.test(pathname)) return true;
    const generic = new Set([
      "en", "global", "news", "news-events", "newsroom", "media", "press",
      "press-release", "press-releases", "releases", "investor", "investors",
      "investor-relations", "ir", "announcements",
    ]);
    const segments = pathname.split("/").filter(Boolean);
    return segments.length > 0 && segments.length <= 3 && segments.every((segment) => generic.has(segment));
  } catch {
    return false;
  }
}

// html-report-prototype 브랜치가 지금 쓰는 규칙. 비교 기준으로 얼려둔다.
export function currentRule(anchor, pageUrl, deps) {
  const title = deps.officialTitle(anchor);
  const direct = `${title} ${anchor.url}`.toLowerCase();
  const detectedDate = deps.detectDate(`${anchor.title} ${anchor.context} ${anchor.url}`);
  if (looksLikeSourceIndexUrl(anchor.url)) return false;
  if (looksLikeBrokenUrl(anchor.url)) return false;
  const pathLooksDetailed = looksDetailed(anchor.url);
  if (title.length < 8 && !pathLooksDetailed) return false;
  if (!detectedDate && !pathLooksDetailed) return false;
  if (ASSET_EXTENSION.test(anchor.url)) return false;
  if (BOILERPLATE.test(direct)) return false;
  if (NAV_TITLE.test(title)) return false;
  if (ARTICLE_KEYWORDS.test(direct)) return true;
  return sameHostNewsPath(anchor, pageUrl);
}

// 링크 단계에서 이미 기사로 인정할 근거. 앞의 두 줄은 currentRule 의 통과 조건과 같은 값이라,
// 제안 규칙의 accept 집합은 현재 규칙의 통과 집합을 그대로 포함한다.
function acceptedAtLinkLevel(anchor, pageUrl, title, direct, detectedDate, pathLooksDetailed, segments) {
  if (title.length < 8 && !pathLooksDetailed) return false;
  if (!detectedDate && !pathLooksDetailed) return false;
  if (ARTICLE_KEYWORDS.test(direct)) return true;
  if (sameHostNewsPath(anchor, pageUrl)) return true;
  // 슬러그에 발행일이 박히고 제목이 붙은 링크. boeing.mediaroom.com/2026-09-04-Boeing-... 이나
  // investors.danaher.com/2026-08-03-Danaher-Appoints-... 처럼 경로에 news/press 낱말이 없어
  // 현재 규칙이 통째로 놓치던 보도자료다. 날짜와 제목이 둘 다 있으면 확인할 것이 없다.
  return title.length >= 8 && publicationShapedPath(segments);
}

const reject = (reason) => ({ verdict: "hard_reject", reason });
const verify = (reason) => ({ verdict: "fetch_to_verify", reason });
const ACCEPT = { verdict: "accept", reason: "article_link" };

// 제안 규칙. hard_reject 는 구조적 근거만 쓰고, 나머지 애매한 링크는 전부 fetch 로 넘긴다.
export function classifyOfficialLink(anchor, pageUrl, deps) {
  const url = String(anchor.url || "");
  if (!isHttpUrl(url)) return reject("not_http");
  if (ASSET_EXTENSION.test(url)) return reject("asset_file");
  if (looksLikeTemplateUrl(url)) return reject("broken_url");

  const title = deps.officialTitle(anchor);
  const direct = `${title} ${url}`.toLowerCase();
  if (BOILERPLATE.test(direct)) return reject("boilerplate_or_social");
  if (NAV_TITLE.test(title)) return reject("navigation_label");

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return reject("not_http");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
  if (!pathname) return reject("site_root");
  if (/(\/|^)(rss|feed|atom)(\/|$)/i.test(pathname)) return reject("feed_url");
  if (hasIndexOnlyPathMarker(parsed)) return reject("category_or_pagination");

  const segments = pathSegments(parsed);
  if (segments.length === 0) return reject("site_root");
  // 남은 조각이 전부 목록용 낱말이면 그 URL이 가리키는 것은 기사 묶음이다. 계속 거부한다.
  if (segments.length <= 4 && segments.every((segment) => INDEX_SEGMENTS.has(segment))) return reject("index_page");

  const detectedDate = deps.detectDate(`${anchor.title} ${anchor.context} ${url}`);
  const pathLooksDetailed = looksDetailed(url);
  if (acceptedAtLinkLevel(anchor, pageUrl, title, direct, detectedDate, pathLooksDetailed, segments)) return ACCEPT;

  // 여기부터는 현재 규칙이 전부 버리던 자리다. 버리는 대신 이유를 붙여 fetch 로 보낸다.
  // 다만 남의 도메인으로 나가면서 기사 낱말도 없는 링크는 파트너·배너라 확인할 값이 없다.
  if (!sameOwner(pageUrl, url) && !ARTICLE_KEYWORDS.test(direct)) return reject("offsite_link");
  // 기사일 수 있다는 표시가 하나도 없으면 확인 대상도 아니다. 이 조항이 fetch 예산을 지킨다.
  if (!hasArticleAffordance(segments, url)) return reject("no_article_affordance");

  if (isShortSlugUnderIndex(segments)) return verify("short_slug_under_index");
  if (title.length < 8) return verify("generic_link_text");
  if (!detectedDate) return verify("no_listing_date");
  return verify("unfamiliar_path");
}

export function proposedRule(anchor, pageUrl, deps) {
  return classifyOfficialLink(anchor, pageUrl, deps).verdict !== "hard_reject";
}

// fetch 이후 판정. 링크 단계에서 확인 대상으로 넘긴 문서가 실제로 기사였는지 본다.
// 링크를 세는 이유는, 받은 것이 기사면 본문이 링크보다 길고 목록이면 그 반대이기 때문이다.
// PDF는 html 이 비어 있어 링크 밀도가 0이므로 이 조항에 걸리지 않는다.
const LISTING_TITLE = new RegExp(
  [
    "press\\s*releases?\\s+from\\s+\\d{4}",
    "news\\s*archive",
    "^\\s*(news|press\\s*releases?|media\\s*releases?|announcements?)\\s*(archive|list|overview)?\\s*$",
  ].join("|"),
  "i",
);

// 제목 자리에 문서 번호만 들어온 경우. IR 사이트의 static-files·SEC 제출 링크가 이 모양이라
// 헤드라인으로 쓸 수 없고, 사람이 읽어도 무슨 문서인지 알 수 없다.
// 0001627223-26-000027 (SEC 접수번호), e9aaa4d1 c1c1 42a4 8a84 1eb683853033 (UUID).
const IDENTIFIER_TITLE = /^[0-9a-f]{4,}(?:[\s._-]+[0-9a-f]{2,})+(?:\.[a-z]{2,4})?$/i;

export function verifyFetchedArticle({ title, content = "", html = "", usableTitle }) {
  if (!usableTitle) return { ok: false, reason: "no_article_title" };
  const text = String(title || "").trim();
  if (IDENTIFIER_TITLE.test(text)) return { ok: false, reason: "no_article_title" };
  if (LISTING_TITLE.test(text)) return { ok: false, reason: "verified_index_page" };
  const body = String(content || "").trim();
  // PDF는 html 이 비어 있다. 링크 밀도는 HTML 문서에만 물을 수 있는 질문이다.
  if (!html) return { ok: true, reason: "verified_article" };
  const linkCount = (html.match(/<a\b[^>]*href=/gi) || []).length;
  // 기사 한 건이면 본문이 링크보다 많다. 반대면 받은 것은 목록이나 색인이다.
  if (body.length < 800 && linkCount >= 20) return { ok: false, reason: "verified_index_page" };
  return { ok: true, reason: "verified_article" };
}
