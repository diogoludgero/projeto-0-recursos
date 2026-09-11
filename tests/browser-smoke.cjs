// Requer Playwright. Executar com NODE_PATH apontado para os pacotes do runtime.
// O servidor só escuta em loopback. Todas as chamadas ao Supabase são intercetadas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const current = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Referência fixa da versão anterior, disponível na história remota do projeto.
// HEAD passa a conter as correções depois do commit e não serve como baseline.
const baselineRef = process.env.CIVIL_BASELINE_REF || '8846dd0d57942158d77b66986194fde0a6c1f3da';
const original = execFileSync('git', ['show', baselineRef + ':index.html'], { cwd: root, encoding: 'utf8' });
const supabaseOrigin = new URL(current.match(/const SUPABASE_URL = "([^"]+)"/)[1]).origin;
const admin = { id: 'browser_test_admin', username: 'browser_test', password: 'test-only', name: 'Administrador de teste', role: 'admin', is_student: true };
const subject = { id: 'browser_subject', name: 'Cadeira de teste', professors: [], tests: [], max_absences_theory: 4, max_absences_practice: 3 };
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
const fixtures = () => ({ subjects: [subject], users: [admin], files: [
  { id: 'browser_file_1', title: 'Exame de teste', subject_id: subject.id, file_name: 'exame.pdf', data_url: pdf },
  { id: 'browser_file_2', title: 'Ficha de teste', subject_id: subject.id, file_name: 'ficha.pdf', data_url: pdf }
], file_requests: [], student_grades: [], student_enrolled: [], student_absences: [] });

async function waitUntil(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test condition timed out');
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/baseline' || req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/baseline' ? original : current);
    } else if (['/logo.png', '/favicon.png', '/favicon.svg'].includes(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
      res.end(fs.readFileSync(path.join(root, req.url.slice(1))));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.CIVIL_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await chromium.launch({ executablePath, headless: true });
  const output = process.env.CIVIL_TEST_OUTPUT || path.join(require('node:os').tmpdir(), 'civil67-audit-screenshots');
  fs.mkdirSync(output, { recursive: true });
  const pageErrors = [];
  const warnings = new Set();
  async function contextFor(db, viewport, signedIn = true) {
    const context = await browser.newContext({ viewport });
    await context.routeWebSocket('**', socket => socket.close());
    await context.route(supabaseOrigin + '/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const table = url.pathname.split('/')[3];
      if (!url.pathname.startsWith('/rest/v1/') || !Array.isArray(db[table])) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Blocked by isolated test"}' });
        return;
      }
      const matches = row => [...url.searchParams].every(([key, value]) => !value.startsWith('eq.') || String(row[key]) === value.slice(3));
      let result = db[table].filter(matches);
      if (request.method() === 'DELETE') {
        if (db.denyDelete) result = [];
        else db[table] = db[table].filter(row => !matches(row));
      } else if (request.method() === 'POST') {
        const row = request.postDataJSON();
        const rows = Array.isArray(row) ? row : [row];
        db[table].push(...rows);
        result = rows;
      } else if (request.method() !== 'GET') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Unexpected test mutation"}' });
        return;
      }
      const order = url.searchParams.get('order');
      if (order) result.sort((a, b) => String(a[order.split('.')[0]]).localeCompare(String(b[order.split('.')[0]])));
      const offset = Number(url.searchParams.get('offset') || 0);
      result = result.slice(offset, offset + Number(url.searchParams.get('limit') || result.length));
      const columns = url.searchParams.get('select');
      if (columns && columns !== '*') result = result.map(row => Object.fromEntries(columns.split(',').map(column => [column, row[column]])));
      const single = request.headers().accept?.includes('vnd.pgrst.object');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(single ? result[0] : result) });
    });
    if (signedIn) await context.addInitScript(({ admin, subject }) => {
      if (localStorage.getItem('test_initialized')) return;
      localStorage.setItem('test_initialized', 'true');
      localStorage.setItem('study_current_user', JSON.stringify(admin));
      localStorage.setItem('study_users', JSON.stringify([admin]));
      localStorage.setItem('study_subjects', JSON.stringify([{ ...subject, maxAbsencesTheory: 4, maxAbsencesPractice: 3 }]));
      localStorage.setItem('study_active_tab', 'files');
    }, { admin, subject });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'warning') warnings.add(message.text()); });
    page.on('dialog', dialog => dialog.accept());
    return { context, page };
  }
  try {
    assert.ok(original.split('  <script>')[0].replace(/\r\n/g, '\n') === current.split('  <script>')[0].replace(/\r\n/g, '\n'), 'HTML e CSS estáticos devem permanecer iguais');
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const shots = [];
      for (const version of ['baseline', 'corrected']) {
        const db = fixtures();
        const { context, page } = await contextFor(db, viewport);
        await page.goto(base + (version === 'baseline' ? '/baseline' : '/'));
        await page.waitForFunction(() => typeof state !== 'undefined' && state.files.some(file => file.id === 'browser_file_1'));
        await page.getByText('Exame de teste', { exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.locator('#toast').evaluate(element => element.classList.add('hidden'));
        const screenshot = await page.screenshot({ path: path.join(output, name + '-' + version + '.png'), fullPage: true, animations: 'disabled' });
        shots.push(screenshot);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': sem overflow horizontal');
        await context.close();
      }
      console.log(name + ': capturas antes/depois guardadas; PNG idêntico = ' + shots[0].equals(shots[1]));
    }
    const db = fixtures();
    const { context, page } = await contextFor(db, { width: 1440, height: 1000 });
    await page.goto(base);
    await page.getByText('Exame de teste', { exact: true }).waitFor();
    await page.getByTitle('Eliminar documento', { exact: true }).first().click();
    await page.waitForFunction(() => state.files.length === 1);
    assert.equal(db.files.length, 1);
    await page.reload();
    await page.waitForFunction(() => state.files.length === 1 && isCloudConnected);
    await page.getByTitle('Eliminar documento', { exact: true }).click();
    await page.waitForFunction(() => state.files.length === 0);
    await page.reload();
    await page.waitForFunction(() => state.files.length === 0 && isCloudConnected);
    assert.equal(db.files.length, 0);
    console.log('UI: DELETE do último ficheiro persiste após atualização.');

    await page.locator('#file-subject-select').selectOption(subject.id);
    await page.locator('#file-title').fill('Documento carregado em teste');
    await page.locator('#file-input').setInputFiles({ name: 'teste.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
    await page.locator('#admin-files-panel button[type="submit"]').click();
    await page.getByText('Documento carregado em teste', { exact: true }).waitFor();
    assert.equal(db.files.length, 1);
    db.denyDelete = true;
    await page.getByTitle('Eliminar documento', { exact: true }).click();
    await page.getByText(/Nenhum registo eliminado/).waitFor();
    assert.equal(await page.getByText('Documento carregado em teste', { exact: true }).count(), 1);
    console.log('UI: upload confirmado e DELETE sem permissão não escondem o documento.');
    await context.close();

    const empty = fixtures();
    empty.files = [];
    empty.subjects = [];
    const old = await contextFor(empty, { width: 1440, height: 1000 }, false);
    await old.page.goto(base + '/baseline');
    await waitUntil(() => empty.files.length === 2);
    assert.deepEqual(empty.files.map(file => file.id).sort(), ['file_demo_1', 'file_demo_2']);
    await old.context.close();
    console.log('Causa reproduzida no código original: navegador novo recriou os dois demos na base simulada.');
    empty.files = [];
    empty.subjects = [];
    const fresh = await contextFor(empty, { width: 1440, height: 1000 }, false);
    await fresh.page.goto(base);
    await fresh.page.waitForFunction(() => isCloudConnected && state.subjects.length === 0);
    assert.equal(empty.files.length, 0);
    assert.equal(empty.subjects.length, 0);
    await fresh.context.close();
    assert.deepEqual(pageErrors, []);
    console.log('Código corrigido: navegador novo mantém tabelas vazias. Erros JavaScript: 0.');
    console.log('Avisos de consola: ' + JSON.stringify([...warnings]));
    console.log('Capturas: ' + output);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
