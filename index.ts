/**
 * Council of Ricks — spawn parallel reviewers for independent second opinions.
 *
 * Each reviewer runs as an isolated pi process with fresh context.
 * Returns structured verdicts (APPROVE / CONCERNS / BLOCK) with notes.
 *
 * Usage:
 *   LLM calls `council` tool with a topic
 *   User runs `/council <topic>` command
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Reviewer definitions ─────────────────────────────────────────────

interface Reviewer {
	name: string;
	prompt: string;
}

const REVIEWERS: Reviewer[] = [
	{
		name: "security",
		prompt: `You are a security reviewer. Focus on: authentication, authorization, input validation, injection risks, secret handling, trust boundaries, cryptographic correctness.

Respond with exactly this format:
VERDICT: APPROVE | CONCERNS | BLOCK
NOTES:
- (bullet points explaining your reasoning)`,
	},
	{
		name: "performance",
		prompt: `You are a performance reviewer. Focus on: algorithmic complexity, unnecessary allocations, I/O patterns, caching opportunities, N+1 queries, memory pressure, hot paths.

Respond with exactly this format:
VERDICT: APPROVE | CONCERNS | BLOCK
NOTES:
- (bullet points explaining your reasoning)`,
	},
	{
		name: "architecture",
		prompt: `You are an architecture reviewer. Focus on: separation of concerns, coupling, API contracts, error propagation, module boundaries, naming, abstractions (too many or too few).

Respond with exactly this format:
VERDICT: APPROVE | CONCERNS | BLOCK
NOTES:
- (bullet points explaining your reasoning)`,
	},
	{
		name: "testing",
		prompt: `You are a testing reviewer. Focus on: coverage of failure paths, assertion quality, test isolation, mocking boundaries, flakiness risk, missing edge cases.

Respond with exactly this format:
VERDICT: APPROVE | CONCERNS | BLOCK
NOTES:
- (bullet points explaining your reasoning)`,
	},
];

// ── Helpers ───────────────────────────────────────────────────────────

interface ReviewResult {
	reviewer: string;
	verdict: "APPROVE" | "CONCERNS" | "BLOCK" | "ERROR";
	notes: string[];
	raw: string;
}

function parseVerdict(output: string): ReviewResult["verdict"] {
	const match = output.match(/VERDICT:\s*(APPROVE|CONCERNS|BLOCK)/i);
	if (!match) return "ERROR";
	return match[1].toUpperCase() as ReviewResult["verdict"];
}

function parseNotes(output: string): string[] {
	const notesMatch = output.match(/NOTES:\s*\n([\s\S]*?)$/i);
	if (!notesMatch) return [];
	return notesMatch[1]
		.split("\n")
		.map((line) => line.replace(/^\s*-\s*/, "").trim())
		.filter((line) => line.length > 0);
}

function parseResult(reviewer: string, output: string): ReviewResult {
	return {
		reviewer,
		verdict: parseVerdict(output),
		notes: parseNotes(output),
		raw: output,
	};
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(name: string, prompt: string): Promise<string> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-council-"));
	const filePath = path.join(tmpDir, `${name}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return filePath;
}

// ── Run one reviewer ──────────────────────────────────────────────────

async function runReviewer(
	reviewer: Reviewer,
	topic: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<ReviewResult> {
	const args = ["--mode", "json", "-p", "--no-session"];

	const tmpPath = await writePromptToTempFile(reviewer.name, reviewer.prompt);
	args.push("--append-system-prompt", tmpPath);
	args.push(`Review the following:\n\n${topic}`);

	let output = "";
	let exitCode = 1;

	try {
		exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							const text = getFinalOutput([event.message]);
							if (text) output = text;
						}
					} catch {
						// skip non-JSON lines
					}
				}
			});

			proc.stderr.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_end" && event.message?.role === "assistant") {
							const text = getFinalOutput([event.message]);
							if (text) output = text;
						}
					} catch {}
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
	} finally {
		try {
			fs.unlinkSync(tmpPath);
			fs.rmdirSync(path.dirname(tmpPath));
		} catch {}
	}

	if (!output) {
		return {
			reviewer: reviewer.name,
			verdict: "ERROR",
			notes: [exitCode !== 0 ? `Process exited with code ${exitCode}` : "No output from reviewer"],
			raw: "",
		};
	}

	return parseResult(reviewer.name, output);
}

// ── Aggregate results ─────────────────────────────────────────────────

function formatResults(results: ReviewResult[]): string {
	const lines: string[] = [];

	for (const r of results) {
		const icon = r.verdict === "APPROVE" ? "✓" : r.verdict === "BLOCK" ? "✗" : r.verdict === "ERROR" ? "!" : "◐";
		lines.push(`**${r.reviewer}** — ${icon} ${r.verdict}`);
		for (const note of r.notes) {
			lines.push(`  - ${note}`);
		}
		lines.push("");
	}

	// Summary line
	const counts = { APPROVE: 0, CONCERNS: 0, BLOCK: 0, ERROR: 0 };
	for (const r of results) counts[r.verdict]++;

	const summaryParts: string[] = [];
	if (counts.APPROVE) summaryParts.push(`${counts.APPROVE} approved`);
	if (counts.CONCERNS) summaryParts.push(`${counts.CONCERNS} raised concerns`);
	if (counts.BLOCK) summaryParts.push(`${counts.BLOCK} blocked`);
	if (counts.ERROR) summaryParts.push(`${counts.ERROR} errored`);

	lines.push("---");
	lines.push(summaryParts.join(", ") || "No results");

	return lines.join("\n");
}

// ── Extension entry point ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const reviewerNames = REVIEWERS.map((r) => r.name);

	pi.registerTool({
		name: "council",
		label: "Council of Ricks",
		description:
			"Spawn parallel independent reviewers for a second opinion. Each reviewer sees the topic with fresh context and returns a verdict (APPROVE/CONCERNS/BLOCK) with notes.",
		parameters: Type.Object({
			topic: Type.String({
				description: "What to review — a diff, plan, code snippet, or question",
			}),
			members: Type.Optional(
				Type.Array(StringEnum(reviewerNames as [string, ...string[]]), {
					description: `Which reviewers to summon. Default: all. Options: ${reviewerNames.join(", ")}`,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const selectedNames = params.members ?? reviewerNames;
			const selected = REVIEWERS.filter((r) => selectedNames.includes(r.name));

			if (selected.length === 0) {
				return {
					content: [{ type: "text", text: `No valid reviewers. Available: ${reviewerNames.join(", ")}` }],
					details: { results: [] },
					isError: true,
				};
			}

			// Track results for streaming updates
			const results: (ReviewResult | null)[] = selected.map(() => null);
			let completed = 0;

			const emitUpdate = () => {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Council: ${completed}/${selected.length} reviewers done...`,
						},
					],
					details: { results: results.filter(Boolean) },
				});
			};

			// Run all reviewers in parallel
			const settled = await Promise.allSettled(
				selected.map(async (reviewer, i) => {
					const result = await runReviewer(reviewer, params.topic, ctx.cwd, signal);
					results[i] = result;
					completed++;
					emitUpdate();
					return result;
				}),
			);

			const finalResults = settled.map((s, i) => {
				if (s.status === "fulfilled") return s.value;
				return {
					reviewer: selected[i].name,
					verdict: "ERROR" as const,
					notes: [s.reason?.message ?? "Unknown error"],
					raw: "",
				};
			});

			return {
				content: [{ type: "text", text: formatResults(finalResults) }],
				details: { results: finalResults },
			};
		},

		renderCall(args, theme) {
			const members = args.members ?? reviewerNames;
			const preview = args.topic
				? args.topic.length > 80
					? `${args.topic.slice(0, 80)}...`
					: args.topic
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("council ")) +
				theme.fg("accent", `(${members.length} reviewers)`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { results: ReviewResult[] } | undefined;
			const results = details?.results ?? [];

			if (results.length === 0) {
				return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
			}

			const verdictIcon = (v: ReviewResult["verdict"]) => {
				switch (v) {
					case "APPROVE":
						return theme.fg("success", "✓");
					case "BLOCK":
						return theme.fg("error", "✗");
					case "ERROR":
						return theme.fg("error", "!");
					default:
						return theme.fg("warning", "◐");
				}
			};

			if (expanded) {
				const container = new Container();
				for (const r of results) {
					container.addChild(
						new Text(
							`${verdictIcon(r.verdict)} ${theme.fg("toolTitle", theme.bold(r.reviewer))} ${theme.fg("muted", `— ${r.verdict}`)}`,
							0,
							0,
						),
					);
					for (const note of r.notes) {
						container.addChild(new Text(theme.fg("dim", `  - ${note}`), 0, 0));
					}
					container.addChild(new Spacer(1));
				}
				return container;
			}

			// Collapsed: summary line
			const counts = { APPROVE: 0, CONCERNS: 0, BLOCK: 0, ERROR: 0 };
			for (const r of results) counts[r.verdict]++;

			let text = theme.fg("toolTitle", theme.bold("council "));
			if (counts.APPROVE) text += theme.fg("success", `✓${counts.APPROVE} `);
			if (counts.CONCERNS) text += theme.fg("warning", `◐${counts.CONCERNS} `);
			if (counts.BLOCK) text += theme.fg("error", `✗${counts.BLOCK} `);
			if (counts.ERROR) text += theme.fg("error", `!${counts.ERROR} `);

			text += "\n" + theme.fg("muted", "(Ctrl+O to expand)");
			return new Text(text, 0, 0);
		},
	});

	// Convenience command
	pi.registerCommand("council", {
		description: "Summon the Council of Ricks for a second opinion",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /council <topic to review>", "warning");
				return;
			}
			// Inject as a user message so the LLM calls the tool
			pi.sendUserMessage(`Use the council tool to review: ${args}`);
		},
	});
}
