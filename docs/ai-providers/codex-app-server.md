# Codex App Server Provider

Use `codex-app-server` to run GBrain reasoning and tool loops through the Codex
CLI's existing ChatGPT login. GBrain does not need an OpenAI API key and does
not read or copy Codex credentials.

## Setup

Install Codex, then sign in with ChatGPT:

```bash
codex login
gbrain config set models.default codex-app-server:gpt-5.6-sol
```

The provider starts a local `codex app-server` subprocess for each generation.
It uses an ephemeral thread, an empty temporary working directory, a read-only
sandbox, no network access, `approvalPolicy: never`, no configured MCP servers,
and hard-disabled Codex execution, browser, app, plugin, image, and agent tools.

For a GBrain tool loop, Codex returns one structured tool request at a time and
GBrain's existing loop executes and records it. The app-server process never
executes a GBrain tool itself.

## Separate brains

Personal and work brains retain independent databases and configuration. Run
the configuration command through each brain's normal CLI route; both can use
the same host's Codex login without sharing brain content.

## Verify

```bash
codex --version
gbrain providers
gbrain think --model codex-app-server:gpt-5.6-sol "Reply with READY"
```

If the provider reports that Codex is logged out, run `codex login` again. The
app-server protocol is experimental, so upgrade GBrain and Codex together if a
future Codex release changes the protocol.
