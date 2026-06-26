# pi-model-authguard

Pi extension that prevents CLI/startup model resolution from landing on a provider with no API key.

**The reason this exists:** pi's interactive TUI (`/model`, Ctrl+P) already filters models by auth --- but the CLI (`--model`) and saved-default paths do **not**. They resolve against the full model list and can pick an unauthed provider, then fail at request time.

## Why

| Path | Source pool | Auth-filtered? |
|------|-------------|---------------|
| Interactive `/model`, model cycling (Ctrl+P) | `getAvailable()` | yes (safe) |
| CLI `--model` flag | `getAll()` | **no** |
| Saved default from `settings.json` | `find()` | **no** |

The TUI already refuses unauthed providers. The CLI/startup paths do not --- they resolve against the full list (`getAll()` / `find()`), so they can land on a provider with no key.

### The concrete failure

Many model IDs exist on **multiple providers** in pi's built-in registry:

| Model ID | Provider | Authed? |
|----------|----------|---------|
| `gpt-5.5` | `azure-openai-responses` | no |
| `gpt-5.5` | `openai-codex` | yes |

`pi --list-models` shows only authed providers, so you see `openai-codex gpt-5.5` and assume it works. But `pi --model gpt-5.5` resolves against the full list, sees both, and the bare-id resolver can pick the **azure** variant --- the one with no key. Result:

```
No API key found for azure-openai-responses.
```

You never get the openai-codex version you have a key for.

### Why it matters

When **LLMs call external agents** (pi subagents, codex, claude, etc.), they pick models by bare name --- "gpt-5.5", "gpt-5.4". They have no knowledge of which providers are authed on your machine, and they don't pass `--provider`. A pick that *looks* valid silently routes to an unauthed provider and the call fails mid-task. The agent then errors out or burns retries.

This hits hardest in autonomous / chained workflows where no human is watching to re-pick the model.

## What it does

Hooks `session_start`, inspects `ctx.model`. If unauthed, looks for the **same model id** on an authed provider and switches to that.

A `ui.notify` announces the switch (or the failure) so it is visible, not silent.

## `--api-key` preserved

The CLI `--api-key` flag calls `setRuntimeApiKey()` in `main.js` *before* `session_start` fires. By the time this extension checks `hasConfiguredAuth()`, the runtime key is registered and the provider counts as authed. No redirect happens. No special-case needed.

## Install

Add to `settings.json`:

```json
{
  "packages": ["git:github.com/keen99/pi-model-authguard"]
}
```

Then `pi install` or restart pi.

## Limitations

- **No substitution.** If no authed provider serves the requested model id, authguard does not swap to a different model. It only corrects same-id cross-provider misroutes. Use `models.json` to enforce a provider for a model, or `pi /login` to add auth.
- **No persistence side effect.** `pi.setModel()` normally writes the chosen model to `settings.json` as the new global default (https://github.com/earendil-works/pi/issues/5976). This extension monkeypatches that write to a no-op during the redirect, so the on-disk default is left untouched. The active session model still switches.
- **CLI/startup only.** Interactive `/model` is already safe (TUI filters by auth), so not touched. This extension guards the `--model` and saved-default paths only.

## License

MIT
