// Executar: node --test tests/archive.test.cjs
// Sem rede: o JavaScript real da página usa um Supabase simulado em memória.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const clone = value => JSON.parse(JSON.stringify(value));
const fileRow = (id = 'file_test') => ({ id, title: 'Documento de teste', subject_id: 'sub_test', file_name: 'teste.pdf', data_url: 'data:application/pdf;base64,dGVzdA==' });
const requestRow = (id = 'request_test', owner = 'student_test') => ({ ...fileRow(id), student_id: owner, student_name: 'Aluno Teste', student_username: 'test' });
const subjectRow = { id: 'sub_test', name: 'Cadeira Teste', professors: [], tests: [], max_absences_theory: 4, max_absences_practice: 3 };
const admin = { id: 'admin_test', username: 'admin_test', role: 'admin' };
const student = { id: 'student_test', username: 'student_test', role: 'student' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function storage(seed = {}, failWrites = false) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (failWrites) throw new Error('QuotaExceededError');
      values.set(key, String(value));
    },
    removeItem: key => values.delete(key),
    values
  };
}

function database(seed = {}) {
  const rows = { subjects: [clone(subjectRow)], users: [], files: [], file_requests: [], student_grades: [], student_enrolled: [], student_absences: [], ...clone(seed) };
  const calls = [];
  const db = {
    rows, calls, hook: null,
    from(table) {
      const call = { table, operation: 'select', filters: [], columns: '*', start: 0, end: Infinity };
      const query = {
        select(columns) { call.columns = columns; return query; },
        delete() { call.operation = 'delete'; return query; },
        insert(value) { call.operation = 'insert'; call.value = clone(value); return query; },
        upsert(value) { call.operation = 'upsert'; call.value = clone(value); return query; },
        eq(column, value) { call.filters.push([column, value]); return query; },
        order(column) { call.order = column; return query; },
        range(start, end) { call.start = start; call.end = end; return query; },
        single() { call.single = true; return query; },
        then(resolve, reject) { return execute().then(resolve, reject); }
      };
      async function execute() {
        calls.push(clone(call));
        const matches = row => call.filters.every(([key, value]) => row[key] === value);
        let snapshot = clone(rows[table].filter(matches));
        if (call.order) snapshot.sort((a, b) => String(a[call.order]).localeCompare(String(b[call.order])));
        snapshot = snapshot.slice(call.start, call.end + 1);
        if (db.hook) {
          const result = await db.hook(call, snapshot);
          if (result) return result;
        }
        if (call.operation === 'delete') rows[table] = rows[table].filter(row => !matches(row));
        if (call.operation === 'insert') {
          if (rows[table].some(row => row.id === call.value.id || (table === 'users' && row.username === call.value.username))) return { data: null, error: { code: '23505' } };
          rows[table].push(clone(call.value));
          snapshot = [clone(call.value)];
        }
        if (call.operation === 'upsert') {
          const key = table.startsWith('student_') ? 'student_id' : 'id';
          rows[table] = rows[table].filter(row => row[key] !== call.value[key]);
          rows[table].push(clone(call.value));
          snapshot = [clone(call.value)];
        }
        if (call.columns !== '*') snapshot = snapshot.map(row => Object.fromEntries(call.columns.split(',').map(key => [key, row[key]])));
        return { data: call.single ? snapshot[0] : snapshot, error: null };
      }
      return query;
    }
  };
  return db;
}

function app(db, { seed = {}, quota = false, currentUser = admin, readFailure = false } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', innerHTML: '', textContent: '', files: [], options: [], children: [], disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(child) { this.children.push(child); },
      querySelectorAll() { return []; }, contains() { return false; }
    });
    return elements.get(id);
  }
  const notices = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, crypto, Blob, URL,
    localStorage: storage(seed, quota), sessionStorage: storage(),
    setTimeout() {}, clearTimeout() {}, confirm() { return true; },
    window: { addEventListener() {}, atob: value => Buffer.from(value, 'base64').toString('binary') },
    document: { getElementById: element, addEventListener() {}, querySelectorAll() { return []; }, createElement() { return element('created_' + elements.size); } },
    FileReader: class {
      readAsDataURL(file) {
        if (readFailure) { this.error = new Error('Read failed'); this.onerror(); }
        else { this.result = file.dataUrl; this.onload(); }
      }
    }
  });
  vm.runInContext(source, context);
  context.db = db;
  context.notices = notices;
  context.user = currentUser;
  vm.runInContext(`
    supabaseClient = db;
    state.currentUser = user;
    showToast = (message, type = 'success') => notices.push({ message, type });
    renderStudentsList = renderGrades = renderAbsences = updateSubjectSelects = () => {};
    renderArchiveTabs = () => {};
  `, context);
  return {
    context, elements, element, notices,
    run(code) { return vm.runInContext(code, context); },
    state() { return clone(vm.runInContext('state', context)); },
    async sync() { await vm.runInContext('fetchCloudState(true)', context); },
    async flush() {
      for (let index = 0; index < 20; index++) {
        await Promise.resolve();
        const promise = vm.runInContext('cloudRefreshPromise', context);
        if (promise) await promise;
      }
    }
  };
}

test('todo o JavaScript da página compila', () => { new vm.Script(source); });

test('um navegador novo respeita tabelas vazias e nunca insere demos', async () => {
  const db = database({ subjects: [] });
  const browser = app(db);
  assert.equal(browser.state().files.length, 0);
  await browser.sync();
  assert.deepEqual(browser.state().files, []);
  assert.deepEqual(browser.state().subjects, []);
  assert.ok(db.calls.every(call => call.operation === 'select'));
});

test('a cache antiga não volta a criar documentos eliminados', async () => {
  const db = database();
  const browser = app(db, { seed: { study_files: JSON.stringify([{ id: 'file_demo_1' }]) } });
  await browser.sync();
  assert.deepEqual(browser.state().files, []);
  assert.equal(db.rows.files.length, 0);
  assert.ok(db.calls.every(call => call.operation === 'select'));
});

test('DELETE remove registo e conteúdo e persiste após reload, login, deploy e outro navegador simulados', async () => {
  const db = database({ files: [fileRow(), fileRow('keep')] });
  const browser = app(db);
  await browser.sync();
  await browser.run("deleteFile('file_test')");
  await browser.flush();
  assert.deepEqual(db.rows.files.map(row => row.id), ['keep']);
  assert.equal(browser.notices.filter(notice => notice.message === 'Documento removido com sucesso.').length, 1);
  browser.run('state.currentUser = null');
  await browser.sync();
  browser.run('state.currentUser = user');
  await browser.sync();
  assert.deepEqual(browser.state().files.map(file => file.id), ['keep']);
  const cache = Object.fromEntries(browser.context.localStorage.values);
  for (const seed of [cache, cache, {}]) {
    const nextBrowser = app(db, { seed });
    await nextBrowser.sync();
    assert.deepEqual(nextBrowser.state().files.map(file => file.id), ['keep']);
  }
});

test('não remove o último ficheiro da interface antes da confirmação remota', async () => {
  const db = database({ files: [fileRow()] });
  const gate = deferred();
  const started = deferred();
  const browser = app(db);
  await browser.sync();
  db.hook = async call => { if (call.operation === 'delete') { started.resolve(); await gate.promise; } };
  const deletion = browser.run("deleteFile('file_test')");
  await started.promise;
  assert.equal(browser.state().files.length, 1);
  assert.equal(browser.notices.length, 0);
  gate.resolve();
  await deletion;
  await browser.flush();
  assert.deepEqual(browser.state().files, []);
  assert.deepEqual(db.rows.files, []);
  const fresh = app(db);
  await fresh.sync();
  assert.deepEqual(fresh.state().files, []);
});

for (const failure of ['rls', 'zero', 'network']) {
  test('DELETE com falha ' + failure + ' mantém o documento e não anuncia sucesso', async () => {
    const db = database({ files: [fileRow()] });
    const browser = app(db);
    await browser.sync();
    db.hook = async call => {
      if (call.operation !== 'delete') return;
      if (failure === 'network') throw new TypeError('Failed to fetch');
      return failure === 'zero' ? { data: [], error: null } : { data: null, error: { code: '42501' } };
    };
    await browser.run("deleteFile('file_test')");
    await browser.flush();
    assert.equal(db.rows.files.length, 1);
    assert.equal(browser.state().files.length, 1);
    assert.equal(browser.notices.length, 1);
    assert.equal(browser.notices[0].type, 'error');
  });
}

test('sem cliente Supabase a eliminação não é simulada localmente', async () => {
  const db = database({ files: [fileRow()] });
  const browser = app(db);
  await browser.sync();
  browser.run('supabaseClient = null');
  await browser.run("deleteFile('file_test')");
  assert.equal(browser.state().files.length, 1);
  assert.equal(browser.notices[0].type, 'error');
});

test('clique repetido faz apenas um DELETE', async () => {
  const db = database({ files: [fileRow()] });
  const browser = app(db);
  await browser.sync();
  const gate = deferred();
  const started = deferred();
  db.hook = async call => { if (call.operation === 'delete') { started.resolve(); await gate.promise; } };
  const first = browser.run("deleteFile('file_test')");
  await started.promise;
  await browser.run("deleteFile('file_test')");
  gate.resolve();
  await first;
  await browser.flush();
  assert.equal(db.calls.filter(call => call.operation === 'delete').length, 1);
});

test('uma resposta antiga recebida depois do DELETE não ressuscita ficheiros', async () => {
  const db = database({ files: [fileRow()] });
  const browser = app(db);
  await browser.sync();
  const gate = deferred();
  const started = deferred();
  let holdOnce = true;
  db.hook = async (call, snapshot) => {
    if (holdOnce && call.operation === 'select' && call.table === 'files') {
      holdOnce = false;
      started.resolve();
      await gate.promise;
      return { data: snapshot, error: null };
    }
  };
  const refresh = browser.sync();
  await started.promise;
  await browser.run("deleteFile('file_test')");
  assert.deepEqual(browser.state().files, []);
  gate.resolve();
  await refresh;
  await browser.flush();
  assert.deepEqual(browser.state().files, []);
  assert.deepEqual(db.rows.files, []);
});

test('cancelar pedido próprio envia DELETE com filtro de proprietário e persiste', async () => {
  const db = database({ file_requests: [requestRow(), requestRow('other', 'other_student')] });
  const browser = app(db, { currentUser: student });
  await browser.sync();
  await browser.run("cancelStudentFileRequest('request_test')");
  await browser.flush();
  assert.deepEqual(db.rows.file_requests.map(row => row.id), ['other']);
  assert.deepEqual(db.calls.find(call => call.operation === 'delete').filters, [['id', 'request_test'], ['student_id', 'student_test']]);
  await browser.run("cancelStudentFileRequest('other')");
  assert.equal(db.calls.filter(call => call.operation === 'delete').length, 1);
  const fresh = app(db, { currentUser: student });
  await fresh.sync();
  assert.equal(fresh.state().fileRequests.some(row => row.id === 'request_test'), false);
});

test('recusa administrativa só remove pedidos após DELETE confirmado', async () => {
  const db = database({ file_requests: [requestRow()] });
  const browser = app(db);
  await browser.sync();
  db.hook = async call => call.operation === 'delete' ? { data: [], error: null } : undefined;
  await browser.run("rejectFileRequest('request_test')");
  await browser.flush();
  assert.equal(browser.state().fileRequests.length, 1);
  db.hook = null;
  await browser.run("rejectFileRequest('request_test')");
  await browser.flush();
  assert.equal(browser.state().fileRequests.length, 0);
});

test('aluno não chama DELETE de ficheiros publicados', async () => {
  const db = database({ files: [fileRow()] });
  const browser = app(db, { currentUser: student });
  await browser.sync();
  await browser.run("deleteFile('file_test')");
  assert.equal(db.calls.filter(call => call.operation === 'delete').length, 0);
});

for (const user of [admin, student]) {
  test('upload confirmado para ' + user.role + ' sem duplicação por Realtime', async () => {
    const db = database();
    const browser = app(db, { currentUser: user });
    await browser.sync();
    browser.element('file-subject-select').value = 'sub_test';
    browser.element('file-title').value = 'Teste de upload';
    browser.element('file-input').files = [{ name: 'teste.pdf', size: 100, dataUrl: fileRow().data_url }];
    const button = { disabled: false };
    browser.context.event = { preventDefault() {}, submitter: button };
    const gate = deferred();
    const started = deferred();
    db.hook = async call => { if (call.operation === 'insert') { started.resolve(); await gate.promise; } };
    const upload = browser.run('uploadFile(event)');
    await started.promise;
    await browser.run('uploadFile(event)');
    await browser.sync();
    assert.equal(browser.notices.length, 0);
    assert.equal(button.disabled, true);
    gate.resolve();
    await upload;
    await browser.flush();
    const table = user.role === 'admin' ? 'files' : 'file_requests';
    const stateKey = user.role === 'admin' ? 'files' : 'fileRequests';
    assert.equal(db.rows[table].length, 1);
    assert.equal(browser.state()[stateKey].length, 1);
    assert.equal(button.disabled, false);
    assert.equal(browser.element('file-title').value, '');
    assert.equal(browser.notices[0].type, 'success');
  });
}

for (const failure of ['insert', 'read']) {
  test('upload com falha ' + failure + ' preserva formulário e não anuncia sucesso', async () => {
    const db = database();
    const browser = app(db, { readFailure: failure === 'read' });
    await browser.sync();
    browser.element('file-subject-select').value = 'sub_test';
    browser.element('file-title').value = 'Manter este título';
    browser.element('file-input').files = [{ name: 'teste.pdf', size: 100, dataUrl: fileRow().data_url }];
    db.hook = async call => call.operation === 'insert' ? { data: null, error: { code: '42501' } } : undefined;
    browser.context.event = { preventDefault() {}, submitter: { disabled: false } };
    await browser.run('uploadFile(event)');
    await browser.flush();
    assert.equal(browser.element('file-title').value, 'Manter este título');
    assert.equal(browser.state().files.length, 0);
    assert.equal(db.rows.files.length, 0);
    assert.equal(browser.notices[0].type, 'error');
    assert.equal(browser.context.event.submitter.disabled, false);
  });
}

test('JSON inválido e quota de cache não impedem arranque, sincronização ou DELETE', async () => {
  const db = database({ files: [fileRow()] });
  const seed = { study_files: '{broken', study_users: '{}', study_subjects: '[null]', study_grades: '[]' };
  const browser = app(db, { seed, quota: true });
  await browser.sync();
  assert.equal(browser.state().files.length, 1);
  await browser.run("deleteFile('file_test')");
  await browser.flush();
  assert.equal(db.rows.files.length, 0);
  assert.equal(browser.state().files.length, 0);
  assert.equal(browser.notices.at(-1).type, 'success');
});

test('listas com mais de 1000 registos são lidas com paginação', async () => {
  const db = database({ files: Array.from({ length: 1201 }, (_, index) => fileRow('file_' + String(index).padStart(4, '0'))) });
  const browser = app(db);
  await browser.sync();
  assert.equal(browser.state().files.length, 1201);
  assert.equal(db.calls.filter(call => call.table === 'files').length, 3);
});

test('falha numa leitura não aplica um estado parcial nem anuncia sincronização bem-sucedida', async () => {
  const db = database({ files: [fileRow()] });
  const browser = app(db);
  await browser.sync();
  db.rows.files = [];
  db.hook = async call => call.table === 'file_requests' ? { data: null, error: { code: '42501' } } : undefined;
  await browser.sync();
  assert.equal(browser.state().files.length, 1);
  assert.equal(browser.run('isCloudConnected'), false);
  assert.equal(browser.notices.at(-1).type, 'error');
});

test('títulos e IDs do arquivo são escapados como texto e argumentos', async () => {
  const db = database({ files: [{ ...fileRow("x');alert(1);//"), title: '<img src=x onerror=alert(1)>', file_name: '" onmouseover="alert(1)' }] });
  const browser = app(db);
  await browser.sync();
  const card = browser.element('files-container').children.at(-1).innerHTML;
  assert.ok(card.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(card.includes('<img src=x'), false);
  assert.ok(card.includes('openPdfFile(&quot;x&#39;);alert(1);//&quot;)'));
});

for (const mode of ['register', 'admin']) {
  test('criação ' + mode + ' com cache antiga nunca apaga uma conta existente', async () => {
    const existing = { id: 'existing_id', username: 'existing_test', role: 'student' };
    const db = database({ users: [existing] });
    const browser = app(db);
    browser.run('applyUserSession = openEnrolledModal = closeAdminCreateStudentModal = () => {}');
    const prefix = mode === 'register' ? 'reg' : 'admin-new-student';
    browser.element(prefix + '-username').value = existing.username;
    browser.element(prefix + '-password').value = 'test-only';
    browser.element(prefix + '-name').value = 'Aluno de teste';
    browser.context.event = { preventDefault() {} };
    await browser.run(mode === 'register' ? 'handleRegister(event)' : 'handleAdminCreateStudent(event)');
    assert.deepEqual(db.rows.users, [existing]);
    assert.equal(db.calls.filter(call => call.operation === 'delete').length, 0);
    assert.equal(browser.state().users.some(user => user.username === existing.username), false);
    assert.equal(browser.notices.at(-1).type, 'error');
  });

  test('criação ' + mode + ' espera confirmação antes de criar sessão/estado local', async () => {
    const db = database();
    const browser = app(db);
    browser.run('applyUserSession = openEnrolledModal = closeAdminCreateStudentModal = () => {}');
    const prefix = mode === 'register' ? 'reg' : 'admin-new-student';
    browser.element(prefix + '-username').value = 'new_test';
    browser.element(prefix + '-password').value = 'test-only';
    browser.element(prefix + '-name').value = 'Aluno de teste';
    browser.context.event = { preventDefault() {} };
    const gate = deferred();
    const started = deferred();
    db.hook = async call => { if (call.operation === 'insert') { started.resolve(); await gate.promise; } };
    const creation = browser.run(mode === 'register' ? 'handleRegister(event)' : 'handleAdminCreateStudent(event)');
    await started.promise;
    assert.equal(browser.state().users.some(user => user.username === 'new_test'), false);
    assert.equal(browser.notices.length, 0);
    gate.resolve();
    await creation;
    assert.equal(db.rows.users.length, 1);
    assert.equal(browser.state().users.filter(user => user.username === 'new_test').length, 1);
    assert.equal(browser.notices.at(-1).type, 'success');
  });
}

for (const denied of [false, true]) {
  test('criação administrativa distingue conta criada e inscrições ' + (denied ? 'recusadas' : 'confirmadas'), async () => {
    const db = database();
    const browser = app(db);
    browser.run('closeAdminCreateStudentModal = () => {}');
    browser.element('admin-new-student-username').value = 'new_enrolled';
    browser.element('admin-new-student-password').value = 'test-only';
    browser.element('admin-new-student-name').value = 'Aluno de teste';
    browser.context.document.querySelectorAll = () => [{ value: 'sub_test' }];
    browser.context.event = { preventDefault() {} };
    if (denied) db.hook = async call => call.operation === 'upsert' ? { data: null, error: { code: '42501' } } : undefined;
    await browser.run('handleAdminCreateStudent(event)');
    assert.equal(db.rows.users.length, 1);
    const userId = db.rows.users[0].id;
    assert.deepEqual(browser.state().enrolledSubjects[userId], denied ? [] : ['sub_test']);
    assert.equal(db.rows.student_enrolled.length, denied ? 0 : 1);
    assert.equal(browser.notices.at(-1).type, denied ? 'error' : 'success');
    if (denied) assert.ok(browser.notices.at(-1).message.startsWith('Conta criada, mas'));
  });
}
