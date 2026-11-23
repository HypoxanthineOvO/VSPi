import { balance, instant, numeric, object, percent, QuotaError, reading, requireReading, usedWindow, window, type Reading } from './common';

export function codex(value: unknown, now: number): Reading {
  const result = reading(), limit = object(object(value)['rate_limit']);
  for (const key of ['primary_window', 'secondary_window']) {
    const w = object(limit[key]), duration = numeric(w['limit_window_seconds']), after = numeric(w['reset_after_seconds']);
    const resetAt = w['reset_at'];
    if (w['limit_window_seconds'] !== undefined && (duration === undefined || duration <= 0) ||
      (resetAt === null || resetAt === undefined) && w['reset_after_seconds'] !== undefined && (after === undefined || after < 0)) continue;
    const reset = resetAt ?? (after === undefined ? undefined : new Date(now + after * 1000).valueOf());
    const label = duration === 18_000 ? '5h' : duration === 604_800 ? '7d' : duration === undefined ? key === 'primary_window' ? '主窗口' : '次窗口' : `${duration}s`;
    usedWindow(result, label === '5h' || label === '7d' ? label : `codex.${key}`, label, w['used_percent'], reset);
  }
  return requireReading(result);
}

const CLAUDE_FAMILIES = ['Opus', 'Sonnet', 'Fable', 'Haiku'] as const;

export function claude(value: unknown, modelIds: readonly string[]): Reading {
  const result = reading(), data = object(value);
  if (Array.isArray(data['limits'])) {
    for (const raw of data['limits']) {
      const w = object(raw), model = object(object(w['scope'])['model']);
      const family = CLAUDE_FAMILIES.find(name => [model['id'], model['display_name'], w['kind']].some(v => typeof v === 'string' && v.toLowerCase().includes(name.toLowerCase())));
      if (model['id'] === undefined && model['display_name'] === undefined && (w['kind'] === 'session' || w['kind'] === 'weekly_all')) {
        const id = w['kind'] === 'session' ? '5h' : '7d';
        usedWindow(result, id, id, w['percent'], w['resets_at']);
      } else if (family !== undefined || modelIds.some(id => id === model['id'])) {
        const ids = typeof model['id'] === 'string' ? modelIds.filter(id => id === model['id']) : modelIds.filter(id => id.toLowerCase().includes(family?.toLowerCase() ?? ''));
        if (ids.length > 0 || modelIds.length === 0 && family !== undefined) {
          const label = family ?? '模型';
          const scope = typeof w['kind'] === 'string' && w['kind'] === 'session' ? '5h' : '7d';
          usedWindow(result, `claude.${scope}.${family?.toLowerCase() ?? modelIds.indexOf(ids[0]!)}`, label, w['percent'], w['resets_at'], ids.length > 0 ? ids : undefined);
        }
      }
    }
  } else {
    for (const [key, id, label] of [['five_hour', '5h', '5h'], ['seven_day', '7d', '7d']] as const) {
      const w = object(data[key]);
      usedWindow(result, id, label, w['utilization'], w['resets_at']);
    }
    for (const family of CLAUDE_FAMILIES) {
      const suffix = family.toLowerCase(), w = object(data[`seven_day_${suffix}`]);
      const models = modelIds.filter(id => id.toLowerCase().includes(suffix));
      if (modelIds.length === 0 || models.length > 0) usedWindow(result, `claude.7d.${suffix}`, family, w['utilization'], w['resets_at'], models.length > 0 ? models : undefined);
    }
  }
  return requireReading(result);
}

export function deepseek(value: unknown): Reading {
  const result = reading(), rows = object(value)['balance_infos'];
  if (Array.isArray(rows)) for (const raw of rows) {
    const row = object(raw), amount = numeric(row['total_balance']), currency = row['currency'];
    if (amount !== undefined && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) && !result.balances.some(item => item.currency === currency)) {
      result.balances.push(balance(`balance.${currency}`, currency, amount));
    }
  }
  return requireReading(result);
}

export function kimi(value: unknown): Reading {
  const d = object(value), usages = object(d['usages']), result = reading();
  for (const [key, id, label] of [['limit_5h', '5h', '5h'], ['limit_7d', '7d', '7d'], ['limit_month_total', 'monthly', '月度总额'], ['limit_month_code', 'monthly.coding', '月度编程']] as const) {
    const w = object(usages[key]), n = numeric(w['used_ratio']);
    if (n !== undefined && n >= 0 && n <= 1) window(result, id, label, (1 - n) * 100, w['reset_time']);
  }
  const wallet = object(d['boosterWallet']), booster = object(wallet['balance']), currency = object(wallet['monthlyChargeLimit'])['currency'] ?? object(wallet['monthlyUsed'])['currency'];
  const amount = numeric(booster['amountLeft']);
  if (booster['type'] === 'BOOSTER' && amount !== undefined && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) {
    result.balances.push(balance('kimi.booster', currency, amount / 100_000_000, { label: 'Booster' }));
  }
  return requireReading(result);
}

export function glm(value: unknown): Reading {
  const d = object(value), limits = object(d['data'])['limits'], result = reading();
  if (d['success'] === false || d['code'] !== undefined && numeric(d['code']) !== 200) throw new QuotaError('schema_mismatch');
  if (Array.isArray(limits)) for (const raw of limits) {
    const w = object(raw), type = w['type'];
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT' && type !== 'TIME_LIMIT') continue;
    const unit = numeric(w['unit']), count = numeric(w['number']);
    const label = unit === 3 && count === 5 ? '5h' : unit === 6 && count === 1 ? '7d' : type === 'TIME_LIMIT' ? '工具额度' : '用量额度';
    const id = (label === '5h' || label === '7d') && !result.windows.some(item => item.id === label) ? label : `glm.${type}.${unit ?? ''}.${count ?? ''}`;
    usedWindow(result, id, label, w['percentage'], w['nextResetTime']);
  }
  return requireReading(result);
}

export function minimax(value: unknown, modelIds: readonly string[]): Reading {
  const d = object(value), status = numeric(object(d['base_resp'])['status_code']), result = reading();
  if (object(d['base_resp'])['status_code'] !== undefined && status !== 0) throw new QuotaError(status === 2057 || status === 2062 ? 'unsupported' : 'schema_mismatch');
  const seen = new Set<string>();
  if (Array.isArray(d['model_remains'])) for (const raw of d['model_remains']) {
    const w = object(raw), model = typeof w['model_name'] === 'string' ? w['model_name'] : undefined;
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const index = modelIds.indexOf(model);
    if (model !== 'general' && modelIds.length > 0 && index < 0) continue;
    const ids = index >= 0 ? [modelIds[index]!] : undefined;
    const key = model === 'general' ? 'general' : index >= 0 ? `${index}` : `other-${seen.size}`;
    for (const weekly of [false, true]) {
      const prefix = weekly ? 'current_weekly_' : 'current_interval_';
      const start = weekly ? w['weekly_start_time'] : w['start_time'], end = weekly ? w['weekly_end_time'] : w['end_time'];
      const startAt = instant(start), endAt = instant(end);
      const duration = startAt !== undefined && endAt !== undefined ? endAt - startAt : undefined;
      const label = weekly ? '7d' : duration === 18_000_000 ? '5h' : duration === 86_400_000 ? '1d' : '当前窗口';
      const id = model === 'general' && (label === '5h' || label === '7d') ? label : `minimax.${key}.${weekly ? 'weekly' : 'interval'}`;
      if (numeric(w[`${prefix}status`]) === 3) {
        result.balances.push(balance(`minimax.${key}.${weekly ? 'weekly' : 'interval'}`, 'POINTS', 0, { label, unlimited: true }));
      } else if (!weekly || w['weekly_boost_permille'] === undefined || numeric(w['weekly_boost_permille']) === 1000) {
        window(result, id, label, percent(w[`${prefix}remaining_percent`]), end, ids, start);
      }
    }
  }
  return requireReading(result);
}

export function devin(value: unknown): Reading {
  const d = object(value), status = object(d['userStatus'] ?? d['user_status']), plan = object(status['planStatus'] ?? status['plan_status']), result = reading();
  for (const [period, id, label] of [['daily', 'daily', '1d'], ['weekly', '7d', '7d']] as const) {
    const left = percent(plan[`${period}QuotaRemainingPercent`] ?? plan[`${period}_quota_remaining_percent`]);
    window(result, id, label, left, plan[`${period}QuotaResetAtUnix`] ?? plan[`${period}_quota_reset_at_unix`]);
  }
  const micros = numeric(plan['overageBalanceMicros'] ?? plan['overage_balance_micros']);
  if (micros !== undefined) result.balances.push(balance('balance.USD', 'USD', micros / 1_000_000));
  return requireReading(result);
}

export function antigravity(value: unknown, modelIds: readonly string[]): Reading {
  const models = object(object(value)['models']), result = reading();
  for (const [index, id] of modelIds.entries()) {
    const quota = object(object(models[id])['quotaInfo']), left = numeric(quota['remainingFraction']);
    if (left !== undefined && left >= 0 && left <= 1) window(result, `antigravity.${index}`, '模型额度', left * 100, quota['resetTime'], [id]);
  }
  return requireReading(result);
}
