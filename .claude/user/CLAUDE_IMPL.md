# Implementation: llama.cpp as a Local Inference Provider

> **Status:** NOT YET CONFIRMED by user. Pending review.

## Checklist

### 0. Run NemoClaw As-Is (learn the product before changing it)

- [x] Install prerequisites: Docker running (switched from Docker Desktop to native WSL2 Docker to fix DNS), Node.js 22.16+
- [x] `npm install` in repo root (9 vulnerabilities from upstream `openclaw` pin — ignorable)
- [x] Get a free API key from https://build.nvidia.com/settings/api-keys
- [x] Run `./bin/nemoclaw.js onboard` — chose **NVIDIA Endpoints** with sandbox name `nemotest`
- [x] Hit gateway DNS issue: OpenShell gateway container (custom Docker network) can't resolve external hosts — `openshell inference set` fails with "failed to connect". Root cause: WSL2 Docker custom networks don't inherit `daemon.json` DNS settings. Workaround: used `--no-verify` manually, but onboard re-runs the command without it.
- [x] Switched from Docker Desktop to native WSL2 Docker (`sudo apt-get install docker.io`) + applied DNS fix (`/etc/docker/daemon.json` with `8.8.8.8`). Resolved the gateway networking issue.
- [x] Completed onboarding: gateway start, sandbox creation, inference setup (NVIDIA Endpoints / nemotron-3-super-120b-a12b), policy presets (npm + pypi enabled)
- [x] Connected to sandbox: `./bin/nemoclaw.js nemotest connect` — drops into bash shell, `openclaw` starts the agent
- [x] Added httpbin.org egress policy manually (`openshell policy set --policy <yaml> nemotest`) — learned that `network_policies` is a map not a list, needs `binaries` allowlist, and `access: full` is needed
- [x] Tested agent: Fibonacci script (inference + file I/O + code execution), curl to httpbin.org (network egress), hostname -I (system introspection), file cleanup — all passed
- [x] Observed logs: `openshell logs nemotest --tail` (not `--follow`), saw inference routing via `openshell_router` to NVIDIA endpoint
- [x] Learned: `urllib` from Python fails when launched by agent (node ancestor chain not matching policy binaries), but `curl` and direct Python from bash work fine — sandbox policy nuance, not blocking

**Key findings for llama.cpp implementation:**

- Port 8080 is claimed by OpenShell gateway — llama.cpp must use 8081
- `openshell inference set --no-verify` skips endpoint verification (useful if gateway can't reach the local endpoint directly)
- Policy `binaries` allowlist is mandatory for network egress — need to include relevant binaries for any new policy entries
- Local providers route through `host.openshell.internal` for container-to-host communication
- Onboard session persists to `~/.nemoclaw/onboard-session.json`, credentials to `~/.nemoclaw/credentials.json` — `rm` both for clean restart

### A. Research & Understand (read-only)

- [ ] Read and map every file that handles a local provider end-to-end (vllm / ollama)
- [ ] Trace the full data flow: menu selection -> validation -> gateway upsert -> sandbox routing
- [ ] Identify every switch/if-else that branches on provider name
- [ ] Catalogue the test files that would need new cases

### B. Core Provider Wiring

- [ ] Add `llamacpp-local` case to `getLocalProviderBaseUrl()` in `bin/lib/local-inference.js`
- [ ] Add `llamacpp-local` case to `getLocalProviderValidationBaseUrl()` in `bin/lib/local-inference.js`
- [ ] Add `llamacpp-local` case to `getLocalProviderHealthCheck()` in `bin/lib/local-inference.js`
- [ ] Add `llamacpp-local` case to `getLocalProviderContainerReachabilityCheck()` in `bin/lib/local-inference.js`
- [ ] Add `llamacpp-local` case to `validateLocalProvider()` in `bin/lib/local-inference.js`
- [ ] Add llama.cpp model-detection helpers (query `/v1/models`) in `bin/lib/local-inference.js`

### C. Inference Config Registration

- [ ] Add `llamacpp-local` case to `getProviderSelectionConfig()` in `bin/lib/inference-config.js`
- [ ] Add `llamacpp-local` to `getOpenClawPrimaryModel()` fallback in `bin/lib/inference-config.js`

### D. Onboarding Wizard

- [ ] Add `llamacpp` to the provider menu in `setupNim()` in `bin/lib/onboard.js` (~line 1949)
- [ ] Add `selected.key === "llamacpp"` handler block in the selection loop (~line 2266)
- [ ] Add `llamacpp-local` branch in `setupInference()` (~line 2331)
- [ ] Add `llamacpp` to `getNonInteractiveProvider()` valid-set and aliases (~line 1447)
- [ ] Add `llamacpp` to `getEffectiveProviderName()` switch (~line 1284)
- [ ] Add `llamacpp-local` label in `printDashboard()` (~line 2743)

### E. Blueprint Profile

- [ ] Add `llamacpp` profile in `nemoclaw-blueprint/blueprint.yaml`
- [ ] Add policy addition for llamacpp service endpoint

### F. Tests

- [ ] Add `llamacpp-local` cases to `test/local-inference.test.js`
- [ ] Add `llamacpp-local` cases to `test/inference-config.test.js`
- [ ] Add `llamacpp-local` validation to `test/onboard.test.js` / `test/onboard-selection.test.js`

### G. Documentation

- [ ] Update inference provider docs to list llama.cpp

### Done (on `main` branch, 0 commits)

_Nothing committed yet._

---

## What & Why

**What:** Add `llama.cpp` (via its built-in OpenAI-compatible HTTP server) as a first-class local inference option in NemoClaw, on par with vLLM and Ollama. The provider key is `llamacpp-local`, menu key is `llamacpp`. llama.cpp's server exposes `/v1/chat/completions` and `/v1/models` endpoints, making it wire-compatible with the existing OpenAI-type routing that vLLM and Ollama already use.

**Why:**

- **Lightweight local inference:** llama.cpp is the most popular CPU/GPU inference engine for GGUF models. It runs on machines without NVIDIA GPUs (Apple Silicon, CPU-only Linux) with excellent performance, filling a gap that NIM and vLLM don't cover well.
- **Parity with the ecosystem:** NemoClaw already mentions llama.cpp in its DGX Spark docs as an alternative, and `node-llama-cpp` is a transitive dependency in the lockfile. Making it a first-class citizen is a natural next step.
- **Same pattern as vLLM/Ollama:** llama.cpp's `--api` server speaks OpenAI-compatible `/v1/*` endpoints on a configurable port (default 8080), so it slots into the exact same routing pattern. Minimal new code needed.

**Design decisions:**

1. **Provider key: `llamacpp-local`, menu key: `llamacpp`.** Follows the existing convention (`vllm-local` / `vllm`, `ollama-local` / `ollama`). The `-local` suffix indicates it runs on the host, not in the cloud.

2. **Port 8081 (not 8080).** llama.cpp defaults to 8080, but the **OpenShell gateway itself claims port 8080** (`onboard.js:1536-1537` — `{ port: 8080, label: "OpenShell gateway" }`). Using 8080 would conflict. We default to **8081** and document that the user must start `llama-server --port 8081` (or whatever port they choose). This is a hard constraint discovered during research.

3. **No managed lifecycle (yet).** Unlike Ollama (which NemoClaw can start via `ollama serve`) or NIM (which NemoClaw pulls and runs via Docker), llama.cpp's `llama-server` must already be running. The user starts it manually. This matches the current vLLM approach ("you start it, we detect it"). A future phase could add `llama-server` auto-start.

4. **OpenAI provider type.** Like vLLM and Ollama, llama.cpp speaks OpenAI-compatible API. We reuse `providerType: "openai"` and credential env `OPENAI_API_KEY` (with dummy value since local).

---

## How

### 01. Run NemoClaw As-Is (COMPLETED)

**Environment:** WSL2, RTX 4060 Laptop (8 GB VRAM), native Docker (not Docker Desktop)

**What we actually did:**

1. **`npm install`** — 9 vulnerabilities from upstream `openclaw@2026.3.11` pin, all ignorable.

2. **Docker Desktop → native WSL2 Docker** — Docker Desktop's custom bridge networks don't inherit `daemon.json` DNS, causing the OpenShell gateway container to fail all external HTTPS. Switched to `sudo apt-get install docker.io` + `/etc/docker/daemon.json` with `{"dns": ["8.8.8.8", "8.8.4.4"]}`. This fixed container DNS on all networks.

3. **Onboarding** — `./bin/nemoclaw.js onboard`, sandbox name `nemotest`, NVIDIA Endpoints provider, model `nvidia/nemotron-3-super-120b-a12b`. API key from build.nvidia.com (free tier). Enabled npm + pypi policy presets.

4. **Gateway verification failure** — `openshell inference set` failed because the gateway container couldn't reach `integrate.api.nvidia.com` (even after Docker DNS fix, the gateway was on a custom network `openshell-cluster-nemoclaw` with `null` DNS config). Workaround: `openshell inference set --no-verify`. Onboard session resume kept re-running the failing command — had to `rm ~/.nemoclaw/onboard-session.json` + `rm ~/.nemoclaw/credentials.json` to reset.

5. **Agent testing** — Connected via `./bin/nemoclaw.js nemotest connect` → `openclaw` to start agent. Uploaded test prompt via `openshell sandbox upload`. Tested: Fibonacci (inference + code exec), curl to httpbin.org (network egress), hostname -I (system info), file cleanup.

6. **Policy learnings:**
   - `openshell policy set` requires a full YAML file (not inline flags), and must include `filesystem_policy` or it errors "cannot be removed on a live sandbox"
   - Safest approach: `openshell policy get --full <name>` → edit → `openshell policy set --policy <file> <name>`
   - `network_policies` is a map (keyed by name), not a list
   - `binaries` allowlist is mandatory — without it, no binary can use the endpoint
   - Python `urllib` fails when run from agent (node ancestor chain doesn't match policy binaries), but `curl` subprocess works
   - Logs: `openshell logs nemotest --tail` (not `--follow`)

7. **Cleanup**:
   - run ~/codeacious/NemoClaw/bin/nemoclaw.js destroy to tear down the container
   - run ~/.local/bin/openshell gateway destroy -g <sandbox-name> to destroy gateway
   - run rm -rf ~/.nemoclaw to remove nemoclaw state

**Key findings for llama.cpp implementation:**

- Port 8080 is claimed by OpenShell gateway — llama.cpp must use 8081
- `--no-verify` is essential for local providers where gateway can't directly reach the endpoint
- Local providers route through `http://host.openshell.internal:<port>/v1`
- Sandbox proxy env vars (`HTTP_PROXY`, `HTTPS_PROXY`) route all traffic through `10.200.0.1:3128`
- Session: `~/.nemoclaw/onboard-session.json`, creds: `~/.nemoclaw/credentials.json` — delete both for clean restart

---

### A1. Research: Map All Provider Touch-Points

Before writing any code, read every file that references `vllm-local` or `ollama-local` to build a complete map of where `llamacpp-local` needs to be added. The goal is a checklist of exact line ranges.

**Files to read (in order):**

| - | - |
| File | What to look for |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
, `bin/lib/local-inference.js` | Every `switch` and function — this is the local-provider core |
| `bin/lib/inference-config.js` | `getProviderSelectionConfig()` switch, exports |
| `bin/lib/onboard.js` | Menu construction (~1920), selection loop (~2186-2300), `setupInference()` (~2310-2366), `getNonInteractiveProvider()` (~1447), `getEffectiveProviderName()` (~1284), `printDashboard()` (~2732) |
| `nemoclaw-blueprint/blueprint.yaml` | Profile definitions |
| `test/local-inference.test.js` | Test patterns for vllm/ollama |
| `test/inference-config.test.js` | Test patterns for provider config |
| `test/onboard-selection.test.js` | Onboarding test patterns |

---

### B1. Add llamacpp-local to `getLocalProviderBaseUrl()`

**File:** `bin/lib/local-inference.js`

Add a new case returning the host-gateway URL on port 8081:

```javascript
case "llamacpp-local":
  return `${HOST_GATEWAY_URL}:8081/v1`;
```

---

### B2. Add llamacpp-local to `getLocalProviderValidationBaseUrl()`

**File:** `bin/lib/local-inference.js`

```javascript
case "llamacpp-local":
  return "http://localhost:8081/v1";
```

---

### B3. Add llamacpp-local to `getLocalProviderHealthCheck()`

**File:** `bin/lib/local-inference.js`

llama.cpp's server responds to `/v1/models` just like vLLM:

```javascript
case "llamacpp-local":
  return "curl -sf http://localhost:8081/v1/models 2>/dev/null";
```

---

### B4. Add llamacpp-local to `getLocalProviderContainerReachabilityCheck()`

**File:** `bin/lib/local-inference.js`

```javascript
case "llamacpp-local":
  return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:8081/v1/models 2>/dev/null`;
```

---

### B5. Add llamacpp-local to `validateLocalProvider()`

**File:** `bin/lib/local-inference.js`

Two new cases in the two existing switch blocks:

```javascript
// In the "not responding" switch:
case "llamacpp-local":
  return {
    ok: false,
    message: "Local llama.cpp was selected, but nothing is responding on http://localhost:8081.",
  };

// In the "not reachable from containers" switch:
case "llamacpp-local":
  return {
    ok: false,
    message:
      "Local llama.cpp is responding on localhost, but containers cannot reach http://host.openshell.internal:8081. Ensure llama-server listens on 0.0.0.0 (--host 0.0.0.0 --port 8081) so sandboxes can reach it.",
  };
```

---

### B6. Add llama.cpp model-detection helper

**File:** `bin/lib/local-inference.js`

Query the `/v1/models` endpoint (same approach as the vLLM auto-detection in `onboard.js`). This is a helper so the onboard wizard can detect the loaded model:

```javascript
function getLlamaCppModelId(runCapture) {
  const output = runCapture(
    "curl -sf http://localhost:8081/v1/models 2>/dev/null",
    {
      ignoreError: true,
    },
  );
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    if (parsed.data && parsed.data.length > 0) {
      return parsed.data[0].id;
    }
  } catch {
    /* ignored */
  }
  return null;
}
```

Export it from `module.exports`.

---

### C1. Add llamacpp-local to `getProviderSelectionConfig()`

**File:** `bin/lib/inference-config.js`

```javascript
case "llamacpp-local":
  return {
    endpointType: "custom",
    endpointUrl: INFERENCE_ROUTE_URL,
    ncpPartner: null,
    model: model || "llamacpp-model",
    profile: DEFAULT_ROUTE_PROFILE,
    credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
    provider,
    providerLabel: "Local llama.cpp",
  };
```

---

### C2. Update `getOpenClawPrimaryModel()` fallback

**File:** `bin/lib/inference-config.js`

Currently only special-cases `ollama-local`. Add `llamacpp-local` so it doesn't fall back to the cloud model:

```javascript
function getOpenClawPrimaryModel(provider, model) {
  const resolvedModel =
    model ||
    (provider === "ollama-local"
      ? DEFAULT_OLLAMA_MODEL
      : provider === "llamacpp-local"
        ? "llamacpp-model"
        : DEFAULT_CLOUD_MODEL);
  return resolvedModel ? `${MANAGED_PROVIDER_ID}/${resolvedModel}` : null;
}
```

---

### D1. Add `llamacpp` to the provider menu

**File:** `bin/lib/onboard.js` (~line 1949, after the vLLM option)

Detect whether llama.cpp is running on port 8081:

```javascript
const llamacppRunning = !!runCapture(
  "curl -sf http://localhost:8081/v1/models 2>/dev/null",
  { ignoreError: true },
);
```

Add the menu option (near vLLM):

```javascript
if (llamacppRunning) {
  options.push({
    key: "llamacpp",
    label: "Local llama.cpp (localhost:8081) — running",
  });
}
```

---

### D2. Add selection handler for `llamacpp`

**File:** `bin/lib/onboard.js` (~after the `selected.key === "vllm"` block, line 2300)

Follows the exact same pattern as vLLM — detect model from `/v1/models`, validate:

```javascript
} else if (selected.key === "llamacpp") {
  console.log("  ✓ Using existing llama.cpp on localhost:8081");
  provider = "llamacpp-local";
  credentialEnv = "OPENAI_API_KEY";
  endpointUrl = getLocalProviderBaseUrl(provider);
  const modelsRaw = runCapture("curl -sf http://localhost:8081/v1/models 2>/dev/null", { ignoreError: true });
  try {
    const models = JSON.parse(modelsRaw);
    if (models.data && models.data.length > 0) {
      model = models.data[0].id;
      if (!isSafeModelId(model)) {
        console.error(`  Detected model ID contains invalid characters: ${model}`);
        process.exit(1);
      }
      console.log(`  Detected model: ${model}`);
    } else {
      console.error("  Could not detect model from llama.cpp. Is a model loaded?");
      process.exit(1);
    }
  } catch {
    console.error("  Could not query llama.cpp models endpoint. Is llama-server running on localhost:8081?");
    process.exit(1);
  }
  preferredInferenceApi = await validateOpenAiLikeSelection(
    "Local llama.cpp",
    getLocalProviderValidationBaseUrl(provider),
    model,
    credentialEnv
  );
  if (!preferredInferenceApi) {
    continue selectionLoop;
  }
  break;
}
```

---

### D3. Add `llamacpp-local` branch to `setupInference()`

**File:** `bin/lib/onboard.js` (~line 2341, after vllm-local block)

```javascript
} else if (provider === "llamacpp-local") {
  const validation = validateLocalProvider(provider, runCapture);
  if (!validation.ok) {
    console.error(`  ${validation.message}`);
    process.exit(1);
  }
  const baseUrl = getLocalProviderBaseUrl(provider);
  upsertProvider("llamacpp-local", "openai", "OPENAI_API_KEY", baseUrl, {
    OPENAI_API_KEY: "dummy",
  });
  runOpenshell(["inference", "set", "--no-verify", "--provider", "llamacpp-local", "--model", model]);
}
```

---

### D4. Add `llamacpp` to non-interactive + helpers

**File:** `bin/lib/onboard.js`

**`getNonInteractiveProvider()` (~line 1457):**

```javascript
// Add to validProviders Set:
const validProviders = new Set([..., "llamacpp"]);
// Add alias:
const aliases = { ..., llamacpp: "llamacpp" };
```

**`getEffectiveProviderName()` (~line 1284):**

```javascript
case "llamacpp":
  return "llamacpp-local";
```

**`printDashboard()` (~line 2744):**

```javascript
else if (provider === "llamacpp-local") providerLabel = "Local llama.cpp";
```

---

### E1. Add llamacpp blueprint profile

**File:** `nemoclaw-blueprint/blueprint.yaml`

Add under `components.inference.profiles`:

```yaml
llamacpp:
  provider_type: "openai"
  provider_name: "llamacpp-local"
  endpoint: "http://localhost:8081/v1"
  model: "llamacpp-model"
  credential_env: "OPENAI_API_KEY"
  credential_default: "dummy"
```

Add under `components.policy.additions`:

```yaml
llamacpp_service:
  name: llamacpp_service
  endpoints:
    - host: "llamacpp-service.local"
      port: 8081
      protocol: rest
```

---

### F1. Tests for `local-inference.js`

**File:** `test/local-inference.test.js`

Add tests mirroring the existing vLLM/Ollama patterns:

```javascript
it("returns the expected base URL for llamacpp-local", () => {
  expect(getLocalProviderBaseUrl("llamacpp-local")).toBe(
    "http://host.openshell.internal:8081/v1",
  );
});

it("returns the expected health check command for llamacpp-local", () => {
  expect(getLocalProviderHealthCheck("llamacpp-local")).toBe(
    "curl -sf http://localhost:8081/v1/models 2>/dev/null",
  );
});

it("returns a clear error when llamacpp-local is unavailable", () => {
  const result = validateLocalProvider("llamacpp-local", () => "");
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/http:\/\/localhost:8081/);
});
```

---

### F2. Tests for `inference-config.js`

**File:** `test/inference-config.test.js`

```javascript
it("maps llamacpp-local to the sandbox inference route", () => {
  expect(getProviderSelectionConfig("llamacpp-local")).toEqual({
    endpointType: "custom",
    endpointUrl: INFERENCE_ROUTE_URL,
    ncpPartner: null,
    model: "llamacpp-model",
    profile: DEFAULT_ROUTE_PROFILE,
    credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
    provider: "llamacpp-local",
    providerLabel: "Local llama.cpp",
  });
});
```

---

## Data Flow

```
User starts llama-server on host (port 8081, --host 0.0.0.0 --port 8081)
         │
         ▼
nemoclaw onboard ──► detects llama.cpp via curl localhost:8081/v1/models
         │
         ▼
Provider menu shows "Local llama.cpp (localhost:8081) — running"
         │
         ▼
setupInference() ──► validateLocalProvider("llamacpp-local")
         │               │
         │               ▼
         │           curl localhost:8081 ──► healthy?
         │           curl from container  ──► reachable?
         │
         ▼
upsertProvider("llamacpp-local", "openai", ..., "http://host.openshell.internal:8081/v1")
         │
         ▼
openshell inference set --provider llamacpp-local --model <detected-model>
         │
         ▼
Sandbox routes inference.local ──► host.openshell.internal:8081 ──► llama-server
```

---

## Files Summary

| File                                | Action                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bin/lib/local-inference.js`        | **Edit** — add `llamacpp-local` to all 5 switch blocks + new model-detection helper                                               |
| `bin/lib/inference-config.js`       | **Edit** — add `llamacpp-local` case in `getProviderSelectionConfig()` + update `getOpenClawPrimaryModel()`                       |
| `bin/lib/onboard.js`                | **Edit** — add menu option, selection handler, `setupInference()` branch, non-interactive support, dashboard label (~6 locations) |
| `nemoclaw-blueprint/blueprint.yaml` | **Edit** — add `llamacpp` profile + policy addition                                                                               |
| `test/local-inference.test.js`      | **Edit** — add llamacpp-local test cases                                                                                          |
| `test/inference-config.test.js`     | **Edit** — add llamacpp-local test case                                                                                           |
| `test/onboard-selection.test.js`    | **Edit** — add llamacpp-local selection test                                                                                      |

---

## Risk

**Low.**

This is additive — no existing provider behavior is modified. The pattern is identical to the vLLM provider which is already implemented and tested.

| Risk                                           | Mitigation                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Port 8081 is non-standard for llama.cpp        | Document clearly that users must start with `--port 8081`; can't use default 8080 because OpenShell gateway owns it         |
| llama.cpp `/v1/models` response format differs | llama.cpp's server conforms to OpenAI spec; already verified by community. Test against actual response shape in unit tests |
| Container reachability fails on macOS          | Same risk as vLLM/Ollama — existing platform detection and error messaging covers this                                      |
| User doesn't have llama-server running         | Option only appears in menu when detection succeeds (same as vLLM pattern)                                                  |
