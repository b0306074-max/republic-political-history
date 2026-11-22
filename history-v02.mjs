const earliest = (date) => date.length === 4 ? date + "-01-01" : date.length === 7 ? date + "-01" : date;
const latest = (date) => {
  if (date.length === 10) return date;
  const [year, month] = date.split("-").map(Number);
  return date + "-" + new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const collator = new Intl.Collator("zh-Hans");
const last = (a, b) => (b ?? "").localeCompare(a ?? "");

export function standings(data, at, domain) {
  const rows = Object.entries(data.people).map(([name, person]) => {
    if (person.death && latest(person.death) <= at) {
      return {name, status: "已逝世", roles: [], candidates: []};
    }
    const relevant = person.roles.filter((role) => role.domain === domain && earliest(role.start) <= at);
    const active = relevant.filter((role) => !role.end || latest(role.end) > at);
    const uncertainDeath = person.death && earliest(person.death) <= at;
    const candidates = active.filter((role) => uncertainDeath || latest(role.start) > at ||
      (role.end && earliest(role.end) <= at) ||
      (role.uncertain && earliest(role.uncertain) <= at));
    const verified = active.filter((role) => !candidates.includes(role))
      .sort((a, b) => a.tier - b.tier || last(a.start, b.start));
    const roles = [...new Map(verified.slice().reverse().map((role) => [role.title, role])).values()]
      .sort((a, b) => a.tier - b.tier || last(a.start, b.start));
    const options = candidates.filter((role) => !roles.some((other) => other.title === role.title));
    const best = roles[0];
    if (options.some((role) => !best || role.tier <= best.tier)) {
      return {name, status: "资料待核", roles, candidates: options};
    }
    if (best) return {name, status: "在榜", tier: best.tier, roles, candidates: options};
    return {name, status: relevant.length ? "已离任" : "无已录职务", roles, candidates: options};
  });
  rows.sort((a, b) => (a.tier ?? Infinity) - (b.tier ?? Infinity) || collator.compare(a.name, b.name));
  let previousTier;
  let rank;
  for (const [index, row] of rows.entries()) {
    if (row.tier === undefined) {
      row.rank = null;
      continue;
    }
    if (previousTier !== row.tier) {
      rank = index + 1;
      previousTier = row.tier;
    }
    row.rank = rank;
  }
  return rows;
}

export function movement(row, prior) {
  if (!prior) return {text: "—", note: ""};
  if (row.status === "资料待核" || prior.status === "资料待核") {
    return {text: "待核", note: "涉及日期或职务状态待核"};
  }
  if (row.rank === null && prior.rank === null) return {text: "—", note: ""};
  if (row.rank === null) return {text: "退出", tone: "down", note: "上期第 " + prior.rank + " 名"};
  if (prior.rank === null) return {text: "新上榜", tone: "up", note: ""};
  const difference = prior.rank - row.rank;
  const retained = row.roles[0].title === prior.roles[0].title;
  const note = difference ? (retained ? "首要职务未变，榜单位置变化" : "上期首要职务：" + prior.roles[0].title) : "";
  return {
    text: difference ? (difference > 0 ? "↑ 上升 " : "↓ 下降 ") + Math.abs(difference) : "持平",
    tone: difference > 0 ? "up" : difference < 0 ? "down" : "",
    note,
  };
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const dateText = (date) => date?.length === 4 ? date + " 年" : date?.length === 7 ? date + "（月）" : date;
const personUrl = (name) => "#people/" + encodeURIComponent(name);
const rankUrl = (index, domain) => "#rank/" + index + "/" + domain;
const time = (when) => '<time datetime="' + esc(when) + '">' + esc(dateText(when)) + "</time>";
const option = (value, label, selected) =>
  '<option value="' + esc(value) + '"' + (value === selected ? " selected" : "") + '>' + esc(label) + "</option>";

async function init() {
  const main = document.querySelector("#main");
  let data;
  try {
    const response = await fetch("./history-v02.json");
    if (!response.ok) throw new Error("HTTP " + response.status);
    data = await response.json();
  } catch {
    main.innerHTML = '<p role="alert">历史资料加载失败。请刷新，或<a href="./history-v02.json">打开资料 JSON</a>。</p>';
    return;
  }
  const {nodes, people, domains, sources} = data;
  const names = Object.keys(people).sort(collator.compare);
  const maxIndex = nodes.length - 1;
  const boards = Object.fromEntries(Object.keys(domains).map((domain) => [
    domain, nodes.map((node) => standings(data, node.at, domain)),
  ]));
  const state = {
    page: "rank", index: maxIndex, domain: "party", filter: "", name: "邓小平",
    peopleFilter: "", compare: ["邓小平", "陈云"], chart: ["邓小平", "陈云", "叶剑英"],
    chartName: "邓颖超", timer: null,
  };

  function citations(keys, full = false) {
    return keys.map((key) => {
      const item = sources[key];
      return '<a href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(full ? item.title : "出处 " + (keys.indexOf(key) + 1)) + "</a>";
    }).join(" ");
  }

  function personOptions(selected) {
    return names.map((name) => option(name, name, selected)).join("");
  }

  function rankTable() {
    const current = boards[state.domain][state.index];
    const prior = new Map((boards[state.domain][state.index - 1] ?? []).map((row) => [row.name, row]));
    const matches = current.filter((row) =>
      !state.filter || [row.name, row.status, ...row.roles.map((role) => role.title)].some((value) => value.includes(state.filter)));
    document.querySelector("#board-count").textContent =
      "已上榜 " + current.filter((row) => row.rank !== null).length + " 人 / 共 " + names.length + " 人" +
      (state.filter ? " · 匹配 " + matches.length + " 人" : "");
    const ties = new Map();
    for (const row of current) ties.set(row.rank, (ties.get(row.rank) ?? 0) + 1);
    document.querySelector("#rank-body").innerHTML = matches.length ? matches.map((row) => {
      const change = movement(row, prior.get(row.name));
      const role = row.roles[0] ?? row.candidates[0];
      const referenceKeys = role?.sources ?? [];
      const other = row.roles.slice(1);
      const lastChange = role ? (role.end && earliest(role.end) <= nodes[state.index].at
        ? "任期终点待核 · " + dateText(role.end) : "任期起点 · " + dateText(role.start)) : "";
      return '<tr><td>' + (row.rank === null ? "—" :
        '<span class="rank-number">' + row.rank + '</span>' + (ties.get(row.rank) > 1 ? '<span class="small">并列</span>' : "")) +
        '</td><td><a class="person-link" href="' + personUrl(row.name) + '">' + esc(row.name) + '</a></td>' +
        '<td><span class="' + (change.tone ?? "") + '">' + change.text + '</span><span class="small">' + esc(change.note) + '</span></td>' +
        '<td>' + (row.rank === null ? '<span class="pill">' + row.status + '</span> ' : "") +
        (role ? esc(role.title) + '<span class="small">' + esc(lastChange) + '</span>' : "") +
        (other.length ? '<details class="small"><summary>另有 ' + other.length + ' 项职务</summary>' +
          other.map((entry) => '<div>' + esc(entry.title) + ' · ' + citations(entry.sources) + '</div>').join("") + '</details>' : "") +
        '</td><td>' + citations(referenceKeys) + '</td></tr>';
    }).join("") : '<tr><td colspan="5">没有匹配的人物或职务。</td></tr>';
  }

  function renderRank() {
    const node = nodes[state.index];
    const tabs = Object.entries(domains).map(([key, label]) =>
      '<button type="button" data-domain="' + key + '" aria-pressed="' + (key === state.domain) + '">' + label + "</button>").join("");
    main.innerHTML = '<h2>排名榜</h2><p class="intro">按时点查看已录正式职务的名次和变化。<a href="#method">查看排序规则</a></p>' +
      '<section class="panel" aria-label="榜单设置"><div class="scope">' + tabs + '</div>' +
      '<div class="controls"><label class="node-field">查看时间 <select id="node">' +
      nodes.map((item, index) => option(index, item.date + " · " + item.label, state.index)).join("") +
      '</select></label><button id="prev"' + (state.index === 0 ? " disabled" : "") + '>上一节点</button>' +
      '<button id="next"' + (state.index === maxIndex ? " disabled" : "") + '>下一节点</button>' +
      '<button id="play" class="primary">' + (state.timer ? "暂停" : "播放") + '</button>' +
      '<label>搜索本榜 <input id="rank-search" type="search" value="' + esc(state.filter) + '" placeholder="姓名或职务"></label></div>' +
      '<p class="node-copy">' + esc(node.detail) + citations(node.sources) + '</p></section>' +
      '<div class="board-head"><div><h3>' + domains[state.domain] + '排名</h3><p id="board-count" class="board-count" aria-live="polite"></p></div>' +
      '<button id="jump-chart" type="button">查看排名趋势 ↓</button></div>' +
      '<div class="table-wrap" tabindex="0" aria-label="排名表，可横向滚动"><table class="rank-table">' +
      '<thead><tr><th scope="col">名次</th><th scope="col">人物</th><th scope="col">较上期</th><th scope="col">当时职务／状态</th>' +
      '<th scope="col">依据</th></tr></thead><tbody id="rank-body"></tbody></table></div>' +
      '<section class="panel chart" id="trend" tabindex="-1"><h3>人物排名趋势</h3><div class="chart-controls">' +
      '<label for="chart-name">比较人物（最多 4 人）</label><select id="chart-name">' + personOptions(state.chartName) + '</select>' +
      '<button id="chart-add" type="button">添加</button><button id="chart-clear" type="button">清空</button></div>' +
      '<div id="chart-key" class="chart-key"></div><canvas id="rank-chart" role="img" aria-label="排名趋势，按公共节点排列，缺失时断开">' +
      '可通过下方表格查看完整名次。</canvas><details><summary>查看趋势数据表</summary><div class="table-wrap">' +
      '<table id="trend-table"></table></div></details></section>';
    rankTable();
    renderChart();
  }

  const colors = ["#872f32", "#265e56", "#3d5290", "#8a4c0b"];

  function trendSeries() {
    return state.chart.map((name, index) => ({
      name, color: colors[index],
      positions: boards[state.domain].map((rows) => rows.find((row) => row.name === name).rank),
    }));
  }

  function renderChart() {
    const series = trendSeries();
    document.querySelector("#chart-key").innerHTML = series.map((entry) =>
      '<span><i style="background:' + entry.color + '"></i>' + esc(entry.name) + '</span>').join("");
    document.querySelector("#chart-add").disabled = state.chart.length >= colors.length || state.chart.includes(state.chartName);
    document.querySelector("#chart-clear").disabled = !state.chart.length;
    document.querySelector("#trend-table").innerHTML = series.length ?
      '<thead><tr><th scope="col">节点</th>' + series.map((entry) => '<th scope="col">' + esc(entry.name) + '</th>').join("") +
      '</tr></thead><tbody>' + nodes.map((node, index) => '<tr><th scope="row">' + esc(node.date) +
        '</th>' + series.map((entry) => '<td>' + (entry.positions[index] ?? "—") + '</td>').join("") + '</tr>').join("") +
      '</tbody>' : '<tbody><tr><td>请选择需要比较的人物。</td></tr></tbody>';
    drawTrend();
  }

  function drawTrend() {
    const canvas = document.querySelector("#rank-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.scale(ratio, ratio);
    const series = trendSeries();
    const positions = series.flatMap((item) => item.positions).filter(Number.isInteger);
    ctx.font = "12px system-ui";
    ctx.fillStyle = "#65594e";
    if (!positions.length) {
      ctx.fillText("所选人物在当前口径下暂无可绘名次。", 8, 20);
      return;
    }
    const edge = 36;
    const step = Math.max(1, Math.ceil((Math.max(...positions) - 1) / 5));
    const limit = Math.max(2, Math.ceil((Math.max(...positions) - 1) / step) * step + 1);
    const x = (index) => edge + (width - 2 * edge) * index / maxIndex;
    const y = (rank) => 16 + (height - 48) * (rank - 1) / (limit - 1);
    ctx.strokeStyle = "#ded4c5";
    for (let rank = 1; rank <= limit; rank += step) {
      ctx.beginPath();
      ctx.moveTo(edge, y(rank));
      ctx.lineTo(width - edge, y(rank));
      ctx.stroke();
      ctx.fillText(String(rank), 5, y(rank) + 4);
    }
    ctx.strokeStyle = "#b5a08c";
    ctx.beginPath();
    ctx.moveTo(x(state.index), 12);
    ctx.lineTo(x(state.index), height - 28);
    ctx.stroke();
    const labels = width < 500 ? [0, 10, 18, maxIndex] : [0, 6, 10, 16, 22, maxIndex];
    ctx.textAlign = "center";
    for (const index of labels) ctx.fillText(nodes[index].date.slice(0, 4), x(index), height - 8);
    for (const entry of series) {
      ctx.strokeStyle = ctx.fillStyle = entry.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let connected = false;
      for (const [index, rank] of entry.positions.entries()) {
        if (rank === null) {
          connected = false;
          continue;
        }
        if (connected) ctx.lineTo(x(index), y(rank));
        else ctx.moveTo(x(index), y(rank));
        connected = true;
      }
      ctx.stroke();
      for (const [index, rank] of entry.positions.entries()) {
        if (rank === null) continue;
        ctx.beginPath();
        ctx.arc(x(index), y(rank), index === state.index ? 4 : 2.7, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  function profile(name, full = true) {
    const person = people[name];
    const entries = person.events.map((entry) => ({...entry, type: "生涯事件"}));
    for (const role of person.roles) {
      entries.push({date: role.start, label: role.title, type: "任期起点", sources: role.sources});
      if (role.end && (!person.death || earliest(role.end) < earliest(person.death))) {
        entries.push({date: role.end, label: role.title, type: "任期终点", sources: role.sources});
      }
      if (role.uncertain) {
        entries.push({date: role.uncertain, label: role.title, type: "在任状态待核", sources: role.sources});
      }
    }
    const unique = new Map(entries.map((item) => [[item.date, item.type, item.label].join("|"), item]));
    const timeline = [...unique.values()].sort((a, b) => earliest(a.date).localeCompare(earliest(b.date)));
    const entryList = (items) => '<ol class="timeline">' + items.map((item) =>
      '<li>' + time(item.date) + '<div><span class="small">' + esc(item.type ?? item.category) + '</span>' +
      esc(item.label) + (item.sources ? '<div class="inline-links">' + citations(item.sources, true) + '</div>' : "") + '</div></li>').join("") + '</ol>';
    return '<article class="panel profile"' + (full ? ' id="profile"' : "") + '><h3>' + esc(name) + '</h3>' +
      '<p class="muted">有出处的任职与生涯节点 · ' + new Set(timeline.map((item) => item.date)).size + ' 个日期</p>' +
      entryList(timeline) +
      (full ? '<details class="section-block"><summary>历次名次</summary><div class="table-wrap"><table><thead><tr>' +
        '<th scope="col">节点</th>' + Object.values(domains).map((label) => '<th scope="col">' + label + '</th>').join("") +
        '</tr></thead><tbody>' + nodes.map((node, index) => '<tr><th scope="row">' + time(node.date) + '</th>' +
          Object.keys(domains).map((domain) => {
            const row = boards[domain][index].find((item) => item.name === name);
            return '<td><a href="' + rankUrl(index, domain) + '">' + (row.rank ?? row.status) + '</a></td>';
          }).join("") + '</tr>').join("") + '</tbody></table></div></details>' : "") +
      (person.legacy.length ? '<details class="section-block"><summary>v0.1 待复核记录（' + person.legacy.length + ' 条）</summary>' +
        '<p class="small">原版采样记录，尚未逐条补上出处。</p>' + entryList(person.legacy) + '</details>' : "") + '</article>';
  }

  function peopleGrid() {
    const results = names.filter((name) => name.includes(state.peopleFilter));
    document.querySelector("#people-count").textContent = "显示 " + results.length + " / " + names.length + " 人";
    document.querySelector("#people-grid").innerHTML = results.map((name) =>
      '<li><a class="panel person-link' + (state.name === name ? " active" : "") + '" href="' + personUrl(name) + '">' + esc(name) +
      '<span class="small">' + people[name].roles.length + ' 段任职记录</span></a></li>').join("");
  }

  function renderPeople() {
    main.innerHTML = '<h2>人物资料</h2><p class="intro">查看个人任职、生涯事件与历次名次。</p>' +
      '<label class="field">搜索姓名 <input id="people-search" type="search" value="' + esc(state.peopleFilter) + '"></label>' +
      '<p class="board-count" id="people-count" aria-live="polite"></p><ul class="people-grid" id="people-grid"></ul>' + profile(state.name);
    peopleGrid();
  }

  function renderNodes() {
    main.innerHTML = '<h2>历史节点</h2><p class="intro">' + nodes.length + ' 个公共节点，每个节点可查看 50 人的榜单状态。</p>' +
      '<ol class="history-list">' + nodes.map((node, index) => '<li class="panel">' + time(node.date) +
      '<div><h3><a href="' + rankUrl(index, state.domain) + '">' + esc(node.label) + '</a></h3>' +
      '<p>' + esc(node.detail) + '</p><div class="inline-links">' + citations(node.sources, true) +
      '</div></div></li>').join("") + '</ol>';
  }

  function renderCompare() {
    main.innerHTML = '<h2>双人对照</h2><p class="intro">并排查看两人的任职记录与出处。</p>' +
      '<div class="controls">' + state.compare.map((name, index) =>
        '<label>人物 ' + (index + 1) + ' <select data-compare="' + index + '">' + personOptions(name) + '</select></label>').join("") +
      '</div><div class="compare-grid">' + state.compare.map((name) => profile(name, false)).join("") + '</div>';
  }

  function renderMethod() {
    main.innerHTML = '<h2>资料与方法</h2><div class="panel section-block"><h3>排名口径</h3>' +
      '<p class="node-copy">每张榜只在本站收录的 50 人中比较。中央党务按所列机构职务层级排序，国家政务将国家机关主要负责人、' +
      '代理总理、副职和委员依次分层，军事领导按军委主席、副主席、常委、委员分层。不同机构的同层职务并列。</p>' +
      '<p class="node-copy">各榜按该时点资料可确认的最高层职务排序，同层并列，例如 1、2、2、4。' +
      '七届中央书记处按当时机构设置列入高层，后续届次中央书记处按各届结构处理。' +
      '榜单序号是本站采用的比较规则，不代表综合政治影响力，也不采用文献名单里的姓名顺序作为排名。</p>' +
      '<p class="node-copy">月级节点以月末观察。任职起止只知道月份时，月内尚无法确定的状态会标为待核。' +
      '换届日期可作为同届职务的区间边界，未发现明确离任日期的记录仍受资料范围限制。' +
      '无已录职务表示当前资料未覆盖；已离任表示本站记录的该口径任职区间已结束。' +
      '中央及国家机构主要名单为本版范围，地方职务、具体军种岗位和其他个人事件按资料逐步补录。</p>' +
      '<p class="node-copy">v0.1 的迁移条目单列为待复核。少数已知逝世日期用于截断任职区间，' +
      '逝世记录出处未逐条补齐时，会在人物档案的待复核区显示。' +
      '趋势图按公共节点等距排列，缺少可比较名次时断开。</p></div>' +
      '<section class="panel section-block"><h3>来源</h3><ul>' + Object.keys(sources).map((key) =>
        '<li>' + citations([key], true) + '</li>').join("") +
      '</ul><a href="./history-v02.json" download>下载 v0.2 JSON</a></section>';
  }

  const renderers = {rank: renderRank, people: renderPeople, nodes: renderNodes, compare: renderCompare, method: renderMethod};

  function route() {
    const [page, first, second] = location.hash.slice(1).split("/");
    const oldPage = state.page;
    state.page = Object.hasOwn(renderers, page) ? page : "rank";
    if (state.page === "rank") {
      if (/^\d+$/.test(first ?? "") && Number(first) <= maxIndex) state.index = Number(first);
      if (Object.hasOwn(domains, second)) state.domain = second;
    } else {
      stopPlayback();
    }
    if (state.page === "people" && first) {
      try {
        const name = decodeURIComponent(first);
        if (Object.hasOwn(people, name)) {
          state.name = name;
          state.peopleFilter = "";
        }
      } catch {
        // Invalid percent encoding leaves the current person selected.
      }
    }
    if (oldPage !== state.page) window.scrollTo(0, 0);
    render();
    if (state.page === "people" && first) document.querySelector("#profile").scrollIntoView();
  }

  function render() {
    for (const link of document.querySelectorAll("[data-page]")) {
      if (link.dataset.page === state.page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    renderers[state.page]();
  }

  function selectRank(index, domain, focus) {
    state.index = index;
    state.domain = domain;
    history.replaceState(null, "", rankUrl(index, domain));
    renderRank();
    const button = focus && document.querySelector(focus);
    if (button && !button.disabled) button.focus({preventScroll: true});
  }

  function stopPlayback() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  main.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "jump-chart") {
      document.querySelector("#trend").focus();
    } else if (button.dataset.domain) {
      stopPlayback();
      selectRank(state.index, button.dataset.domain, '[data-domain="' + button.dataset.domain + '"]');
    } else if (button.id === "prev" || button.id === "next") {
      stopPlayback();
      selectRank(state.index + (button.id === "prev" ? -1 : 1), state.domain, "#" + button.id);
    } else if (button.id === "play") {
      if (state.timer) {
        stopPlayback();
        selectRank(state.index, state.domain, "#play");
        return;
      }
      const index = state.index === maxIndex ? 0 : state.index;
      state.timer = setInterval(() => {
        const next = state.index + 1;
        if (next === maxIndex) stopPlayback();
        selectRank(next, state.domain);
      }, 1500);
      selectRank(index, state.domain, "#play");
    } else if (button.id === "chart-add" && !state.chart.includes(state.chartName)) {
      state.chart.push(state.chartName);
      renderChart();
    } else if (button.id === "chart-clear") {
      state.chart = [];
      renderChart();
    }
  });

  main.addEventListener("change", (event) => {
    const element = event.target;
    if (element.id === "node") {
      stopPlayback();
      selectRank(Number(element.value), state.domain, "#node");
    } else if (element.id === "chart-name") {
      state.chartName = element.value;
      renderChart();
    } else if (element.dataset.compare !== undefined) {
      state.compare[Number(element.dataset.compare)] = element.value;
      renderCompare();
      document.querySelector('[data-compare="' + element.dataset.compare + '"]').focus();
    }
  });

  main.addEventListener("input", (event) => {
    if (event.target.id === "rank-search") {
      state.filter = event.target.value.trim();
      rankTable();
    } else if (event.target.id === "people-search") {
      state.peopleFilter = event.target.value.trim();
      peopleGrid();
    }
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("resize", drawTrend);
  route();
}

if (typeof document !== "undefined") init();
