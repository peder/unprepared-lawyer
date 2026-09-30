// LLM provider factory: stub (default, deterministic) | opencode CLI | direct HTTP.
// LLM_PROVIDER=stub|opencode|direct. Direct (OpenRouter by default) needs
// OPENROUTER_API_KEY. Model slots: LLM_VOICE_MODEL, LLM_AUTHOR_MODEL.
import type { LLMClient } from "./LLMClient.js";
import { StubLLMClient } from "./LLMClient.js";
import { OpencodeLLMClient, DEFAULT_VOICE_MODEL as OPENCODE_VOICE_MODEL, DEFAULT_AUTHOR_MODEL, LLM_TIMEOUT_MS, type OpencodeRunner, defaultOpencodeRunner } from "./OpencodeLLMClient.js";
import { DirectLLMClient, DEFAULT_VOICE_MODEL as DIRECT_VOICE_MODEL } from "./DirectLLMClient.js";

export function createLLMClient(runner?: OpencodeRunner): LLMClient {
  const provider = (process.env.LLM_PROVIDER ?? "stub").toLowerCase();
  if (provider === "opencode") {
    // eslint-disable-next-line no-console
    console.log(`[llm] provider=opencode voice=${OPENCODE_VOICE_MODEL} author=${DEFAULT_AUTHOR_MODEL}`);
    return new OpencodeLLMClient(OPENCODE_VOICE_MODEL, runner ?? defaultOpencodeRunner, LLM_TIMEOUT_MS);
  }
  if (provider === "direct") {
    const voice = process.env.LLM_VOICE_MODEL ?? DIRECT_VOICE_MODEL;
    // eslint-disable-next-line no-console
    console.log(`[llm] provider=direct voice=${voice}`);
    return new DirectLLMClient(process.env.OPENROUTER_API_KEY ?? "", voice);
  }
  return new StubLLMClient();
}
