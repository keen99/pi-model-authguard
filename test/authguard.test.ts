import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const smPath = join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "settings-manager.js");
const { SettingsManager } = require(smPath);

const { default: authguard } = await import("../index.js");

// ── harness ─────────────────────────────────────────────────────────────
function harness(opts: { model?: any; authed?: boolean; available?: any[]; setModel?: any } = {}) {
	const notifies: Array<{ text: string; level: string }> = [];
	const setModelCalls: any[] = [];
	const proto = SettingsManager.prototype as any;
	const original = proto.setDefaultModelAndProvider;
	let persistCalls = 0;

	const fakePi: any = {
		on: (ev: string, fn: any) => { handlers[ev] = fn; },
		setModel: async (m: any) => {
			setModelCalls.push(m);
			// Simulate pi: switching model normally persists the global default.
			proto.setDefaultModelAndProvider("some-provider", "some-id");
			if (opts.setModel === "reject") return false;
			if (opts.setModel === "throw") throw new Error("boom");
			return true;
		},
	};
	const handlers: Record<string, any> = {};
	const ctx: any = {
		model: opts.model,
		modelRegistry: {
			hasConfiguredAuth: () => opts.authed ?? true,
			getAvailable: () => opts.available ?? [],
		},
		ui: { notify: (text: string, level: string) => notifies.push({ text, level }) },
	};
	// count real persist calls
	proto.setDefaultModelAndProvider = function (...a: any[]) { persistCalls++; return original.apply(this, a); };

	authguard(fakePi);

	return {
		sessionStart: () => handlers.session_start({}, ctx),
		notifies,
		setModelCalls,
		persistCallsRef: () => persistCalls,
		restore: () => { proto.setDefaultModelAndProvider = original; },
	};
}

const M = (provider: string, id: string) => ({ provider, id });

test("no ctx.model → no-op", async () => {
	const h = harness({ model: null });
	await h.sessionStart();
	assert.equal(h.notifies.length, 0);
	assert.equal(h.setModelCalls.length, 0);
	h.restore();
});

test("authed model → no-op", async () => {
	const h = harness({ model: M("openai", "gpt-5.5"), authed: true });
	await h.sessionStart();
	assert.equal(h.notifies.length, 0);
	assert.equal(h.setModelCalls.length, 0);
	h.restore();
});

test("unauthed, no authed provider serves same id → error notify, no substitution", async () => {
	const h = harness({
		model: M("azure-openai-responses", "gpt-5.5"),
		authed: false,
		available: [M("openai-codex", "other-model")],
	});
	await h.sessionStart();
	assert.equal(h.notifies.length, 1);
	assert.equal(h.notifies[0].level, "error");
	assert.match(h.notifies[0].text, /no authed provider serves model "gpt-5\.5"/);
	assert.equal(h.setModelCalls.length, 0);
	h.restore();
});

test("unauthed + same id on authed provider → redirected, persist swallowed, prototype restored", async () => {
	const replacement = M("openai-codex", "gpt-5.5");
	const h = harness({
		model: M("azure-openai-responses", "gpt-5.5"),
		authed: false,
		available: [replacement, M("openai", "something-else")],
	});
	const proto = SettingsManager.prototype as any;
	const original = proto.setDefaultModelAndProvider;

	await h.sessionStart();

	// redirect happened
	assert.equal(h.setModelCalls.length, 1);
	assert.deepEqual(h.setModelCalls[0], replacement);
	assert.equal(h.notifies[0].level, "info");
	assert.match(h.notifies[0].text, /Switched to openai-codex\/gpt-5\.5/);

	// pi's persist call inside setModel was swallowed by the patch
	assert.equal(h.persistCallsRef(), 0, "setDefaultModelAndProvider never executed");

	// prototype restored to the real implementation afterwards
	assert.equal(proto.setDefaultModelAndProvider, original);
	// and it works again (stub this: real impl writes this.globalSettings + marks/saves)
	proto.setDefaultModelAndProvider.call({ globalSettings: {}, markModified() {}, save() {} }, "p", "m");
	assert.equal(h.persistCallsRef(), 1, "restored implementation runs");
	proto.setDefaultModelAndProvider = original;
	h.restore();
});

test("setModel returns false → rejected notify, prototype restored", async () => {
	const h = harness({
		model: M("a", "x"),
		authed: false,
		available: [M("b", "x")],
		setModel: "reject",
	});
	const proto = SettingsManager.prototype as any;
	const original = proto.setDefaultModelAndProvider;

	await h.sessionStart();
	assert.equal(h.notifies[0].level, "error");
	assert.match(h.notifies[0].text, /rejected the replacement/);
	assert.equal(proto.setDefaultModelAndProvider, original);
	h.restore();
});

test("setModel throws → failed notify, prototype restored", async () => {
	const h = harness({
		model: M("a", "x"),
		authed: false,
		available: [M("b", "x")],
		setModel: "throw",
	});
	const proto = SettingsManager.prototype as any;
	const original = proto.setDefaultModelAndProvider;

	await h.sessionStart();
	assert.equal(h.notifies[0].level, "error");
	assert.match(h.notifies[0].text, /authguard failed: boom/);
	assert.equal(proto.setDefaultModelAndProvider, original);
	h.restore();
});

test("model id match is exact, not prefix", async () => {
	const h = harness({
		model: M("a", "gpt-5"),
		authed: false,
		available: [M("b", "gpt-5.5"), M("c", "gpt-5-turbo")],
	});
	await h.sessionStart();
	assert.equal(h.setModelCalls.length, 0, "no near-id substitution");
	assert.equal(h.notifies[0].level, "error");
	h.restore();
});
