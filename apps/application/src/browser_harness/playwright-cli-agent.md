# Playwright CLI Reference

This reference describes the Playwright CLI commands that are useful to agent-driven testing units in the web-testing worker.

The agent-driven workflow assigns one fixed browser session, provisions its authentication state, starts managed recording, and performs final cleanup. Use the assigned session without passing `--session` or `-s`. Do not use lifecycle commands such as `open`, `attach`, `detach`, `close`, `delete-data`, `close-all`, or `kill-all`. The worker reserves `show` and `video-stop` for harness use, and testing agents should not start a redundant recording.

## Core

```bash
pwcli goto https://example.com/account
pwcli snapshot
pwcli snapshot e5
pwcli click e3
pwcli dblclick e7
pwcli type "search terms"
pwcli press Enter
pwcli fill e5 "user@example.com"
pwcli drag e2 e8
pwcli drop e8 --path=/workspace/document.pdf
pwcli drop e8 --data="text/plain=example"
pwcli hover e4
pwcli select e9 "option-value"
pwcli upload ./document.pdf
pwcli check e12
pwcli uncheck e12
pwcli eval "document.title"
pwcli eval "el => el.textContent" e5
pwcli dialog-accept
pwcli dialog-accept "typed prompt response"
pwcli dialog-dismiss
pwcli resize 1920 1080
```

## Navigation

```bash
pwcli go-back
pwcli go-forward
pwcli reload
```

## Keyboard

```bash
pwcli press Enter
pwcli press ArrowDown
pwcli keydown Shift
pwcli keyup Shift
```

## Mouse

```bash
pwcli mousemove 150 300
pwcli mousedown
pwcli mousedown right
pwcli mouseup
pwcli mouseup right
pwcli mousewheel 0 100
```

## Save as

```bash
pwcli screenshot
pwcli screenshot e5
pwcli pdf
```

## Tabs

```bash
pwcli tab-list
pwcli tab-new
pwcli tab-new https://example.com/page
pwcli tab-close
pwcli tab-close 2
pwcli tab-select 0
```

## Storage inspection

Use storage inspection to confirm browser-visible state. Avoid printing secrets or adding authentication material to reports and artifacts.

```bash
pwcli cookie-list
pwcli cookie-list --domain=example.com --path=/
pwcli cookie-get session-cookie
pwcli localstorage-list
pwcli localstorage-get preference-key
pwcli sessionstorage-list
pwcli sessionstorage-get workflow-key
```

## Storage mutation

```bash
pwcli cookie-set feature-flag enabled
pwcli cookie-delete feature-flag
pwcli cookie-clear
pwcli localstorage-set preference-key dark
pwcli localstorage-delete preference-key
pwcli localstorage-clear
pwcli sessionstorage-set workflow-key checkout
pwcli sessionstorage-delete workflow-key
pwcli sessionstorage-clear
```

## Network inspection

```bash
pwcli requests
pwcli requests --filter="/api/.*"
pwcli requests --clear
pwcli request 3
pwcli request-headers 3
pwcli request-body 3
pwcli response-headers 3
pwcli response-body 3
```

## Network control



```bash
pwcli route "**/api/profile" --status=503 --body="{\"error\":\"unavailable\"}" --content-type=application/json
pwcli route-list
pwcli unroute "**/api/profile"
pwcli unroute
pwcli network-state-set offline
pwcli network-state-set online
```

## DevTools

Prefer ordinary CLI commands.

```bash
pwcli console
pwcli console warning
pwcli run-code "async (page) => { await page.waitForTimeout(1000); }"
pwcli tracing-start
pwcli tracing-stop
pwcli generate-locator e5
pwcli highlight e5
pwcli highlight e5 --style="outline: 2px dashed red"
pwcli highlight e5 --hide
pwcli highlight --hide
```

## Recording annotations

You may add chapters or action annotations to the existing recording when instructed but should not start another recording.

```bash
pwcli video-chapter "Checkout submission"
pwcli video-show-actions
pwcli video-hide-actions
```

## Sessions

Use the default session.
