import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadArticleDocument, sniffDocumentType } from '../scripts/collect_company_signals.mjs';

// 2026-09 수집본에서 Nabtesco 보도자료 5건과 Renishaw 실적 자료 2건이 PDF 였는데도 추출기를 타지
// 못했다. 주소에 .pdf 가 없고 content-type 도 PDF 라고 말하지 않아 response.text() 로 내려갔고,
// 본문 자리에 "%PDF-1.6" 바이트가 그대로 실려 모델에게 근거로 넘어갔다. 종류는 바이트가 말한다.

// 압축하지 않은 최소 PDF. 바이너리 픽스처를 두지 않으려고 여기서 짓는다. pdfplumber 가 읽는다.
function minimalPdf(line) {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const respondWith = (body, contentType, url) => async () => {
  const response = new Response(body, { headers: { 'content-type': contentType } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

test('the document type comes from the bytes, not from the header or the URL', () => {
  const bytes = value => Buffer.from(value, 'latin1');
  assert.equal(sniffDocumentType(bytes('%PDF-1.6\r%\xe2\xe3\xcf\xd3')), 'pdf');
  assert.equal(sniffDocumentType(bytes('PK\x03\x04\x14\x00\x06\x00[Content_Types].xml')), 'zip');
  assert.equal(sniffDocumentType(bytes('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')), 'ole');
  assert.equal(sniffDocumentType(bytes('\x89PNG\r\n\x1a\n')), 'png');
  // 기사 본문은 그대로 글로 읽는다. BOM 이 붙은 문서도 글이다.
  for (const page of ['<!DOCTYPE html><html><body>Nabtesco reported', '{"title":"results"}', '﻿<html>']) {
    assert.equal(sniffDocumentType(Buffer.from(page, 'utf8')), 'text', page.slice(0, 20));
  }
});

test('a PDF served without a PDF header or a .pdf URL still reaches the extractor', async t => {
  const url = 'https://www.nabtesco.com/en/news/20260814-18378/';
  const pdf = minimalPdf('Orders for precision reduction gears rose 11 percent');
  assert.equal(sniffDocumentType(pdf), 'pdf');
  let document;
  try {
    document = await downloadArticleDocument(url, 30, respondWith(pdf, 'text/html; charset=utf-8', url));
  } catch (error) {
    // 추출기는 python 과 pdfplumber 를 쓴다. 없는 환경에서는 조용히 통과시키지 않고 건너뛴 것을 남긴다.
    t.skip(`PDF extractor unavailable: ${error.message}`);
    return;
  }
  assert.equal(document.html, '');
  assert.match(document.content, /precision reduction gears/);
  // 바이트가 본문으로 실리지 않는다.
  assert.doesNotMatch(document.content, /%PDF/);
});

test('a spreadsheet is kept as a row with an empty body and a stated reason', async () => {
  const url = 'https://www.emdgroup.com/financial-statement';
  const xlsx = Buffer.from('PK\x03\x04\x14\x00\x06\x00[Content_Types].xml', 'latin1');
  const document = await downloadArticleDocument(url, 30, respondWith(xlsx, 'application/octet-stream', url));
  // 근거로 올리지 않되 행은 살린다. 무엇을 고쳐야 하는지 알 수 있게 종류를 남긴다.
  assert.equal(document.content, '');
  assert.equal(document.documentType, 'zip');
});

test('an ordinary HTML page is decoded exactly as before', async () => {
  const page = '<html><head><title>Nabtesco</title></head><body>주문이 11% 늘었음</body></html>';
  const url = 'https://www.nabtesco.com/en/news/1/';
  const document = await downloadArticleDocument(url, 30,
    respondWith(Buffer.from(page, 'utf8'), 'text/html; charset=utf-8', url));
  assert.equal(document.html, page);
  assert.equal(document.documentType, undefined);
});
