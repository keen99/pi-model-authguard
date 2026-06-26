/**
 * pi-model-authguard
 *
 * Prevents pi from using a model on a provider with no auth.
 *
 * Problem: pi's initial model resolution has two paths that resolve against the
 * FULL model list (getAll()/find()), not the auth-filtered list (getAvailable()):
 *   1. resolveCliModel()  -> `pi --model X` / `pi --provider P --model X`
 *   2. findInitialModel() -> saved default from settings.json
 * Both can land on a provider with no API key, then fail at request time.
 *
 * Interactive /model and model cycling (Ctrl+P) already filter by auth, so
 * they are safe; this extension does not touch them.
 *
 * Root cause: many model IDs exist on MULTIPLE providers in pi's built-in
 * registry (e.g. "gpt-5.5" on both azure-openai-responses and openai-codex).
 * `pi --list-models` shows only authed providers, but `pi --model gpt-5.5`
 * resolves against all of them and can pick the unauthed duplicate.
 *
 * This bites hardest when LLMs call external agents (pi subagents, codex,
 * claude, etc.): they pick models by bare name with no knowledge of which
 * providers are authed on your machine, then fail mid-task with a key error.
 *
 * Fix: at session_start, inspect ctx.model. If unauthed, look for the SAME
 * model id on an authed provider and switch to that. If none exists, notify
 * and leave pi's pick alone (do NOT swap to an unrelated model).
 *
 * Scope is intentionally narrow: never silently substitute a different model.
 * If you ask for X and no authed provider serves X, you get told, not rerouted
 * to something you didn't ask for.
 *
 * --api-key is preserved automatically: setRuntimeApiKey() runs before
 * session_start, so hasConfiguredAuth() returns true for that provider and no
 * redirect happens.
 *
 * NO PERSISTENCE SIDE EFFECT: pi's only model-switch API for extensions
 * (pi.setModel()) unconditionally writes the chosen model to settings.json as
 * the new global default. That changes baked-in behavior for anyone using this.
 * To avoid it, we monkeypatch SettingsManager.prototype.setDefaultModelAndProvider
 * to a no-op for the duration of our setModel() call, then restore it. The
 * active session model still switches (agent.state.model is set directly), but
 * the on-disk global default is left untouched.
 *
 * Zero config. No settings keys, no models.json required.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Path to the installed pi settings-manager module. The package's exports map
// blocks require.resolve on the package or any subpath. Resolve directly via
// the extension's own location: pi-coding-agent sits in ./node_modules next to
// this file (it's a peerDependency the installer provides).
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const here = dirname(fileURLToPath(import.meta.url));
const smPath = join(
  here,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "settings-manager.js",
);
const require = createRequire(import.meta.url);
const { SettingsManager } = require(smPath);

type SetDefault = (provider: string, modelId: string) => void;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const current = ctx.model;

    // Authed (or no model to check) -> nothing to do.
    if (!current || ctx.modelRegistry.hasConfiguredAuth(current)) {
      return;
    }

    // Unauthed: look for same model id on an authed provider.
    const sameId = ctx.modelRegistry
      .getAvailable()
      .find((m) => m.id === current.id);

    if (!sameId) {
      // No authed copy of the requested model. Do not substitute.
      ctx.ui.notify(
        `No API key for ${current.provider}/${current.id}, and no authed provider serves model "${current.id}". Run \`pi /login\` or pick a different model.`,
        "error",
      );
      return;
    }

    // Monkeypatch setDefaultModelAndProvider -> no-op so pi.setModel() switches
    // the active session model WITHOUT persisting it as the new global default.
    const proto = SettingsManager.prototype as { setDefaultModelAndProvider: SetDefault };
    const original = proto.setDefaultModelAndProvider;
    proto.setDefaultModelAndProvider = function () {
      // intentionally swallow: do not persist global default on authguard redirect
    };

    try {
      const ok = await pi.setModel(sameId);
      if (!ok) {
        ctx.ui.notify("authguard: setModel rejected the replacement.", "error");
        return;
      }
      ctx.ui.notify(
        `No key for ${current.provider}/${current.id}. Switched to ${sameId.provider}/${sameId.id} (same model, authed provider).`,
        "info",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`authguard failed: ${msg}`, "error");
    } finally {
      // Always restore, even on error.
      proto.setDefaultModelAndProvider = original;
    }
  });
}
