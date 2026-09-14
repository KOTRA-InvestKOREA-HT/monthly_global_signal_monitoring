import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBetterTitle, dateEvidence, extractDateFromText, isUsableTitle } from '../scripts/collect_company_signals.mjs';

const company = { company: 'Umicore', query_aliases: [] };

test('link labels and site greetings are not article titles', () => {
  for (const title of ['English version', 'Download the document', 'Download the video transcript',
    '11 MB (PDF)', 'PDF&nbsp;3.29 MB', 'PDF 3.29 MB', 'Welcome to Mkango Resources Ltd.']) {
    assert.equal(isUsableTitle(title, company), false, title);
  }
  assert.equal(isUsableTitle('Umicore breaks ground on cathode plant in Ontario', company), true);
});

test('a label title on a document without a page title takes the file name', () => {
  assert.equal(chooseBetterTitle('English version', '',
    'https://www.umicore.com/storage/umicore/umicore-integrated-annual-report-2022.pdf', company),
  'umicore integrated annual report 2022');
  // A site-wide og:title never replaces a usable link title.
  assert.equal(chooseBetterTitle('Mkango completes acquisition of Remloy', 'Welcome to Mkango Resources Ltd.',
    'https://mkango.ca/news/mkango-completes-acquisition-of-remloy/', { company: 'HyproMag', query_aliases: [] }),
  'Mkango completes acquisition of Remloy');
  // A usable link title is kept when the document has no title.
  assert.equal(chooseBetterTitle('H1 2026 activity report', '', 'https://example.com/files/x.pdf', company),
    'H1 2026 activity report');
});

test('European hyphenated dates are read day first, ISO dates are unchanged', () => {
  assert.equal(extractDateFromText('1-04-2026 | Press release Prodrive Technologies announces 2025 results').slice(0, 10), '2026-04-01');
  assert.equal(extractDateFromText('23-09-2025 | Press release Change in executive management').slice(0, 10), '2025-09-23');
  assert.equal(extractDateFromText('Published 2026-08-14 in Tokyo').slice(0, 10), '2026-08-14');
  assert.equal(extractDateFromText('SEC filing 0001627223-26-000027'), null);
});

test('zone-less dates are read as written in UTC, whatever the machine time zone', () => {
  // Albemarle JSON-LD datePublished; a KST machine used to read it as 2026-08-04T15:00:00Z.
  assert.equal(dateEvidence('08/05/26', 'jsonld').date, '2026-08-05T00:00:00Z');
  assert.equal(dateEvidence('2026-08-05T12:15:00', 'meta').date, '2026-08-05T12:15:00Z');
  assert.equal(dateEvidence('2026-08-05', 'meta').date, '2026-08-05T00:00:00Z');
  assert.equal(dateEvidence('2026-08-05T12:15:00-04:00', 'meta').date, '2026-08-05T16:15:00Z');
  assert.equal(dateEvidence('Wed, 05 Aug 2026 16:00:00 GMT', 'feed').date, '2026-08-05T16:00:00Z');
});

test('US zone abbreviations in feed dates keep their zone', () => {
  assert.equal(dateEvidence('Wed, 05 Aug 2026 16:00:00 EST', 'feed').date, '2026-08-05T21:00:00Z');
  assert.equal(dateEvidence('Wed, 05 Aug 2026 22:30:00 PDT', 'feed').date, '2026-08-06T05:30:00Z');
});
