import type { AppSettings, UsageSnapshot } from "./types.js";

export const FX = {
  currency: "CNY",
  source: "中国外汇交易中心参考价",
  asOf: "2026-07-23",
  fxRate: 7.18,
} as const;

export const DEFAULT_USAGE: UsageSnapshot = {
  contextTokens: 0,
  contextWindow: 0,
  contextPercent: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  currency: "CNY",
  source: FX.source,
  asOf: FX.asOf,
  fxRate: FX.fxRate,
};

export const DEFAULT_SETTINGS: AppSettings = {
  scope: "project",
  theme: "Terminal",
  reducedMotion: false,
  thinkingDisplay: "collapsed",
  thinkingTranslationEndpoint: "",
  wrapCode: false,
  collapseTools: true,
  bridgeEnabled: true,
};
