// Native Weda page handler: overview/handler/loadCockpit (handler-fn).
// Identity is supplied by the platform session, never by this request body.
const PALETTE = ['#A35D45', '#4C6C5E', '#B98A62', '#8C7970', '#8D9C88', '#BD9D83'];
let latestLoad = 0;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, limit = 120) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
}

function integer(value, signed = false) {
  return Number.isSafeInteger(value) && (signed || value >= 0) ? value : null;
}

export function formatCount(value) {
  const number = integer(value);
  return number === null ? '—' : number.toLocaleString('zh-CN');
}

export function formatFen(value, signed = false) {
  const number = integer(value, signed);
  return number === null ? '—' : (number / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function maskedName(value) {
  const name = Array.from(text(value, 40));
  return name.length ? name[0] + '**' : '未命名主理人';
}

function dateLabel(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  return stamp.getUTCFullYear() === year && stamp.getUTCMonth() === month - 1 && stamp.getUTCDate() === day ? value : null;
}

function toTrend(rows, fields) {
  if (!Array.isArray(rows)) return [];
  const values = [];
  for (const row of rows) {
    if (!record(row)) continue;
    const date = dateLabel(row.date);
    if (!date) continue;
    values.push({
      date,
      XLabel: { Name: 'date', Value: date.slice(5) },
      YLabels: fields.map(([key, label, money, signed]) => {
        const value = integer(row[key], !!signed);
        return { Name: key, Cn_Name: label, Value: value === null ? null : money ? value / 100 : value };
      }),
    });
  }
  // Missing values stay null gaps. A genuine numeric zero remains visible.
  if (!values.some(row => row.YLabels.some(item => item.Value !== null))) return [];
  // The official native Line transformer fixes axisLabel.interval at zero.
  // Keep every point and its ISO date, but expose at most eight short labels.
  const shown = new Set(Array.from({ length: Math.min(8, values.length) }, (_, index) => Math.round(index * (values.length - 1) / Math.max(1, Math.min(8, values.length) - 1))));
  return values.map((row, index) => ({ ...row, XLabel: { ...row.XLabel, Value: shown.has(index) ? row.XLabel.Value : '' } }));
}

function sumKnown(rows, key) {
  let total = 0;
  for (const row of rows) {
    const value = integer(row[key]);
    if (value === null || !Number.isSafeInteger(total + value)) return null;
    total += value;
  }
  return total;
}

function productsView(products, paidFen, quality) {
  if (!Array.isArray(products)) return { rows: [], pie: [], colors: PALETTE, hasData: false };
  const items = products.filter(record).map((item, index) => ({
    code: text(item.code, 60), title: text(item.title, 50) || '待核对套餐',
    paidFen: integer(item.paidFen), color: PALETTE[index % PALETTE.length],
  }));
  const total = integer(paidFen);
  // Partial or inconsistent amounts must not become a seemingly complete pie.
  const complete = quality?.productsComplete !== false && items.length === products.length && total !== null && sumKnown(items, 'paidFen') === total;
  const visible = items.slice(0, 9);
  if (items.length > 9) visible.push({ title: `其他${items.length - 9}项套餐`, paidFen: sumKnown(items.slice(9), 'paidFen'), color: PALETTE[3] });
  const pie = complete && total > 0 ? visible.filter(item => item.paidFen > 0).map(item => ({
    XLabel: { Name: 'product', Value: item.title },
    YLabels: [{ Name: 'paidFen', Cn_Name: '实付金额', Value: item.paidFen / 100 }],
  })) : [];
  const rows = visible.map(item => ({
    title: item.title,
    amount: formatFen(item.paidFen) + (item.paidFen === null ? '' : ' 元'),
    share: complete && total > 0 && item.paidFen !== null ? (item.paidFen / total * 100).toFixed(1) + ' %' : '— %',
    color: item.color,
  }));
  return { rows, pie, colors: visible.filter(item => item.paidFen > 0).map(item => item.color), hasData: pie.length > 0 };
}

function warningsOf(value) {
  return record(value) && Array.isArray(value.warnings) ? value.warnings.map(item => text(item, 300)).filter(Boolean) : [];
}

export function createCockpitView(data) {
  if (!record(data) || !record(data.members) || !record(data.matchmakers) || !record(data.revenue)) throw new Error('COCKPIT_INVALID_RESPONSE');
  const members = data.members;
  const matchmakers = data.matchmakers;
  const revenue = data.revenue;
  const days = [7, 30, 90].includes(data.period?.days) ? data.period.days : 30;
  const asOf = typeof data.asOf === 'string' ? new Date(data.asOf) : null;
  const updatedAt = asOf && Number.isFinite(asOf.getTime()) ? asOf.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
  const memberTrend = toTrend(members.trend, [['newCount', '新增会员'], ['cumulative', '累计建档']]);
  const revenueTrend = toTrend(revenue.trend, [['paidFen', '实付金额', true], ['refundFen', '退款金额', true], ['netFen', '净收款', true, true]]);
  const mix = productsView(revenue.products, revenue.paidFen, revenue.quality);
  const ranking = Array.isArray(matchmakers.ranking) ? matchmakers.ranking.filter(record).slice(0, 10).map(row => ({
    name: maskedName(row.name), city: text(row.city, 40) || '未填写',
    memberCount: formatCount(row.memberCount), newAssignments: formatCount(row.newAssignments),
  })) : [];
  const warnings = [...new Set([...warningsOf(data.quality), ...warningsOf(members.quality), ...warningsOf(revenue.quality)])];
  return {
    periodLabel: `统计周期 · 近${days}天`, periodDays: days,
    updatedLabel: `统计截至 ${updatedAt}（北京时间）`,
    metrics: [formatCount(members.total), formatCount(members.newCount), formatCount(matchmakers.approved), formatFen(revenue.paidFen), formatFen(revenue.refundFen), formatFen(revenue.netFen, true)],
    memberCounts: [formatCount(members.vip), formatCount(members.ordinary), formatCount(members.verified), formatCount(members.publicCount)],
    matchmakerCounts: [formatCount(matchmakers.approved), formatCount(matchmakers.pending), formatCount(matchmakers.active30d)],
    memberTrend, revenueTrend, mixRows: mix.rows, productPie: mix.pie, productColors: mix.colors,
    hasMemberTrend: memberTrend.length > 0, hasRevenueTrend: revenueTrend.length > 0, hasProductPie: mix.hasData,
    hasRanking: ranking.length > 0, ranking,
    memberEmptyTitle: '暂无可统计的会员趋势', revenueEmptyTitle: '暂无可统计的收款趋势',
    mixEmptyLabel: integer(revenue.paidFen) === 0 ? '本期无已核验实付' : '占比暂不可统计',
    rankingEmptyTitle: Array.isArray(matchmakers.ranking) ? '暂无符合条件的主理人' : '主理人排名暂不可统计',
    pendingMatchmakers: `待审核 ${formatCount(matchmakers.pending)}`,
    qualityText: '统计说明：— 表示暂不可统计，0 表示已核实零值；净收款未扣手续费，不代表会计收入。' + (warnings.length ? '\n' + warnings.join('；') : ''),
    warnings,
  };
}

function errorText(error) {
  const code = String(error?.code ?? error?.errCode ?? error?.status ?? '').toUpperCase();
  if (/401|403|UNAUTH|FORBIDDEN|PERMISSION|NOT_LOGIN|SIGN_IN|LOGIN_REQUIRED|TOKEN_EXPIRED/.test(code)) return '无权查看经营统计，请使用已授权的管理员账号登录。';
  return '经营统计暂时无法加载，请稍后刷新重试。';
}

export default async function loadCockpit(input = {}) {
  const page = $w.page;
  if (!page || page.id !== 'overview') return null;
  const request = ++latestLoad;
  const requestedDays = input?.data?.target?.periodDays;
  const periodDays = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  page.setState({ cockpit: null, loading: true, error: '' });
  try {
    const response = await $w.cloud.callFunction({ name: 'hlAdminCockpit', data: { periodDays } });
    const result = response?.result;
    if (!record(result) || result.code !== 0) throw { code: result?.code || response?.code || 'COCKPIT_INVALID_RESPONSE' };
    const view = createCockpitView(result.data);
    if (request !== latestLoad) return null;
    page.setState({ cockpit: view, loading: false, error: '' });
    return view;
  } catch (error) {
    if (request !== latestLoad) return null;
    // Never retain stale data after authentication or transport failure.
    page.setState({ cockpit: null, loading: false, error: errorText(error) });
    return null;
  }
}
