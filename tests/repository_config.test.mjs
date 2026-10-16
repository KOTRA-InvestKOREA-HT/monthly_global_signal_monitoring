import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// 저장소 설정(npm 스크립트, 런타임 버전, Python 의존성, CI)이 서로 어긋나지 않는지 본다.
const read = file => fs.readFile(file, 'utf8').then(text => text.replace(/\r\n/g, '\n'));

test('npm scripts run as written and never overwrite published outputs', async () => {
  const { scripts } = JSON.parse(await read('package.json'));
  // 운영 outputs/latest_* 와 public/reports PDF 를 덮어쓰던 레거시 스크립트.
  for (const name of ['report:pdf', 'filter:relevant', 'filter:investment', 'summarize:ai'])
    assert.equal(scripts[name], undefined, `${name} is back`);
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, /C:\/Users\/|public\/reports\/|outputs\/latest_/, `${name} names a personal path or a published file`);
    for (const match of command.matchAll(/\b(?:node|python3?)\s+(?:--[\w-]+\s+)*(scripts\/[\w.-]+\.(?:mjs|py))/g))
      await assert.doesNotReject(fs.access(match[1]), `${name} runs missing ${match[1]}`);
  }
  // 필수 인자 --pdf 를 넘기지 않아 늘 실패하던 스크립트. 저장소의 참고본을 쓴다.
  const pdf = scripts['validate:pdf'].match(/--pdf "([^"]+)"/)?.[1];
  assert.ok(pdf, 'validate:pdf passes --pdf');
  await assert.doesNotReject(fs.access(pdf));
  // 개인 PC 경로 대신 실행할 때 넘긴다: npm run build:technology-map -- --pdf "<path>".
  assert.doesNotMatch(scripts['build:technology-map'], /--pdf/);
});

test('local, CI and Vercel use the same Node and Python versions', async () => {
  const { engines } = JSON.parse(await read('package.json'));
  const node = (await read('.nvmrc')).trim();
  const python = (await read('.python-version')).trim();
  assert.equal(engines.node, `${node}.x`);
  for (const file of ['collect-company-signals.yml', 'publish-report.yml']) {
    const text = await read(`.github/workflows/${file}`);
    assert.match(text, new RegExp(`node-version: "${node}"`), file);
    assert.match(text, new RegExp(`python-version: "${python.replace('.', '\\.')}"`), file);
  }
  const ci = await read('.github/workflows/test.yml');
  assert.match(ci, /node-version-file: \.nvmrc/);
  assert.match(ci, /python-version-file: \.python-version/);
});

test('Python dependencies are pinned once, and the Vercel list stays inside the Actions list', async () => {
  const vercel = await read('requirements.txt');
  const actions = await read('requirements-python.txt');
  const pins = text => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('-r '));
  for (const line of [...pins(vercel), ...pins(actions)]) assert.match(line, /^[A-Za-z0-9_.-]+==[\w.]+$/, line);
  assert.match(actions, /^-r requirements\.txt$/m);
  const names = text => pins(text).map(line => line.split('==')[0].toLowerCase());
  const shared = names(actions).filter(name => names(vercel).includes(name));
  assert.deepEqual(shared, [], 'a package is pinned in both files');
  assert.ok(names(vercel).includes('reportlab'));
  assert.ok(names(actions).includes('pdfplumber'));
  // 요구사항 파일은 pip 가 지역 인코딩으로 읽을 수 있다. 한글 주석을 넣지 않는다.
  assert.doesNotMatch(vercel + actions, /[^\x00-\x7f]/);
});

test('CI runs both test suites', async () => {
  const ci = await read('.github/workflows/test.yml');
  assert.match(ci, /\n\s+pull_request:/);
  assert.match(ci, /run: python -m pip install -r requirements-python\.txt/);
  assert.match(ci, /run: node --test\n/);
  assert.match(ci, /run: python -m unittest discover tests\n/);
});
