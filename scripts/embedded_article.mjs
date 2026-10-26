// 페이지 스크립트 안에 실린 기사 본문을 꺼낸다. 네트워크도 상태도 없는 순수 함수만 둔다.
//
// 본문을 HTML 이 아니라 스크립트 데이터로 내려 주고 브라우저에서 그리는 뉴스 사이트가 있다. 2026-09 수집에서
// Chosun English(Arc XP) 기사는 HTML 추출로 70~90자, Motley Fool·LPGA(Next.js) 기사는 제목과 메뉴만 남았다.
// 같은 페이지의 Fusion.globalContent, JSON-LD articleBody, self.__next_f 조각에는 기사 전문이 있었다.
//
// 수집기(fetchDetailOutcome)는 HTML 추출이 실패했을 때만(본문이 기준 미달이거나 제목을 못 찾았을 때) 이 모듈을
// 부른다. 이미 본문이 있던 기사의 근거 글자가 바뀌면 기사 ID 가 바뀌어 저장된 판정을 다시 쓸 수 없기 때문이다.
// 여기서 꺼낸 글은 모두 제목 대조를 통과해야 한다. 같은 페이지의 사이드바·추천 기사 데이터가 함께 실리기 때문이다.

import { ARTICLE_BODY_MIN_CHARS } from "./date_state.mjs";

const STOPWORDS = new Set([
  "about", "after", "also", "amid", "ahead", "been", "being", "from", "have", "into", "more", "over", "says",
  "said", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "what", "when",
  "where", "which", "while", "will", "with", "would", "your", "year", "years",
]);

export function normalizeTitle(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// 제목을 가르는 낱말. 영문은 네 글자 이상, 한글·한자처럼 라틴 문자가 아닌 낱말은 두 글자 이상이다.
// 한국어 제목("반도체 투자 확대")은 네 글자를 넘는 낱말이 드물어 영문 기준을 쓰면 비어 버린다.
export function distinctiveWords(value) {
  return [...new Set(normalizeTitle(value).split(" ").filter(word =>
    !STOPWORDS.has(word) && (word.length >= 4 || (/[^\x00-\x7f]/.test(word) && word.length >= 2))))];
}

// candidate 의 가르는 낱말 가운데 reference 에도 있는 몫. 가르는 낱말이 없으면 0 이다.
export function sharedWordRatio(candidate, reference) {
  const words = distinctiveWords(candidate);
  if (!words.length) return 0;
  const pool = new Set(normalizeTitle(reference).split(" "));
  return words.filter(word => pool.has(word)).length / words.length;
}

// 뒤에 붙은 사이트 이름 한 토막(" - X", " – X", " — X", " | X", X 는 40자 이내)을 뗀다.
// Google News 제목은 " - 발행사"로 끝나고, 많은 사이트의 og:title·<title> 도 " - 사이트 이름"으로 끝난다.
export function withoutSiteSuffix(value) {
  return String(value || "").replace(/\s+[-–—|]\s+[^-–—|]{1,40}$/, "").trim();
}

// 꺼낸 글의 제목이 찾던 기사의 제목인지. 정규화한 제목이 서로를 담거나, 양쪽 가르는 낱말이 절반 이상 겹치면 같은 기사로 본다.
export function sameHeadline(headline, titles) {
  const wanted = normalizeTitle(headline);
  if (!wanted) return false;
  return titles.some(title => {
    const other = normalizeTitle(title);
    if (!other) return false;
    if (other === wanted) return true;
    const [shorter, longer] = other.length < wanted.length ? [other, wanted] : [wanted, other];
    if (shorter.split(" ").length >= 3 && ` ${longer} `.includes(` ${shorter} `)) return true;
    return sharedWordRatio(headline, title) >= 0.5 && sharedWordRatio(title, headline) >= 0.5;
  });
}

// 비교에 쓸 제목들. 페이지 제목과 행 제목(Google 은 " - 발행사"로 끝난다), 그리고 둘에서 사이트 이름을 뗀 것.
// 사이트 이름을 뗀 것을 앞에 둔다. RSC 본문 앞에 붙일 제목 줄로는 이쪽이 맞다.
function titleVariants(titles) {
  return [...new Set(titles.flatMap(title => [withoutSiteSuffix(title), title]).map(title => String(title || "").trim())
    .filter(Boolean))];
}

// text[start] 의 { 부터 짝이 맞는 } 까지를 JSON 으로 읽는다. 문자열 안의 괄호는 세지 않는다.
// 정규식으로 "};Fusion." 까지 자르면 본문에 그 글자가 든 기사에서 중간에 끊긴다.
function jsonObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
    } else if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function arcGlobalContent(html) {
  const match = /Fusion\.globalContent\s*=\s*\{/.exec(html);
  return match ? jsonObjectAt(html, match.index + match[0].length - 1) : null;
}

// Arc XP 의 접근 제한 표시. GenomeWeb 은 {"content_code":"digital"}(구독), Pensions&Investments 는
// {"content_code":"registration-required"}(가입)이다. 발행사가 유료·가입 뒤에 둔 글은 꺼내지 않는다.
// 제한이 없는 Chosun English 기사에는 이 값이 없다.
function arcRestricted(content) {
  const restrictions = content?.content_restrictions;
  if (!restrictions) return false;
  if (typeof restrictions !== "object") return true;
  return Object.values(restrictions).some(Boolean);
}

function arcArticle(content, titles, htmlToText) {
  const headline = String(content?.headlines?.basic || "").trim();
  if (!headline || !sameHeadline(headline, titles)) return null;
  const text = (Array.isArray(content.content_elements) ? content.content_elements : [])
    .filter(element => (element?.type === "text" || element?.type === "header") && typeof element.content === "string")
    .map(element => htmlToText(element.content))
    .filter(Boolean)
    .join("\n");
  return text ? { kind: "arc", title: headline, content: text } : null;
}

// JSON-LD 덩어리. 줄바꿈을 이스케이프하지 않고 그대로 싣는 사이트가 있어, 처음 읽기가 실패하면 제어 문자를 공백으로 바꿔 다시 읽는다.
function jsonLdBlocks(html) {
  const blocks = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1].trim();
    for (const text of [raw, raw.replace(/[\u0000-\u001f]+/g, " ")]) {
      try {
        blocks.push(JSON.parse(text));
        break;
      } catch {
        // 다음 방식으로 다시 읽는다.
      }
    }
  }
  return blocks;
}

function* jsonLdNodes(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) yield* jsonLdNodes(item, depth + 1);
    return;
  }
  yield value;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") yield* jsonLdNodes(child, depth + 1);
  }
}

// isAccessibleForFree 가 false 인 노드는 유료 기사다(GenomeWeb·Pensions&Investments 의 JSON-LD 가 그렇다).
function jsonLdArticle(html, titles, htmlToText) {
  for (const block of jsonLdBlocks(html)) {
    for (const node of jsonLdNodes(block)) {
      if (typeof node.articleBody !== "string" || /^false$/i.test(String(node.isAccessibleForFree ?? ""))) continue;
      const headline = String(node.headline || node.name || "").trim();
      if (!headline || !sameHeadline(headline, titles)) continue;
      const text = htmlToText(node.articleBody.replace(/\r\n?/g, "\n"));
      if (text.length >= ARTICLE_BODY_MIN_CHARS) return { kind: "jsonld", title: htmlToText(headline), content: text };
    }
  }
  return null;
}

// Next.js RSC 조각. self.__next_f.push([1,"..."]) 의 문자열 가운데 HTML 태그로 시작하는 가장 긴 것이 기사 본문이다.
// 같은 페이지에 추천 기사·사이드바 조각도 HTML 로 실린다. Nutrition Insight 기사에서는 가장 긴 조각이 다른 기사
// 소개였다. 그래서 제목의 가르는 낱말 절반 이상이 조각 앞부분(1500자)에 나와야 받는다.
function rscArticle(html, titles, htmlToText) {
  const chunks = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      // 깨진 조각은 건너뛴다.
    }
  }
  const best = chunks.filter(chunk => /^\s*<(?:p|h[1-6]|div|ul|blockquote)\b/i.test(chunk))
    .map(chunk => htmlToText(chunk))
    .sort((a, b) => b.length - a.length)[0] || "";
  if (best.length < ARTICLE_BODY_MIN_CHARS) return null;
  const head = best.slice(0, 1500);
  const title = titles.find(item => sharedWordRatio(item, head) >= 0.5);
  return title ? { kind: "rsc", title, content: best } : null;
}

// 순서대로 시도해 처음 통과한 것을 돌려준다: Arc XP → JSON-LD articleBody → Next.js RSC.
// titles: 찾던 기사의 제목들(행 제목, 페이지 제목). htmlToText: 태그를 지우고 엔티티를 푸는 함수(수집기가 넘긴다).
// 돌려주는 값은 { kind, title, content } 이고, 못 찾았거나 유료 기사이면 null 이다.
export function extractEmbeddedArticle(html, { titles = [], htmlToText } = {}) {
  if (!html || typeof htmlToText !== "function") return null;
  const wanted = titleVariants(titles);
  if (!wanted.length) return null;
  const arc = arcGlobalContent(html);
  // 유료·가입 기사이면 다른 형식도 보지 않는다. JSON-LD 나 RSC 에 같은 글이 실려 있어도 발행사가 막아 둔 글이다.
  if (arc && arcRestricted(arc)) return null;
  return (arc && arcArticle(arc, wanted, htmlToText)) || jsonLdArticle(html, wanted, htmlToText) ||
    rscArticle(html, wanted, htmlToText);
}
