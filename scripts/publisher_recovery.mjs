// Resolve an opaque Google News discovery URL only when the RSS publisher and an
// independently discovered official article agree on company, host, and title.
// This module deliberately does no network access and never invents an article
// URL from title words. The collector supplies links found on configured official
// pages (or their explicitly followed same-host indexes).

function httpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return /^https?:$/.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalHost(value) {
  const parsed = httpUrl(value);
  const host = parsed ? parsed.hostname : String(value || "").trim().toLowerCase();
  return host.replace(/^www\./, "").replace(/\.$/, "");
}

function cleanTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u00a0\s]+/g, " ")
    .trim();
}

export function publisherArticleTitle(row) {
  const title = cleanTitle(row?.title);
  const publisher = cleanTitle(row?.publisher);
  if (!publisher) return title;
  const suffix = ` - ${publisher}`;
  return title.toLocaleLowerCase("en-US").endsWith(suffix.toLocaleLowerCase("en-US"))
    ? title.slice(0, -suffix.length).trim()
    : title;
}

export function configuredOfficialHosts(company, sourceConfig) {
  const pages = sourceConfig?.official_pages?.[company] || [];
  return new Set(pages.map(page => canonicalHost(page.domain || page.url)).filter(Boolean));
}

// 받은 문서 주소가 그 기업의 공식 호스트(configuredOfficialHosts)인지. www. 와 끝의 점은 무시한다.
export function isOfficialHostUrl(url, hosts) {
  const parsed = httpUrl(url);
  return Boolean(parsed && hosts?.has(canonicalHost(parsed.hostname)));
}

export function publisherRecoveryCandidate(row, sourceConfig) {
  const discovery = httpUrl(row?.url);
  const publisherHome = httpUrl(row?.publisher_home_url);
  const hosts = configuredOfficialHosts(row?.company, sourceConfig);
  if (!discovery || canonicalHost(discovery.hostname) !== "news.google.com") return null;
  if (!publisherHome || !hosts.has(canonicalHost(publisherHome.hostname))) return null;
  const title = publisherArticleTitle(row);
  if (!title) return null;
  return { company: row.company, title, publisher_host: canonicalHost(publisherHome.hostname) };
}

export function fetchedTitleMatchesPublisherArticle(row, fetchedTitle) {
  const wanted = publisherArticleTitle(row).toLocaleLowerCase("en-US");
  const fetched = cleanTitle(fetchedTitle);
  if (!wanted || !fetched) return false;
  if (fetched.toLocaleLowerCase("en-US") === wanted) return true;
  const publisher = cleanTitle(row?.publisher);
  if (!publisher) return false;
  return [` | ${publisher}`, ` - ${publisher}`].some(suffix => {
    const lowerFetched = fetched.toLocaleLowerCase("en-US");
    const lowerSuffix = suffix.toLocaleLowerCase("en-US");
    return lowerFetched.endsWith(lowerSuffix) &&
      lowerFetched.slice(0, -lowerSuffix.length).trim() === wanted;
  });
}

export function aemModelUrl(articleUrl) {
  const parsed = httpUrl(articleUrl);
  if (!parsed) return "";
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}.model.json`;
  return parsed.toString();
}

export function extractQualcommAemArticle(row, model, htmlToText) {
  if (!model || typeof model !== "object" || typeof htmlToText !== "function") return null;
  if (!fetchedTitleMatchesPublisherArticle(row, model.title)) return null;
  // Qualcomm's press-note AEM model stores the article in this named media-RTE
  // component. Do not recursively harvest rich text: sibling RTEs contain the
  // company boilerplate, footer, and related cards.
  // 본문 컴포넌트 이름은 "mediarte" 로 정해져 있지 않다. 2026-09 수집의 Apple 특허 재계약 보도자료는
  // 이미지 컴포넌트(mediaimage)가 먼저 오고 본문이 "mediarte_1" 에 있었다. 그래서 :itemsOrder 순서(없으면 키 순서)로
  // 처음 나오는 mediarte(_숫자) 컴포넌트 하나만 읽는다. PickNik 인수 보도자료처럼 mediarte 뒤에 오는
  // mediarte_1 은 회사 소개 문구라서 모두 모으지 않는다.
  const grid = model?.[":items"]?.root?.[":items"]?.responsivegrid;
  const items = grid?.[":items"];
  if (!items || typeof items !== "object") return null;
  const order = Array.isArray(grid[":itemsOrder"]) ? grid[":itemsOrder"] : Object.keys(items);
  const key = order.find(name => /^mediarte(?:_\d+)?$/.test(name) &&
    /\/mediarte\/v1\/mediarte$/.test(items[name]?.[":type"] || ""));
  if (!key) return null;
  const content = cleanTitle(htmlToText(items[key]?.qcommRTE?.text || ""));
  return content ? { title: cleanTitle(model.title), content } : null;
}

function officialLink(candidate, sourceConfig) {
  const article = httpUrl(candidate?.url);
  const sourcePage = httpUrl(candidate?.source_page_url || candidate?.official_source_url || candidate?.query);
  const hosts = configuredOfficialHosts(candidate?.company, sourceConfig);
  if (!article || !sourcePage) return null;
  if (!hosts.has(canonicalHost(article.hostname)) || !hosts.has(canonicalHost(sourcePage.hostname))) return null;
  return article.toString();
}

export function matchOfficialPublisherArticle(row, candidates, sourceConfig) {
  const wanted = publisherRecoveryCandidate(row, sourceConfig);
  if (!wanted) return null;
  const wantedTitle = cleanTitle(wanted.title).toLocaleLowerCase("en-US");
  const matches = new Map();
  for (const candidate of candidates || []) {
    if (candidate?.company !== row.company) continue;
    if (cleanTitle(candidate.title).toLocaleLowerCase("en-US") !== wantedTitle) continue;
    const directUrl = officialLink(candidate, sourceConfig);
    if (directUrl && !matches.has(directUrl)) matches.set(directUrl, {
      direct_url: directUrl,
      matched_title: wanted.title,
      source_page_url: candidate.source_page_url || candidate.official_source_url || candidate.query,
    });
  }
  // Recurring headlines (for example quarterly-dividend announcements) can
  // produce more than one legitimate article. A title alone cannot choose one.
  return matches.size === 1 ? [...matches.values()][0] : null;
}

export function recoverPublisherRow(row, candidates, sourceConfig) {
  const match = matchOfficialPublisherArticle(row, candidates, sourceConfig);
  if (!match) return row;
  // Preserve the Google discovery URL, source fields, and all date evidence. The
  // normal detail fetch may add stronger page evidence after it reads this URL.
  return {
    ...row,
    source_direct_url: match.direct_url,
    publisher_resolution: "official_exact_title",
    publisher_resolution_source_url: match.source_page_url,
  };
}
