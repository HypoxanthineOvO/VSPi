import { Input, Key, matchesKey } from "@moonshot-ai/pi-tui";
import type { SubagentModelEdit, SubagentModelPreferences } from "../backend/types.js";
import type { ModelOption } from "../domain/types.js";
import { padLine, stripAnsi, truncateToWidth, wrapTextWithAnsi } from "./ansi.js";
import type { VspiTheme } from "./theme.js";

interface Candidate {
	alias: string;
	label: string;
	available: boolean;
}

export class SubagentModelsPanel {
	private models: readonly ModelOption[] = [];
	private preferences: SubagentModelPreferences = { models: {} };
	private readonly search = new Input();
	private readonly purpose = new Input();
	private selected = 0;
	private editingAlias: string | undefined;
	private candidateCache: Candidate[] | undefined;

	open(): void {
		this.search.setValue("");
		this.selected = 0;
		this.editingAlias = undefined;
		this.candidateCache = undefined;
	}

	setModels(models: readonly ModelOption[]): void {
		const alias = this.candidates()[this.selected]?.alias;
		this.models = models;
		this.candidateCache = undefined;
		this.selected = Math.max(0, this.candidates().findIndex((candidate) => candidate.alias === alias));
	}

	setPreferences(preferences: SubagentModelPreferences): void {
		const alias = this.candidates()[this.selected]?.alias;
		this.preferences = structuredClone(preferences);
		this.candidateCache = undefined;
		this.selected = Math.max(0, this.candidates().findIndex((candidate) => candidate.alias === alias));
	}

	handleInput(data: string): SubagentModelEdit | "close" | undefined {
		if (this.editingAlias !== undefined) {
			if (matchesKey(data, Key.escape)) { this.editingAlias = undefined; return; }
			if (matchesKey(data, Key.enter)) {
				const model = this.editingAlias;
				this.editingAlias = undefined;
				return { action: "purpose", model, purpose: this.purpose.getValue().trim() };
			}
			this.purpose.handleInput(data);
			if (this.purpose.getValue().length > 4000) this.purpose.setValue(this.purpose.getValue().slice(0, 4000));
			return;
		}
		if (matchesKey(data, Key.escape)) return "close";
		const candidates = this.candidates();
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const delta = matchesKey(data, Key.up) ? -1 : 1;
			this.selected = Math.max(0, Math.min(candidates.length - 1, this.selected + delta));
			return;
		}
		const candidate = candidates[this.selected];
		if (candidate && !this.preferences.force) {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) return { action: "toggle", model: candidate.alias };
			if (matchesKey(data, Key.ctrl("d"))) return { action: "default", model: candidate.alias };
			if (matchesKey(data, Key.ctrl("p"))) {
				this.editingAlias = candidate.alias;
				this.purpose.setValue(this.preferences.models[candidate.alias] ?? "");
				return;
			}
		}
		const query = this.search.getValue();
		this.search.handleInput(data);
		if (this.search.getValue().length > 500) this.search.setValue(this.search.getValue().slice(0, 500));
		if (this.search.getValue() !== query) {
			this.selected = 0;
			this.candidateCache = undefined;
		}
	}

	render(width: number, rows: number, theme: VspiTheme): string[] {
		if (this.editingAlias !== undefined) return [
			theme.bold(truncateToWidth(Object.hasOwn(this.preferences.models, this.editingAlias) ? "模型能力 / 用途" : "编辑能力（保存后加入候选）", width)),
			truncateToWidth(stripAnsi(this.editingAlias), width),
			...this.purpose.render(width),
		].slice(0, rows);
		const candidates = this.candidates();
		const current = candidates[this.selected];
		const count = Object.keys(this.preferences.models).length;
		const header = this.preferences.force
			? "secondary_model.force=true；候选池只读，请先在 core 配置中关闭 force"
			: count === 0 ? "secondary_model · 未配置候选池，继承主模型" : `secondary_model · ${count} 个候选`;
		const prefix = [
			...wrapTextWithAnsi(theme.muted(header), width),
			truncateToWidth(`搜索：${stripAnsi(this.search.getValue())}`, width),
		];
		const detail = current
			? wrapTextWithAnsi(theme.muted(`能力：${stripAnsi(this.preferences.models[current.alias] ?? "尚未填写")}`), width).slice(0, 2)
			: [];
		const listRows = Math.max(1, rows - prefix.length - detail.length);
		const start = Math.max(0, Math.min(this.selected - Math.floor(listRows / 2), candidates.length - listRows));
		const list = candidates.slice(start, start + listRows).map((candidate, index) => {
			const enabled = Object.hasOwn(this.preferences.models, candidate.alias);
			const primary = this.preferences.defaultModel === candidate.alias ? " · 默认" : "";
			const status = candidate.available ? "" : " · 接入暂不可用";
			const line = padLine(truncateToWidth(`${enabled ? "[x]" : "[ ]"} ${stripAnsi(candidate.alias)}${primary}${status}`, width), width);
			return start + index === this.selected ? theme.selected(line) : line;
		});
		if (list.length === 0) list.push(theme.muted("没有匹配模型；请先配置 Provider"));
		return [...prefix, ...list, ...detail].slice(0, rows);
	}

	hint(): string {
		if (this.editingAlias !== undefined) return "输入能力描述  Enter 保存  Esc 取消";
		if (this.preferences.force) return "↑↓ 浏览  输入搜索  Esc 关闭";
		return "↑↓ 选择  Enter 加入/移除  Ctrl+D 默认  Ctrl+P 能力  输入搜索  Esc 关闭";
	}

	private candidates(): Candidate[] {
		if (this.candidateCache) return this.candidateCache;
		const byAlias = new Map(this.models.map((model) => {
			const alias = model.alias ?? `${model.provider ?? model.brand}/${model.id}`;
			return [alias, { alias, label: model.label, available: true }];
		}));
		for (const alias of Object.keys(this.preferences.models)) {
			if (!byAlias.has(alias)) byAlias.set(alias, { alias, label: alias, available: false });
		}
		const query = this.search.getValue().trim().toLowerCase();
		this.candidateCache = [...byAlias.values()]
			.filter((candidate) => `${candidate.alias} ${candidate.label}`.toLowerCase().includes(query))
			.toSorted((left, right) => Number(Object.hasOwn(this.preferences.models, right.alias)) - Number(Object.hasOwn(this.preferences.models, left.alias)) || left.alias.localeCompare(right.alias));
		return this.candidateCache;
	}
}
