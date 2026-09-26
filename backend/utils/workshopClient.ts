/**
 * Browser-side script for the /db table page ("The Workshop"): list views,
 * column resize/reorder/visibility, sort, search, field filters and export.
 *
 * Shipped as a string and inlined by routes/dbRoutes.ts. It reads everything it
 * needs from the <script type="application/json" id="workshop-config"> block, so
 * no server values are spliced into the code itself. String.raw keeps the
 * backslashes in the regexes and escapes intact — which means this source must
 * not contain a backtick or a dollar-brace, since either would end or
 * interpolate the template.
 *
 * Cells are always filled with textContent: row values are user-typed data and
 * this page runs with an admin token in its URL.
 */
export const workshopClientJs = String.raw`
(function () {
  'use strict';

  var CFG = JSON.parse(document.getElementById('workshop-config').textContent);
  var TOKEN = CFG.token;
  var COLL = CFG.collection;
  var ROWS = CFG.rows;
  var DATA_KEYS = CFG.keys;
  var SENSITIVE = CFG.sensitive;
  var CAN_RESET = CFG.canReset;
  var ACTIONS_WIDTH = CAN_RESET ? 250 : 150;
  var FILTER_OPS = [
    ['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'equals'],
    ['not_equals', 'does not equal'], ['starts', 'starts with'], ['empty', 'is empty'],
    ['not_empty', 'is not empty'], ['gt', 'greater than'], ['lt', 'less than']
  ];
  var NO_VALUE_OPS = { empty: true, not_empty: true };

  var $ = function (id) { return document.getElementById(id); };
  var table = $('data-table');
  var thead = table.tHead;
  var tbody = table.tBodies[0];
  var colgroup = $('data-colgroup');

  // ── Row text, computed once ─────────────────────────────────────────────
  function text(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  var ROW_TEXT = ROWS.map(function (r) {
    var o = {};
    DATA_KEYS.forEach(function (k) { o[k] = text(r[k]); });
    return o;
  });

  // ── View state ──────────────────────────────────────────────────────────
  // state is exactly what a saved view stores. Column widths the page measured
  // itself live in autoWidths instead, so opening a view never marks it dirty.
  function baseState() {
    return {
      columns: DATA_KEYS.map(function (k) { return { key: k, width: null, hidden: false }; }),
      sort: [], search: '', filters: []
    };
  }
  function normalize(cfg) {
    cfg = cfg || {};
    var s = { columns: [], sort: [], search: cfg.search || '', filters: [] };
    var seen = {};
    (cfg.columns || []).forEach(function (c) {
      if (DATA_KEYS.indexOf(c.key) === -1 || seen[c.key]) return;
      seen[c.key] = true;
      s.columns.push({ key: c.key, width: c.width || null, hidden: !!c.hidden });
    });
    // Fields added to the table since the view was saved show up at the end.
    DATA_KEYS.forEach(function (k) { if (!seen[k]) s.columns.push({ key: k, width: null, hidden: false }); });
    (cfg.sort || []).forEach(function (x) {
      if (DATA_KEYS.indexOf(x.key) !== -1) s.sort.push({ key: x.key, order: x.order === 'desc' ? 'desc' : 'asc' });
    });
    (cfg.filters || []).forEach(function (f) {
      if (DATA_KEYS.indexOf(f.key) !== -1) s.filters.push({ key: f.key, op: f.op, value: f.value || '' });
    });
    return s;
  }

  var state = baseState();
  var autoWidths = {};
  var views = [];
  var activeView = null;          // null = "All records"
  var savedJson = JSON.stringify(state);
  var current = [];               // row indices after filter + sort

  function snapshot() { return JSON.stringify(state); }
  function isDirty() { return snapshot() !== savedJson; }
  function visibleCols() { return state.columns.filter(function (c) { return !c.hidden; }); }
  function colByKey(key) { return state.columns.find(function (c) { return c.key === key; }); }
  function widthOf(c) { return c.width || autoWidths[c.key] || 160; }

  // ── Filter + sort ───────────────────────────────────────────────────────
  var ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
  function compare(a, b) {
    var na = Number(a), nb = Number(b);
    if (a !== '' && b !== '' && isFinite(na) && isFinite(nb)) return na - nb;
    if (ISO_DATE.test(a) && ISO_DATE.test(b)) {
      var da = Date.parse(a), db = Date.parse(b);
      if (!isNaN(da) && !isNaN(db)) return da - db;
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }
  function filterActive(f) { return NO_VALUE_OPS[f.op] || f.value !== ''; }
  function matchFilter(t, f) {
    var v = t[f.key] || '';
    var lv = v.toLowerCase(), lq = (f.value || '').toLowerCase();
    switch (f.op) {
      case 'contains': return lv.indexOf(lq) !== -1;
      case 'not_contains': return lv.indexOf(lq) === -1;
      case 'equals': return lv === lq;
      case 'not_equals': return lv !== lq;
      case 'starts': return lv.indexOf(lq) === 0;
      case 'empty': return v === '';
      case 'not_empty': return v !== '';
      case 'gt': return v !== '' && compare(v, f.value) > 0;
      case 'lt': return v !== '' && compare(v, f.value) < 0;
    }
    return true;
  }
  function recompute() {
    var q = state.search.trim().toLowerCase();
    var cols = visibleCols();
    var filters = state.filters.filter(filterActive);
    var idx = [];
    for (var i = 0; i < ROWS.length; i++) {
      var t = ROW_TEXT[i];
      var ok = filters.every(function (f) { return matchFilter(t, f); });
      if (ok && q) ok = cols.some(function (c) { return t[c.key].toLowerCase().indexOf(q) !== -1; });
      if (ok) idx.push(i);
    }
    if (state.sort.length) {
      idx.sort(function (a, b) {
        for (var s = 0; s < state.sort.length; s++) {
          var key = state.sort[s].key;
          var va = ROW_TEXT[a][key], vb = ROW_TEXT[b][key];
          if (va === vb) continue;
          if (va === '') return 1;      // blanks sink, whichever direction
          if (vb === '') return -1;
          var c = compare(va, vb);
          if (c) return state.sort[s].order === 'asc' ? c : -c;
        }
        return a - b;
      });
    }
    current = idx;
  }

  // ── Table rendering ─────────────────────────────────────────────────────
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  function renderHead() {
    var cols = visibleCols();
    colgroup.replaceChildren();
    var tr = el('tr');
    cols.forEach(function (c) {
      colgroup.appendChild(el('col'));
      var th = el('th');
      th.dataset.key = c.key;
      th.title = c.key + ' — click to sort, Ctrl/Shift-click to add a secondary sort';
      th.appendChild(el('span', 'th-label', c.key));
      var si = state.sort.findIndex(function (s) { return s.key === c.key; });
      if (si !== -1) {
        th.appendChild(el('span', 'sort-ind',
          (state.sort[si].order === 'asc' ? '▲' : '▼') + (state.sort.length > 1 ? String(si + 1) : '')));
      }
      var grip = el('div', 'col-resizer');
      grip.title = 'Drag to resize · double-click to fit';
      th.appendChild(grip);
      tr.appendChild(th);
    });
    colgroup.appendChild(el('col'));
    tr.appendChild(el('th', 'col-actions', 'ACTIONS'));
    thead.replaceChildren(tr);
  }

  function actionsCell(id) {
    var td = el('td', 'col-actions');
    var wrap = el('div', 'actions-cell');
    var edit = el('a', 'btn btn-teal', 'EDIT');
    edit.href = '/db/' + encodeURIComponent(COLL) + '/edit/' + encodeURIComponent(id) + '?token=' + encodeURIComponent(TOKEN);
    wrap.appendChild(edit);
    if (CAN_RESET) {
      var rp = el('button', 'btn btn-orange', 'RESET PASS');
      rp.dataset.act = 'reset'; rp.dataset.id = id;
      wrap.appendChild(rp);
    }
    var del = el('button', 'btn btn-red', 'DELETE');
    del.dataset.act = 'delete'; del.dataset.id = id;
    wrap.appendChild(del);
    td.appendChild(wrap);
    return td;
  }

  function renderBody() {
    var cols = visibleCols();
    var frag = document.createDocumentFragment();
    current.forEach(function (i) {
      var tr = el('tr');
      var t = ROW_TEXT[i];
      cols.forEach(function (c) {
        var td = el('td');
        td.appendChild(el('div', 'cell-content', t[c.key]));
        tr.appendChild(td);
      });
      tr.appendChild(actionsCell(ROWS[i]._id));
      frag.appendChild(tr);
    });
    if (!current.length) {
      var tr = el('tr', 'no-rows');
      var td = el('td', '', ROWS.length ? 'No rows match this view.' : 'No rows.');
      td.colSpan = cols.length + 1;
      tr.appendChild(td);
      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);
  }

  // Columns nobody has sized get their natural (max-content) width, clamped,
  // measured once; after that the table is fixed-layout so drags are exact.
  function measureMissing() {
    var cols = visibleCols();
    if (!cols.some(function (c) { return !c.width && !autoWidths[c.key]; })) return;
    table.classList.remove('fixed');
    table.style.width = 'max-content';
    Array.prototype.forEach.call(colgroup.children, function (col) { col.style.width = ''; });
    var ths = thead.rows[0].cells;
    cols.forEach(function (c, i) {
      if (c.width || autoWidths[c.key]) return;
      // +2: a column set to exactly its natural width wraps once the
      // fractional pixels are rounded away.
      var w = Math.ceil(ths[i].getBoundingClientRect().width) + 2;
      autoWidths[c.key] = Math.min(Math.max(w, 80), 420);
    });
  }

  function applyWidths() {
    var cols = visibleCols();
    var colEls = colgroup.children;
    var total = 0;
    cols.forEach(function (c, i) {
      var w = widthOf(c);
      colEls[i].style.width = w + 'px';
      total += w;
    });
    colEls[cols.length].style.width = ACTIONS_WIDTH + 'px';
    total += ACTIONS_WIDTH;
    table.style.width = total + 'px';
    table.classList.add('fixed');
  }

  function updateCount() {
    $('filter-count').textContent = current.length === ROWS.length
      ? ROWS.length + ' ROWS'
      : current.length + ' / ' + ROWS.length + ' ROWS';
    var n = state.filters.filter(filterActive).length;
    $('filters-btn').textContent = 'FILTERS' + (n ? ' (' + n + ')' : '') + ' ▾';
    $('filters-btn').classList.toggle('has-active', n > 0);
    var hidden = state.columns.length - visibleCols().length;
    $('cols-btn').textContent = 'COLUMNS' + (hidden ? ' (' + hidden + ' hidden)' : '') + ' ▾';
    $('export-view-label').textContent = 'CSV — this view (' + current.length + ' rows)';
  }

  function refresh() {
    recompute();
    renderHead();
    renderBody();
    measureMissing();
    applyWidths();
    updateCount();
    renderViewBar();
  }

  // ── Header interactions: sort + resize ──────────────────────────────────
  var justResized = false;

  thead.addEventListener('mousedown', function (e) {
    var grip = e.target.closest('.col-resizer');
    if (!grip) return;
    e.preventDefault();
    e.stopPropagation();
    var c = colByKey(grip.parentElement.dataset.key);
    var startX = e.clientX, startW = widthOf(c);
    document.body.classList.add('col-resizing');
    function move(ev) {
      c.width = Math.max(50, Math.round(startW + ev.clientX - startX));
      applyWidths();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      justResized = true;
      setTimeout(function () { justResized = false; }, 0);
      renderViewBar();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  thead.addEventListener('dblclick', function (e) {
    var grip = e.target.closest('.col-resizer');
    if (!grip) return;
    var key = grip.parentElement.dataset.key;
    colByKey(key).width = null;
    delete autoWidths[key];
    refresh();
  });

  thead.addEventListener('click', function (e) {
    if (justResized || e.target.closest('.col-resizer')) return;
    var th = e.target.closest('th[data-key]');
    if (!th) return;
    var key = th.dataset.key;
    var i = state.sort.findIndex(function (s) { return s.key === key; });
    if (e.ctrlKey || e.shiftKey || e.metaKey) {
      // Secondary sorts: add ascending, flip to descending, then drop.
      if (i === -1) state.sort.push({ key: key, order: 'asc' });
      else if (state.sort[i].order === 'asc') state.sort[i].order = 'desc';
      else state.sort.splice(i, 1);
    } else if (i !== -1 && state.sort.length === 1) {
      if (state.sort[0].order === 'asc') state.sort[0].order = 'desc';
      else state.sort = [];
    } else {
      state.sort = [{ key: key, order: 'asc' }];
    }
    refresh();
  });

  // ── Row actions ─────────────────────────────────────────────────────────
  tbody.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.act === 'delete') deleteDoc(id);
    else if (btn.dataset.act === 'reset') resetPassword(id);
  });

  function dbUrl(path) {
    return '/db/' + encodeURIComponent(COLL) + path + '?token=' + encodeURIComponent(TOKEN);
  }

  function deleteDoc(id) {
    if (!confirm('Delete this record? This cannot be undone.')) return;
    fetch(dbUrl('/delete/' + encodeURIComponent(id)), { method: 'POST' }).then(function (res) {
      if (!res.ok) { alert('Delete failed'); return; }
      var i = ROWS.findIndex(function (r) { return r._id === id; });
      if (i !== -1) { ROWS.splice(i, 1); ROW_TEXT.splice(i, 1); }
      refresh();
    });
  }

  function resetPassword(id) {
    if (!confirm('Send a password reset link to this record?')) return;
    fetch(dbUrl('/reset-password/' + encodeURIComponent(id)), { method: 'POST' }).then(function (res) {
      return res.text().then(function (msg) { alert(res.ok ? (msg || 'Reset email sent') : 'Reset failed: ' + msg); });
    });
  }

  // ── Search ──────────────────────────────────────────────────────────────
  var searchTimer = null;
  $('search-input').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.search = v; refresh(); }, 120);
  });

  // ── Dropdown menus ──────────────────────────────────────────────────────
  var MENUS = ['cols-menu', 'filters-menu', 'export-menu'];
  function toggleMenu(id) {
    MENUS.forEach(function (m) { if (m !== id) $(m).classList.remove('open'); });
    var open = $(id).classList.toggle('open');
    if (open && id === 'cols-menu') renderColumnMenu();
    if (open && id === 'filters-menu') renderFilterMenu();
  }
  $('cols-btn').addEventListener('click', function () { toggleMenu('cols-menu'); });
  $('filters-btn').addEventListener('click', function () { toggleMenu('filters-menu'); });
  $('export-btn').addEventListener('click', function () { toggleMenu('export-menu'); });
  document.addEventListener('click', function (e) {
    if (e.target.closest('.menu-wrap')) return;
    MENUS.forEach(function (m) { $(m).classList.remove('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') MENUS.forEach(function (m) { $(m).classList.remove('open'); });
  });

  // Columns: show/hide and order.
  function renderColumnMenu() {
    var list = $('cols-list');
    list.replaceChildren();
    state.columns.forEach(function (c, i) {
      var row = el('div', 'col-item' + (c.hidden ? ' hidden-col' : ''));
      var label = el('label');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !c.hidden;
      cb.addEventListener('change', function () { c.hidden = !cb.checked; refresh(); renderColumnMenu(); });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + c.key));
      row.appendChild(label);
      var up = el('button', 'mini-btn', '▲');
      up.title = 'Move left';
      up.disabled = i === 0;
      up.addEventListener('click', function () { moveCol(i, -1); });
      var down = el('button', 'mini-btn', '▼');
      down.title = 'Move right';
      down.disabled = i === state.columns.length - 1;
      down.addEventListener('click', function () { moveCol(i, 1); });
      row.appendChild(up);
      row.appendChild(down);
      list.appendChild(row);
    });
  }
  function moveCol(i, d) {
    var c = state.columns.splice(i, 1)[0];
    state.columns.splice(i + d, 0, c);
    refresh();
    renderColumnMenu();
  }
  $('cols-all').addEventListener('click', function () { state.columns.forEach(function (c) { c.hidden = false; }); refresh(); renderColumnMenu(); });
  $('cols-none').addEventListener('click', function () { state.columns.forEach(function (c) { c.hidden = true; }); refresh(); renderColumnMenu(); });
  $('cols-fit').addEventListener('click', function () {
    state.columns.forEach(function (c) { c.width = null; });
    autoWidths = {};
    refresh();
  });

  // Field filters, AND-ed together.
  function renderFilterMenu() {
    var list = $('filters-list');
    list.replaceChildren();
    if (!state.filters.length) list.appendChild(el('div', 'menu-empty', 'No filters. Rows must match every filter you add.'));
    state.filters.forEach(function (f, i) {
      var row = el('div', 'filter-row');
      var field = el('select');
      DATA_KEYS.forEach(function (k) {
        var o = el('option', '', k); o.value = k; if (k === f.key) o.selected = true; field.appendChild(o);
      });
      field.addEventListener('change', function () { f.key = field.value; refresh(); });
      var op = el('select');
      FILTER_OPS.forEach(function (p) {
        var o = el('option', '', p[1]); o.value = p[0]; if (p[0] === f.op) o.selected = true; op.appendChild(o);
      });
      var val = el('input');
      val.type = 'text';
      val.placeholder = 'value';
      val.value = f.value;
      val.disabled = !!NO_VALUE_OPS[f.op];
      op.addEventListener('change', function () { f.op = op.value; val.disabled = !!NO_VALUE_OPS[f.op]; refresh(); });
      var t = null;
      val.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () { f.value = val.value; refresh(); }, 150);
      });
      var rm = el('button', 'mini-btn', '✕');
      rm.title = 'Remove filter';
      rm.addEventListener('click', function () { state.filters.splice(i, 1); refresh(); renderFilterMenu(); });
      row.appendChild(field); row.appendChild(op); row.appendChild(val); row.appendChild(rm);
      list.appendChild(row);
    });
  }
  $('filters-add').addEventListener('click', function () {
    var first = visibleCols()[0] || state.columns[0];
    state.filters.push({ key: first ? first.key : DATA_KEYS[0], op: 'contains', value: '' });
    renderFilterMenu();
    updateCount();
    renderViewBar();
    var inputs = $('filters-list').querySelectorAll('input[type=text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  $('filters-clear').addEventListener('click', function () { state.filters = []; refresh(); renderFilterMenu(); });

  // ── Export ──────────────────────────────────────────────────────────────
  function csvField(t) {
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
    return /[",\r\n]|^\s|\s$/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function fileBase() {
    var slug = activeView ? '-' + activeView.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
    return COLL + slug + '-' + new Date().toISOString().slice(0, 10);
  }
  function download(name, body, type) {
    var url = URL.createObjectURL(new Blob([body], { type: type }));
    var a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  $('export-view').addEventListener('click', function () {
    var keys = visibleCols().map(function (c) { return c.key; })
      .filter(function (k) { return SENSITIVE.indexOf(k) === -1; });
    var lines = [keys.map(csvField).join(',')];
    current.forEach(function (i) {
      lines.push(keys.map(function (k) { return csvField(ROW_TEXT[i][k]); }).join(','));
    });
    download(fileBase() + '.csv', '\uFEFF' + lines.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
    $('export-menu').classList.remove('open');
  });
  ['csv', 'json'].forEach(function (fmt) {
    var a = $('export-all-' + fmt);
    a.href = '/db/' + encodeURIComponent(COLL) + '/export?format=' + fmt + '&token=' + encodeURIComponent(TOKEN);
    a.addEventListener('click', function () { $('export-menu').classList.remove('open'); });
  });

  // ── List views ──────────────────────────────────────────────────────────
  function viewsApi(method, path, body) {
    var url = '/db/api/views/' + encodeURIComponent(COLL) + path + '?token=' + encodeURIComponent(TOKEN);
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  var viewsError = '';
  var busy = false;

  function renderViewBar() {
    var sel = $('view-select');
    sel.replaceChildren();
    var all = el('option', '', 'All records');
    all.value = '';
    sel.appendChild(all);
    views.forEach(function (v) {
      var o = el('option', '', v.name + (v.isDefault ? '  ★' : ''));
      o.value = v.id;
      sel.appendChild(o);
    });
    sel.value = activeView ? activeView.id : '';

    var dirty = isDirty();
    $('view-dirty').hidden = !dirty;
    $('view-save').hidden = !activeView;
    $('view-save').disabled = busy || !dirty;
    $('view-revert').hidden = !dirty;
    $('view-rename').hidden = !activeView;
    $('view-delete').hidden = !activeView;
    $('view-default').hidden = !activeView;
    $('view-default').textContent = activeView && activeView.isDefault ? '★ DEFAULT' : '☆ MAKE DEFAULT';
    $('view-default').title = activeView && activeView.isDefault
      ? 'Opens first for this table. Click to stop opening it by default.'
      : 'Open this view first whenever this table loads';
    [$('view-saveas'), $('view-rename'), $('view-delete'), $('view-default')].forEach(function (b) { b.disabled = busy || !!viewsError; });
    $('view-status').textContent = viewsError;
    $('view-status').className = 'view-status' + (viewsError ? ' err' : '');
  }

  function syncUrl() {
    var u = new URL(location.href);
    if (activeView) u.searchParams.set('view', activeView.id); else u.searchParams.delete('view');
    history.replaceState(null, '', u.toString());
  }

  function applyView(v) {
    activeView = v;
    state = v ? normalize(v.config) : baseState();
    savedJson = snapshot();
    $('search-input').value = state.search;
    syncUrl();
    refresh();
    if ($('filters-menu').classList.contains('open')) renderFilterMenu();
    if ($('cols-menu').classList.contains('open')) renderColumnMenu();
  }

  function flash(msg) {
    $('view-status').textContent = msg;
    $('view-status').className = 'view-status ok';
    setTimeout(function () { if ($('view-status').textContent === msg) renderViewBar(); }, 2500);
  }

  function run(p, okMsg) {
    busy = true;
    renderViewBar();
    return p.then(function (r) { busy = false; renderViewBar(); if (okMsg) flash(okMsg); return r; })
      .catch(function (e) { busy = false; renderViewBar(); alert(e.message); });
  }

  $('view-select').addEventListener('change', function () {
    var id = this.value;
    if (isDirty() && !confirm('Discard the unsaved changes to this view?')) { this.value = activeView ? activeView.id : ''; return; }
    applyView(views.find(function (v) { return v.id === id; }) || null);
  });

  $('view-save').addEventListener('click', function () {
    if (!activeView) return;
    run(viewsApi('PUT', '/' + encodeURIComponent(activeView.id), { config: state }).then(function (v) {
      replaceView(v);
      activeView = v;
      savedJson = snapshot();
    }), 'Saved.');
  });

  $('view-saveas').addEventListener('click', function () {
    var name = prompt('Name this view:', activeView ? activeView.name + ' (copy)' : '');
    if (name === null || !name.trim()) return;
    run(viewsApi('POST', '', { name: name.trim(), config: state }).then(function (v) {
      views.push(v);
      views.sort(byName);
      activeView = v;
      savedJson = snapshot();
      syncUrl();
    }), 'Saved as "' + name.trim() + '".');
  });

  $('view-rename').addEventListener('click', function () {
    if (!activeView) return;
    var name = prompt('Rename view:', activeView.name);
    if (name === null || !name.trim() || name.trim() === activeView.name) return;
    run(viewsApi('PUT', '/' + encodeURIComponent(activeView.id), { name: name.trim() }).then(function (v) {
      replaceView(v);
      activeView.name = v.name;
      views.sort(byName);
    }), 'Renamed.');
  });

  $('view-delete').addEventListener('click', function () {
    if (!activeView || !confirm('Delete the view "' + activeView.name + '"? The table itself is not touched.')) return;
    var id = activeView.id;
    run(viewsApi('DELETE', '/' + encodeURIComponent(id)).then(function () {
      views = views.filter(function (v) { return v.id !== id; });
      applyView(null);
    }), 'View deleted.');
  });

  $('view-default').addEventListener('click', function () {
    if (!activeView) return;
    var makeDefault = !activeView.isDefault;
    run(viewsApi('PUT', '/' + encodeURIComponent(activeView.id), { isDefault: makeDefault }).then(function (v) {
      views.forEach(function (x) { x.isDefault = false; });
      replaceView(v);
      activeView.isDefault = v.isDefault;
    }), makeDefault ? 'Opens by default now.' : 'No longer the default.');
  });

  $('view-revert').addEventListener('click', function () { applyView(activeView); });

  function replaceView(v) {
    var i = views.findIndex(function (x) { return x.id === v.id; });
    if (i !== -1) views[i] = v;
  }
  function byName(a, b) {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  }

  window.addEventListener('beforeunload', function (e) {
    if (activeView && isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── CSV import (unchanged behaviour) ────────────────────────────────────
  var upload = $('csv-upload');
  $('import-btn').addEventListener('click', function () { upload.click(); });
  upload.addEventListener('change', function () {
    var file = upload.files[0];
    if (!file) return;
    var btn = $('import-btn');
    var form = new FormData();
    form.append('csv', file);
    btn.textContent = 'IMPORTING...';
    btn.disabled = true;
    fetch(dbUrl('/import'), { method: 'POST', body: form })
      .then(function (res) { return res.text().then(function (msg) {
        if (res.ok) { alert(msg || 'Import successful'); location.reload(); }
        else alert('Import failed: ' + msg);
      }); })
      .catch(function (err) { alert('Error: ' + err.message); })
      .finally(function () { btn.textContent = 'IMPORT CSV'; btn.disabled = false; upload.value = ''; });
  });

  // ── Boot ────────────────────────────────────────────────────────────────
  refresh();
  viewsApi('GET', '').then(function (list) {
    views = list.sort(byName);
    var wanted = new URL(location.href).searchParams.get('view');
    var v = views.find(function (x) { return x.id === wanted; }) || views.find(function (x) { return x.isDefault; });
    if (v) applyView(v); else renderViewBar();
  }).catch(function (e) {
    viewsError = 'List views unavailable: ' + e.message;
    renderViewBar();
  });
})();
`;
