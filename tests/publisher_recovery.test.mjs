import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aemModelUrl,
  extractQualcommAemArticle,
  fetchedTitleMatchesPublisherArticle,
  matchOfficialPublisherArticle,
  publisherArticleTitle,
  publisherRecoveryCandidate,
  recoverPublisherRow,
} from '../scripts/publisher_recovery.mjs';

const config = { official_pages: {
  Qualcomm: [{ url: 'https://www.qualcomm.com/news/releases', domain: 'www.qualcomm.com' }],
  Airbus: [{ url: 'https://www.airbus.com/en/newsroom', domain: 'www.airbus.com' }],
} };
const relay = 'https://news.google.com/rss/articles/opaque?oc=5';
const fallback = {
  company: 'Qualcomm', source_type: 'fallback', url: relay,
  title: 'Qualcomm opens robotics center - Qualcomm', publisher: 'Qualcomm',
  publisher_home_url: 'https://www.qualcomm.com/', published_at: '2026-08-25',
  published_at_source: 'feed', date_confidence: 'high',
};
const official = {
  company: 'Qualcomm', title: 'Qualcomm opens robotics center',
  url: 'https://www.qualcomm.com/news/releases/2026/08/robotics-center',
  source_page_url: 'https://www.qualcomm.com/news/releases',
};

test('publisher suffix is removed only when it exactly terminates the RSS title', () => {
  assert.equal(publisherArticleTitle(fallback), 'Qualcomm opens robotics center');
  assert.equal(publisherArticleTitle({ ...fallback, title: 'Qualcomm - Qualcomm update' }),
    'Qualcomm - Qualcomm update');
});

test('same-company configured publisher domain and exact title resolve the direct URL', () => {
  assert.deepEqual(publisherRecoveryCandidate(fallback, config), {
    company: 'Qualcomm', title: 'Qualcomm opens robotics center', publisher_host: 'qualcomm.com',
  });
  assert.equal(matchOfficialPublisherArticle(fallback, [official], config).direct_url, official.url);
});

test('wrong company, wrong title, and unconfigured article domain never match', () => {
  assert.equal(matchOfficialPublisherArticle(fallback, [{ ...official, company: 'Airbus' }], config), null);
  assert.equal(matchOfficialPublisherArticle(fallback, [{ ...official, title: 'Another article' }], config), null);
  assert.equal(matchOfficialPublisherArticle(fallback,
    [{ ...official, url: 'https://attacker.example/news/releases/robotics-center' }], config), null);
  assert.equal(publisherRecoveryCandidate({ ...fallback, publisher_home_url: 'https://attacker.example/' }, config), null);
});

test('a recurring exact headline with distinct official URLs is ambiguous', () => {
  const other = { ...official, url: 'https://www.qualcomm.com/news/releases/2025/08/robotics-center' };
  assert.equal(matchOfficialPublisherArticle(fallback, [official, other], config), null);
  // Repeated extraction of the same anchor remains one unambiguous match.
  assert.equal(matchOfficialPublisherArticle(fallback, [official, { ...official }], config).direct_url, official.url);
});

test('the fetched detail headline must still identify the same article', () => {
  assert.equal(fetchedTitleMatchesPublisherArticle(fallback, 'Qualcomm opens robotics center | Qualcomm'), true);
  assert.equal(fetchedTitleMatchesPublisherArticle(fallback, 'Qualcomm opens robotics center'), true);
  assert.equal(fetchedTitleMatchesPublisherArticle(fallback, 'Qualcomm Newsroom | Qualcomm'), false);
  assert.equal(fetchedTitleMatchesPublisherArticle(fallback, 'Another article - Qualcomm'), false);
});

test('same-path AEM model content is accepted only with the expected headline', () => {
  assert.equal(aemModelUrl(`${official.url}?campaign=x`), `${official.url}.model.json?campaign=x`);
  assert.equal(aemModelUrl('javascript:alert(1)'), '');
  const model = {
    title: 'Qualcomm opens robotics center',
    ':items': { root: { ':items': { responsivegrid: { ':items': {
      mediarte: { ':type': 'qcomm/components/mediarte/v1/mediarte', qcommRTE: { text: '<p>Official body evidence.</p>' } },
      footer: { qcommRTE: { text: '<p>Decoy footer and related article.</p>' } },
    } } } } },
  };
  const htmlToText = html => html.replace(/<[^>]+>/g, '');
  assert.deepEqual(extractQualcommAemArticle(fallback, model, htmlToText), {
    title: model.title, content: 'Official body evidence.',
  });
  assert.equal(extractQualcommAemArticle(fallback, { ...model, title: 'Qualcomm newsroom' }, htmlToText), null);
});

test('non-HTTP URLs and a source page outside configured official hosts are rejected', () => {
  assert.equal(matchOfficialPublisherArticle(fallback, [{ ...official, url: 'javascript:alert(1)' }], config), null);
  assert.equal(matchOfficialPublisherArticle(fallback,
    [{ ...official, source_page_url: 'https://search.example/result' }], config), null);
  assert.equal(publisherRecoveryCandidate({ ...fallback, publisher_home_url: 'ftp://qualcomm.com/' }, config), null);
});

test('resolution preserves discovery provenance and does not promote date trust', () => {
  const recovered = recoverPublisherRow(fallback, [official], config);
  assert.equal(recovered.url, relay);
  assert.equal(recovered.source_direct_url, official.url);
  assert.equal(recovered.publisher_resolution_source_url, official.source_page_url);
  assert.equal(recovered.publisher_resolution, 'official_exact_title');
  assert.equal(recovered.published_at, fallback.published_at);
  assert.equal(recovered.published_at_source, fallback.published_at_source);
  assert.equal(recovered.date_confidence, fallback.date_confidence);
});
