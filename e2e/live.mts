// Live end-to-end check of the model provider against https://obscurify.ai/v1.
// Run: OBSCURIFY_API_KEY=sk-obs1_... npx tsx e2e/live.mts
import { createModelProvider } from "../src/model-provider.ts";

const apiKey = process.env.OBSCURIFY_API_KEY;
if (!apiKey) throw new Error("Set OBSCURIFY_API_KEY");

const sentBodies: Record<string, unknown>[] = [];
const spy: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") sentBodies.push(JSON.parse(init.body));
  return fetch(input, init);
};
const provider = createModelProvider({ apiKey, fetch: spy });
const ctx = { sessionId: "e2e", locale: "en", currentDate: new Date().toISOString() };

async function collect(stream: unknown) {
  const parts: { type: string; [k: string]: unknown }[] = [];
  const s = stream as { fullStream: AsyncIterable<{ type: string }> };
  for await (const part of s.fullStream) parts.push(part);
  return parts;
}
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
}

const models = await provider.getModels();
check("getModels lists 200+ models", models.length >= 200, `${models.length}`);
const llama = models.find((m) => m.id === "meta-llama/llama-3.3-70b-instruct")!;
const flash = models.find((m) => m.id === "deepseek/deepseek-v4-flash")!;
check("known models present", !!llama && !!flash);
check("tool capability from catalog", flash.capabilities?.tools?.supported === true);

let parts = await collect(
  await provider.streamCompletion(llama, {
    system: "Reply in one short sentence.",
    messages: [{ role: "user", content: [{ type: "text", text: "Say hello to Raycast." }] }],
    providerOptions: { raycast: ctx },
  } as never),
);
const text = parts.filter((p) => p.type === "text-delta").map((p) => p.text).join("");
check("streams text", text.length > 0, JSON.stringify(text.slice(0, 60)));
check("stream finishes", parts.some((p) => p.type === "finish"));

parts = await collect(
  await provider.streamCompletion(flash, {
    messages: [{ role: "user", content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }] }],
    tools: {
      get_weather: {
        description: "Get the current weather for a city",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
    providerOptions: { raycast: { ...ctx, reasoningEffort: "low" } },
  } as never),
);
const call = parts.find((p) => p.type === "tool-call");
check("emits tool-call part", !!call, call ? `${call.toolName} ${JSON.stringify(call.input)}` : "");
const last = sentBodies.at(-1) as { reasoning_effort?: string; tools?: unknown[] };
check("sends reasoning_effort", last.reasoning_effort === "low");
check("sends tools", Array.isArray(last.tools) && last.tools.length === 1);

parts = await collect(
  await provider.streamCompletion(flash, {
    messages: [{ role: "user", content: [{ type: "text", text: "What is 17*23? Answer with the number." }] }],
    providerOptions: { raycast: { ...ctx, reasoningEffort: "medium" } },
  } as never),
);
const reasoning = parts.filter((p) => p.type === "reasoning-delta").length;
const answer = parts.filter((p) => p.type === "text-delta").map((p) => p.text).join("");
check("streams reasoning parts", reasoning > 0, `${reasoning} reasoning deltas`);
check("answer correct", answer.includes("391"), JSON.stringify(answer.slice(0, 40)));
