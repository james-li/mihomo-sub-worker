import type { TaggedProxy } from "./clash";
import { mapConcurrent } from "./concurrency";
import { fetchTextCached } from "./upstream";

const GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance"]);
const BUILTIN_GROUPS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS"]);

interface RuleSetDefinition {
	group: string;
	source: string;
}

interface GroupDefinition {
	name: string;
	type: string;
	explicitMembers: string[];
	nameExpressions: string[];
	tags: string[];
	testUrl?: string;
	interval?: number;
	tolerance?: number;
}

export interface AclDefinition {
	ruleSets: RuleSetDefinition[];
	groups: GroupDefinition[];
}

export interface CompiledAcl {
	groups: Array<Record<string, unknown>>;
	rules: string[];
}

export class AclError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}

function parseGroup(line: string): GroupDefinition {
	const fields = line.slice(line.indexOf("=") + 1).split("`");
	const name = fields.shift()?.trim() ?? "";
	const type = fields.shift()?.trim() ?? "";
	if (!name || !GROUP_TYPES.has(type)) throw new AclError("invalid_proxy_group");

	const explicitMembers: string[] = [];
	const nameExpressions: string[] = [];
	const tags: string[] = [];
	let testUrl: string | undefined;
	let interval: number | undefined;
	let tolerance: number | undefined;

	for (const field of fields) {
		const token = field.trim();
		if (!token) continue;
		if (token.startsWith("[]")) {
			explicitMembers.push(token.slice(2));
			continue;
		}
		if (token.startsWith("!!TAG=")) {
			tags.push(
				...token
					.slice("!!TAG=".length)
					.split(",")
					.map((tag) => tag.trim().toUpperCase())
					.filter(Boolean),
			);
			continue;
		}
		if (/^https?:\/\//i.test(token)) {
			testUrl = token;
			continue;
		}
		if (testUrl && /^\d+(?:,,\d+)?$/.test(token)) {
			const [intervalValue, toleranceValue] = token.split(",,");
			interval = Number(intervalValue);
			if (toleranceValue) tolerance = Number(toleranceValue);
			continue;
		}
		nameExpressions.push(token);
	}

	return {
		name,
		type,
		explicitMembers,
		nameExpressions,
		tags: [...new Set(tags)],
		testUrl,
		interval,
		tolerance,
	};
}

export function parseAclIni(text: string): AclDefinition {
	const ruleSets: RuleSetDefinition[] = [];
	const groups: GroupDefinition[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith(";") || line.startsWith("#")) continue;
		if (line.startsWith("ruleset=") || line.startsWith("surge_ruleset=")) {
			const value = line.slice(line.indexOf("=") + 1);
			const separator = value.indexOf(",");
			if (separator <= 0) throw new AclError("invalid_ruleset");
			ruleSets.push({
				group: value.slice(0, separator).trim(),
				source: value.slice(separator + 1).trim(),
			});
		} else if (line.startsWith("custom_proxy_group=")) {
			groups.push(parseGroup(line));
		}
	}
	if (groups.length === 0) throw new AclError("missing_proxy_groups");
	if (new Set(groups.map((group) => group.name)).size !== groups.length) {
		throw new AclError("duplicate_proxy_group");
	}
	return { ruleSets, groups };
}

function matchesNameExpression(name: string, expression: string): boolean {
	const terms = expression.split("&&").map((term) => term.trim()).filter(Boolean);
	if (terms.length === 0) throw new AclError("invalid_name_expression");
	return terms.every((term) => {
		const negated = term.startsWith("!");
		const pattern = negated ? term.slice(1) : term;
		if (!pattern) throw new AclError("invalid_name_expression");
		let matches: boolean;
		try {
			matches = new RegExp(pattern).test(name);
		} catch {
			throw new AclError("invalid_name_expression");
		}
		return negated ? !matches : matches;
	});
}

export function matchesGroup(proxy: TaggedProxy, group: GroupDefinition): boolean {
	const hasFilter = group.nameExpressions.length > 0 || group.tags.length > 0;
	const matchesNames =
		group.nameExpressions.length === 0 ||
		group.nameExpressions.every((expression) =>
			matchesNameExpression(proxy.proxy.name, expression),
		);
	const matchesTags =
		group.tags.length === 0 || group.tags.some((tag) => proxy.tags.includes(tag));
	return hasFilter && matchesNames && matchesTags;
}

function compileGroups(
	definitions: GroupDefinition[],
	proxies: TaggedProxy[],
): Array<Record<string, unknown>> {
	let compiled = definitions.map((definition) => {
		const matchedNames = proxies
			.filter((proxy) => matchesGroup(proxy, definition))
			.map((proxy) => proxy.proxy.name);
		const members = [...new Set([...definition.explicitMembers, ...matchedNames])];
		const group: Record<string, unknown> = {
			name: definition.name,
			type: definition.type,
			proxies: members,
		};
		if (definition.type !== "select") {
			if (!definition.testUrl) throw new AclError("missing_group_test_url");
			group.url = definition.testUrl;
			group.interval = definition.interval ?? 300;
			if (definition.tolerance !== undefined) group.tolerance = definition.tolerance;
		}
		return group;
	});

	let changed = true;
	while (changed) {
		changed = false;
		const available = new Set(compiled.map((group) => group.name as string));
		const next = compiled
			.map((group) => ({
				...group,
				proxies: (group.proxies as string[]).filter(
					(member) =>
						BUILTIN_GROUPS.has(member) ||
						available.has(member) ||
						proxies.some((proxy) => proxy.proxy.name === member),
				),
			}))
			.filter((group) => (group.proxies as string[]).length > 0);
		changed =
			next.length !== compiled.length ||
			next.some(
				(group, index) =>
					JSON.stringify(group.proxies) !== JSON.stringify(compiled[index]?.proxies),
			);
		compiled = next;
	}
	return compiled;
}

function assertNoGroupCycles(groups: Array<Record<string, unknown>>): void {
	const graph = new Map(
		groups.map((group) => [
			group.name as string,
			(group.proxies as string[]).filter((member) =>
				groups.some((candidate) => candidate.name === member),
			),
		]),
	);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (name: string) => {
		if (visiting.has(name)) throw new AclError("proxy_group_cycle");
		if (visited.has(name)) return;
		visiting.add(name);
		for (const child of graph.get(name) ?? []) visit(child);
		visiting.delete(name);
		visited.add(name);
	};
	for (const name of graph.keys()) visit(name);
}

function appendRuleGroup(rule: string, group: string): string {
	if (rule.endsWith(",no-resolve")) {
		return `${rule.slice(0, -",no-resolve".length)},${group},no-resolve`;
	}
	return `${rule},${group}`;
}

async function compileRuleSet(definition: RuleSetDefinition): Promise<string[]> {
	if (definition.source.startsWith("[]")) {
		const inline = definition.source.slice(2);
		if (inline === "FINAL") return [`MATCH,${definition.group}`];
		return [appendRuleGroup(inline, definition.group)];
	}
	if (!/^https:\/\//i.test(definition.source)) {
		throw new AclError("invalid_ruleset_source");
	}
	const { text } = await fetchTextCached(definition.source, "ruleset");
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && !line.startsWith(";"))
		.map((line) => appendRuleGroup(line, definition.group));
}

export async function compileAcl(
	definition: AclDefinition,
	proxies: TaggedProxy[],
): Promise<CompiledAcl> {
	const groups = compileGroups(definition.groups, proxies);
	assertNoGroupCycles(groups);
	const availableTargets = new Set([
		...groups.map((group) => group.name as string),
		...BUILTIN_GROUPS,
	]);
	for (const ruleSet of definition.ruleSets) {
		if (!availableTargets.has(ruleSet.group)) {
			throw new AclError("missing_ruleset_target");
		}
	}
	const ruleLists = await mapConcurrent(definition.ruleSets, 4, compileRuleSet);
	return { groups, rules: ruleLists.flat() };
}
