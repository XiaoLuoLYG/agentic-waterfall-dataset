export function orderedEntries(entries, key, direction = 'desc', query = '', origin = 'all') {
  const compare = (a, b) => {
    const x = a.metrics[key], y = b.metrics[key];
    if (x == null) return y == null ? a.method.localeCompare(b.method) : 1;
    if (y == null) return -1;
    return y - x || a.method.localeCompare(b.method);
  };
  const ranked = [...entries].sort(compare).map((entry, i, all) => ({
    ...entry,
    rank: entry.metrics[key] == null ? null : all.findIndex(e => e.metrics[key] === entry.metrics[key]) + 1,
  }));
  if (direction === 'asc') ranked.sort((a, b) => {
    if (a.metrics[key] == null || b.metrics[key] == null) return compare(a, b);
    return a.metrics[key] - b.metrics[key] || a.method.localeCompare(b.method);
  });
  const needle = query.trim().toLocaleLowerCase();
  return ranked.filter(e => (origin === 'all' || e.origin === origin) && e.method.toLocaleLowerCase().includes(needle));
}

export function formatScore(value, column) {
  if (value == null) return 'Not reported';
  return column.total ? `${value}/${column.total}` : value.toFixed(column.digits);
}

export function csvTable(board, columns, entries) {
  const quote = value => {
    let text = String(value ?? '');
    // Spreadsheet applications execute formula-prefixed cells even inside quotes.
    if (/^[\s]*[=+@-]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const lines = [['Method', 'Source', 'Protocol', ...columns.map(c => c.key), 'Evidence']];
  for (const entry of entries) {
    lines.push([entry.method, entry.origin, board.version, ...columns.map(c => entry.metrics[c.key]), entry.reproduction?.review ?? board.source]);
  }
  return lines.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

export async function mountLeaderboard() {
  const $ = id => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const link = (label, href) => {
    const a = el('a', label);
    if (new URL(href).protocol === 'https:') a.href = href;
    return a;
  };
  try {
    const response = await fetch(new URL('./results.json', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const params = new URLSearchParams(location.search);
    let board = data.boards.find(b => b.id === params.get('track')) ?? data.boards[0];
    let view = board.views[0], key = board.primary, direction = 'desc';

    function renderRows() {
      const columns = view.columns.map(name => board.columns.find(c => c.key === name));
      const entries = orderedEntries(board.entries, key, direction, $('search').value, $('origin').value);
      const header = el('tr');
      const ranked = board.group !== 'ablation' && !key.endsWith('sd');
      const rankHead = el('th', ranked ? '#' : '', 'rank');
      rankHead.scope = 'col'; header.append(rankHead);
      const methodHead = el('th', 'Method', 'method-head'); methodHead.scope = 'col'; header.append(methodHead);
      for (const column of columns) {
        const th = el('th'); th.scope = 'col';
        if (column.key === key) th.setAttribute('aria-sort', direction === 'desc' ? 'descending' : 'ascending');
        const button = el('button', `${column.label}${column.key === key ? (direction === 'desc' ? ' ↓' : ' ↑') : ''}`);
        button.type = 'button';
        button.addEventListener('click', () => {
          direction = key === column.key && direction === 'desc' ? 'asc' : 'desc'; key = column.key; renderRows();
          $('table-head').querySelector('[aria-sort] button')?.focus({ preventScroll: true });
        });
        th.append(button); header.append(th);
      }
      const sourceHead = el('th', 'Source'); sourceHead.scope = 'col'; header.append(sourceHead);
      $('table-head').replaceChildren(header);
      const body = document.createDocumentFragment();
      for (const entry of entries) {
        const row = el('tr');
        row.append(el('td', ranked ? (entry.rank ?? '') : '', 'rank'));
        const name = el('th'); name.scope = 'row';
        const details = el('details', null, 'method-details');
        details.append(el('summary', entry.method));
        const detail = el('div', null, 'entry-detail');
        detail.append(link(entry.origin === 'reference' ? 'Reported results ↗' : 'Review ↗', entry.reproduction?.review ?? board.source));
        if (entry.reproduction) {
          const r = entry.reproduction;
          detail.append(link('Code ↗', r.code), link('Outputs ↗', r.artifacts));
          for (const text of [`Revision ${r.revision}`, `${r.evaluated}/${r.expected} cases evaluated`, `Model & setup: ${r.configuration}`, `Run: ${r.command}`]) detail.append(el('p', text));
        } else detail.append(el('p', board.evidence));
        if (entry.notes) detail.append(el('p', entry.notes));
        details.append(detail); name.append(details); row.append(name);
        for (const column of columns) {
          const value = entry.metrics[column.key];
          const best = !column.key.endsWith('sd') && value != null && value === Math.max(...board.entries.map(e => e.metrics[column.key] ?? -Infinity));
          row.append(el('td', formatScore(value, column), best ? 'best' : ''));
        }
        const source = el('td');
        source.append(el('span', entry.origin === 'reference' ? 'Reference' : 'Community', `source-tag ${entry.origin}`));
        row.append(source); body.append(row);
      }
      $('table-body').replaceChildren(body);
      $('empty').hidden = entries.length !== 0;
      $('result-count').textContent = `${entries.length} of ${board.entries.length} results`;
      $('sort-note').textContent = `Sorted by ${columns.find(c => c.key === key).label} ${direction === 'desc' ? '↓' : '↑'}`;
      $('table-caption').textContent = `${board.title}, ${view.label}, ${board.version}`;
      $('download-csv').disabled = entries.length === 0;
      $('download-csv').onclick = () => {
        const url = URL.createObjectURL(new Blob([csvTable(board, columns, entries)], { type: 'text/csv;charset=utf-8' }));
        const anchor = el('a'); anchor.href = url; anchor.download = `waterfall-${board.id}-${view.id}.csv`;
        document.body.append(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    }

    function selectBoard(next) {
      board = next; view = board.views[0]; key = board.primary; direction = 'desc';
      const url = new URL(location.href); url.searchParams.set('track', board.id);
      history.replaceState(null, '', url);
      document.querySelectorAll('[data-group]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.group === board.group)));
      $('board-picker').replaceChildren(...data.boards.filter(b => b.group === board.group).map(b => {
        const button = el('button', b.title); button.type = 'button'; button.setAttribute('aria-pressed', String(b.id === board.id));
        button.addEventListener('click', () => {
          selectBoard(b); $('board-picker').querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
        });
        return button;
      }));
      $('board-picker').hidden = board.group === 'ablation';
      for (const [id, text] of Object.entries({ 'board-title': board.title, cohort: board.cohort, description: board.description, protocol: board.protocol, evidence: board.evidence, version: `Protocol ${board.version}` })) $(id).textContent = text;
      $('protocol-source').href = new URL(board.source).protocol === 'https:' ? board.source : '#leaderboard';
      $('view').replaceChildren(...board.views.map(v => { const option = el('option', v.label); option.value = v.id; return option; }));
      $('view-label').hidden = board.views.length < 2;
      renderRows();
    }
    document.querySelectorAll('[data-group]').forEach(button => button.addEventListener('click', () => selectBoard(data.boards.find(b => b.group === button.dataset.group))));
    $('search').addEventListener('input', renderRows);
    $('origin').addEventListener('change', renderRows);
    $('view').addEventListener('change', () => {
      view = board.views.find(v => v.id === $('view').value); key = view.columns[0]; direction = 'desc'; renderRows();
    });
    selectBoard(board);
  } catch (error) {
    $('description').textContent = 'The result table could not load.';
    $('load-error').hidden = false;
    $('load-error').textContent = 'Reload this page or open results.json directly. For a local preview, run python3 -m http.server 4198 --directory docs from the repository root and open http://localhost:4198.';
    console.error('Leaderboard load failed', error);
  }
}
